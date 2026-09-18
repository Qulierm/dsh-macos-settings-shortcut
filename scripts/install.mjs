#!/usr/bin/env node
/**
 * Narrow, auditable installer for the `dsh-macos-settings-shortcut` bundle in
 * a local DSH profile.
 *
 * Why this exists: the official desktop CLI reconciles profile bundles, but it
 * intentionally refuses to operate on the desktop profile. Rather than editing
 * application files (which a signed bundle, and the next app update, would
 * both reject), this script performs exactly the two profile-local mutations a
 * bundle needs:
 *
 *   1. `pnpm add link:<absolute checkout path>` run from the profile directory,
 *      so pnpm owns node_modules and the profile lockfile; and
 *   2. appending `dsh-macos-settings-shortcut` to `dsh.profile.bundles` in the
 *      profile's package.json, and only when it is absent.
 *
 * It never writes to /Applications (or any application bundle), never touches
 * settings.yaml, credentials, or sessions, and never rewrites unrelated
 * profile fields. `--dry-run` prints the whole plan without writing anything.
 *
 * Usage:
 *   node scripts/install.mjs --dry-run [--profile desktop] [--dsh-home <path>]
 *   node scripts/install.mjs           [--profile desktop] [--dsh-home <path>]
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	DEFAULT_PROFILE_NAME,
	InstallPlanError,
	PACKAGE_ID,
	assertPlainManifest,
	describePlan,
	isInsideDirectory,
	planInstallation,
	planProfileTarget,
	resolveDshHome,
	withBundleAppended
} from "./lib/profile-plan.mjs";

/** Absolute path of this checkout (the package that gets linked). */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Files that must exist before this bundle may be registered anywhere. */
const REQUIRED_BUILD_ARTIFACTS = ["package.json", "cordis.patch.yml", "lib/index.js", "lib/client.js"];

const USAGE = [
	"Usage: node scripts/install.mjs [options]",
	"",
	"Options:",
	"  --profile <name>   profile to register the bundle in (default: desktop)",
	"  --dsh-home <path>  DSH home directory (default: $DSH_HOME or ~/.dsh)",
	"  --dry-run          print the planned changes without writing anything",
	"  --pnpm <path>      pnpm executable to invoke (default: pnpm on PATH)",
	"  -h, --help         show this message",
	"",
	`Only <dsh-home>/profiles/<profile>/package.json and the pnpm-managed files`,
	`in that profile directory are ever written.`
].join("\n");

/**
 * Read one option value, accepting both `--flag value` and `--flag=value`.
 * @param argv - raw arguments.
 * @param index - index of the flag.
 * @param flag - the flag name.
 * @param inlineValue - value from the `=` form, when present.
 * @returns `{ value, consumed }` where `consumed` counts extra arguments used.
 */
function takeOptionValue(argv, index, flag, inlineValue) {
	if (inlineValue !== undefined) {
		if (inlineValue.length === 0) throw new InstallPlanError(`${flag} requires a value`);
		return { value: inlineValue, consumed: 0 };
	}
	const next = argv[index + 1];
	if (next === undefined || next.startsWith("--")) throw new InstallPlanError(`${flag} requires a value`);
	return { value: next, consumed: 1 };
}

/**
 * Parse command-line arguments.
 * @param argv - `process.argv.slice(2)`.
 * @returns the parsed options.
 * @throws {InstallPlanError} on unknown flags or missing values.
 */
function parseArguments(argv) {
	const options = { profile: DEFAULT_PROFILE_NAME, dshHome: undefined, dryRun: false, pnpm: "pnpm", help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (argument === "--help" || argument === "-h") {
			options.help = true;
			continue;
		}
		const equals = argument.indexOf("=");
		const flag = equals === -1 ? argument : argument.slice(0, equals);
		const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1);
		if (flag === "--profile") {
			const taken = takeOptionValue(argv, index, flag, inlineValue);
			options.profile = taken.value;
			index += taken.consumed;
			continue;
		}
		if (flag === "--dsh-home") {
			const taken = takeOptionValue(argv, index, flag, inlineValue);
			options.dshHome = taken.value;
			index += taken.consumed;
			continue;
		}
		if (flag === "--pnpm") {
			const taken = takeOptionValue(argv, index, flag, inlineValue);
			options.pnpm = taken.value;
			index += taken.consumed;
			continue;
		}
		throw new InstallPlanError(`unknown argument "${argument}"`);
	}
	return options;
}

/**
 * Assert that a path exists and is a directory.
 * @param path - path to check.
 * @param label - human-readable subject for diagnostics.
 */
function assertDirectory(path, label) {
	if (existsSync(path) === false) throw new InstallPlanError(`${label} does not exist: ${path}`);
	if (statSync(path).isDirectory() === false) throw new InstallPlanError(`${label} is not a directory: ${path}`);
}

/**
 * Resolve both profile and profiles-root through symlinks and re-check
 * containment, so a symlinked profile directory cannot redirect the install.
 * @param profilesRoot - `<dsh-home>/profiles`.
 * @param profileDir - `<dsh-home>/profiles/<profile>`.
 * @returns `{ realProfilesRoot, realProfileDir }`.
 */
function assertRealPathContainment(profilesRoot, profileDir) {
	const realProfilesRoot = realpathSync(profilesRoot);
	const realProfileDir = realpathSync(profileDir);
	if (isInsideDirectory(realProfilesRoot, realProfileDir) === false) {
		throw new InstallPlanError(`profile directory resolves outside ${realProfilesRoot}: ${realProfileDir}`);
	}
	return { realProfilesRoot, realProfileDir };
}

/**
 * Assert this checkout is built, so the profile never links a half-built bundle.
 * (A missing client half would only surface as a client-composition error at
 * the next GUI launch.)
 */
function assertBundleBuilt() {
	for (const relativePath of REQUIRED_BUILD_ARTIFACTS) {
		if (existsSync(join(PACKAGE_ROOT, relativePath)) === false) {
			throw new InstallPlanError(
				`this checkout is not built: ${relativePath} is missing — run \`pnpm run build\` first`
			);
		}
	}
}

/**
 * Read and parse the profile manifest.
 * @param packageJsonPath - absolute path of the profile package.json.
 * @returns the parsed manifest.
 * @throws {InstallPlanError} when missing, unreadable, or not a JSON object.
 */
function readManifest(packageJsonPath) {
	if (existsSync(packageJsonPath) === false) {
		throw new InstallPlanError(`profile manifest not found: ${packageJsonPath}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	} catch (error) {
		throw new InstallPlanError(`profile manifest is not valid JSON: ${error.message}`);
	}
	return assertPlainManifest(parsed, "profile package.json");
}

/**
 * Write the manifest through a temporary file plus rename, so an interrupted
 * run can never leave a truncated package.json behind.
 * @param packageJsonPath - absolute path of the profile package.json.
 * @param manifest - manifest to serialize.
 */
function writeManifestAtomically(packageJsonPath, manifest) {
	const temporaryPath = `${packageJsonPath}.dsh-settings-shortcut.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		renameSync(temporaryPath, packageJsonPath);
	} catch (error) {
		if (existsSync(temporaryPath)) {
			try {
				unlinkSync(temporaryPath);
			} catch {
				// best effort cleanup only
			}
		}
		throw new InstallPlanError(`cannot write ${packageJsonPath}: ${error.message}`);
	}
}

/**
 * Run `pnpm add link:<checkout>` inside the profile directory.
 * @param options - `{ pnpm, profileDir, linkSpec }`.
 * @returns the child process result.
 */
function runPnpmAdd(options) {
	process.stdout.write(`install: running ${options.pnpm} add ${options.linkSpec} (cwd ${options.profileDir})\n`);
	return spawnSync(options.pnpm, ["add", options.linkSpec], { cwd: options.profileDir, stdio: "inherit" });
}

/**
 * Re-read the profile and report whether the bundle is registered and linked.
 * @param options - `{ packageJsonPath, profileDir }`.
 * @returns `{ problems, notes, summary }` for the final report.
 */
function verifyInstallation(options) {
	const problems = [];
	const notes = [];
	const manifest = readManifest(options.packageJsonPath);
	const dependency = manifest.dependencies === undefined ? undefined : manifest.dependencies[PACKAGE_ID];
	const bundles = manifest.dsh?.profile?.bundles;
	if (dependency === undefined) problems.push(`dependencies.${PACKAGE_ID} is missing from the profile manifest`);
	if (Array.isArray(bundles) === false || bundles.includes(PACKAGE_ID) === false) {
		problems.push(`dsh.profile.bundles does not list ${PACKAGE_ID}`);
	}
	const modulePath = join(options.profileDir, "node_modules", PACKAGE_ID);
	if (existsSync(modulePath) === false) {
		problems.push(`node_modules/${PACKAGE_ID} is missing in the profile`);
	} else {
		const resolved = realpathSync(modulePath);
		if (resolved !== realpathSync(PACKAGE_ROOT)) {
			notes.push(`node_modules/${PACKAGE_ID} resolves to ${resolved} (expected ${realpathSync(PACKAGE_ROOT)})`);
		}
	}
	return {
		problems,
		notes,
		summary: [
			`dependency:     ${dependency === undefined ? "<missing>" : dependency}`,
			`bundles:        ${Array.isArray(bundles) ? bundles.join(", ") : "<missing>"}`,
			`node_modules:   ${modulePath}`
		]
	};
}

/** Entry point. */
function main() {
	const options = parseArguments(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(`${USAGE}\n`);
		return;
	}

	const dshHome = resolveDshHome(options.dshHome, process.env, homedir());
	const target = planProfileTarget({ dshHome, profileName: options.profile });

	assertBundleBuilt();
	assertDirectory(target.profilesRoot, "profiles directory");
	assertDirectory(target.profileDir, "profile directory");
	const { realProfilesRoot, realProfileDir } = assertRealPathContainment(target.profilesRoot, target.profileDir);
	const manifest = readManifest(target.packageJsonPath);
	const plan = planInstallation({
		manifest,
		packageRoot: PACKAGE_ROOT,
		profileName: options.profile,
		dshHome
	});

	process.stdout.write(`install: dsh home ${target.dshHome}\n`);
	process.stdout.write(`install: profiles root ${realProfilesRoot}\n`);
	process.stdout.write(`install: profile directory ${realProfileDir}\n`);
	for (const line of describePlan(plan)) process.stdout.write(`install: ${line}\n`);
	process.stdout.write("install: the signed application bundle is never read, written, or patched\n");

	if (options.dryRun) {
		process.stdout.write("install: dry run — nothing was written\n");
		return;
	}

	if (plan.dependencyNeedsInstall) {
		const result = runPnpmAdd({ pnpm: options.pnpm, profileDir: target.profileDir, linkSpec: plan.linkSpec });
		if (result.error !== undefined) throw new InstallPlanError(`cannot run ${options.pnpm}: ${result.error.message}`);
		if (result.status !== 0) {
			throw new InstallPlanError(`${options.pnpm} add exited with status ${String(result.status)}`);
		}
	} else {
		process.stdout.write(`install: dependency already present as ${plan.linkSpec}; skipping pnpm add\n`);
	}

	// Re-read: pnpm has just rewritten the manifest with the new dependency.
	const updated = readManifest(target.packageJsonPath);
	const appended = withBundleAppended(updated, PACKAGE_ID);
	if (appended === updated) {
		process.stdout.write(`install: ${PACKAGE_ID} is already listed in dsh.profile.bundles\n`);
	} else {
		writeManifestAtomically(target.packageJsonPath, appended);
		process.stdout.write(`install: appended ${PACKAGE_ID} to dsh.profile.bundles in ${target.packageJsonPath}\n`);
	}

	const verification = verifyInstallation({ packageJsonPath: target.packageJsonPath, profileDir: target.profileDir });
	for (const line of verification.summary) process.stdout.write(`install: ${line}\n`);
	for (const note of verification.notes) process.stdout.write(`install: warning: ${note}\n`);
	if (verification.problems.length > 0) {
		for (const problem of verification.problems) process.stderr.write(`install: ${problem}\n`);
		throw new InstallPlanError("profile verification failed");
	}
	process.stdout.write("install: profile registration verified; relaunch DeepSeek Harness to activate it\n");
}

try {
	main();
} catch (error) {
	if (error instanceof InstallPlanError) {
		process.stderr.write(`install: ${error.message}\n`);
		process.stderr.write(`install: nothing was installed\n`);
		process.exitCode = 1;
	} else {
		throw error;
	}
}
