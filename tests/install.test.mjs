/**
 * Installer tests: pure validation/planning rules plus end-to-end runs of
 * `scripts/install.mjs` against temporary DSH-home fixtures.
 *
 * No test ever runs the installer against the real `~/.dsh`, and none of them
 * invokes real pnpm: the fixture flow uses a stub `pnpm` executable that
 * emulates exactly the two things pnpm does here (record the dependency in the
 * profile manifest and create the `node_modules` link), so the assertions can
 * check the resulting profile state precisely.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	DEFAULT_PROFILE_NAME,
	InstallPlanError,
	PACKAGE_ID,
	assertPlainManifest,
	isInsideDirectory,
	linkSpecFor,
	planBundleAppend,
	planInstallation,
	planProfileTarget,
	resolveDshHome,
	validateProfileName,
	withBundleAppended
} from "../scripts/lib/profile-plan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_SCRIPT = join(ROOT, "scripts/install.mjs");

/** Stub pnpm: records the invocation, records the dependency, creates the link. */
const FAKE_PNPM_SOURCE = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
if (process.env.FAKE_PNPM_LOG) {
	appendFileSync(process.env.FAKE_PNPM_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
}
if (argv[0] !== "add" || typeof argv[1] !== "string" || argv[1].startsWith("link:") === false) process.exit(3);
const manifestPath = join(process.cwd(), "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.dependencies = manifest.dependencies === undefined ? {} : manifest.dependencies;
manifest.dependencies["${PACKAGE_ID}"] = argv[1];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\\n");
const modules = join(process.cwd(), "node_modules");
mkdirSync(modules, { recursive: true });
const linkPath = join(modules, "${PACKAGE_ID}");
if (existsSync(linkPath)) rmSync(linkPath, { recursive: true, force: true });
symlinkSync(argv[1].slice("link:".length), linkPath, "dir");
process.exit(0);
`;

/**
 * Create a temporary DSH home with a desktop profile fixture.
 * @param options - `manifest` overrides the fixture manifest; `decoy` adds a sibling profile.
 * @returns the fixture root and paths used by the tests.
 */
function createFixtureDshHome(options = {}) {
	const root = mkdtempSync(join(tmpdir(), "dsh-settings-shortcut-"));
	const dshHome = join(root, ".dsh");
	const profileDir = join(dshHome, "profiles", "desktop");
	mkdirSync(profileDir, { recursive: true });
	const manifest = options.manifest ?? {
		name: "dsh-profile-desktop",
		private: true,
		dependencies: { "dsh-context": "0.53.3" },
		dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], patchReload: "live" } }
	};
	if (options.rawManifest !== undefined) {
		writeFileSync(join(profileDir, "package.json"), options.rawManifest, "utf8");
	} else {
		writeFileSync(join(profileDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	}
	if (options.decoy === true) {
		const decoyDir = join(dshHome, "profiles", "web");
		mkdirSync(decoyDir, { recursive: true });
		writeFileSync(join(decoyDir, "package.json"), '{\n  "name": "dsh-profile-web"\n}\n', "utf8");
	}
	const fakePnpmPath = join(root, "fake-pnpm");
	writeFileSync(fakePnpmPath, FAKE_PNPM_SOURCE, { mode: 0o755 });
	const logPath = join(root, "pnpm-calls.log");
	return { root, dshHome, profileDir, manifestPath: join(profileDir, "package.json"), fakePnpmPath, logPath };
}

/** Remove a fixture directory tree. */
function removeFixture(root) {
	rmSync(root, { recursive: true, force: true });
}

/**
 * Run the installer CLI.
 * @param fixture - fixture from {@link createFixtureDshHome}.
 * @param args - extra CLI arguments.
 * @returns the spawn result.
 */
function runInstaller(fixture, args) {
	const environment = { ...process.env, FAKE_PNPM_LOG: fixture.logPath };
	delete environment.DSH_HOME;
	return spawnSync(process.execPath, [INSTALL_SCRIPT, "--dsh-home", fixture.dshHome, ...args], {
		encoding: "utf8",
		env: environment
	});
}

/** Read the fixture manifest. */
function readFixtureManifest(fixture) {
	return JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
}

test("profile names are accepted only as single safe path segments", () => {
	assert.equal(validateProfileName("desktop"), "desktop");
	assert.equal(validateProfileName(DEFAULT_PROFILE_NAME), "desktop");
	assert.equal(validateProfileName("web"), "web");
	assert.equal(validateProfileName("my-profile_1.0"), "my-profile_1.0");
	assert.equal(validateProfileName("a1"), "a1");

	const rejected = [
		["", "empty"],
		["   ", "whitespace only"],
		[".", "current directory"],
		["..", "parent directory"],
		["../desktop", "traversal"],
		["profiles/desktop", "nested path"],
		["desktop/../web", "traversal with separator"],
		["/absolute/path/profiles/desktop", "absolute path"],
		["a\\b", "backslash separator"],
		["with space", "space"],
		["-flag", "leading hyphen"],
		[".dot", "leading dot"],
		["tab\there", "control character"],
		["dot.ted.", "trailing dot"],
		["x".repeat(65), "over-long name"],
		[null, "null"],
		[42, "number"],
		[{}, "object"]
	];
	for (const [name, label] of rejected) {
		assert.throws(() => validateProfileName(name), InstallPlanError, label);
	}
});

test("containment checks reject sibling, parent, and identical paths", () => {
	const root = "/Users/example/.dsh/profiles";
	assert.equal(isInsideDirectory(root, join(root, "desktop")), true);
	assert.equal(isInsideDirectory(root, join(root, "web")), true);
	assert.equal(isInsideDirectory(root, "/Users/example/.dsh/profiles-evil/desktop"), false);
	assert.equal(isInsideDirectory(root, "/Users/example/.dsh"), false);
	assert.equal(isInsideDirectory(root, root), false);
	assert.equal(isInsideDirectory(root, join(root, "..", "settings.yaml")), false);
});

test("the DSH home defaults to $DSH_HOME and then to ~/.dsh", () => {
	assert.equal(resolveDshHome(undefined, {}, "/Users/example"), "/Users/example/.dsh");
	assert.equal(resolveDshHome(undefined, { DSH_HOME: "/srv/dsh" }, "/Users/example"), "/srv/dsh");
	assert.equal(resolveDshHome("/tmp/custom", { DSH_HOME: "/srv/dsh" }, "/Users/example"), "/tmp/custom");
	assert.throws(() => resolveDshHome("relative/path", {}, "/Users/example"), InstallPlanError);
	assert.throws(() => resolveDshHome(undefined, { DSH_HOME: "relative" }, "/Users/example"), InstallPlanError);
});

test("escaped profile paths are rejected before any filesystem work", () => {
	assert.throws(
		() => planProfileTarget({ dshHome: "/Users/example/.dsh", profileName: "../web" }),
		InstallPlanError
	);
	assert.throws(
		() => planProfileTarget({ dshHome: "/Users/example/.dsh", profileName: "/etc" }),
		InstallPlanError
	);
	const target = planProfileTarget({ dshHome: "/Users/example/.dsh", profileName: "desktop" });
	assert.equal(target.profilesRoot, "/Users/example/.dsh/profiles");
	assert.equal(target.profileDir, "/Users/example/.dsh/profiles/desktop");
	assert.equal(target.packageJsonPath, "/Users/example/.dsh/profiles/desktop/package.json");
});

test("manifests must be plain JSON objects", () => {
	assert.deepEqual(assertPlainManifest({ name: "x" }, "fixture"), { name: "x" });
	for (const value of [null, [], "text", 7, true]) {
		assert.throws(() => assertPlainManifest(value, "fixture"), InstallPlanError);
	}
});

test("bundle planning is idempotent and creates missing containers", () => {
	const absent = planBundleAppend({ name: "p", dsh: { profile: { bundles: ["a"] } } });
	assert.equal(absent.changed, true);
	assert.deepEqual(absent.bundles, ["a", PACKAGE_ID]);

	const present = planBundleAppend({ name: "p", dsh: { profile: { bundles: ["a", PACKAGE_ID] } } });
	assert.equal(present.changed, false);
	assert.deepEqual(present.bundles, ["a", PACKAGE_ID]);

	const empty = planBundleAppend({ name: "p" });
	assert.equal(empty.changed, true);
	assert.deepEqual(empty.bundles, [PACKAGE_ID]);

	for (const manifest of [
		{ dsh: { profile: { bundles: "not-an-array" } } },
		{ dsh: { profile: "not-an-object" } },
		{ dsh: "not-an-object" },
		[]
	]) {
		assert.throws(() => planBundleAppend(manifest), InstallPlanError);
	}
});

test("appending a bundle preserves every other field and never mutates the input", () => {
	const manifest = {
		name: "dsh-profile-desktop",
		private: true,
		dependencies: { "dsh-context": "0.53.3" },
		dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"], patchReload: "live" }, extra: 7 },
		other: { keep: [1, 2, 3] }
	};
	const snapshot = JSON.parse(JSON.stringify(manifest));
	const updated = withBundleAppended(manifest);
	assert.deepEqual(manifest, snapshot, "input manifest is untouched");
	assert.deepEqual(updated.dsh.profile.bundles, ["@deepseek-ai/dsh-base", PACKAGE_ID]);
	assert.equal(updated.dsh.profile.patchReload, "live");
	assert.equal(updated.dsh.extra, 7);
	assert.deepEqual(updated.other, { keep: [1, 2, 3] });
	assert.deepEqual(updated.dependencies, { "dsh-context": "0.53.3" });
	assert.equal(withBundleAppended(updated), updated, "second application is a no-op");
});

test("installation planning reports the dependency spec and bundle mutation", () => {
	const manifest = { name: "p", dependencies: {}, dsh: { profile: { bundles: [] } } };
	const plan = planInstallation({
		manifest,
		packageRoot: ROOT,
		profileName: "desktop",
		dshHome: "/Users/example/.dsh"
	});
	assert.equal(plan.linkSpec, `link:${ROOT}`);
	assert.equal(linkSpecFor(ROOT), `link:${ROOT}`);
	assert.equal(plan.dependencyNeedsInstall, true);
	assert.equal(plan.appendBundle, true);
	assert.deepEqual(plan.bundlesAfter, [PACKAGE_ID]);
	assert.equal(plan.target.profileDir, "/Users/example/.dsh/profiles/desktop");

	const settled = planInstallation({
		manifest: { name: "p", dependencies: { [PACKAGE_ID]: `link:${ROOT}` }, dsh: { profile: { bundles: [PACKAGE_ID] } } },
		packageRoot: ROOT,
		profileName: "desktop",
		dshHome: "/Users/example/.dsh"
	});
	assert.equal(settled.dependencyNeedsInstall, false);
	assert.equal(settled.appendBundle, false);
	assert.throws(() => linkSpecFor("relative/path"), InstallPlanError);
});

test("dry run reports the plan against a fixture and writes nothing", () => {
	const fixture = createFixtureDshHome({ decoy: true });
	try {
		const before = readFileSync(fixture.manifestPath, "utf8");
		const decoy = readFileSync(join(fixture.dshHome, "profiles/web/package.json"), "utf8");
		const result = runInstaller(fixture, ["--profile", "desktop", "--dry-run", "--pnpm", fixture.fakePnpmPath]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /dry run — nothing was written/u);
		assert.match(result.stdout, new RegExp(`dependency:     link:${ROOT.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
		assert.match(result.stdout, /bundle append:  yes/u);
		assert.equal(readFileSync(fixture.manifestPath, "utf8"), before, "manifest untouched");
		assert.equal(readFileSync(join(fixture.dshHome, "profiles/web/package.json"), "utf8"), decoy, "sibling profile untouched");
		assert.equal(existsSync(join(fixture.profileDir, "node_modules")), false, "no node_modules written");
		assert.equal(existsSync(fixture.logPath), false, "pnpm was never invoked");
	} finally {
		removeFixture(fixture.root);
	}
});

test("a full fixture installation links the package and lists the bundle", () => {
	const fixture = createFixtureDshHome({ decoy: true });
	try {
		const result = runInstaller(fixture, ["--profile", "desktop", "--pnpm", fixture.fakePnpmPath]);
		assert.equal(result.status, 0, result.stderr);
		const calls = readFileSync(fixture.logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].argv, ["add", `link:${ROOT}`]);
		// The child reports a symlink-resolved cwd on macOS (/var -> /private/var).
		assert.equal(realpathSync(calls[0].cwd), realpathSync(fixture.profileDir), "pnpm runs from the profile directory");

		const manifest = readFixtureManifest(fixture);
		assert.equal(manifest.dependencies[PACKAGE_ID], `link:${ROOT}`);
		assert.equal(manifest.dependencies["dsh-context"], "0.53.3", "unrelated dependency preserved");
		assert.equal(manifest.dsh.profile.patchReload, "live", "unrelated profile field preserved");
		assert.deepEqual(manifest.dsh.profile.bundles, [
			"@deepseek-ai/dsh-base",
			"@deepseek-ai/dsh-web-app",
			PACKAGE_ID
		]);
		assert.equal(manifest.name, "dsh-profile-desktop");
		assert.equal(readFileSync(join(fixture.dshHome, "profiles/web/package.json"), "utf8"), '{\n  "name": "dsh-profile-web"\n}\n');
		assert.match(result.stdout, /profile registration verified/u);

		// Second run: idempotent, no second pnpm call, no duplicated bundle entry.
		const second = runInstaller(fixture, ["--profile", "desktop", "--pnpm", fixture.fakePnpmPath]);
		assert.equal(second.status, 0, second.stderr);
		assert.match(second.stdout, /already listed in dsh\.profile\.bundles/u);
		assert.match(second.stdout, /skipping pnpm add/u);
		assert.equal(readFileSync(fixture.logPath, "utf8").trim().split("\n").length, 1, "no extra pnpm call");
		const settled = readFixtureManifest(fixture);
		assert.deepEqual(settled.dsh.profile.bundles.filter((entry) => entry === PACKAGE_ID), [PACKAGE_ID]);
	} finally {
		removeFixture(fixture.root);
	}
});

test("the installer refuses unsafe profiles, escaped symlinks, and broken manifests", () => {
	const fixture = createFixtureDshHome();
	try {
		const before = readFileSync(fixture.manifestPath, "utf8");

		const traversal = runInstaller(fixture, ["--profile", "../web", "--dry-run"]);
		assert.equal(traversal.status, 1);
		assert.match(traversal.stderr, /path separator|must not/u);

		const sibling = runInstaller(fixture, ["--profile", "web", "--dry-run"]);
		assert.equal(sibling.status, 1);
		assert.match(sibling.stderr, /profile directory does not exist/u);

		const unknown = runInstaller(fixture, ["--profile", "desktop", "--dry-run", "--launch"]);
		assert.equal(unknown.status, 1);
		assert.match(unknown.stderr, /unknown argument/u);

		assert.equal(readFileSync(fixture.manifestPath, "utf8"), before, "manifest untouched by rejected runs");
	} finally {
		removeFixture(fixture.root);
	}

	const escaped = createFixtureDshHome();
	try {
		const outside = join(escaped.root, "outside-profile");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "package.json"), '{\n  "name": "outside"\n}\n', "utf8");
		rmSync(join(escaped.dshHome, "profiles", "desktop"), { recursive: true, force: true });
		symlinkSync(outside, join(escaped.dshHome, "profiles", "desktop"), "dir");
		const result = runInstaller(escaped, ["--profile", "desktop", "--dry-run"]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /resolves outside/u);
		assert.equal(readFileSync(join(outside, "package.json"), "utf8"), '{\n  "name": "outside"\n}\n');
	} finally {
		removeFixture(escaped.root);
	}

	const broken = createFixtureDshHome({ rawManifest: "[1, 2, 3]\n" });
	try {
		const result = runInstaller(broken, ["--profile", "desktop", "--dry-run"]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /must be a JSON object/u);
	} finally {
		removeFixture(broken.root);
	}

	const invalid = createFixtureDshHome({ rawManifest: "{ not json" });
	try {
		const result = runInstaller(invalid, ["--profile", "desktop", "--dry-run"]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /not valid JSON/u);
	} finally {
		removeFixture(invalid.root);
	}
});
