# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

**DSH Desktop 2.0.14 support — source-only, not published.** npm's `latest`
tag still resolves to `0.1.0`, which contains only the behavior described below
for the older shells; the changes in this section exist in Git and in the
regenerated `lib/client.js`, and require a separate release to reach npm.

### Added

- **Account-menu launcher support for DSH Desktop 2.0.14 and later.** That shell
  fills the `settings.launcher` slot with an account button
  (`[data-slot="settings.launcher"] button[aria-haspopup="menu"]`) and no longer
  renders a dialog button, so Cmd+, now opens that menu and selects its **first
  menu row** — the Settings action — which invokes the shell's own
  `openSettings` callback.
- **Asynchronous mount handling.** Because the menu is portaled by React and is
  first mounted in a hidden measuring position, the flow snapshots the menus
  already present, clicks the collapsed launcher, then uses a single bounded
  `MutationObserver` on `document.body` (attribute and child-list aware) with a
  1000 ms safety deadline — not polling — to act on the menu that mounts.
- **Regression coverage** for both shells: 45 tests, including synchronous and
  asynchronous menu opening, first-row selection, measurement passes,
  pre-existing and ambiguous menus, already-expanded launchers, an already-open
  Settings dialog, hidden/disabled controls, deadline, launcher closure, repeat
  presses, disposal while pending, the legacy dialog path, and a read-only
  assertion against the installed 0.1.7-rc.1 client artifacts.

### Changed

- **Menu and legacy selection now fail closed.** A row is clicked only when
  exactly one new visible menu appeared, while the same launcher is still
  expanded, and its first row is a plain, enabled, visible, non-submenu row.
  The legacy dialog button is clicked only when it wraps the
  `settings.trigger` slot anchor; the previous "otherwise fall back to the first
  candidate" behavior — which could click an unrelated dialog button — is gone.
- **Pending work is always released**: on success, on the deadline, when the
  launcher closes, on the next valid Cmd+,, and on Cordis disposal.

### Notes

- No npm publication was performed for this change, `package.json` remains at
  `0.1.0`, and no new published-compatibility assertion was added: the version
  bump and the `dsh.compatibility`/`dshhub` update await a live verification.
- Activating the fix in the linked profile requires relaunching DSH Desktop; the
  running app keeps serving the bundle it already loaded.
- Live keyboard verification in a running app has **not** been performed.

## [0.1.0] - 2026-09-18

First published release (npm `latest`). This version contains the behavior
described below and does **not** include the account-menu support listed under
[Unreleased]. No DSH Market listing has been created for it.

### Added

- **Cmd+, opens the existing Settings dialog** on macOS. A capture-phase
  `keydown` listener in the DSH browser client recognizes only the unmodified
  Cmd+Comma gesture (`metaKey` set, `ctrl`/`alt`/`shift` unset, `key === ","` or
  `code === "Comma"`), ignores key repeats and IME composition, and claims the
  event with `preventDefault()` and `stopPropagation()`.
- **Safe trigger selection.** The dialog is opened by clicking the first visible
  Settings trigger found through the shell's published accessibility markup
  (`button[aria-haspopup="dialog"][aria-expanded]`), preferring the candidate
  that carries the Settings shell's own slot anchor
  (`div[data-slot="settings.trigger"]`); when no candidate carried that anchor it
  fell back to the first suitable candidate, which the [Unreleased] section
  replaces with a fail-closed rule. An already-expanded dialog or a missing
  trigger clicks nothing, so the shortcut never toggles Settings closed.
- **No application files are modified.** The plugin is a profile-layer bundle:
  it never patches the signed application, never writes to `/Applications`, and
  is therefore unaffected by application updates.
- **No localized text, no private React state, no polling, no permissions.** The
  runtime logic touches only the document it is handed, reads no button labels
  and no React internals, and requests no host capability, network access, or
  credentials.
- **Dependency-free runtime artifacts.** `lib/index.js` (no-op host half, needed
  only to keep the Cordis row active) and `lib/client.js` (self-contained
  browser bundle registering a lazy CJS factory through
  `window.__ModuleLoader__.load`) are built from `src/` by a deterministic,
  dependency-free build script, and are committed because the profile
  installer links this checkout directly.
- **Safe profile installer** (`node scripts/install.mjs`). Defaults to
  `$DSH_HOME` and the `desktop` profile, accepts `--profile` only after strict
  single-segment validation, requires `--dsh-home` to be absolute, re-checks
  profile containment through symlinks, supports `--dry-run`, writes the profile
  manifest atomically, and appends the bundle id to `dsh.profile.bundles` only
  when it is absent. It never touches `settings.yaml`, credentials, sessions,
  other profiles, or unrelated manifest fields.
- **Test suite** (31 tests, `node --test`, no GUI required): Cmd+, detection and
  exclusions, default prevention, collapsed-versus-open behavior, missing
  trigger, invisible candidates, listener disposal, generated-artifact
  registration, installer validation and planning, plus end-to-end installer
  runs against temporary `DSH_HOME` fixtures.
- **Public repository metadata and documentation:** MIT `LICENSE`, keywords,
  `repository`/`homepage`/`bugs`, `publishConfig`, `packageManager`,
  `dsh.compatibility`, a `dshhub` record for marketplaces, and this changelog.
- **Repository automation:** CI that builds, tests, and validates the npm
  archive on Node 20 and Node 22 with an isolated npm cache, and a manual
  release-validation workflow that performs only an offline dry run.

### Notes

- Supported platforms: macOS; DSH Desktop ≥ 0.1.5-rc.2; Node.js ≥ 20 for build,
  tests, and installation.
- Activating the bundle requires restarting DSH Desktop: the profile bundle list
  is read when the app loads the profile.
