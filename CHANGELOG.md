# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-09-18

First prepared release. **Not published:** this version exists in Git only. No
npm publication and no DSH Market listing have been made for it.

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
  (`div[data-slot="settings.trigger"]`). An already-expanded dialog or a missing
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
