#!/usr/bin/env node
/**
 * Assert that the npm archive contains exactly the declared runtime payload.
 *
 * `package.json` declares `files: ["lib", "cordis.patch.yml", "README.md",
 * "LICENSE"]`, so publishing this package must ship the two generated runtime
 * artifacts, the DSH bundle patch, and the documentation — and nothing else.
 * Source, tests, the installer scripts, the lockfile, node_modules, and the
 * workflow configuration belong to Git, not to the tarball.
 *
 * Usage:
 *   node scripts/verify-archive.mjs                 # runs `npm pack --dry-run --json` itself
 *   node scripts/verify-archive.mjs <report.json>   # checks an existing pack report
 *
 * The command is offline: `npm pack --dry-run` inspects the local package and
 * never contacts a registry. Whatever `NPM_CONFIG_CACHE` points at is used by
 * the spawned npm; the script never changes that setting, so an isolated cache
 * (for example `<checkout>/node_modules/.npm-cache`) keeps the machine-global
 * cache untouched.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, derived from this script's location. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Files the published archive must contain, exactly. */
const EXPECTED_FILES = ["LICENSE", "README.md", "cordis.patch.yml", "lib/client.js", "lib/index.js", "package.json"];

/**
 * Additional files npm is allowed to generate on its own during packing.
 * Nothing else may appear: an unexpected entry is a packaging mistake, and a
 * missing expected entry is a broken release.
 */
const ALLOWED_NPM_GENERATED_FILES = ["npm-shrinkwrap.json"];

/**
 * Path categories that must never ship, each with the reason it stays in Git.
 * Anything outside `EXPECTED_FILES` already fails the check; these patterns
 * exist so the failure names the category instead of the bare path.
 */
const FORBIDDEN_PATTERNS = [
	{ pattern: /^src\//u, reason: "source stays in Git; only the built artifacts ship" },
	{ pattern: /^tests\//u, reason: "tests stay in Git" },
	{ pattern: /^scripts\//u, reason: "build and installer scripts stay in Git" },
	{ pattern: /^node_modules\//u, reason: "installed dependencies are never packed" },
	{ pattern: /^\.github\//u, reason: "workflow configuration stays in Git" },
	{ pattern: /^pnpm-lock\.yaml$/u, reason: "the workspace lockfile stays in Git" },
	{ pattern: /\.tmp$/u, reason: "installer temporary files are local state, not content" }
];

/**
 * Extract the JSON report from `npm pack --dry-run --json` output.
 *
 * Lifecycle scripts (`prepack`) write to the same stdout stream as the report,
 * so the report is the LAST top-level JSON array in the output.
 * @param stdout - raw stdout of the pack command.
 * @returns the parsed report array.
 */
function extractPackReport(stdout) {
	const trimmed = stdout.trim();
	if (trimmed.startsWith("[")) return JSON.parse(trimmed);
	const index = stdout.lastIndexOf("\n[");
	if (index !== -1) {
		try {
			return JSON.parse(stdout.slice(index + 1));
		} catch {
			// fall through to the explicit error below
		}
	}
	throw new Error(
		`could not find the npm pack JSON report in the command output (last 200 characters: ${JSON.stringify(stdout.slice(-200))})`
	);
}

/**
 * Run `npm pack --dry-run --json` in this checkout.
 * @returns the parsed report.
 */
function runPack() {
	const command = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(command, ["pack", "--dry-run", "--json"], {
		cwd: ROOT,
		encoding: "utf8",
		env: process.env,
		maxBuffer: 16 * 1024 * 1024
	});
	if (result.error !== undefined) throw new Error(`cannot run npm: ${result.error.message}`);
	if (result.status !== 0) {
		throw new Error(`npm pack --dry-run --json exited with status ${String(result.status)}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
	}
	return extractPackReport(result.stdout ?? "");
}

/**
 * Read a report produced earlier by `npm pack --dry-run --json`.
 * @param path - path of the JSON report.
 * @returns the parsed report.
 */
function readReport(path) {
	return extractPackReport(readFileSync(path, "utf8"));
}

/**
 * Normalize a report to `{ name, version, files }`.
 * @param report - parsed pack report (array form or single object).
 * @returns the normalized view.
 */
function normalizeReport(report) {
	const entry = Array.isArray(report) ? report[0] : report;
	if (typeof entry !== "object" || entry === null) throw new Error("npm pack report is not an object");
	const files = Array.isArray(entry.files) ? entry.files.map((file) => file.path) : [];
	if (files.length === 0) throw new Error("npm pack report lists no files");
	return { name: entry.name, version: entry.version, files: [...files].sort() };
}

/**
 * Compare the archive contents with the declared payload.
 * @param files - sorted archive file paths.
 * @returns `{ problems, allowed }`.
 */
function auditFiles(files) {
	const problems = [];
	const allowed = new Set([...EXPECTED_FILES, ...ALLOWED_NPM_GENERATED_FILES]);
	for (const expected of EXPECTED_FILES) {
		if (files.includes(expected) === false) problems.push(`missing from the archive: ${expected}`);
	}
	for (const file of files) {
		const forbidden = FORBIDDEN_PATTERNS.find((entry) => entry.pattern.test(file));
		if (forbidden !== undefined) {
			problems.push(`must not ship: ${file} (${forbidden.reason})`);
			continue;
		}
		if (allowed.has(file) === false) problems.push(`not part of the declared runtime payload: ${file}`);
	}
	return { problems, allowed };
}

/** Entry point. */
function main() {
	if (process.env.NPM_CONFIG_CACHE === undefined || process.env.NPM_CONFIG_CACHE === "") {
		process.stdout.write(
			"verify-archive: warning: NPM_CONFIG_CACHE is not set; npm will use its machine-global cache\n" +
				'verify-archive: hint: NPM_CONFIG_CACHE="$PWD/node_modules/.npm-cache" npm run verify:archive\n'
		);
	}

	const argument = process.argv[2];
	const report = argument === undefined ? runPack() : readReport(argument);
	const { name, version, files } = normalizeReport(report);
	const { problems } = auditFiles(files);

	process.stdout.write(`verify-archive: ${String(name)}@${String(version)} — ${String(files.length)} files\n`);
	for (const file of files) process.stdout.write(`verify-archive:   ${file}\n`);

	if (problems.length > 0) {
		for (const problem of problems) process.stderr.write(`verify-archive: ${problem}\n`);
		throw new Error(`${String(problems.length)} archive content problem(s)`);
	}
	process.stdout.write("verify-archive: the archive matches the declared runtime payload exactly\n");
}

try {
	main();
} catch (error) {
	process.stderr.write(`verify-archive: ${error.message}\n`);
	process.exitCode = 1;
}
