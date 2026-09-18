#!/usr/bin/env node
/**
 * Deterministic, dependency-free build for dsh-macos-settings-shortcut.
 *
 * Two artifacts are emitted from `src/`:
 *
 *   lib/index.js   the host half, copied verbatim (plain ESM with named
 *                  exports, which is what the vendored Cordis Loader imports
 *                  for an inserted row).
 *   lib/client.js  the browser half, wrapped in the runtime module-loader
 *                  format the prebuilt DSH plugin client bundles use:
 *                  `window.__ModuleLoader__.load({ id, factory })` with a lazy
 *                  CJS factory. Executing the script only REGISTERS the
 *                  factory; every side effect stays inside the factory closure
 *                  and runs at materialization.
 *
 * No third-party code is bundled, transpiled, or downloaded: the client half
 * is restricted to a small source subset (no `import` statements, no
 * `export default`, no `require(...)` calls, and no regular-expression
 * literals, which the comment stripper below cannot tell apart from comment
 * openers) that a textual ESM-to-CJS conversion can rewrite safely and
 * deterministically. Anything outside that subset fails the build loudly
 * instead of being silently mangled.
 *
 * Comments are stripped from the generated client bundle: the artifact stays
 * free of any text that a dependency audit could mistake for a module
 * reference (the source keeps the documentation).
 *
 * Usage: node scripts/build.mjs   (also `pnpm run build`)
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package id of both halves; also the registered Loader module id. */
const PACKAGE_ID = "dsh-macos-settings-shortcut";
/** Repository root, derived from this script's location. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Generated output directory. */
const OUT_DIR = join(ROOT, "lib");

/** Statement-level `import` at the start of a line (comments may mention the word). */
const IMPORT_STATEMENT = /^[ \t]*import[\s{*"']/m;
/** Call form of CommonJS `require`; the loader's factory parameter is not a call. */
const REQUIRE_CALL = /\brequire[ \t]*\(/;
/** Statement-level `export` keyword at the start of a line. */
const EXPORT_STATEMENT = /^[ \t]*export\b/m;
/** `export <declaration>` forms this build can rewrite by dropping `export`. */
const EXPORT_DECLARATION =
	/^export[ \t]+(async[ \t]+function|function|const|let|var|class)[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
/** `export { a, b as c };` form. */
const EXPORT_LIST = /^export[ \t]*\{([^}]*)\}[ \t]*;?[ \t]*$/gm;

/**
 * Strip `//` line comments and block comments while leaving string and
 * template literals intact. The client half is a restricted subset without
 * regular-expression literals, so the two comment forms are unambiguous here.
 * @param source - raw source text.
 * @returns the source with comments removed.
 */
function stripComments(source) {
	let out = "";
	let index = 0;
	while (index < source.length) {
		const char = source[index];
		const next = source[index + 1];
		if (char === "/" && next === "/") {
			while (index < source.length && source[index] !== "\n") index += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
			index += 2;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			const quote = char;
			out += char;
			index += 1;
			while (index < source.length) {
				const literalChar = source[index];
				out += literalChar;
				index += 1;
				if (literalChar === "\\") {
					if (index < source.length) {
						out += source[index];
						index += 1;
					}
					continue;
				}
				if (literalChar === quote) break;
			}
			continue;
		}
		out += char;
		index += 1;
	}
	return out;
}

/**
 * Read a source file and fail with a clear diagnostic when it is missing.
 * @param relativePath - path relative to the repository root.
 * @returns the file contents.
 */
function readSource(relativePath) {
	const path = join(ROOT, relativePath);
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`build: cannot read ${relativePath}: ${error.message}`);
	}
}

/**
 * Rewrite the restricted ESM source subset into a CJS factory body.
 *
 * Supported and rewritten:
 *   - `export function f`, `export async function f`, `export class C`,
 *     `export const/let/var x` → the declaration with `export` dropped.
 *   - `export { local, local as exported };` → dropped, re-emitted as
 *     `exports.exported = local;` assignments.
 *
 * Rejected (build error, never silently ignored):
 *   - any `import` statement,
 *   - any `export default`,
 *   - any `require(...)` call,
 *   - any other statement-level `export`.
 *
 * @param source - the client half source text.
 * @returns the transformed body plus the export assignment lines.
 */
function toCommonJsBody(source) {
	const code = stripComments(source).replace(/[ \t]+$/gmu, "").replace(/\n{3,}/gu, "\n\n");

	if (IMPORT_STATEMENT.test(code)) {
		throw new Error("build: the client half must not use import statements (it is a self-contained bundle)");
	}
	if (REQUIRE_CALL.test(code)) {
		throw new Error("build: the client half must not call CommonJS require (it is a self-contained bundle)");
	}

	/** Exported name → local name inside the factory. */
	const exports = new Map();

	let body = code.replace(EXPORT_DECLARATION, (match, declaration, identifier) => {
		exports.set(identifier, identifier);
		return `${declaration} ${identifier}`;
	});

	body = body.replace(EXPORT_LIST, (match, list) => {
		for (const entry of list.split(",")) {
			const trimmed = entry.trim();
			if (trimmed.length === 0) continue;
			const aliased = /^([A-Za-z_$][A-Za-z0-9_$]*)[ \t]+as[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)$/u.exec(trimmed);
			if (aliased !== null) {
				exports.set(aliased[2], aliased[1]);
				continue;
			}
			if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(trimmed)) {
				throw new Error(`build: unsupported export list entry "${trimmed}"`);
			}
			exports.set(trimmed, trimmed);
		}
		return "";
	});

	if (EXPORT_STATEMENT.test(body)) {
		throw new Error("build: unsupported export form in the client half (only named declarations and export lists)");
	}
	if (exports.size === 0) {
		throw new Error("build: the client half exports nothing; the Loader would activate an empty module");
	}

	const assignments = [...exports]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([exported, local]) => `\t\texports.${exported} = ${local};`);

	return { body: body.replace(/^\n+/u, "").replace(/\s*$/u, ""), assignments };
}

/** Host half: copied verbatim, only preceded by a generated-file banner. */
function buildHostHalf() {
	const source = readSource("src/index.js");
	if (EXPORT_STATEMENT.test(source) === false) {
		throw new Error("build: the host half must use named exports (Loader activation contract)");
	}
	const banner = [
		"// Generated by scripts/build.mjs from src/index.js — do not edit this file.",
		"// Host half of dsh-macos-settings-shortcut: a no-op Cordis plugin whose",
		"// only purpose is to keep the row active so the browser half is composed.",
		""
	].join("\n");
	return `${banner}${source}`;
}

/** Browser half: wrapped into the lazy CJS factory registration. */
function buildClientHalf() {
	const { body, assignments } = toCommonJsBody(readSource("src/client.js"));
	return [
		"// Generated by scripts/build.mjs from src/client.js — do not edit this file.",
		"// Browser half of dsh-macos-settings-shortcut. Executing this script only",
		"// REGISTERS the lazy CJS factory; all behavior runs at materialization.",
		"window.__ModuleLoader__.load({",
		`\tid: ${JSON.stringify(PACKAGE_ID)},`,
		"\tfactory: (require) => {",
		"\t\tvar module = { exports: {} };",
		"\t\tvar exports = module.exports;",
		body,
		"",
		...assignments,
		"\t\treturn module.exports;",
		"\t}",
		"});",
		""
	].join("\n");
}

/** Entry point: wipe and regenerate `lib/`. */
function main() {
	rmSync(OUT_DIR, { recursive: true, force: true });
	mkdirSync(OUT_DIR, { recursive: true });

	const artifacts = [
		["lib/index.js", buildHostHalf()],
		["lib/client.js", buildClientHalf()]
	];
	for (const [relativePath, contents] of artifacts) {
		writeFileSync(join(ROOT, relativePath), contents, "utf8");
		process.stdout.write(`build: wrote ${relativePath} (${Buffer.byteLength(contents, "utf8")} bytes)\n`);
	}
	process.stdout.write(`build: ${PACKAGE_ID} up to date\n`);
}

main();
