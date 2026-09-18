/**
 * Browser half of dsh-macos-settings-shortcut: make Cmd+, open the Settings
 * dialog the shipped DSH Desktop web shell already renders.
 *
 * Written in the restricted source subset the build script understands (see
 * scripts/build.mjs): no `import` statements, no `export default`, no calls to
 * CommonJS `require`, and no regular-expression literals. The build wraps this
 * file into the lazy CJS factory that `window.__ModuleLoader__.load`
 * registers, so the module stays dependency-free and self-contained.
 *
 * Design constraints honored here:
 *   - No app-bundle patch, no private React state, no localized button text.
 *     The only app knowledge used is published accessibility markup: the
 *     Settings shell renders its trigger as
 *     `button[aria-haspopup="dialog"][aria-expanded]` and opens on click
 *     (`@deepseek-ai/dsh-client-ui-settings-general`, SettingsRoot).
 *   - The pure logic touches nothing but the objects handed to it: the passed
 *     document and the event. Only `apply` reads `globalThis.document`, to
 *     pass it in — there is no other global access, no timer, and no polling.
 *   - The gesture is claimed (preventDefault + stopPropagation) as soon as it
 *     matches Cmd+, and the dialog is clicked open only when a visible,
 *     collapsed trigger exists. An already-open dialog or a missing trigger
 *     therefore never toggles anything closed.
 *
 * Selector-safety note: the accessibility markup alone is not unique in the
 * shipped shell — the context meter and the usage/statistics pills also render
 * `button[aria-haspopup="dialog"][aria-expanded]`. The prescribed selector
 * remains the only query, and candidate ORDER is the plan's (document order);
 * on top of that, a candidate carrying the Settings shell's own slot anchor
 * (`div[data-slot="settings.trigger"]`, rendered by the shared SlotOutlet into
 * the trigger button) is preferred. That anchor is structural markup, not
 * localized text. When no candidate carries it, selection falls back to the
 * first suitable candidate exactly as specified.
 */

/** Cordis plugin name of the browser half (diagnostics only). */
const name = "dsh-macos-settings-shortcut";

/** No browser-half services are required. */
const inject = [];

/**
 * Published accessibility markup of the Settings dialog trigger. The shell
 * renders exactly one of these per mounted Settings root; `aria-expanded`
 * mirrors the dialog's open state.
 */
const SETTINGS_TRIGGER_SELECTOR = 'button[aria-haspopup="dialog"][aria-expanded]';

/**
 * Structural marker of the Settings shell's own trigger: `SettingsRoot` renders
 * `renderSlot("settings.trigger")`, and the shared renderer wraps every slot in
 * `<div data-slot="<slotKey>" style="display:contents">`. Used only to rank
 * candidates, never to narrow the query above.
 */
const SETTINGS_TRIGGER_SLOT_ANCHOR = '[data-slot="settings.trigger"]';

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
	// Exactly the Command modifier: any Control/Option/Shift combination is a
	// different gesture (for example Cmd+Shift+, belongs to the app).
	if (!event.metaKey) return false;
	if (event.ctrlKey || event.altKey || event.shiftKey) return false;
	// Layout-independent match: `code` covers non-US layouts where the comma
	// key produces a different character; `key` covers synthetic events that
	// carry no code.
	return event.key === "," || event.code === "Comma";
}

/**
 * Decide whether a candidate trigger can actually open the dialog: it must be
 * rendered (not hidden, not `aria-hidden`), not disabled, and not hidden by
 * inline styles. `checkVisibility()` is used when the engine provides it,
 * which additionally catches CSS-class and ancestor-driven hiding.
 * @param element - a candidate element.
 * @returns true when the element is a usable, visible trigger.
 */
function isVisibleTrigger(element) {
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
 * Collect every visible trigger whose dialog is currently collapsed, in
 * document order.
 * @param doc - the document to search (never `window`/`document` globals).
 * @returns the suitable candidates (possibly empty).
 */
function collectCollapsedTriggers(doc) {
	const usable = [];
	if (doc === null || typeof doc !== "object") return usable;
	if (typeof doc.querySelectorAll !== "function") return usable;
	const candidates = doc.querySelectorAll(SETTINGS_TRIGGER_SELECTOR);
	if (candidates === null || candidates === undefined) return usable;
	const total = typeof candidates.length === "number" ? candidates.length : 0;
	for (let index = 0; index < total; index += 1) {
		const candidate = candidates[index];
		if (candidate === null || candidate === undefined) continue;
		if (typeof candidate.getAttribute !== "function") continue;
		if (typeof candidate.click !== "function") continue;
		// Only a collapsed trigger opens the dialog; an expanded one means the
		// dialog is already open and must never be toggled closed.
		if (candidate.getAttribute("aria-expanded") !== "false") continue;
		if (isVisibleTrigger(candidate) === false) continue;
		usable.push(candidate);
	}
	return usable;
}

/**
 * Does the candidate carry the Settings shell's own slot anchor?
 * @param candidate - a candidate trigger element.
 * @returns true when the marker is present.
 */
function carriesSettingsSlotAnchor(candidate) {
	if (candidate === null || typeof candidate !== "object") return false;
	if (typeof candidate.querySelector !== "function") return false;
	return candidate.querySelector(SETTINGS_TRIGGER_SLOT_ANCHOR) !== null;
}

/**
 * Find the Settings trigger to click: the first candidate carrying the
 * Settings shell's slot anchor, otherwise the first suitable candidate.
 * @param doc - the document to search (never `window`/`document` globals).
 * @returns the trigger element, or null when there is nothing safe to click.
 */
function findCollapsedTrigger(doc) {
	const usable = collectCollapsedTriggers(doc);
	for (let index = 0; index < usable.length; index += 1) {
		if (carriesSettingsSlotAnchor(usable[index])) return usable[index];
	}
	return usable.length > 0 ? usable[0] : null;
}

/**
 * Handle one keydown event.
 * @param event - the keydown event.
 * @param doc - the document whose Settings trigger should be opened.
 * @returns true when the gesture was recognized (and therefore claimed).
 */
function handleKeydown(event, doc) {
	if (isSettingsShortcut(event) === false) return false;
	if (typeof event.preventDefault !== "function") return false;
	// Claim the gesture before acting: the browser must not also process Cmd+,
	// and no other listener (for example an editor shortcut) may see it.
	event.preventDefault();
	if (typeof event.stopPropagation === "function") event.stopPropagation();
	const trigger = findCollapsedTrigger(doc);
	if (trigger === null) return true;
	trigger.click();
	return true;
}

/**
 * Install the capture-phase keydown listener.
 * @param options - `{ document }`: the document to listen on.
 * @returns a disposer that removes the listener, or null when no usable
 *          document was supplied.
 */
function installSettingsShortcut(options) {
	const doc = options === null || options === undefined ? undefined : options.document;
	if (doc === null || doc === undefined || typeof doc.addEventListener !== "function") return null;
	const listener = (event) => {
		handleKeydown(event, doc);
	};
	// Capture phase: the gesture is claimed before any app-level handler can
	// consume or cancel it.
	doc.addEventListener("keydown", listener, true);
	return function removeSettingsShortcutListener() {
		doc.removeEventListener("keydown", listener, true);
	};
}

/**
 * Cordis plugin entry of the browser half: the listener lives inside a Cordis
 * effect, so unloading or reloading the row disposes it and removes the
 * listener from the document.
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

export { apply, carriesSettingsSlotAnchor, collectCollapsedTriggers, findCollapsedTrigger, handleKeydown, inject, installSettingsShortcut, isSettingsShortcut, isVisibleTrigger, name, SETTINGS_TRIGGER_SELECTOR, SETTINGS_TRIGGER_SLOT_ANCHOR };
