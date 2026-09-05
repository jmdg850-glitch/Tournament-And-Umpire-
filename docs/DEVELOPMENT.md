# Development

Requires Node 24+.

```bash
npm install
npm test
npm run lint
npm run build
npm run typecheck
```

## Apps

```bash
cp apps/operator/.env.example apps/operator/.env.local
cp apps/umpire/.env.example apps/umpire/.env.local
# fill client-safe keys only

npm run dev:operator   # http://localhost:5174 (strictPort)
npm run dev:umpire     # http://localhost:5175 (strictPort)
```

## API (optional local Node)

```bash
# packages/api uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the environment
npm run dev:api
```

Prefer the hosted Edge Function for the same command contract.

## Tests

- Engine: `npm test -w @tournament/engine`
- Contracts: `npm test -w @tournament/contracts`
- API unit: `npm test -w @tournament/api`
- Live path: seed `supabase/seed.dev.sql`, then `RUN_LIVE_API_TESTS=1` with `SUPABASE_URL`, `SUPABASE_ANON_KEY` / publishable key, and `COMMAND_URL`.

Dev seed users (not production credentials; never baked into release binaries):

- organizer.dev@tournament.local / dev-organizer-pass
- umpire.dev@tournament.local / dev-umpire-pass
- outsider.dev@tournament.local / dev-outsider-pass

## Packaging

Operator Windows desktop (Electron, after a verified web build):

```bash
npm run build:desktop -w @tournament/operator
```

Installer output: `apps/operator/release/Tournament-Operator-Setup-1.0.0.exe`

NSIS also writes `Tournament Operator.lnk` to the real user Desktop (`$DESKTOP`, including OneDrive) via `apps/operator/build/installer.nsh`.

The Vite build bakes `VITE_SUPABASE_*` and `VITE_COMMAND_URL` from `apps/operator/.env.local`. Never put `SUPABASE_SERVICE_ROLE_KEY` in those files.

Umpire Android (Capacitor) requires Android Studio / SDK **and JDK 17 or 21** (Gradle 8.14 does not run on JDK 25).

```bash
# from repo root, after apps/umpire/.env.local is set
npm run build:android -w @tournament/umpire
cd apps/umpire/android
# use Android Studio's JBR if the default java is too new:
# $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
.\gradlew.bat assembleDebug
```

Debug APK: `apps/umpire/android/app/build/outputs/apk/debug/app-debug.apk`

See `docs/RELEASE.md` for Auth production vs development, Windows packaging, Android signing, and the release checklist.
