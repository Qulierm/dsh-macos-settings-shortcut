/**
 * Browser half of dsh-macos-settings-shortcut: make Cmd+, open the Settings
 * dialog the shipped DSH Desktop web shell already renders.
 *
 * Two shipped shells are supported, and neither is modified:
 *
 *   DSH Desktop 2.0.14 and later
 *     `SettingsRoot` renders `renderSlot("settings.launcher", …)` with the old
 *     dialog button only as a *fallback*. The account plugin registers an entry
 *     for that slot, so the visible control is an account-menu button
 *     (`[data-slot="settings.launcher"] button[aria-haspopup="menu"]`) that
 *     toggles a portaled `[role="menu"]`. Its FIRST `button[role="menuitem"]`
 *     is the Settings row, which invokes the shell-provided `openSettings`
 *     callback. The shortcut therefore has to open that menu and pick its first
 *     row — in this shell the dialog button does not exist at all.
 *
 *   Older shells (the shape npm 0.1.0 was written against)
 *     `SettingsRoot` renders the dialog button directly; it carries
 *     `aria-haspopup="dialog"` and wraps `renderSlot("settings.trigger")`.
 *
 * Written in the restricted source subset the build script understands (see
 * scripts/build.mjs): no `import` statements, no `export default`, no calls to
 * CommonJS `require`, and no regular-expression literals. The build wraps this
 * file into the lazy CJS factory that `window.__ModuleLoader__.load` registers,
 * so the module stays dependency-free and self-contained.
 *
 * Safety rules honored here:
 *   - Only published slot anchors are used; localized labels, private React
 *     state, Electron APIs, and application files are never touched.
 *   - A menu row is clicked only when exactly ONE newly mounted visible menu
 *     appeared after clicking the launcher, while that same launcher is still
 *     expanded, and only if the menu's first row is a plain, enabled,
 *     non-submenu row. Anything ambiguous fails closed.
 *   - An already-open Settings dialog is recognized by the `settings.header`
 *     slot anchor inside a `[role="dialog"][aria-modal="true"]` panel; the
 *     shortcut then claims the gesture but clicks nothing, so Settings is never
 *     toggled closed.
 *   - The legacy dialog button is clicked only when it actually wraps the
 *     `settings.trigger` slot anchor — never "some dialog button".
 *   - Pending observation is released on action, deadline, launcher closure,
 *     the next valid shortcut, and Cordis disposal.
 */

/** Cordis plugin name of the browser half (diagnostics only). */
const name = "dsh-macos-settings-shortcut";

/** No browser-half services are required. */
const inject = [];

/**
 * Account-menu launcher of the DSH Desktop 2.0.14+ shell: the only button
 * inside the `settings.launcher` slot anchor that toggles a menu.
 */
const SETTINGS_LAUNCHER_SELECTOR = '[data-slot="settings.launcher"] button[aria-haspopup="menu"][aria-expanded]';

/**
 * Legacy Settings dialog trigger (the launcher slot's fallback button). It is
 * accepted only together with {@link SETTINGS_TRIGGER_SLOT_ANCHOR}, because the
 * bare accessibility markup also matches unrelated app popovers.
 */
const SETTINGS_TRIGGER_SELECTOR = 'button[aria-haspopup="dialog"][aria-expanded]';

/** Slot anchor rendered inside the legacy Settings dialog button. */
const SETTINGS_TRIGGER_SLOT_ANCHOR = '[data-slot="settings.trigger"]';

/** Slot anchor rendered inside the Settings dialog panel header. */
const SETTINGS_HEADER_SLOT_ANCHOR = '[data-slot="settings.header"]';

/** The Settings dialog panel: a modal dialog that contains the header anchor. */
const SETTINGS_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';

/** Menu container rendered by the menu primitive (portaled into `document.body`). */
const MENU_SELECTOR = '[role="menu"]';

/** Menu row rendered by the menu primitive. */
const MENU_ITEM_SELECTOR = 'button[role="menuitem"]';

/**
 * Safety deadline for one launcher interaction. It is not a poll: the observer
 * reacts to DOM mutations, and this timer only guarantees that observation is
 * released even if nothing ever mounts.
 */
const MENU_DEADLINE_MS = 1000;

/**
 * Accept only the unmodified macOS Cmd+Comma gesture.
 * @param event - a KeyboardEvent (or a structurally equivalent test double).
 * @returns true when the event is Cmd+Comma with no other modifier.
 */
function isSettingsShortcut(event) {
	if (event === null || typeof event !== "object") return false;
	// Key repeat and IME composition must never re-trigger the dialog.
	if (event.repeat) return false;
	if (event.isComposing) return false;
	// Exactly the Command modifier: Control/Option/Shift belong to other gestures.
	if (!event.metaKey) return false;
	if (event.ctrlKey || event.altKey || event.shiftKey) return false;
	// Layout-independent match: `code` covers layouts where the comma key emits
	// another character; `key` covers synthetic events that carry no code.
	return event.key === "," || event.code === "Comma";
}

/**
 * Decide whether an element is rendered and usable: not hidden, not
 * `aria-hidden`, not disabled, and not hidden by inline styles. The inline
 * `visibility` check is load-bearing for the menu primitive, which mounts its
 * list once in a hidden measuring position before positioning it.
 * @param element - candidate element.
 * @returns true when the element can be interacted with.
 */
function isVisibleElement(element) {
	if (element === null || typeof element !== "object") return false;
	if (element.hidden === true) return false;
	if (element.disabled === true) return false;
	if (typeof element.getAttribute === "function") {
		if (element.getAttribute("hidden") !== null) return false;
		if (element.getAttribute("aria-hidden") === "true") return false;
	}
	const style = element.style;
	if (style !== null && typeof style === "object") {
		if (style.display === "none") return false;
		if (style.visibility === "hidden" || style.visibility === "collapse") return false;
	}
	if (typeof element.checkVisibility === "function" && element.checkVisibility() === false) return false;
	return true;
}

/**
 * Does the element wrap the given slot anchor?
 * @param element - candidate element.
 * @param anchorSelector - `[data-slot="…"]` selector.
 * @returns true when the anchor exists inside the element.
 */
function carriesSlotAnchor(element, anchorSelector) {
	if (element === null || typeof element !== "object") return false;
	if (typeof element.querySelector !== "function") return false;
	return element.querySelector(anchorSelector) !== null;
}

/**
 * Find the account-menu launcher of the 2.0.14+ shell.
 * @param doc - the document to search (never `window`/`document` globals).
 * @returns the first visible launcher button, or null.
 */
function findSettingsLauncher(doc) {
	if (doc === null || typeof doc !== "object") return null;
	if (typeof doc.querySelectorAll !== "function") return null;
	const candidates = doc.querySelectorAll(SETTINGS_LAUNCHER_SELECTOR);
	const total = candidates === null || candidates === undefined || typeof candidates.length !== "number" ? 0 : candidates.length;
	for (let index = 0; index < total; index += 1) {
		const candidate = candidates[index];
		if (candidate === null || candidate === undefined) continue;
		if (typeof candidate.getAttribute !== "function") continue;
		if (typeof candidate.click !== "function") continue;
		if (isVisibleElement(candidate) === false) continue;
		return candidate;
	}
	return null;
}

/**
 * Collect the menu containers currently mounted in the document. Nested
 * submenus are excluded: only top-level menus (the portaled ones) count.
 * @param doc - the document to search.
 * @returns the mounted menu roots, in document order.
 */
function collectMenuRoots(doc) {
	const roots = [];
	if (doc === null || typeof doc !== "object") return roots;
	if (typeof doc.querySelectorAll !== "function") return roots;
	const menus = doc.querySelectorAll(MENU_SELECTOR);
	const total = menus === null || menus === undefined || typeof menus.length !== "number" ? 0 : menus.length;
	for (let index = 0; index < total; index += 1) {
		const menu = menus[index];
		if (menu === null || menu === undefined) continue;
		if (typeof menu.closest === "function" && menu.closest(MENU_SELECTOR) !== menu) continue;
		roots.push(menu);
	}
	return roots;
}

/**
 * Is a mounted menu usable? Menus are containers, so only visibility matters.
 * @param menu - candidate menu root.
 * @returns true when the menu is visible.
 */
function isVisibleMenu(menu) {
	return isVisibleElement(menu);
}

/**
 * First row of a menu that may be clicked safely: the first menuitem, accepted
 * only when it is visible, enabled, and a plain action row. A row that opens a
 * submenu is not an action and is refused instead of being treated as one.
 * @param menu - menu root element.
 * @returns the first selectable row, or null when there is none.
 */
function firstSelectableMenuItem(menu) {
	if (menu === null || typeof menu !== "object") return null;
	if (typeof menu.querySelectorAll !== "function") return null;
	const rows = menu.querySelectorAll(MENU_ITEM_SELECTOR);
	const total = rows === null || rows === undefined || typeof rows.length !== "number" ? 0 : rows.length;
	if (total === 0) return null;
	const first = rows[0];
	if (first === null || first === undefined) return null;
	if (typeof first.getAttribute !== "function") return null;
	if (typeof first.click !== "function") return null;
	if (first.getAttribute("aria-haspopup") === "menu") return null;
	if (first.getAttribute("aria-expanded") !== null) return null;
	if (isVisibleElement(first) === false) return null;
	return first;
}

/**
 * Is the Settings dialog already open? Identified by the Settings shell's own
 * header slot anchor inside a modal dialog panel, so unrelated dialogs (sign-in,
 * lightboxes, plugin modals) never match.
 * @param doc - the document to search.
 * @returns the open Settings panel, or null.
 */
function findSettingsDialog(doc) {
	if (doc === null || typeof doc !== "object") return null;
	if (typeof doc.querySelectorAll !== "function") return null;
	const dialogues = doc.querySelectorAll(SETTINGS_DIALOG_SELECTOR);
	const total = dialogues === null || dialogues === undefined || typeof dialogues.length !== "number" ? 0 : dialogues.length;
	for (let index = 0; index < total; index += 1) {
		const dialogue = dialogues[index];
		if (dialogue === null || dialogue === undefined) continue;
		if (carriesSlotAnchor(dialogue, SETTINGS_HEADER_SLOT_ANCHOR) === false) continue;
		return dialogue;
	}
	return null;
}

/**
 * Collect the collapsed legacy Settings triggers of older shells: dialog
 * buttons that wrap the `settings.trigger` slot anchor. Generic dialog buttons
 * (context meter, usage pills, other plugins) never match and are never
 * clicked.
 * @param doc - the document to search.
 * @returns the usable legacy triggers, in document order.
 */
function collectCollapsedTriggers(doc) {
	const usable = [];
	if (doc === null || typeof doc !== "object") return usable;
	if (typeof doc.querySelectorAll !== "function") return usable;
	const candidates = doc.querySelectorAll(SETTINGS_TRIGGER_SELECTOR);
	const total = candidates === null || candidates === undefined || typeof candidates.length !== "number" ? 0 : candidates.length;
	for (let index = 0; index < total; index += 1) {
		const candidate = candidates[index];
		if (candidate === null || candidate === undefined) continue;
		if (typeof candidate.getAttribute !== "function") continue;
		if (typeof candidate.click !== "function") continue;
		// Only a collapsed trigger opens the dialog; an expanded one means the
		// dialog is already open and must never be toggled closed.
		if (candidate.getAttribute("aria-expanded") !== "false") continue;
		if (carriesSlotAnchor(candidate, SETTINGS_TRIGGER_SLOT_ANCHOR) === false) continue;
		if (isVisibleElement(candidate) === false) continue;
		usable.push(candidate);
	}
	return usable;
}

/**
 * First usable legacy Settings trigger.
 * @param doc - the document to search.
 * @returns the trigger element, or null.
 */
function findCollapsedTrigger(doc) {
	const usable = collectCollapsedTriggers(doc);
	return usable.length > 0 ? usable[0] : null;
}

/**
 * Resolve the timing/observer environment of a document. The plugin never
 * reaches for bare globals: it uses the window the document belongs to, so
 * tests can supply a controllable view.
 * @param doc - the document the listener was installed on.
 * @returns the view object, or undefined when none is available.
 */
function viewOf(doc) {
	if (doc !== null && typeof doc === "object" && doc.defaultView !== null && typeof doc.defaultView === "object") {
		return doc.defaultView;
	}
	return typeof globalThis === "undefined" ? undefined : globalThis;
}

/**
 * Create the per-installation flow state (at most one pending interaction).
 * @returns a fresh state object.
 */
function createFlowState() {
	return { pending: undefined };
}

/**
 * Release a pending menu interaction, if any.
 * @param state - flow state from {@link createFlowState}.
 */
function releasePending(state) {
	if (state === null || typeof state !== "object") return;
	const pending = state.pending;
	if (pending === undefined) return;
	state.pending = undefined;
	pending();
}

/**
 * Click the launcher and open Settings from the menu it mounts.
 *
 * The click may mount the menu synchronously (React flushes discrete events) or
 * asynchronously (concurrent render, portal, measuring pass first). One bounded
 * MutationObserver on `document.body` covers both: it reacts to mutations, and
 * the deadline timer only guarantees release when nothing ever mounts.
 * @param doc - the document.
 * @param launcher - the launcher button (currently collapsed).
 * @param state - flow state from {@link createFlowState}.
 */
function startLauncherFlow(doc, launcher, state) {
	const existingMenus = new Set(collectMenuRoots(doc));
	const view = viewOf(doc);
	const flow = { observer: undefined, deadline: undefined, sawExpanded: false, settled: false };

	const settle = () => {
		if (flow.settled) return;
		flow.settled = true;
		if (flow.observer !== undefined) flow.observer.disconnect();
		if (flow.deadline !== undefined && view !== undefined && typeof view.clearTimeout === "function") {
			view.clearTimeout(flow.deadline);
		}
		if (state.pending === settle) state.pending = undefined;
	};

	/** @returns true when the flow is finished (acted or released). */
	const evaluate = () => {
		if (flow.settled) return true;
		// The launcher must stay expanded: having seen it expanded, a collapsed
		// reading means the menu was closed again, so the flow stops.
		if (launcher.getAttribute("aria-expanded") === "true") flow.sawExpanded = true;
		else if (flow.sawExpanded) {
			settle();
			return true;
		}
		const fresh = [];
		for (const menu of collectMenuRoots(doc)) {
			if (existingMenus.has(menu) === false) fresh.push(menu);
		}
		const visible = fresh.filter(isVisibleMenu);
		if (visible.length > 1) {
			// Two new menus: which one the launcher mounted is unknowable.
			settle();
			return true;
		}
		if (visible.length === 0) return false;
		const row = firstSelectableMenuItem(visible[0]);
		if (row === null) {
			// The menu mounted, but its first row is not a plain action row.
			settle();
			return true;
		}
		if (launcher.getAttribute("aria-expanded") !== "true") return false;
		row.click();
		settle();
		return true;
	};

	state.pending = settle;
	launcher.click();
	// Synchronous mount: nothing left to observe.
	if (evaluate()) return;

	const body = doc.body;
	const Observer = view === undefined ? undefined : view.MutationObserver;
	if (typeof Observer === "function" && body !== null && typeof body === "object") {
		flow.observer = new Observer(() => {
			evaluate();
		});
		const options = {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["style", "hidden", "aria-hidden", "aria-expanded"]
		};
		try {
			flow.observer.observe(body, options);
		} catch {
			// Fail closed: without observation the flow simply waits for its deadline.
			flow.observer = undefined;
		}
	}
	if (view !== undefined && typeof view.setTimeout === "function") {
		flow.deadline = view.setTimeout(() => {
			settle();
		}, MENU_DEADLINE_MS);
	} else {
		settle();
	}
}

/**
 * Handle one keydown event.
 * @param event - the keydown event.
 * @param doc - the document whose Settings dialog should be opened.
 * @param state - optional flow state shared by successive invocations.
 * @returns true when the gesture was recognized (and therefore claimed).
 */
function handleKeydown(event, doc, state) {
	if (isSettingsShortcut(event) === false) return false;
	if (typeof event.preventDefault !== "function") return false;
	const flowState = state === null || state === undefined || typeof state !== "object" ? createFlowState() : state;
	// Claim the gesture before acting: the browser must not also process Cmd+,
	// and no other listener (for example an editor shortcut) may see it.
	event.preventDefault();
	if (typeof event.stopPropagation === "function") event.stopPropagation();
	// A new valid shortcut releases the previous interaction.
	releasePending(flowState);
	// Settings already open: claim the gesture, change nothing.
	if (findSettingsDialog(doc) !== null) return true;

	const launcher = findSettingsLauncher(doc);
	if (launcher !== null) {
		const expanded = launcher.getAttribute("aria-expanded");
		if (expanded === "false") {
			startLauncherFlow(doc, launcher, flowState);
			return true;
		}
		if (expanded === "true") {
			// Already open: use it only when exactly one visible menu exists.
			const visible = collectMenuRoots(doc).filter(isVisibleMenu);
			if (visible.length === 1) {
				const row = firstSelectableMenuItem(visible[0]);
				if (row !== null) row.click();
			}
		}
		return true;
	}

	const trigger = findCollapsedTrigger(doc);
	if (trigger !== null) trigger.click();
	return true;
}

/**
 * Install the capture-phase keydown listener.
 * @param options - `{ document }`: the document to listen on.
 * @returns a disposer that removes the listener and releases pending work, or
 *          null when no usable document was supplied.
 */
function installSettingsShortcut(options) {
	const doc = options === null || options === undefined ? undefined : options.document;
	if (doc === null || doc === undefined || typeof doc.addEventListener !== "function") return null;
	const state = createFlowState();
	const listener = (event) => {
		handleKeydown(event, doc, state);
	};
	// Capture phase: the gesture is claimed before any app-level handler can
	// consume or cancel it.
	doc.addEventListener("keydown", listener, true);
	return function removeSettingsShortcutListener() {
		doc.removeEventListener("keydown", listener, true);
		releasePending(state);
	};
}

/**
 * Cordis plugin entry of the browser half: the listener lives inside a Cordis
 * effect, so unloading or reloading the row disposes it, removes the listener,
 * and releases any pending menu interaction.
 * @param ctx - Cordis context of the client row.
 */
function apply(ctx) {
	ctx.effect(() => {
		const doc = typeof globalThis === "undefined" ? undefined : globalThis.document;
		const dispose = installSettingsShortcut({ document: doc });
		if (dispose === null) {
			ctx.logger?.warn?.("dsh-macos-settings-shortcut: no document available; Cmd+, is not installed");
			return undefined;
		}
		ctx.logger?.debug?.("dsh-macos-settings-shortcut: Cmd+, keydown listener installed");
		return dispose;
	}, "dsh-macos-settings-shortcut: keydown listener");
}

export { apply, carriesSlotAnchor, collectCollapsedTriggers, collectMenuRoots, createFlowState, findCollapsedTrigger, findSettingsDialog, findSettingsLauncher, firstSelectableMenuItem, handleKeydown, inject, installSettingsShortcut, isSettingsShortcut, isVisibleElement, isVisibleMenu, MENU_DEADLINE_MS, MENU_ITEM_SELECTOR, MENU_SELECTOR, name, SETTINGS_DIALOG_SELECTOR, SETTINGS_HEADER_SLOT_ANCHOR, SETTINGS_LAUNCHER_SELECTOR, SETTINGS_TRIGGER_SELECTOR, SETTINGS_TRIGGER_SLOT_ANCHOR };
