# dsh-macos-settings-shortcut

A small, local DSH Desktop profile bundle that makes **Cmd+,** open the Settings
dialog the shipped macOS app already renders.

It is a profile-layer plugin: nothing inside the signed application bundle is
patched, so app updates cannot overwrite the change and code signing stays
intact.

* Bundle id: `dsh-macos-settings-shortcut`
* Target profile: `$DSH_HOME/profiles/desktop` (default: `~/.dsh/profiles/desktop`)
* Checkout: any local clone of this repository — the commands below assume your
  shell is in the repository root.

---

## What it does

The DSH web shell already ships a Settings dialog; only the macOS shortcut is
missing. This bundle adds a capture-phase `keydown` listener to the document
that recognizes exactly one gesture and clicks the existing Settings trigger:

1. **Gesture**: `metaKey` set, `ctrl`/`alt`/`shift` unset, and either
   `event.key === ","` or `event.code === "Comma"` (layout-independent). Key
   repeats and IME composition are ignored.
2. **Claim**: the event is `preventDefault()`-ed and `stopPropagation()`-ed, so
   neither the browser nor an editor handler also reacts to Cmd+,.
3. **Action**: it clicks the first *visible, collapsed* Settings trigger found
   through the shell's published accessibility markup,
   `button[aria-haspopup="dialog"][aria-expanded]`.

Behavior details worth knowing:

* **It never closes the dialog.** A trigger whose `aria-expanded` is not
  `"false"` is skipped, so Cmd+, while Settings is open does nothing.
* **No trigger, no click.** If the shell renders no usable trigger, the gesture
  is still claimed (Cmd+, stays harmless) but nothing is clicked.
* **Selector safety.** That accessibility markup is not unique in the shipped
  shell: the context meter and the usage/statistics pills use it too. The
  selector above remains the only query; candidates carrying the Settings
  shell's own structural slot anchor `div[data-slot="settings.trigger"]` (which
  the shared slot renderer emits inside the Settings trigger button) are
  preferred, and when no candidate carries it, selection falls back to the
  first suitable candidate in document order.
* **No localized text, no private state.** The plugin never reads button
  labels, React internals, or app files; it only queries the document it is
  given.

## How it is wired into a profile

| Piece | Purpose |
| --- | --- |
| `cordis.patch.yml` | Inserts exactly one row (`id`/`name` = `dsh-macos-settings-shortcut`) into the profile's Cordis tree. |
| `lib/index.js` (from `src/index.js`) | The row's host half: a deliberate no-op Cordis plugin. It exists only so the row is *active*. |
| `lib/client.js` (from `src/client.js`) | The browser half: a dependency-free bundle registering a lazy CJS factory via `window.__ModuleLoader__.load({ id, factory })`. |
| `package.json` → `dsh.bundle.patch` | Tells DSH to apply `cordis.patch.yml` as a bundle layer. |
| `package.json` → `dsh.client.platform: "web"` + `exports["./client"]` | Marks the package as a web client package and points at its browser bundle, which the host composes into the page. |

The browser half is created by the host: `@deepseek-ai/dsh-client-modules`
scans the active Cordis rows for packages declaring `dsh.client`, serves each
package's `./client` bundle, and activates it in the page. That is why the
inactive-looking host row is required at all.

## Prerequisites

* macOS with DSH Desktop installed (verified against 0.1.5-rc.2).
* `node` ≥ 20 and `pnpm` on `PATH` (used for the profile install).
* A DSH home directory — `$DSH_HOME`, or `~/.dsh` by default.
* No runtime dependencies: the package installs nothing at run time, and the
  browser bundle is self-contained.

## Build and test

```sh
cd /path/to/dsh-macos-settings-shortcut   # your local clone
pnpm run build     # regenerates lib/index.js and lib/client.js from src/
pnpm test          # builds, then runs every test file in tests/
```

`pnpm test` never touches the live DSH installation: the shortcut tests use
fake document/button/event objects plus a `node:vm` sandbox for the generated
artifact, and the installer tests run against temporary `DSH_HOME` fixtures
with a stub `pnpm`.

## Install into the desktop profile

Preview first — a dry run writes nothing:

```sh
node scripts/install.mjs --dry-run --profile desktop
```

Then install:

```sh
node scripts/install.mjs --profile desktop
```

Options:

| Flag | Meaning |
| --- | --- |
| `--profile <name>` | Profile to register the bundle in (default `desktop`). Names are validated as a single path segment (`[A-Za-z0-9][A-Za-z0-9._-]*`, no separators, no `..`, no trailing dot). |
| `--dsh-home <path>` | DSH home directory (default `$DSH_HOME`, then `~/.dsh`). Must be absolute. |
| `--dry-run` | Print the planned changes and write nothing. |
| `--pnpm <path>` | pnpm executable to invoke (default `pnpm` on `PATH`). |
| `-h`, `--help` | Usage. |

What the installer writes — and nothing else:

* `<dsh-home>/profiles/<profile>/package.json`: adds
  `"dsh-macos-settings-shortcut": "link:<absolute path of your checkout>"`
  to `dependencies` (through pnpm) and appends `dsh-macos-settings-shortcut` to
  `dsh.profile.bundles` (only when it is absent, so re-running is a no-op).
* The pnpm-managed files in that same profile directory: `node_modules/` and
  the profile lockfile.

The install is narrow by construction: the profile directory is resolved and
re-checked (including through symlinks) to stay inside
`<dsh-home>/profiles`, the manifest must parse to a JSON object, and the write
goes through a temporary file plus rename. It never touches `settings.yaml`,
credentials, sessions, other profiles, other dependencies, or unrelated
`package.json` fields — and it never writes anything under
`/Applications`, including the DSH Desktop application bundle.

## Relaunch is required

`dsh.profile.bundles` is resolved (and each listed bundle's patch layer loaded)
when DSH loads the profile, so the shortcut is **not** active in the currently
running app. After installing:

1. Quit DeepSeek Harness (Cmd+Q).
2. Start it again.
3. Press **Cmd+,** — the Settings dialog should open.

No application file changes are needed for this, and none are made.

## Verify the installation

```sh
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
node -e 'const {readFileSync}=require("node:fs");const home=process.argv[1];const m=JSON.parse(readFileSync(home+"/profiles/desktop/package.json","utf8"));console.log(m.dependencies["dsh-macos-settings-shortcut"], m.dsh.profile.bundles.includes("dsh-macos-settings-shortcut"))' "$DSH_HOME_DIR"
readlink "$DSH_HOME_DIR/profiles/desktop/node_modules/dsh-macos-settings-shortcut"
```

The first command should print the `link:` spec and `true`; the second should
resolve to your checkout. The installer prints the same verification itself
after a successful run.

## Removal

Remove the bundle from the profile and re-install the remaining dependencies:

```sh
cd "${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
pnpm remove dsh-macos-settings-shortcut
```

Then edit `package.json` in that profile directory and delete the
`dsh-macos-settings-shortcut` entry from `dsh.profile.bundles`, and relaunch
DeepSeek Harness. Deleting the checkout directory afterwards is safe: the
profile only links to it, and nothing inside the app bundle refers to it.

To re-enable later, run the installer again from a checkout that has been built
with `pnpm run build`.

## Layout

```
dsh-macos-settings-shortcut/          # this repository
├── cordis.patch.yml          # bundle patch layer: one inserted row
├── package.json              # bundle metadata (dsh.bundle.patch, dsh.client.platform)
├── src/index.js              # host half source (no-op Cordis plugin)
├── src/client.js             # browser half source (Cmd+, handling)
├── lib/                      # generated by scripts/build.mjs (committed on purpose)
├── scripts/build.mjs         # deterministic, dependency-free build
├── scripts/install.mjs       # narrow profile installer (dry-run capable)
├── scripts/lib/profile-plan.mjs  # pure validation/planning rules
├── tests/                    # node:test suites (no GUI required)
└── LICENSE                   # MIT
```

## License

MIT — see [LICENSE](LICENSE).
