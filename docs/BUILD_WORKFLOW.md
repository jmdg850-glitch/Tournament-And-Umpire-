# Build Workflow

This repo's dependency install (`npm ci`) is slow and, on Windows, sensitive to
antivirus real-time scanning of `node_modules`. Normal feature development must
never require it. This document is the contract for how builds work day to day.

## Normal feature development (no `npm ci`, no dependency reset)

1. Modify source.
2. Run tests: `npm test` (root: engine/contracts/api/client/ui) and, if you
   touched Operator, also `npm test -w @tournament/operator`.
3. Run: `npm run build:all`
4. Use the generated artifacts (paths/versions are printed in the report — see
   Artifact locations below).

`build:all` reuses the existing `node_modules` install and the existing Vite /
Gradle caches. It never runs `npm ci` and never deletes `node_modules`.

For a fast web-only build while iterating (no Windows installer, no Android
APK), use `npm run build:apps` instead — it only builds Operator and Umpire
web bundles.

## If `package.json` / `package-lock.json` actually change

Install/update as usual (`npm install <pkg>`, or edit `package.json` and run
`npm install`), verify with `npm run check:dependencies`, then build as normal
with `npm run build:all`. This is not a "corrupted dependencies" situation —
don't reach for `reset:dependencies` just because the lockfile changed.

## Dependency recovery (corrupted install only)

Only when `npm run check:dependencies` reports a real problem (missing
`node_modules/.package-lock.json`, a required package missing, a broken
workspace link):

```
npm run reset:dependencies
```

This is the *only* sanctioned command that deletes `node_modules`. It:
1. refuses to run unless it resolves to this actual repo root,
2. prints the exact paths it's about to delete before deleting anything,
3. verifies source, migrations, `package.json`/`package-lock.json`, and the
   Android signing files are untouched, both before and after,
4. deletes only `node_modules` and `node_modules.broken` (nothing else),
5. runs exactly one `npm ci`, with output captured to `npm-ci-install.log`
   (not piped through `tail` — read the log directly, or `Get-Content -Wait
   npm-ci-install.log` in a separate shell to follow it live),
6. re-runs the health check before declaring success.

After it succeeds, resume normal builds with `npm run build:all` — do not run
`npm ci` again.

## Available scripts

| Script | Does | Touches `node_modules`? |
|---|---|---|
| `npm run build:apps` | Operator + Umpire web builds only | No |
| `npm run build:all` | Operator web, Umpire web, Android APK, Windows installer, then verifies all four | No |
| `npm run check:dependencies` | Reports whether the install is healthy | No (read-only) |
| `npm run reset:dependencies` | Deletes and reinstalls `node_modules` | **Yes — the only one that does** |
| `npm run clean:build` | Deletes generated output (`dist`, `release`, Android `build` dirs) | No |
| `npm run release` | Full release pipeline: tests, version bump, both builds, verify, commit, push, publish | No (assumes a healthy install, same as `build:all`) |

## Artifact locations

- Operator web: `apps/operator/dist/`
- Umpire web: `apps/umpire/dist/`
- Windows installer: `apps/operator/release/Tournament-Operator-Setup-<version>.exe`
- Android APK: `apps/umpire/android/app/build/outputs/apk/release/app-release.apk`

## When a build fails

Don't reflexively delete `node_modules`, run `npm ci`, downgrade a package, or
touch unrelated source. `build:all` and `release.mjs` both report failures in
the same shape:

```
FAILED STAGE: <which step>
ERROR: <exact error>
```

From there:
- **PACKAGE**: is the error inside a specific package's build step (Vite,
  Gradle, electron-builder)? Note it.
- **LIKELY CAUSE**: a real source/config error in the stage that failed, vs.
  evidence of dependency corruption (only `check:dependencies` failing, or an
  error about a missing/corrupt package *inside* `node_modules`, counts as the
  latter).
- **RECOMMENDED ACTION**: fix the source/config issue directly, or — only with
  real evidence of dependency corruption — `npm run reset:dependencies`.

## Performance goal

One initial `npm ci`, then many feature changes, each rebuilt with
`npm run build:all` reusing the same install and the same Vite/Gradle caches.
Adding a feature should never require reinstalling the dependency tree.
