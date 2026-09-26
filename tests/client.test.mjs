/**
 * Behavior tests for the Cmd+, browser half, covering both shipped shells:
 *
 *   - DSH Desktop 2.0.14+: the `settings.launcher` slot is filled by the account
 *     plugin, so the shortcut must open the launcher's portaled menu and pick
 *     its first row (the Settings action).
 *   - older shells: the launcher slot falls back to a dialog button that wraps
 *     the `settings.trigger` slot anchor.
 *
 * The suite uses a fake DOM (with a small attribute/descendant selector
 * matcher, so the real selector strings are exercised), fake events, a fake
 * `MutationObserver`, and a fake clock. It never touches the live DSH profile,
 * never writes anywhere, and the only absolute path it reads is the installed
 * application bundle, read-only and skippable.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import {
	MENU_DEADLINE_MS,
	SETTINGS_DIALOG_SELECTOR,
	SETTINGS_HEADER_SLOT_ANCHOR,
	SETTINGS_LAUNCHER_SELECTOR,
	SETTINGS_TRIGGER_SELECTOR,
	SETTINGS_TRIGGER_SLOT_ANCHOR,
	createFlowState,
	findSettingsDialog,
	findSettingsLauncher,
	firstSelectableMenuItem,
	handleKeydown,
	installSettingsShortcut,
	isSettingsShortcut,
	isVisibleElement,
	name as clientPluginName
} from "../src/client.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILT_CLIENT = join(ROOT, "lib/client.js");

/* ------------------------------------------------------------------ *
 * Fake DOM with attribute/descendant selector matching
 * ------------------------------------------------------------------ */

/**
 * Parse a descendant-only selector into compound parts.
 * @param selector - selector text such as `[role="menu"]` or `div[a="1"] button[b="2"]`.
 * @returns the parsed compounds, outermost first.
 */
function parseSelector(selector) {
	return selector
		.trim()
		.split(" ")
		.map((part) => {
			const tag = /^[A-Za-z][A-Za-z0-9-]*/u.exec(part);
			const attributes = [];
			const attributePattern = /\[([^\]=\s]+)(?:="([^"]*)")?\]/gu;
			let match = attributePattern.exec(part);
			while (match !== null) {
				attributes.push({ name: match[1], value: match[2] });
				match = attributePattern.exec(part);
			}
			return { tag: tag === null ? null : tag[0].toLowerCase(), attributes };
		});
}

/**
 * Does one element satisfy one compound selector part?
 * @param element - candidate element.
 * @param compound - parsed compound.
 * @returns true on a match.
 */
function matchesCompound(element, compound) {
	if (compound.tag !== null && element.tag !== compound.tag) return false;
	for (const attribute of compound.attributes) {
		const value = element.getAttribute(attribute.name);
		if (value === null) return false;
		if (attribute.value !== undefined && value !== attribute.value) return false;
	}
	return true;
}

/**
 * Does one element match a full descendant selector?
 * @param element - candidate element.
 * @param selector - selector text.
 * @returns true on a match.
 */
function matchesSelector(element, selector) {
	const parts = parseSelector(selector);
	if (matchesCompound(element, parts[parts.length - 1]) === false) return false;
	let index = parts.length - 2;
	let current = element.parentNode;
	while (index >= 0) {
		let found = false;
		while (current !== null) {
			if (matchesCompound(current, parts[index])) {
				found = true;
				current = current.parentNode;
				break;
			}
			current = current.parentNode;
		}
		if (found === false) return false;
		index -= 1;
	}
	return true;
}

/**
 * Create a fake element.
 * @param spec - `{ tag, attrs, hidden, disabled, style, onClick }`.
 * @returns the fake element.
 */
function createFakeElement(spec = {}) {
	const attributes = new Map(Object.entries(spec.attrs ?? {}));
	const element = {
		tag: spec.tag ?? "div",
		children: [],
		parentNode: null,
		clicks: 0,
		hidden: spec.hidden === true,
		disabled: spec.disabled === true,
		style: { ...(spec.style ?? {}) },
		getAttribute(name) {
			return attributes.has(name) ? attributes.get(name) : null;
		},
		setAttribute(name, value) {
			attributes.set(name, value);
		},
		removeAttribute(name) {
			attributes.delete(name);
		},
		appendChild(child) {
			child.parentNode = element;
			element.children.push(child);
			return child;
		},
		removeChild(child) {
			const index = element.children.indexOf(child);
			if (index >= 0) {
				element.children.splice(index, 1);
				child.parentNode = null;
			}
			return child;
		},
		querySelector(selector) {
			const found = element.querySelectorAll(selector);
			return found.length > 0 ? found[0] : null;
		},
		querySelectorAll(selector) {
			const found = [];
			const walk = (node) => {
				for (const child of node.children) {
					if (matchesSelector(child, selector)) found.push(child);
					walk(child);
				}
			};
			walk(element);
			return found;
		},
		closest(selector) {
			let node = element;
			while (node !== null) {
				if (matchesSelector(node, selector)) return node;
				node = node.parentNode;
			}
			return null;
		},
		click() {
			element.clicks += 1;
			if (typeof spec.onClick === "function") spec.onClick(element);
		},
		addEventListener() {},
		removeEventListener() {}
	};
	return element;
}

/**
 * Create a fake document with a body, listener bookkeeping, and a query log.
 * @returns the fake document.
 */
function createFakeDocument() {
	const body = createFakeElement({ tag: "body" });
	const document = {
		body,
		listeners: [],
		queries: [],
		appendChild(child) {
			return body.appendChild(child);
		},
		querySelectorAll(selector) {
			document.queries.push(selector);
			return body.querySelectorAll(selector);
		},
		querySelector(selector) {
			const found = document.querySelectorAll(selector);
			return found.length > 0 ? found[0] : null;
		},
		addEventListener(type, listener, capture) {
			document.listeners.push({ type, listener, capture });
		},
		removeEventListener(type, listener, capture) {
			const index = document.listeners.findIndex(
				(entry) => entry.type === type && entry.listener === listener && entry.capture === capture
			);
			if (index >= 0) document.listeners.splice(index, 1);
		}
	};
	return document;
}

/**
 * Create a fake view (window) with a fake MutationObserver and clock.
 * @returns the fake view.
 */
function createFakeView() {
	const timers = [];
	const observers = [];
	const view = {
		timers,
		observers,
		MutationObserver: class {
			constructor(callback) {
				this.callback = callback;
				this.disconnected = false;
				this.observed = null;
				observers.push(this);
			}
			observe(target, options) {
				this.observed = { target, options };
			}
			disconnect() {
				this.disconnected = true;
			}
			fire() {
				this.callback([], this);
			}
		},
		setTimeout(callback, delay) {
			timers.push({ callback, delay, cleared: false, fired: false });
			return timers.length;
		},
		clearTimeout(handle) {
			const timer = timers[handle - 1];
			if (timer !== undefined) timer.cleared = true;
		},
		fireDeadline() {
			for (const timer of timers) {
				if (timer.cleared === false && timer.fired === false) {
					timer.fired = true;
					timer.callback();
				}
			}
		}
	};
	return view;
}

/* ------------------------------------------------------------------ *
 * Shell builders
 * ------------------------------------------------------------------ */

/**
 * Build the DSH Desktop 2.0.14 account-menu shell.
 *
 * The launcher click mimics the real component: it flips `aria-expanded` and,
 * depending on `mount`, either portals the menu immediately (React discrete
 * flush), records a pending asynchronous mount, or only expands.
 * @param options - `{ expanded, mount, hidden, disabled, firstRow, menuSpec, settingsOpen }`.
 * @returns `{ document, view, launcher, state, mountMenu, closeMenus, rows }`.
 */
function createAccountShell(options = {}) {
	const document = createFakeDocument();
	const view = createFakeView();
	document.defaultView = view;

	const rows = [];
	const state = { settingsOpen: false, menus: [] };

	/** Create a menu root with the given rows; the portal target is document.body. */
	const createMenu = (rowSpecs, menuSpec = {}) => {
		const menu = createFakeElement({ tag: "div", attrs: { role: "menu" }, style: menuSpec.style ?? {} });
		for (const rowSpec of rowSpecs) {
			const row = createFakeElement({
				tag: "button",
				attrs: { role: "menuitem", ...(rowSpec.attrs ?? {}) },
				hidden: rowSpec.hidden === true,
				disabled: rowSpec.disabled === true,
				onClick: () => {
					if (rowSpec.opensSettings === true) state.settingsOpen = true;
				}
			});
			menu.appendChild(row);
			rows.push(row);
		}
		state.menus.push(menu);
		document.appendChild(menu);
		return menu;
	};

	const rowSpecsFor = () => {
		if (options.firstRow === "submenu") return [{ attrs: { "aria-haspopup": "menu", "aria-expanded": "false" } }, { opensSettings: true }];
		if (options.firstRow === "disabled") return [{ disabled: true, opensSettings: true }, { opensSettings: true }];
		if (options.firstRow === "hidden") return [{ hidden: true, opensSettings: true }, { opensSettings: true }];
		if (options.firstRow === "empty") return [];
		return [{ opensSettings: true }, {}, {}];
	};

	const mountMenu = () => createMenu(rowSpecsFor(), options.menuSpec ?? {});

	const closeMenus = () => {
		for (const menu of [...state.menus]) {
			document.body.removeChild(menu);
			state.menus.splice(state.menus.indexOf(menu), 1);
		}
		launcher.setAttribute("aria-expanded", "false");
	};

	const accountRoot = createFakeElement({ tag: "span" });
	const launcherSlot = createFakeElement({ tag: "div", attrs: { "data-slot": "settings.launcher" } });
	const launcher = createFakeElement({
		tag: "button",
		attrs: {
			"aria-haspopup": "menu",
			"aria-expanded": options.expanded === true ? "true" : "false",
			"aria-label": "Account menu"
		},
		hidden: options.hidden === true,
		disabled: options.disabled === true,
		onClick: () => {
			if (launcher.getAttribute("aria-expanded") === "true") {
				closeMenus();
				return;
			}
			launcher.setAttribute("aria-expanded", "true");
			if (options.mount === "async" || options.mount === "none") return;
			mountMenu();
		}
	});
	const triggerRow = createFakeElement({ tag: "div" });
	accountRoot.appendChild(launcher);
	launcherSlot.appendChild(accountRoot);
	triggerRow.appendChild(launcherSlot);
	document.appendChild(triggerRow);

	if (options.settingsOpen === true) mountSettingsDialog(document);
	if (options.expanded === true && options.mount !== "none") mountMenu();

	return { document, view, launcher, state, mountMenu, closeMenus, rows };
}

/**
 * Mount an already-open Settings panel (modal dialog with the header slot
 * anchor) next to an unrelated modal dialog.
 * @param document - fake document.
 * @returns the Settings panel element.
 */
function mountSettingsDialog(document) {
	const unrelated = createFakeElement({ tag: "div", attrs: { role: "dialog", "aria-modal": "true" } });
	unrelated.appendChild(createFakeElement({ tag: "div", attrs: { "data-slot": "settings.signIn.header" } }));
	document.appendChild(unrelated);

	const panel = createFakeElement({ tag: "div", attrs: { role: "dialog", "aria-modal": "true" } });
	panel.appendChild(createFakeElement({ tag: "div", attrs: { "data-slot": "settings.header" } }));
	document.appendChild(panel);
	return panel;
}

/**
 * Build the older shell: no account launcher, only dialog buttons.
 * @param options - `{ expanded, anchored, hidden }`.
 * @returns `{ document, view, trigger, otherTrigger }`.
 */
function createLegacyShell(options = {}) {
	const document = createFakeDocument();
	const view = createFakeView();
	document.defaultView = view;

	/** One dialog-style button; only the anchored variant is a Settings trigger. */
	const createDialogButton = (anchored) => {
		const button = createFakeElement({
			tag: "button",
			attrs: {
				"aria-haspopup": "dialog",
				"aria-expanded": options.expanded === true ? "true" : "false",
				"aria-label": anchored ? "Settings" : "Context meter"
			},
			hidden: options.hidden === true && anchored
		});
		const child = anchored && options.anchored !== false
			? createFakeElement({ tag: "div", attrs: { "data-slot": "settings.trigger" } })
			: createFakeElement({ tag: "span" });
		button.appendChild(child);
		document.appendChild(button);
		return button;
	};

	const otherTrigger = createDialogButton(false);
	const trigger = createDialogButton(true);
	return { document, view, trigger, otherTrigger };
}
/* ------------------------------------------------------------------ *
 * Events, listener driving, built artifact loading
 * ------------------------------------------------------------------ */

/**
 * Build a fake keydown event.
 * @param overrides - event field overrides (defaults are unmodified Cmd+,).
 * @returns the fake event.
 */
function createFakeEvent(overrides = {}) {
	const event = {
		key: ",",
		code: "Comma",
		metaKey: true,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		repeat: false,
		isComposing: false,
		prevented: 0,
		stopped: 0,
		preventDefault() {
			event.prevented += 1;
		},
		stopPropagation() {
			event.stopped += 1;
		},
		...overrides
	};
	return event;
}

/**
 * Deliver an event to every registered keydown listener of a fake document.
 * @param document - fake document.
 * @param event - fake event.
 */
function dispatchKeydown(document, event) {
	for (const entry of [...document.listeners]) if (entry.type === "keydown") entry.listener(event);
}

/**
 * Materialize the generated client bundle inside a fresh VM context.
 * @param document - fake document exposed as the sandbox `document`.
 * @returns the materialized plugin module.
 */
function loadBuiltClientModule(document) {
	const registrations = [];
	const sandbox = {
		document,
		window: {
			__ModuleLoader__: {
				load(registration) {
					registrations.push(registration);
				}
			}
		}
	};
	runInNewContext(readFileSync(BUILT_CLIENT, "utf8"), sandbox, { filename: BUILT_CLIENT });
	assert.equal(registrations.length, 1);
	return registrations[0].factory((specifier) => {
		throw new Error(`the client half must not require "${specifier}"`);
	});
}

/** Build a minimal Cordis context double collecting effects. */
function createFakeCordisContext() {
	const effects = [];
	const warnings = [];
	return {
		effects,
		warnings,
		logger: {
			debug() {},
			warn(message) {
				warnings.push(message);
			}
		},
		effect(callback, label) {
			const dispose = callback();
			effects.push({ label, dispose });
			return dispose;
		}
	};
}

/* ------------------------------------------------------------------ *
 * Gesture recognition
 * ------------------------------------------------------------------ */

test("unmodified Cmd+Comma is recognized in both key and code forms", () => {
	assert.equal(isSettingsShortcut(createFakeEvent()), true);
	assert.equal(isSettingsShortcut(createFakeEvent({ key: ",", code: "" })), true);
	assert.equal(isSettingsShortcut(createFakeEvent({ key: "<", code: "Comma" })), true);
	assert.equal(isSettingsShortcut(createFakeEvent({ key: ",", code: undefined })), true);
});

test("every other gesture is rejected", () => {
	assert.equal(isSettingsShortcut(createFakeEvent({ metaKey: false })), false, "plain comma");
	assert.equal(isSettingsShortcut(createFakeEvent({ ctrlKey: true })), false, "Cmd+Ctrl+,");
	assert.equal(isSettingsShortcut(createFakeEvent({ altKey: true })), false, "Cmd+Option+,");
	assert.equal(isSettingsShortcut(createFakeEvent({ shiftKey: true })), false, "Cmd+Shift+,");
	assert.equal(isSettingsShortcut(createFakeEvent({ repeat: true })), false, "held key repeat");
	assert.equal(isSettingsShortcut(createFakeEvent({ isComposing: true })), false, "IME composition");
	assert.equal(isSettingsShortcut(createFakeEvent({ key: "k", code: "KeyK" })), false, "Cmd+K");
	assert.equal(isSettingsShortcut(null), false);
	assert.equal(isSettingsShortcut(undefined), false);
	assert.equal(isSettingsShortcut("Comma"), false);
});

test("non-matching gestures never query the document or touch the event", () => {
	const shell = createAccountShell({ mount: "sync" });
	const event = createFakeEvent({ shiftKey: true });
	assert.equal(handleKeydown(event, shell.document, createFlowState()), false);
	assert.equal(event.prevented, 0);
	assert.equal(event.stopped, 0);
	assert.equal(shell.launcher.clicks, 0);
	assert.deepEqual(shell.document.queries, []);
});

/* ------------------------------------------------------------------ *
 * DSH Desktop 2.0.14 account-menu flow
 * ------------------------------------------------------------------ */

test("synchronously mounted account menu: launcher then first row", () => {
	const shell = createAccountShell({ mount: "sync" });
	const event = createFakeEvent();
	assert.equal(handleKeydown(event, shell.document, createFlowState()), true);
	assert.equal(event.prevented, 1);
	assert.equal(event.stopped, 1);
	assert.equal(shell.launcher.clicks, 1, "the launcher is clicked once");
	assert.equal(shell.rows[0].clicks, 1, "the first row (Settings) is clicked");
	assert.equal(shell.rows[1].clicks, 0);
	assert.equal(shell.rows[2].clicks, 0);
	assert.equal(shell.state.settingsOpen, true);
	assert.equal(shell.view.observers.length, 0, "a synchronous mount needs no observer");
	assert.equal(shell.document.queries.includes(SETTINGS_LAUNCHER_SELECTOR), true);
});

test("asynchronously mounted account menu is opened through the observer", () => {
	const shell = createAccountShell({ mount: "async" });
	const state = createFlowState();
	assert.equal(handleKeydown(createFakeEvent(), shell.document, state), true);
	assert.equal(shell.launcher.clicks, 1);
	assert.equal(shell.rows.length, 0, "nothing mounted yet");
	assert.equal(shell.view.observers.length, 1, "exactly one bounded observer");
	assert.equal(shell.view.observers[0].observed.target, shell.document.body);
	assert.equal(shell.view.observers[0].observed.options.subtree, true);
	assert.equal(shell.view.observers[0].observed.options.childList, true);
	assert.equal(shell.view.observers[0].observed.options.attributes, true);
	assert.equal(shell.view.timers.length, 1, "exactly one deadline");
	assert.equal(shell.view.timers[0].delay, MENU_DEADLINE_MS);

	shell.mountMenu();
	shell.view.observers[0].fire();
	assert.equal(shell.rows[0].clicks, 1);
	assert.equal(shell.state.settingsOpen, true);
	assert.equal(shell.view.observers[0].disconnected, true, "observer released on action");
	assert.equal(shell.view.timers[0].cleared, true, "deadline released on action");
	assert.equal(state.pending, undefined, "pending state released");
});

test("the menu primitive's hidden measuring pass is tolerated", () => {
	const shell = createAccountShell({ mount: "async", menuSpec: { style: { visibility: "hidden" } } });
	const state = createFlowState();
	handleKeydown(createFakeEvent(), shell.document, state);
	shell.mountMenu();
	shell.view.observers[0].fire();
	assert.equal(shell.rows[0].clicks, 0, "an invisible menu is not used");
	assert.notEqual(state.pending, undefined, "the flow keeps waiting");

	shell.state.menus[0].style.visibility = "";
	shell.view.observers[0].fire();
	assert.equal(shell.rows[0].clicks, 1, "the positioned menu is used");
	assert.equal(shell.view.observers[0].disconnected, true);
});

test("a pre-existing unrelated portal menu is ignored and left untouched", () => {
	const shell = createAccountShell({ mount: "async" });
	const unrelated = createFakeElement({ tag: "div", attrs: { role: "menu" } });
	const unrelatedRow = createFakeElement({ tag: "button", attrs: { role: "menuitem" } });
	unrelated.appendChild(unrelatedRow);
	shell.document.appendChild(unrelated);

	handleKeydown(createFakeEvent(), shell.document, createFlowState());
	shell.mountMenu();
	shell.view.observers[0].fire();

	assert.equal(unrelatedRow.clicks, 0, "the unrelated menu is never used");
	assert.equal(shell.rows[0].clicks, 1, "the newly mounted menu is used");
});

test("two newly mounted visible menus fail closed", () => {
	const shell = createAccountShell({ mount: "async" });
	const state = createFlowState();
	handleKeydown(createFakeEvent(), shell.document, state);
	shell.mountMenu();
	shell.mountMenu();
	shell.view.observers[0].fire();
	assert.equal(shell.state.menus.length, 2);
	for (const row of shell.rows) assert.equal(row.clicks, 0, "an ambiguous mount clicks nothing");
	assert.equal(shell.view.observers[0].disconnected, true);
	assert.equal(state.pending, undefined);
});

test("an already-expanded launcher is used only when exactly one visible menu exists", () => {
	const unique = createAccountShell({ expanded: true });
	handleKeydown(createFakeEvent(), unique.document, createFlowState());
	assert.equal(unique.launcher.clicks, 0, "never toggled closed");
	assert.equal(unique.rows[0].clicks, 1);
	assert.equal(unique.state.settingsOpen, true);

	const none = createAccountShell({ expanded: true, mount: "none" });
	handleKeydown(createFakeEvent(), none.document, createFlowState());
	assert.equal(none.rows.length, 0);
	assert.equal(none.view.observers.length, 0, "an expanded launcher starts no observation");

	const ambiguous = createAccountShell({ expanded: true });
	const second = createFakeElement({ tag: "div", attrs: { role: "menu" } });
	const secondRow = createFakeElement({ tag: "button", attrs: { role: "menuitem" } });
	second.appendChild(secondRow);
	ambiguous.document.appendChild(second);
	handleKeydown(createFakeEvent(), ambiguous.document, createFlowState());
	assert.equal(ambiguous.rows[0].clicks, 0, "two visible menus are ambiguous");
	assert.equal(secondRow.clicks, 0);
});

test("an open Settings dialog claims the shortcut and changes nothing", () => {
	const shell = createAccountShell({ mount: "sync", settingsOpen: true });
	const event = createFakeEvent();
	assert.notEqual(findSettingsDialog(shell.document), null, "the dialog is recognized by its header anchor");
	assert.equal(handleKeydown(event, shell.document, createFlowState()), true);
	assert.equal(event.prevented, 1);
	assert.equal(event.stopped, 1);
	assert.equal(shell.launcher.clicks, 0, "the launcher is not toggled");
	assert.deepEqual(shell.state.menus, [], "no menu is opened");
});

test("hidden or disabled launchers are never clicked", () => {
	for (const variant of [{ hidden: true }, { disabled: true }]) {
		const shell = createAccountShell({ mount: "sync", ...variant });
		handleKeydown(createFakeEvent(), shell.document, createFlowState());
		assert.equal(shell.launcher.clicks, 0);
		assert.equal(shell.rows.length, 0);
		assert.equal(findSettingsLauncher(shell.document), null);
	}
});

test("an unusable first row fails closed", () => {
	for (const firstRow of ["submenu", "disabled", "hidden"]) {
		const shell = createAccountShell({ mount: "sync", firstRow });
		handleKeydown(createFakeEvent(), shell.document, createFlowState());
		assert.equal(shell.rows[0].clicks, 0, `first row: ${firstRow}`);
		assert.equal(shell.state.settingsOpen, false, `first row: ${firstRow}`);
	}
});

test("a menu without any visible row fails closed", () => {
	const shell = createAccountShell({ mount: "sync", firstRow: "empty" });
	handleKeydown(createFakeEvent(), shell.document, createFlowState());
	assert.equal(shell.state.settingsOpen, false);
	assert.equal(firstSelectableMenuItem(createFakeElement({ tag: "div", attrs: { role: "menu" } })), null);
});

/* ------------------------------------------------------------------ *
 * Release paths: deadline, closure, repeat, disposal
 * ------------------------------------------------------------------ */

test("the deadline releases observation without clicking anything", () => {
	const shell = createAccountShell({ mount: "async" });
	const state = createFlowState();
	handleKeydown(createFakeEvent(), shell.document, state);
	assert.notEqual(state.pending, undefined);

	shell.view.fireDeadline();
	assert.equal(shell.view.observers[0].disconnected, true);
	assert.equal(state.pending, undefined, "pending released by the deadline");

	// A late mount after the deadline must not activate anything.
	shell.mountMenu();
	shell.view.observers[0].fire();
	assert.equal(shell.rows[0].clicks, 0, "no stale menu activation");
});

test("closing the launcher releases observation", () => {
	const shell = createAccountShell({ mount: "async" });
	const state = createFlowState();
	handleKeydown(createFakeEvent(), shell.document, state);
	assert.equal(shell.view.observers.length, 1);

	// React commits the expanded state first, then the menu is closed again.
	shell.launcher.setAttribute("aria-expanded", "true");
	shell.view.observers[0].fire();
	shell.closeMenus();
	shell.view.observers[0].fire();

	assert.equal(shell.view.observers[0].disconnected, true);
	assert.equal(state.pending, undefined);
});

test("a second valid shortcut releases the previous interaction", () => {
	const shell = createAccountShell({ mount: "async" });
	const state = createFlowState();
	handleKeydown(createFakeEvent(), shell.document, state);
	const firstObserver = shell.view.observers[0];
	assert.equal(firstObserver.disconnected, false);

	// Second press while the launcher is expanded but its menu never mounted:
	// the earlier flow is released, and nothing ambiguous is clicked.
	handleKeydown(createFakeEvent(), shell.document, state);
	assert.equal(firstObserver.disconnected, true, "the first flow is released");
	assert.equal(shell.view.observers.length, 1, "an expanded launcher starts no second flow");
	assert.equal(shell.state.settingsOpen, false, "nothing is clicked while the state is unclear");

	// Once the launcher is collapsed again, a fresh flow observes and succeeds.
	shell.closeMenus();
	handleKeydown(createFakeEvent(), shell.document, state);
	assert.equal(shell.view.observers.length, 2, "a fresh flow starts for the collapsed launcher");
	shell.mountMenu();
	shell.view.observers[1].fire();
	assert.equal(shell.rows[0].clicks, 1, "the new flow opens Settings");
	assert.equal(shell.view.observers[0].disconnected, true);
});

test("disposal while pending releases the listener and the observation", () => {
	const shell = createAccountShell({ mount: "async" });
	const dispose = installSettingsShortcut({ document: shell.document });
	assert.equal(typeof dispose, "function");
	assert.equal(shell.document.listeners.length, 1);
	assert.equal(shell.document.listeners[0].type, "keydown");
	assert.equal(shell.document.listeners[0].capture, true, "capture-phase registration");

	dispatchKeydown(shell.document, createFakeEvent());
	assert.equal(shell.launcher.clicks, 1);
	assert.equal(shell.view.observers.length, 1);

	dispose();
	assert.equal(shell.document.listeners.length, 0);
	assert.equal(shell.view.observers[0].disconnected, true);
	assert.equal(shell.view.timers[0].cleared, true);

	shell.mountMenu();
	const afterDispose = createFakeEvent();
	dispatchKeydown(shell.document, afterDispose);
	assert.equal(shell.rows[0].clicks, 0, "no handling after disposal");
	assert.equal(afterDispose.prevented, 0);
});

test("installation without a usable document reports null instead of throwing", () => {
	assert.equal(installSettingsShortcut({ document: null }), null);
	assert.equal(installSettingsShortcut({ document: {} }), null);
	assert.equal(installSettingsShortcut(undefined), null);
	assert.equal(installSettingsShortcut({}), null);
});

/* ------------------------------------------------------------------ *
 * Legacy shell
 * ------------------------------------------------------------------ */

test("the legacy shell still opens Settings from its anchored dialog trigger", () => {
	const shell = createLegacyShell();
	const event = createFakeEvent();
	assert.equal(handleKeydown(event, shell.document, createFlowState()), true);
	assert.equal(event.prevented, 1);
	assert.equal(shell.trigger.clicks, 1);
	assert.equal(shell.otherTrigger.clicks, 0, "the unanchored dialog button is never clicked");
	assert.equal(shell.document.queries.includes(SETTINGS_TRIGGER_SELECTOR), true);
	assert.equal(
		shell.document.queries.includes(SETTINGS_TRIGGER_SLOT_ANCHOR),
		false,
		"anchors are checked on the candidate button, not queried document-wide"
	);
});

test("the legacy path fails closed when no dialog button carries the settings.trigger anchor", () => {
	const shell = createLegacyShell({ anchored: false });
	const event = createFakeEvent();
	assert.equal(handleKeydown(event, shell.document, createFlowState()), true, "the gesture is still claimed");
	assert.equal(event.prevented, 1);
	assert.equal(shell.trigger.clicks, 0, "an unrelated dialog button is NOT clicked");
	assert.equal(shell.otherTrigger.clicks, 0);
});

test("an expanded legacy trigger is never clicked", () => {
	const shell = createLegacyShell({ expanded: true });
	handleKeydown(createFakeEvent(), shell.document, createFlowState());
	assert.equal(shell.trigger.clicks, 0);
});

test("a hidden legacy trigger is never clicked", () => {
	const shell = createLegacyShell({ hidden: true });
	handleKeydown(createFakeEvent(), shell.document, createFlowState());
	assert.equal(shell.trigger.clicks, 0);
});

test("a shell with neither launcher nor legacy trigger claims the gesture and clicks nothing", () => {
	const document = createFakeDocument();
	document.defaultView = createFakeView();
	const event = createFakeEvent();
	assert.equal(handleKeydown(event, document, createFlowState()), true);
	assert.equal(event.prevented, 1);
	assert.equal(document.queries.includes(SETTINGS_LAUNCHER_SELECTOR), true);
	assert.equal(document.queries.includes(SETTINGS_TRIGGER_SELECTOR), true);
});

test("visibility rules cover hidden, aria-hidden, disabled, and inline styles", () => {
	assert.equal(isVisibleElement(createFakeElement()), true);
	assert.equal(isVisibleElement(createFakeElement({ hidden: true })), false);
	assert.equal(isVisibleElement(createFakeElement({ disabled: true })), false);
	assert.equal(isVisibleElement(createFakeElement({ attrs: { hidden: "" } })), false);
	assert.equal(isVisibleElement(createFakeElement({ attrs: { "aria-hidden": "true" } })), false);
	assert.equal(isVisibleElement(createFakeElement({ style: { display: "none" } })), false);
	assert.equal(isVisibleElement(createFakeElement({ style: { visibility: "hidden" } })), false);
	assert.equal(isVisibleElement(createFakeElement({ style: { visibility: "collapse" } })), false);
	assert.equal(isVisibleElement(null), false);
});

/* ------------------------------------------------------------------ *
 * Generated artifact
 * ------------------------------------------------------------------ */

test("the generated client bundle installs the shortcut through a Cordis effect", () => {
	const shell = createAccountShell({ mount: "sync" });
	const plugin = loadBuiltClientModule(shell.document);
	assert.equal(plugin.name, clientPluginName);
	assert.equal(typeof plugin.apply, "function");

	const ctx = createFakeCordisContext();
	plugin.apply(ctx);
	assert.equal(ctx.effects.length, 1);
	assert.equal(ctx.effects[0].label, "dsh-macos-settings-shortcut: keydown listener");
	assert.equal(shell.document.listeners.length, 1);

	dispatchKeydown(shell.document, createFakeEvent());
	assert.equal(shell.state.settingsOpen, true);

	ctx.effects[0].dispose();
	assert.equal(shell.document.listeners.length, 0, "effect disposal removes the listener");
});

test("the generated client bundle stays free of imports, requires, localized text, and polling", () => {
	const source = readFileSync(BUILT_CLIENT, "utf8");
	assert.equal(/^[ \t]*import[\s{*"']/mu.test(source), false, "no imports");
	assert.equal(/\brequire[ \t]*\(/u.test(source), false, "no runtime dependency reference");
	assert.equal(/textContent|innerText|innerHTML|aria-label/u.test(source), false, "no localized or rendered text lookup");
	assert.equal(/setInterval|requestAnimationFrame/u.test(source), false, "no polling");
	assert.equal(/_react|ReactDOM|__reactFiber/u.test(source), false, "no private React state");
	assert.equal(source.includes("window.__ModuleLoader__.load"), true, "registers through the module loader");
	assert.equal(/setTimeout\(/u.test(source), true, "the bounded deadline is the only timer");
});

test("published selectors are exactly the ones the shipped shells render", () => {
	const source = readFileSync(BUILT_CLIENT, "utf8");
	for (const selector of [
		SETTINGS_LAUNCHER_SELECTOR,
		SETTINGS_TRIGGER_SELECTOR,
		SETTINGS_TRIGGER_SLOT_ANCHOR,
		SETTINGS_HEADER_SLOT_ANCHOR,
		SETTINGS_DIALOG_SELECTOR
	]) {
		assert.equal(source.includes(selector), true, `the artifact must carry ${selector}`);
	}
	assert.equal(SETTINGS_LAUNCHER_SELECTOR, '[data-slot="settings.launcher"] button[aria-haspopup="menu"][aria-expanded]');
	assert.equal(SETTINGS_DIALOG_SELECTOR, '[role="dialog"][aria-modal="true"]');
});

/* ------------------------------------------------------------------ *
 * Read-only regression check against the installed DSH client artifacts
 * ------------------------------------------------------------------ */

const APP_CLIENT_ROOT = "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai";
const INSTALLED_ARTIFACTS = [
	{ name: "settings-account", path: join(APP_CLIENT_ROOT, "dsh-client-ui-settings-account/lib/client.js") },
	{ name: "settings-general", path: join(APP_CLIENT_ROOT, "dsh-client-ui-settings-general/lib/client.js") },
	{ name: "renderer", path: join(APP_CLIENT_ROOT, "dsh-client-ui-renderer/lib/client.js") }
];
const MISSING_INSTALLED_ARTIFACTS = INSTALLED_ARTIFACTS.filter((artifact) => existsSync(artifact.path) === false);

test(
	"the installed DSH client still renders the launcher, the menu row, and the slot anchors this plugin relies on",
	{
		skip:
			MISSING_INSTALLED_ARTIFACTS.length > 0
				? `installed DSH client artifacts are unavailable (${MISSING_INSTALLED_ARTIFACTS.map((artifact) => artifact.name).join(", ")}); run this check on a machine with DSH Desktop installed`
				: false
	},
	() => {
		const [account, general, renderer] = INSTALLED_ARTIFACTS.map((artifact) => readFileSync(artifact.path, "utf8"));

		// settings-account provides the launcher entry whose FIRST menu row is Settings.
		assert.match(account, /slots\.inject\("settings\.launcher"/u);
		const itemsIndex = account.indexOf("items: [");
		const settingsIndex = account.indexOf('id: "settings"');
		assert.notEqual(itemsIndex, -1, "the account menu must declare an items array");
		assert.notEqual(settingsIndex, -1, "the account menu must declare the settings row");
		assert.ok(itemsIndex < settingsIndex, "the settings row must be declared inside the items array");
		assert.equal(/id: "/u.test(account.slice(itemsIndex, settingsIndex)), false, "the settings row must be the FIRST row");

		// settings-general renders the launcher slot with the dialog-button fallback.
		assert.match(general, /renderSlot\("settings\.launcher"/u);
		assert.match(general, /"aria-haspopup": "dialog"/u);
		assert.match(general, /renderSlot\("settings\.trigger"/u);
		assert.match(general, /renderSlot\("settings\.header"/u);

		// The renderer anchors every slot in the DOM, which is what the selectors match.
		assert.match(renderer, /"data-slot": slotKey/u);
	}
);
