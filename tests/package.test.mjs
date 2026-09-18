/**
 * Package-foundation tests: bundle metadata, the Cordis patch layer, and the
 * generated Loader artifacts.
 *
 * These tests never touch the live DSH installation: every subject is read
 * from this checkout, and the client half is executed inside a `node:vm`
 * sandbox with a fake `window`, exactly like the app's own
 * `verify-client-loader` script does.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ID = "dsh-macos-settings-shortcut";

/** Read a UTF-8 file from the repository root. */
function readRootFile(relativePath) {
	return readFileSync(join(ROOT, relativePath), "utf8");
}

/** Parse package.json. */
function readManifest() {
	return JSON.parse(readRootFile("package.json"));
}

/**
 * Execute a generated client bundle in a sandbox with a fake module-loader
 * `window`, returning every registration it performed.
 * @param relativePath - bundle path relative to the repository root.
 * @returns the captured `load` calls.
 */
function captureLoaderRegistrations(relativePath) {
	const registrations = [];
	const window = {
		__ModuleLoader__: {
			load(registration) {
				registrations.push(registration);
			}
		}
	};
	runInNewContext(readRootFile(relativePath), { window }, { filename: join(ROOT, relativePath) });
	return registrations;
}

test("package.json declares the bundle patch, the web client half, and both entry points", () => {
	const manifest = readManifest();
	assert.equal(manifest.name, PACKAGE_ID);
	assert.equal(manifest.type, "module");
	assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
	assert.equal(manifest.dsh?.client?.platform, "web");
	assert.equal(manifest.exports?.["."]?.default, "./lib/index.js");
	assert.equal(manifest.exports?.["./client"], "./lib/client.js");
	assert.equal(manifest.main, "lib/index.js");
});

test("package.json has no runtime dependencies of any kind", () => {
	const manifest = readManifest();
	assert.equal(manifest.dependencies, undefined);
	assert.equal(manifest.devDependencies, undefined);
	assert.equal(manifest.peerDependencies, undefined);
	assert.equal(manifest.optionalDependencies, undefined);
});

test("cordis.patch.yml inserts exactly one no-op host row", () => {
	const meaningful = readRootFile("cordis.patch.yml")
		.split("\n")
		.filter((line) => line.trim().length > 0 && line.trim().startsWith("#") === false);
	assert.deepEqual(meaningful, [
		"- insert:",
		`    - id: ${PACKAGE_ID}`,
		`      name: ${PACKAGE_ID}`
	]);
});

test("lib/index.js is a host half with named exports", () => {
	const source = readRootFile("lib/index.js");
	assert.match(source, /^export \{ apply, inject, name \};$/mu);
});

test("lib/client.js registers the lazy CJS factory under the exact package id", () => {
	const source = readRootFile("lib/client.js");
	assert.match(source, /^window\.__ModuleLoader__\.load\(\{$/mu);
	const registrations = captureLoaderRegistrations("lib/client.js");
	assert.equal(registrations.length, 1);
	const [registration] = registrations;
	assert.equal(registration?.id, PACKAGE_ID);
	assert.equal(typeof registration?.factory, "function");
	const exported = registration.factory((specifier) => {
		throw new Error(`the client half must not require "${specifier}"`);
	});
	assert.equal(exported.name, PACKAGE_ID);
	assert.equal(typeof exported.apply, "function");
});

test("lib/client.js stays self-contained: no imports and no require() calls", () => {
	const source = readRootFile("lib/client.js");
	assert.equal(/^[ \t]*import[\s{*"']/mu.test(source), false, "client bundle must not import modules");
	assert.equal(/\brequire[ \t]*\(/u.test(source), false, "client bundle must not call require(...)");
	assert.equal(/\bfrom[ \t]+["'][^"']+["']/u.test(source), false, "client bundle must not use module specifiers");
});
