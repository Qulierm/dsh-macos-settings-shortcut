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
that recognizes exactly one gesture and then opens Settings through whichever
control the running shell renders:

1. **Gesture**: `metaKey` set, `ctrl`/`alt`/`shift` unset, and either
   `event.key === ","` or `event.code === "Comma"` (layout-independent). Key
   repeats and IME composition are ignored.
2. **Claim**: the event is `preventDefault()`-ed and `stopPropagation()`-ed, so
   neither the browser nor an editor handler also reacts to Cmd+,.
3. **Action — DSH Desktop 2.0.14 and later (account menu).** That shell fills
   the `settings.launcher` slot with an account button
   (`[data-slot="settings.launcher"] button[aria-haspopup="menu"]`) instead of a
   dialog button, and Settings is the *first row* of the menu that button
   toggles. The listener snapshots the menus already mounted, clicks the
   collapsed launcher, and then clicks the first row of the one menu that
   mounts as a result — whether React mounts it synchronously or asynchronously.
4. **Action — older shells (dialog button).** Where the launcher slot falls back
   to the shipped dialog button, the listener clicks that button directly; it is
   accepted only when it actually wraps the `settings.trigger` slot anchor.

Neither shell is patched: the plugin only reads the DOM it is given.

Behavior details worth knowing:

* **It never closes the dialog.** An open Settings dialog (a
  `[role="dialog"][aria-modal="true"]` panel containing the `settings.header`
  slot anchor) is detected first: Cmd+, then claims the gesture and changes
  nothing. A launcher or trigger whose `aria-expanded` is not `"false"` is never
  toggled closed.
* **It never clicks an arbitrary control.** The legacy dialog markup
  (`button[aria-haspopup="dialog"][aria-expanded]`) is *not* unique in the
  shipped shell — the context meter and the usage/statistics pills use it too —
  so a candidate is accepted only with the `settings.trigger` slot anchor
  inside it. If no such button exists (for example because an account-menu
  launcher replaced it), nothing is clicked: the gesture is claimed and the
  shortcut stays harmless.
* **Menu selection fails closed.** The account-menu flow acts only when exactly
  one new *visible* menu appeared after the launcher click, while that same
  launcher is still expanded, and only if the menu's first row is a plain,
  enabled, visible, non-submenu row. Two new menus, a submenu parent, a disabled
  or hidden first row, a missing menu, or a launcher that closes again all
  result in no click.
* **Bounded observation, never polling.** Asynchronous mounts are handled by one
  short-lived `MutationObserver` on `document.body` (which also tolerates the
  menu primitive's hidden measuring pass) plus a 1000 ms safety deadline. Both
  are released on success, on the deadline, when the launcher closes, on the
  next valid Cmd+,, and when the Cordis row is disposed.
* **No localized text, no private state.** The plugin never reads button labels,
  React internals, Electron APIs, or app files; it queries the document it is
  given, and all menu work is re-derived from markup each time.

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

* macOS with DSH Desktop installed.
* `node` ≥ 20 and `pnpm` on `PATH` (used for the profile install).
* A DSH home directory — `$DSH_HOME`, or `~/.dsh` by default.
* No runtime dependencies: the package installs nothing at run time, and the
  browser bundle is self-contained.

## Compatibility

| Component | Supported |
| --- | --- |
| Operating system | macOS. Cmd+, is the macOS Settings gesture, and the plugin does nothing on other platforms. |
| DSH Desktop | Two shipped shells are supported. **2.0.14 and later**: the `settings.launcher` slot hosts an account-menu button and Settings is the first menu row. **Older releases** (the 0.1.5 line, where the shell renders the dialog trigger directly): the launcher slot's fallback dialog button is used. `dsh.compatibility` still records only 0.1.5-rc.2 as compatible, because the 2.0.14 account-menu support is not released yet; it is verified against the installed 0.1.7-rc.1 client artifacts by the test suite (see *Release status*). |
| Node.js | ≥ 20 (`engines.node`). Node is used for the build, the tests, and the profile installer — not by the plugin at runtime. |
| Surfaces | exactly one: `web` (`dsh.client.platform`), the DSH Desktop browser client. |
| Capabilities and permissions | none. No host capability is provided and none is required: no network access, no filesystem access from the browser half, no credentials, no settings namespace. |

Matching DSH releases are recorded in `package.json` under
`dsh.compatibility.dshReleases`; a release that is not listed there has not been
verified against this bundle.

## Build and test

```sh
cd /path/to/dsh-macos-settings-shortcut   # your local clone
pnpm run build     # regenerates lib/index.js and lib/client.js from src/
pnpm test          # builds, then runs every test file in tests/
```

`pnpm test` never modifies the live DSH installation: the shortcut tests drive a
fake DOM, fake events, a fake `MutationObserver`, and a fake clock (plus a
`node:vm` sandbox for the generated artifact), and the installer tests run
against temporary `DSH_HOME` fixtures with a stub `pnpm`. One test reads the
installed client bundles under `/Applications` **read-only** to assert that the
launcher, menu row, and slot anchors this plugin relies on are still there; it
skips with an explicit reason on machines without DSH Desktop installed.

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
running app. The same is true of this fix: a linked checkout whose `lib/client.js`
was rebuilt keeps serving the bundle the running app already loaded until the
profile is loaded again. After installing (or after updating the linked
checkout):

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

## Release status and maintainer handoff

**npm `0.1.0` is published; the DSH Desktop 2.0.14 fix in this repository is
not.** `latest` on the registry is `0.1.0` (published 2026-09-18), and that
artifact still carries the original behavior only: it queries
`button[aria-haspopup="dialog"][aria-expanded]`, prefers a candidate wrapping the
`settings.trigger` anchor, and otherwise falls back to the first candidate. It
has no account-menu path, so in DSH Desktop 2.0.14 — where the `settings.launcher`
slot hosts the account button and no dialog button exists — it cannot open
Settings. The account-menu support documented above lives **only on this
repository's `main` branch** (`src/client.js` plus the regenerated
`lib/client.js`) and will reach npm only through a separate, explicitly
authorized release.

`package.json` still declares `0.1.0`, and no new published-compatibility claim
has been added: version bump, registry publication, and the corresponding
`dsh.compatibility`/`dshhub` assertions are deliberately deferred until the fix
has been verified in a live app. **Do not publish this checkout under the
existing version.**

This repository never publishes on its own: it stores no npm credentials,
defines no registry secret, and contains no workflow that uploads a package.

* **Publishing the fix is a manual, maintainer-only step.** It requires an
  authenticated npm account with publish rights for the unscoped name
  `dsh-macos-settings-shortcut`, a version chosen for the new release, and
  publication from a revision that contains the fix — CI and the manual
  release-validation workflow only *verify* the package, and the
  release-validation run is an offline dry run that cannot upload.
* **Archive check (offline, no registry access).** Confirm exactly what a
  publication would upload:

  ```sh
  # The cache lives under node_modules/, which is already ignored, so this
  # never touches ~/.npm and never leaves local state in Git.
  NPM_CONFIG_CACHE="$PWD/node_modules/.npm-cache" npm pack --dry-run
  NPM_CONFIG_CACHE="$PWD/node_modules/.npm-cache" pnpm run verify:archive
  ```

  The archive contains only `package.json`, `README.md`, `LICENSE`,
  `cordis.patch.yml`, `lib/index.js`, and `lib/client.js` — the runtime payload
  declared in `files`. `src/`, `tests/`, `scripts/`, `node_modules/`,
  `pnpm-lock.yaml`, and `.github/` stay in Git and never ship.
* **DSH Market submission is a separate manual marketplace action** performed
  after a new npm publication. Marketplaces that consume DSH plugins list
  *published* npm packages, so a submission describing the account-menu fix
  before that publication would point at a package that does not contain it.
  The `dshhub` record in `package.json` (`schemaVersion`, `displayName`,
  `summary`, `categories`, `surfaces`, `compatibility`) is the metadata such a
  submission reads. **No DSH Market listing has been created for this package**,
  and submission requirements are not verifiable from this repository.
* **Automation.** `.github/workflows/ci.yml` builds, tests, and validates the
  archive on Node 20 and Node 22 with an npm cache under the runner's temporary
  directory. `.github/workflows/release-validation.yml` is manual-only and runs
  the same checks plus an offline dry run of the packaging path. Both workflows
  request `contents: read` and neither can publish.

## Layout

```
dsh-macos-settings-shortcut/          # this repository
├── cordis.patch.yml          # bundle patch layer: one inserted row
├── package.json              # bundle metadata (dsh.bundle.patch, dsh.client.platform, dshhub)
├── CHANGELOG.md              # Keep a Changelog release notes
├── src/index.js              # host half source (no-op Cordis plugin)
├── src/client.js             # browser half source (Cmd+, handling)
├── lib/                      # generated by scripts/build.mjs (committed on purpose)
├── scripts/build.mjs         # deterministic, dependency-free build
├── scripts/install.mjs       # narrow profile installer (dry-run capable)
├── scripts/verify-archive.mjs    # asserts the npm archive payload
├── scripts/lib/profile-plan.mjs  # pure validation/planning rules
├── tests/                    # node:test suites (no GUI required)
├── .github/workflows/        # CI and manual release validation
└── LICENSE                   # MIT
```

## License

MIT — see [LICENSE](LICENSE).
