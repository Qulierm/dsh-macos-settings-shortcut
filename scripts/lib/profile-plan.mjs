/**
 * Pure validation and planning logic of the desktop-profile installer.
 *
 * Everything here is side-effect free: no filesystem, no process spawning, no
 * globals. `scripts/install.mjs` performs the I/O and calls into this module
 * for every decision, which is what makes the decision rules testable against
 * temporary fixtures (and against adversarial profile names).
 *
 * The plan this module produces is deliberately narrow. The installer may:
 *   1. run `pnpm add link:<absolute checkout path>` in the profile directory
 *      (pnpm owns node_modules and the profile lockfile), and
 *   2. append `dsh-macos-settings-shortcut` to `dsh.profile.bundles` in that
 *      profile's package.json when it is absent.
 * Nothing else in the profile is touched: settings, sessions, credentials,
 * other dependencies, other profile fields, and the signed application bundle
 * are never read as write targets, let alone modified.
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Package id of the bundle this installer registers. */
export const PACKAGE_ID = "dsh-macos-settings-shortcut";
/** Profile the installer targets unless `--profile` says otherwise. */
export const DEFAULT_PROFILE_NAME = "desktop";
/** Directory name of the DSH home under the user's home directory. */
export const DEFAULT_DSH_HOME_DIRECTORY = ".dsh";
/** `profiles` is the only directory this installer is ever allowed to write in. */
export const PROFILES_DIRECTORY = "profiles";
/** Profile names are single path segments: leading alphanumeric, then `[A-Za-z0-9._-]`. */
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
/** Upper bound on a profile name, so pathological input fails loudly. */
const PROFILE_NAME_MAX_LENGTH = 64;

/** Error type for every rejected input, so the CLI can print one clean line. */
export class InstallPlanError extends Error {
	constructor(message) {
		super(message);
		this.name = "InstallPlanError";
	}
}

/**
 * Validate a profile name as a single, safe path segment.
 *
 * Rejected: non-strings, empty/whitespace names, `.` and `..`, anything with a
 * path separator (or a Windows separator), absolute paths, names that would be
 * read as a command-line flag, names with control characters or shells-y
 * characters, and names that are too long.
 *
 * @param value - candidate profile name.
 * @returns the validated name.
 * @throws {InstallPlanError} when the name is not usable.
 */
export function validateProfileName(value) {
	if (typeof value !== "string") {
		throw new InstallPlanError(`profile name must be a string, received ${typeof value}`);
	}
	if (value.length === 0) throw new InstallPlanError("profile name must not be empty");
	if (value.length > PROFILE_NAME_MAX_LENGTH) {
		throw new InstallPlanError(`profile name must be at most ${String(PROFILE_NAME_MAX_LENGTH)} characters`);
	}
	if (value !== value.trim()) throw new InstallPlanError("profile name must not start or end with whitespace");
	if (value === "." || value === "..") throw new InstallPlanError(`profile name must not be "${value}"`);
	if (value.endsWith(".")) throw new InstallPlanError("profile name must not end with a dot");
	if (value.includes("/") || value.includes("\\")) {
		throw new InstallPlanError("profile name must not contain a path separator");
	}
	if (isAbsolute(value)) throw new InstallPlanError("profile name must not be an absolute path");
	if (value.startsWith("-")) throw new InstallPlanError("profile name must not start with a hyphen");
	if (PROFILE_NAME_PATTERN.test(value) === false) {
		throw new InstallPlanError(
			"profile name must start with a letter or digit and contain only letters, digits, dot, underscore, and hyphen"
		);
	}
	return value;
}

/**
 * True when `child` is a strict descendant of `parent` (both are resolved
 * purely, without touching the filesystem).
 * @param parent - containing directory.
 * @param child - candidate descendant.
 * @returns whether the containment holds.
 */
export function isInsideDirectory(parent, child) {
	const parentPath = resolve(parent);
	const childPath = resolve(child);
	const delta = relative(parentPath, childPath);
	if (delta.length === 0) return false;
	if (delta === "..") return false;
	if (delta.startsWith(`..${sep}`)) return false;
	return isAbsolute(delta) === false;
}

/**
 * Resolve the DSH home directory.
 * @param explicit - value of `--dsh-home`, when given.
 * @param environment - environment variables (defaults to `process.env`).
 * @param home - the user's home directory.
 * @returns the absolute DSH home path.
 * @throws {InstallPlanError} on a relative or empty explicit path.
 */
export function resolveDshHome(explicit, environment, home) {
	if (explicit !== undefined && explicit !== null) {
		if (typeof explicit !== "string" || explicit.length === 0) {
			throw new InstallPlanError("--dsh-home requires a non-empty path");
		}
		if (isAbsolute(explicit) === false) throw new InstallPlanError("--dsh-home must be an absolute path");
		return resolve(explicit);
	}
	const fromEnvironment = environment?.DSH_HOME;
	if (typeof fromEnvironment === "string" && fromEnvironment.length > 0) {
		if (isAbsolute(fromEnvironment) === false) throw new InstallPlanError("$DSH_HOME must be an absolute path");
		return resolve(fromEnvironment);
	}
	return join(home, DEFAULT_DSH_HOME_DIRECTORY);
}

/**
 * Resolve the profile target paths and assert containment inside
 * `<dshHome>/profiles`.
 * @param options - `{ dshHome, profileName }`.
 * @returns `{ profileName, dshHome, profilesRoot, profileDir, packageJsonPath }`.
 * @throws {InstallPlanError} when the name is unsafe or escapes the profiles root.
 */
export function planProfileTarget(options) {
	const profileName = validateProfileName(options.profileName);
	const dshHome = resolve(options.dshHome);
	const profilesRoot = join(dshHome, PROFILES_DIRECTORY);
	const profileDir = join(profilesRoot, profileName);
	if (isInsideDirectory(profilesRoot, profileDir) === false) {
		throw new InstallPlanError(`refusing to use a profile directory outside ${profilesRoot}`);
	}
	return {
		profileName,
		dshHome,
		profilesRoot,
		profileDir,
		packageJsonPath: join(profileDir, "package.json")
	};
}

/**
 * Assert that a parsed JSON value is a plain object manifest.
 * @param value - parsed JSON value.
 * @param label - human-readable subject used in diagnostics.
 * @returns the same value, typed as a record.
 * @throws {InstallPlanError} when the value is not a plain object.
 */
export function assertPlainManifest(value, label) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new InstallPlanError(`${label} must be a JSON object`);
	}
	return value;
}

/**
 * Plan the `dsh.profile.bundles` mutation for one manifest.
 * @param manifest - parsed profile package.json.
 * @param packageId - bundle id to ensure present.
 * @returns `{ changed, bundles }` where `bundles` is the resulting list.
 * @throws {InstallPlanError} when `dsh`, `dsh.profile`, or `bundles` have an unexpected shape.
 */
export function planBundleAppend(manifest, packageId = PACKAGE_ID) {
	assertPlainManifest(manifest, "profile package.json");
	const dsh = manifest.dsh;
	if (dsh !== undefined && (typeof dsh !== "object" || dsh === null || Array.isArray(dsh))) {
		throw new InstallPlanError("profile package.json field \"dsh\" must be an object");
	}
	const profile = dsh === undefined ? undefined : dsh.profile;
	if (profile !== undefined && (typeof profile !== "object" || profile === null || Array.isArray(profile))) {
		throw new InstallPlanError("profile package.json field \"dsh.profile\" must be an object");
	}
	const bundles = profile === undefined ? undefined : profile.bundles;
	if (bundles !== undefined && Array.isArray(bundles) === false) {
		throw new InstallPlanError("profile package.json field \"dsh.profile.bundles\" must be an array");
	}
	const current = bundles === undefined ? [] : [...bundles];
	const changed = current.includes(packageId) === false;
	return { changed, bundles: changed ? [...current, packageId] : current };
}

/**
 * Build a new manifest with the bundle id appended (input is never mutated).
 * @param manifest - parsed profile package.json.
 * @param packageId - bundle id to ensure present.
 * @returns the updated manifest (the same object when nothing changes).
 * @throws {InstallPlanError} when the manifest shape is unexpected.
 */
export function withBundleAppended(manifest, packageId = PACKAGE_ID) {
	const plan = planBundleAppend(manifest, packageId);
	if (plan.changed === false) return manifest;
	const dsh = { ...(manifest.dsh ?? {}) };
	const profile = { ...(dsh.profile ?? {}) };
	profile.bundles = plan.bundles;
	dsh.profile = profile;
	return { ...manifest, dsh };
}

/**
 * Absolute `link:` dependency spec for this checkout.
 * @param packageRoot - absolute path of the local package checkout.
 * @returns the spec pnpm stores in the profile manifest.
 * @throws {InstallPlanError} when the path is not absolute.
 */
export function linkSpecFor(packageRoot) {
	if (typeof packageRoot !== "string" || isAbsolute(packageRoot) === false) {
		throw new InstallPlanError("package checkout path must be absolute");
	}
	return `link:${resolve(packageRoot)}`;
}

/**
 * Plan one installation: what would be added, what would stay untouched.
 * @param options - `{ manifest, packageRoot, profileName, dshHome, packageId }`.
 * @returns a structured plan (dependency spec, bundle mutation, target paths).
 * @throws {InstallPlanError} on an invalid manifest or unsafe target.
 */
export function planInstallation(options) {
	const target = planProfileTarget({ dshHome: options.dshHome, profileName: options.profileName });
	const packageId = options.packageId ?? PACKAGE_ID;
	const manifest = assertPlainManifest(options.manifest, "profile package.json");
	const dependencies = manifest.dependencies;
	if (dependencies !== undefined && (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies))) {
		throw new InstallPlanError("profile package.json field \"dependencies\" must be an object");
	}
	const linkSpec = linkSpecFor(options.packageRoot);
	const currentDependency = dependencies === undefined ? undefined : dependencies[packageId];
	const bundle = planBundleAppend(manifest, packageId);
	return {
		packageId,
		target,
		linkSpec,
		currentDependency,
		dependencyNeedsInstall: currentDependency !== linkSpec,
		appendBundle: bundle.changed,
		bundlesAfter: bundle.bundles
	};
}

/**
 * Render a plan as printable lines (used by `--dry-run` and for the real run).
 * @param plan - a plan from {@link planInstallation}.
 * @returns one string per line, without trailing newlines.
 */
export function describePlan(plan) {
	return [
		`package:        ${plan.packageId}`,
		`profile dir:    ${plan.target.profileDir}`,
		`manifest:       ${plan.target.packageJsonPath}`,
		`dependency:     ${plan.linkSpec}${plan.dependencyNeedsInstall ? "" : " (already present)"}`,
		`bundle append:  ${plan.appendBundle ? "yes" : "no (already listed)"}`,
		`bundles after:  ${plan.bundlesAfter.join(", ")}`,
		"writes:         node_modules/ and the profile lockfile (through pnpm) plus dsh.profile.bundles only"
	];
}
