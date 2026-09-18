/**
 * Behavior tests for the Cmd+, browser half.
 *
 * Everything runs against fake document/button/event objects (and, for the
 * artifact test, a `node:vm` sandbox), so the suite never needs a running GUI,
 * never touches the live DSH installation, and never writes outside this
 * checkout.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import {
	SETTINGS_TRIGGER_SELECTOR,
	SETTINGS_TRIGGER_SLOT_ANCHOR,
	carriesSettingsSlotAnchor,
	collectCollapsedTriggers,
	findCollapsedTrigger,
	handleKeydown,
	installSettingsShortcut,
	isSettingsShortcut,
	isVisibleTrigger,
	name as clientPluginName
} from "../src/client.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Build a fake Settings trigger button.
 * @param options - overrides for the shipped markup (`aria-expanded` default "false").
 * @returns a fake button recording clicks.
 */
function createFakeButton(options = {}) {
	const attributes = new Map();
	attributes.set("aria-haspopup", "dialog");
	attributes.set("aria-expanded", options.expanded ?? "false");
	if (options.hiddenAttribute === true) attributes.set("hidden", "");
	if (options.ariaHidden === true) attributes.set("aria-hidden", "true");
	const button = {
		clicks: 0,
		hidden: options.hidden === true,
		disabled: options.disabled === true,
		queriedSelectors: [],
		style: { display: options.display ?? "", visibility: options.visibility ?? "" },
		getAttribute(attributeName) {
			return attributes.has(attributeName) ? attributes.get(attributeName) : null;
		},
		querySelector(selector) {
			button.queriedSelectors.push(selector);
			return options.slotAnchor === true && selector === SETTINGS_TRIGGER_SLOT_ANCHOR ? {} : null;
		},
		click() {
			button.clicks += 1;
		}
	};
	if (options.checkVisibility !== undefined) button.checkVisibility = () => options.checkVisibility;
	return button;
}

/**
 * Build a fake document.
 * @param buttons - candidates `querySelectorAll` returns.
 * @param options - `result` overrides the returned node list.
 * @returns a fake document recording queries and listeners.
 */
function createFakeDocument(buttons = [], options = {}) {
	const document = {
		queries: [],
		listeners: [],
		querySelectorAll(selector) {
			document.queries.push(selector);
			return options.result === undefined ? buttons : options.result;
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
 * Build a fake keydown event.
 * @param overrides - event field overrides (defaults are unmodified Cmd+,).
 * @returns a fake event recording default prevention.
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
 * @param document - the fake document.
 * @param event - the fake event.
 */
function dispatchKeydown(document, event) {
	for (const entry of [...document.listeners]) if (entry.type === "keydown") entry.listener(event);
}

/**
 * Materialize the generated client bundle inside a fresh VM context.
 * @param document - the fake document exposed as the sandbox `document`.
 * @returns the materialized plugin module plus its Loader registrations.
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
	runInNewContext(readFileSync(join(ROOT, "lib/client.js"), "utf8"), sandbox, {
		filename: join(ROOT, "lib/client.js")
	});
	assert.equal(registrations.length, 1);
	const plugin = registrations[0].factory((specifier) => {
		throw new Error(`the client half must not require "${specifier}"`);
	});
	return plugin;
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
	assert.equal(isSettingsShortcut(createFakeEvent({ key: "", code: "" })), false, "no key information");
	assert.equal(isSettingsShortcut(null), false);
	assert.equal(isSettingsShortcut(undefined), false);
	assert.equal(isSettingsShortcut("Comma"), false);
});

test("a collapsed Settings trigger is clicked with default prevention and propagation stop", () => {
	const trigger = createFakeButton();
	const document = createFakeDocument([trigger]);
	const event = createFakeEvent();
	assert.equal(handleKeydown(event, document), true);
	assert.equal(event.prevented, 1);
	assert.equal(event.stopped, 1);
	assert.equal(trigger.clicks, 1);
	assert.deepEqual(document.queries, [SETTINGS_TRIGGER_SELECTOR]);
});

test("an already-expanded dialog is never toggled closed", () => {
	const expanded = createFakeButton({ expanded: "true" });
	const document = createFakeDocument([expanded]);
	const event = createFakeEvent();
	assert.equal(handleKeydown(event, document), true, "the gesture is still claimed");
	assert.equal(event.prevented, 1);
	assert.equal(event.stopped, 1);
	assert.equal(expanded.clicks, 0);
});

test("only a collapsed trigger is clicked when several candidates exist", () => {
	const hidden = createFakeButton({ hidden: true });
	const expanded = createFakeButton({ expanded: "true" });
	const collapsed = createFakeButton();
	const document = createFakeDocument([hidden, expanded, collapsed]);
	const event = createFakeEvent();
	assert.equal(handleKeydown(event, document), true);
	assert.equal(hidden.clicks, 0);
	assert.equal(expanded.clicks, 0);
	assert.equal(collapsed.clicks, 1);
});

test("the Settings shell trigger wins over other collapsed dialog triggers in the shell", () => {
	// Same accessibility markup appears on the context meter and the usage
	// pills; only the Settings trigger carries the Settings slot anchor.
	const contextMeter = createFakeButton();
	const settingsTrigger = createFakeButton({ slotAnchor: true });
	const document = createFakeDocument([contextMeter, settingsTrigger]);
	assert.equal(handleKeydown(createFakeEvent(), document), true);
	assert.equal(contextMeter.clicks, 0, "unrelated dialog trigger untouched");
	assert.equal(settingsTrigger.clicks, 1);
	assert.deepEqual(document.queries, [SETTINGS_TRIGGER_SELECTOR]);
	assert.deepEqual(settingsTrigger.queriedSelectors, [SETTINGS_TRIGGER_SLOT_ANCHOR]);
	assert.equal(carriesSettingsSlotAnchor(settingsTrigger), true);
	assert.equal(carriesSettingsSlotAnchor(contextMeter), false);
});

test("candidate selection falls back to document order when no anchor is present", () => {
	const first = createFakeButton();
	const second = createFakeButton();
	assert.deepEqual(collectCollapsedTriggers(createFakeDocument([first, second])), [first, second]);
	assert.equal(findCollapsedTrigger(createFakeDocument([first, second])), first);
	const clickDocument = createFakeDocument([first, second]);
	assert.equal(handleKeydown(createFakeEvent(), clickDocument), true);
	assert.equal(first.clicks, 1);
	assert.equal(second.clicks, 0);
	assert.deepEqual(clickDocument.queries, [SETTINGS_TRIGGER_SELECTOR]);
});

test("a missing trigger clicks nothing and never throws", () => {
	const emptyDocument = createFakeDocument([]);
	const emptyEvent = createFakeEvent();
	assert.equal(handleKeydown(emptyEvent, emptyDocument), true);
	assert.equal(emptyEvent.prevented, 1);
	assert.deepEqual(emptyDocument.queries, [SETTINGS_TRIGGER_SELECTOR]);

	const returningNull = createFakeDocument([], { result: null });
	assert.equal(handleKeydown(createFakeEvent(), returningNull), true);
	assert.equal(handleKeydown(createFakeEvent(), null), true);
	assert.equal(handleKeydown(createFakeEvent(), {}), true);
	assert.equal(findCollapsedTrigger(undefined), null);
});

test("non-matching gestures never query the document or touch the event", () => {
	const trigger = createFakeButton();
	const document = createFakeDocument([trigger]);
	const event = createFakeEvent({ shiftKey: true });
	assert.equal(handleKeydown(event, document), false);
	assert.equal(event.prevented, 0);
	assert.equal(event.stopped, 0);
	assert.equal(trigger.clicks, 0);
	assert.deepEqual(document.queries, []);
});

test("invisible or unusable candidates are skipped", () => {
	const cases = [
		["hidden attribute", createFakeButton({ hiddenAttribute: true })],
		["hidden property", createFakeButton({ hidden: true })],
		["aria-hidden", createFakeButton({ ariaHidden: true })],
		["display:none", createFakeButton({ display: "none" })],
		["visibility:hidden", createFakeButton({ visibility: "hidden" })],
		["visibility:collapse", createFakeButton({ visibility: "collapse" })],
		["disabled", createFakeButton({ disabled: true })],
		["checkVisibility() false", createFakeButton({ checkVisibility: false })]
	];
	for (const [label, candidate] of cases) {
		assert.equal(isVisibleTrigger(candidate), false, label);
		assert.equal(findCollapsedTrigger(createFakeDocument([candidate])), null, label);
	}
	const visible = createFakeButton();
	assert.equal(isVisibleTrigger(visible), true);
	assert.equal(isVisibleTrigger(createFakeButton({ checkVisibility: true })), true);
	assert.equal(findCollapsedTrigger(createFakeDocument([createFakeButton({ disabled: true }), visible])), visible);
});

test("installation adds a capture-phase keydown listener and disposal removes it", () => {
	const trigger = createFakeButton();
	const document = createFakeDocument([trigger]);
	const dispose = installSettingsShortcut({ document });
	assert.equal(typeof dispose, "function");
	assert.equal(document.listeners.length, 1);
	assert.equal(document.listeners[0].type, "keydown");
	assert.equal(document.listeners[0].capture, true, "capture phase");

	dispatchKeydown(document, createFakeEvent());
	assert.equal(trigger.clicks, 1);

	dispose();
	assert.equal(document.listeners.length, 0, "disposal detaches the listener");
	const afterDispose = createFakeEvent();
	dispatchKeydown(document, afterDispose);
	assert.equal(trigger.clicks, 1, "no handling after disposal");
	assert.equal(afterDispose.prevented, 0);
});

test("installation without a usable document reports null instead of throwing", () => {
	assert.equal(installSettingsShortcut({ document: null }), null);
	assert.equal(installSettingsShortcut({ document: {} }), null);
	assert.equal(installSettingsShortcut(undefined), null);
	assert.equal(installSettingsShortcut({}), null);
});

test("the generated client bundle installs the shortcut through a Cordis effect", () => {
	const trigger = createFakeButton();
	const document = createFakeDocument([trigger]);
	const plugin = loadBuiltClientModule(document);
	assert.equal(plugin.name, clientPluginName);
	assert.equal(typeof plugin.apply, "function");

	const ctx = createFakeCordisContext();
	plugin.apply(ctx);
	assert.equal(ctx.effects.length, 1);
	assert.equal(ctx.effects[0].label, "dsh-macos-settings-shortcut: keydown listener");
	assert.equal(document.listeners.length, 1);
	assert.equal(document.listeners[0].capture, true);

	dispatchKeydown(document, createFakeEvent());
	assert.equal(trigger.clicks, 1);

	ctx.effects[0].dispose();
	assert.equal(document.listeners.length, 0, "effect disposal removes the listener");
});

test("the generated client bundle stays free of localized text, timers, and private React state", () => {
	const source = readFileSync(join(ROOT, "lib/client.js"), "utf8");
	assert.equal(/textContent|innerText|innerHTML|aria-label/u.test(source), false, "no localized or rendered text lookup");
	assert.equal(/setTimeout|setInterval|requestAnimationFrame/u.test(source), false, "no polling or deferred retry");
	assert.equal(/_react|ReactDOM|__reactFiber/u.test(source), false, "no private React state");
	assert.equal(/^[ \t]*import[\s{*"']/mu.test(source), false, "no imports");
	assert.equal(/\brequire[ \t]*\(/u.test(source), false, "no runtime dependency reference");
});
