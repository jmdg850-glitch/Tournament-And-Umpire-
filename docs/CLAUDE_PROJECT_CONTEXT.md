# Claude Project Context

Persistent reference for future Claude Code sessions on this repository. Generated from a full read-only audit (Phase 1–9 of the onboarding audit). Describes the **current codebase as it exists today**, not an idealized target. If something here conflicts with what you observe in the code, trust the code and update this document.

Audit date: 2026-09-05.

---

# Project Overview

This repository contains **two separate products**:

1. **Tournament** — the current, actively developed product. A pickleball-style tournament management platform with two apps: an **operator** (organizer) app packaged for web and Windows desktop (Electron), and an **umpire** (match scoring) app packaged for web and Android (Capacitor). Backed by a dedicated Supabase project ("Tournament App", ref `evuvgxruavnadpbiehgb`, region `ap-southeast-1`).
2. **PickleLive / "NextG"** — the previous product. A single-page app living at the repo root (`src/`, `index.html`), with its own (different) Supabase project (ref `qfyfomiqxouqftrgganh`) and its own migration history. It is explicitly deprecated and must not be connected to the Tournament Supabase project.

The repo is an **npm workspaces monorepo** (`workspaces: ["packages/*", "apps/*"]`), Node `>=24`, no TypeScript build/typecheck configured anywhere, no CI/CD (no `.github/workflows`). Deployment is manual/CLI-driven via two separate Vercel projects plus manual Electron/Android packaging.

This split into two products is not a guess — it is stated directly by the repo's own `legacy/README.md`, `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, and `docs/SUPABASE_SETUP.md`, and confirmed independently by reading the source and the Supabase config.

---

# Current Architecture

Verified against source (matches `docs/ARCHITECTURE.md`):

```
Client (operator / umpire)
   ↓  user JWT (Supabase Auth)
Authenticated API — Edge Function `command` (production) or packages/api (local dev, Hono)
   ↓  actor = JWT sub (server re-verifies identity every request — never trusts client-declared user id)
Role/authorization check — packages/api/src/authz.js
   ↓
Tournament Engine — packages/engine (pure domain logic, no I/O)
   ↓
public.apply_official_writes(payload)  — SECURITY DEFINER, EXECUTE granted only to service_role
   ↓
PostgreSQL — Supabase project "Tournament App" (evuvgxruavnadpbiehgb)
   ↓
Realtime — postgres_changes on matches / score_events / match_results / court_assignments
   ↓
Subscribers — organizer desk (`desk-live:{tournamentId}`) and live-match popup (`live-match:{matchId}`)
   (the umpire app does NOT subscribe to realtime — it polls on window focus/visibility instead)
```

Clients (`apps/operator`, `apps/umpire`) never receive a `service_role` key. All domain-table access from client code is `SELECT`-only (enforced by Postgres RLS) plus `auth.updateUser` for password flows. All mutations go through the single `command` API using a client-generated `command_id` (idempotent) and, for scoring, a client-generated `event_id`/`seq` (also idempotent).

---

# Repository Structure

```
e:\.1
├── apps/
│   ├── operator/        Tournament organizer app (web + Electron/Windows desktop)
│   └── umpire/          Match-execution/umpire app (web + Capacitor/Android)
├── packages/
│   ├── engine/          Pure domain logic (lifecycle, scoring, brackets, teams, seeding, realtime helpers)
│   ├── contracts/       Command envelope schema + shared enums
│   ├── api/             Local Hono server mirroring the production Edge Function (packages/api/src/handleCommand.js)
│   ├── client/          Thin shared Supabase client wrapper (auth helpers, deep-link callback handling)
│   └── ui/               Shared React UI components/styles
├── supabase/
│   ├── config.toml       Points at project evuvgxruavnadpbiehgb ("Tournament App")
│   ├── migrations/       CURRENT schema: 0001–0010
│   ├── migrations-applied/  LEGACY (PickleLive) schema history, ~144 files — NOT applied to the current project
│   ├── functions/        command (current), pair-station (current), submit-match / dupr-webhook-receiver /
│   │                     link-dupr-account / _shared (LEGACY, DUPR/PickleLive-only)
│   └── seed.dev.sql       Dev-only seed data
├── src/                  LEGACY PickleLive SPA (do not extend; do not connect to Tournament Supabase project)
├── index.html, vite.config.js, dist/   LEGACY SPA build entry/output
├── legacy/README.md      Explicit "do not connect legacy code to the Tournament project" guardrail note
├── docs/                  Existing hand-maintained docs (ARCHITECTURE, DATABASE, AUTHORIZATION, API,
│                          DEVELOPMENT, RELEASE, SUPABASE_SETUP, PUBLIC_RELEASE_AUDIT, FINAL_PUBLIC_RELEASE_REPORT)
├── scripts/               Manual QA/ops utilities (Electron CDP scripts, bundle-command, publish-desktop-update,
│                          vercel-sync-client-env, audit-bundles)
├── vercel.operator.json, vercel.umpire.json, apps/operator/vercel.json, apps/umpire/vercel.json
│                          Four Vercel configs for two deployed projects (see "Known Issues")
└── package.json           Root workspace manifest; scripts delegate to per-workspace scripts
```

---

# Applications

## `apps/operator` — Tournament organizer app
- `package.json` name `@tournament/operator`, v1.1.0, `"main": "electron/main.cjs"`.
- Vite + React 19 SPA, also packaged as a Windows Electron desktop app (electron-builder, NSIS installer, auto-update via `electron-updater` reading from a public Supabase Storage bucket `desktop-updates`).
- Dev: `npm run dev:operator` → `http://localhost:5174` (strictPort). Preview: 4174.
- Key source: `apps/operator/src/App.jsx` (auth, dashboard, tournament creation), `apps/operator/src/TournamentDesk.jsx` (everything else — divisions, participants, teams, courts, brackets, umpire assignment, live view), `apps/operator/src/LiveMatchWindow.jsx` (read-only scoreboard popup), `apps/operator/src/useRealtimeChannel.js`, `apps/operator/electron/{main.cjs,preload.cjs,updater.cjs,updatePolicy.cjs}`.
- Deployed to Vercel project `tournament-operator`.

## `apps/umpire` — Umpire / match-execution app
- `package.json` name `@tournament/umpire`, v1.3.0.
- Vite + React 19 SPA, also packaged as an Android app via Capacitor (`app.tournament.umpire`).
- Dev: `npm run dev:umpire` → `http://localhost:5175` (strictPort). Preview: 4175.
- Key source: `apps/umpire/src/App.jsx` (auth, match list, scoring UI for both human-umpire and court-station identities), `apps/umpire/src/CoinTossPanel.jsx`, `apps/umpire/src/PairingScanner.jsx`, `apps/umpire/src/stationSession.js` (localStorage-persisted court-station credentials).
- Deployed to Vercel project `tournament-umpire`. Android release signing is configured (`keystore.properties` + JKS present on disk, kept out of version control) and produces genuinely signed APK/AAB output — verified via `apksigner verify`.

## Root SPA (`src/`, `index.html`) — LEGACY PickleLive product
- Old MixMatch/PickleLive/NextG single-page app. Full app in `src/App.jsx` (~194KB), `src/lib/{cloud.js,mixmatch.js,dupr.js,ratingEngine.js,tournament*.js}`.
- Run via `legacy:dev` / `legacy:build` / `legacy:test` / `legacy:lint` root npm scripts.
- **Do not connect this app or its Supabase project (`qfyfomiqxouqftrgganh`) to the Tournament project.**

---

# Packages

| Package | Name | Purpose | Notes |
|---|---|---|---|
| `packages/engine` | `@tournament/engine` | Pure domain logic: lifecycle state machines, side-out scoring, single-elim brackets, double-elim, round robin, pool play, standings, seeding, team round robin, team playoffs, team-vs-team, realtime sync helpers | 15 vitest test files, 218 tests passing. No I/O, no `Date.now()` inside logic. |
| `packages/contracts` | `@tournament/contracts` | Command envelope schema, role/format enums shared by client and server | `node --test`, 4 tests passing |
| `packages/api` | `@tournament/api` | Local Hono server (`src/server.js`) mirroring the production Edge Function; exports `handleCommand.js`, `authz.js`, `stationAuth.js`, `writes.js` | 11 unit tests passing, 3 skipped (live tests gated behind `RUN_LIVE_API_TESTS=1`) |
| `packages/client` | `@tournament/client` | Thin Supabase client wrapper: browser client factory, auth redirect URL resolution, deep-link callback parsing, `pairStation`/`refreshStation` helpers | Used by both apps |
| `packages/ui` | `@tournament/ui` | Shared React components/styles | Peer dep `react ^19.2.7` |

**Engine is centralized and not duplicated** — no other file in the repo redefines `applyScoreEvent`, `generateBracket`, or `reduceScoreEvents`. Both apps and the server import the same `packages/engine` functions (server for authoritative writes, clients for optimistic UI).

---

# Authentication

Implemented entirely via Supabase Auth, wrapped by `packages/client/src/index.js`.

- **Client factory**: `createBrowserClient(url, publishableKey)` (`packages/client/src/index.js`) — `persistSession: true`, `autoRefreshToken: true`.
- **Login**: `supabase.auth.signInWithPassword` — `apps/operator/src/App.jsx`, `apps/umpire/src/App.jsx`.
- **Signup** (operator only; no umpire self-signup UI): `supabase.auth.signUp({ email, password, options: { data: { display_name }, emailRedirectTo } })` — `apps/operator/src/App.jsx`.
- **Password reset request**: `supabase.auth.resetPasswordForEmail` — both apps.
- **Password reset completion**: a `RecoveryScreen` component listens for the `PASSWORD_RECOVERY` auth event and calls `supabase.auth.updateUser({ password })` — both apps.
- **Desktop deep-link callback** (Electron uses a custom `tournament-operator://` protocol, not `http`): `applyAuthCallback(supabase, rawUrl)` and `authRedirectUrl()` in `packages/client/src/index.js`; Electron main-process wiring registers the protocol and forwards the callback URL via IPC (`apps/operator/electron/main.cjs`).
- **Session handling**: both apps call `supabase.auth.getSession()` on mount and subscribe via `onAuthStateChange`.
- **Logout**: `supabase.auth.signOut({ scope: "local" })` — local to that client only; logging out of one client does not revoke sessions elsewhere.
- **Server-side identity verification** (never trusts client-declared identity): `resolveActor(admin, jwt)` in `packages/api/src/stationAuth.js` calls `admin.auth.getUser(jwt)`; falls back to verifying a custom HS256 "station JWT" for unattended court devices (see Umpire Flow). Entry point: `packages/api/src/server.js` (`POST /command`).
- Umpires are never self-signup — they are provisioned by an organizer via the `add_member` command.

---

# User Roles

Two independent role systems, both ultimately backed by the database:

1. **Platform role** — `public.profiles.platform_role` (`user` | `admin`), set automatically to `user` on signup (`private.handle_new_user()` trigger on `auth.users`), and **trigger-protected** against client changes (`private.protect_platform_role()`, raises unless caller is `service_role`). Not currently surfaced or checked anywhere in app code beyond the DB-level protection — effectively dormant.
2. **Tournament role** — `public.tournament_members.role` (`organizer` | `admin` | `umpire` | `viewer`), scoped **per tournament**, not global. Granted `organizer` automatically to whoever calls `create_tournament`. Other roles (`umpire`/`viewer`/`admin`) are granted only via the `add_member` command, and only by an existing organizer/admin.

Enforced in three layers, all ultimately checking `tournament_members`:
1. **Command API (authoritative)** — `packages/api/src/authz.js`: `requireOrganizer`, `canScoreMatch`/`requireScoreAccess`, `requireStationScoreAccess`. Every mutating handler in `packages/api/src/handleCommand.js` calls this before doing anything.
2. **Postgres RLS** — `supabase/migrations/0004_rls.sql`: deny-by-default, RLS forced on every domain table; `SELECT` gated by tournament membership; no `INSERT`/`UPDATE`/`DELETE` grants to `anon`/`authenticated` on any domain table except `profiles.display_name`.
3. **Frontend** — surfaces the API's 403 (`FORBIDDEN`) responses; does not itself gate access. This is intentional per `docs/AUTHORIZATION.md` ("Deny by default... authorization is a server responsibility").

There is no "player" role — players exist only as `persons`/`participants` rows, not as `tournament_members`.

---

# Organizer Flow

UI (`apps/operator/src/App.jsx` for auth/dashboard, `apps/operator/src/TournamentDesk.jsx` for everything else) → `command()` wrapper → `sendCommand` (`packages/client/src/index.js`) → `POST {commandUrl}/command` → `packages/api/src/server.js` → `handleCommand()` (`packages/api/src/handleCommand.js`) → per-type handler → `packages/engine` pure functions for any domain computation → `applyBatch`/`apply_official_writes` (`packages/api/src/writes.js` → Postgres RPC defined in `supabase/migrations/0006_court_stations.sql`, refined in `0007_official_writes_present_columns.sql`).

Traced flows (handler names in `handleCommand.js`):
- **Tournament creation** — `create_tournament` → `handleCreateTournament`: validates name, requires an existing `profiles` row, inserts `tournaments` (status `draft`) + `tournament_members` (role `organizer`) in one batch; commit also writes `command_receipts` + `audit_logs`.
- **Lifecycle transitions** — `transition_tournament` → `handleTransitionTournament` → `assertTransitionTournament` (`packages/engine/src/lifecycle.js`): `draft → registration → registration_closed → ready → in_progress → completed → archived`, with `cancelled` reachable from any non-terminal state.
- **Divisions** — `create_division`/`update_division` → `handleCreateDivision`/`handleUpdateDivision`. `format` (`single_elim|double_elim|round_robin|pool|team_elimination`) is enforced only at the DB check-constraint level, not re-validated in the API handler.
- **Participants/teams** — `register_participant`, `add_person`, `create_team`, `add_team_member`, `remove_team_member`, `remove_participant` → matching handlers. Double-booking a person across teams/pairs is prevented server-side via `packages/engine/src/registration.js`.
- **Courts/court assignment** — `create_court` (also mints a `station_public_id` for QR pairing) → `handleCreateCourt`. `assign_court` → `handleAssignCourt` — rejects if the court already has a different **live** match (`COURT_BUSY`), auto-transitions match `scheduled → ready`.
- **Umpire assignment** — `add_member` (role `umpire`) then `assign_umpire` → `handleAssignUmpire` — validates target is already a tournament umpire/organizer/admin, writes `umpire_assignments`, transitions match to `assigned`.
- **Bracket/stage generation** — `generate_bracket` (single-elim, `packages/engine/src/bracket.js`, seeded with byes + optional bronze match) and `generate_team_elimination`/`generate_team_playoffs` (team formats, `packages/engine/src/{teamRoundRobin,teamPlayoffs}.js`) are the only formats reachable end-to-end (see "Known Issues" — double-elim/round-robin/pool are built but unwired). `TournamentDesk.jsx` auto-triggers `generate_team_playoffs` once a team-elimination round-robin stage completes, unless `config.qualifierMode === "manual"`.
- **Live view** — organizer desk subscribes to Supabase Realtime for live match state (see Realtime Architecture); `LiveMatchWindow.jsx` is a read-only popup scoreboard.
- **Completion** — same `transition_tournament` mechanism through to `completed`/`archived`. Per-match results are recorded incrementally in `match_results` as each match finishes (`finishMatchIfWon` in `handleCommand.js`), not as a separate tournament-level completion step.

---

# Umpire Flow

Two distinct identities share the same UI (`apps/umpire/src/App.jsx`):

- **Human umpire account** — signs in with Supabase Auth, sees `MyMatches` (queries `umpire_assignments` filtered to their own `user_id`).
- **Court station device** — no human login; a tablet mounted at a court, paired via QR/pairing code, sees `CourtQueue` (calls `station_sync` instead of querying tables directly).

**Pairing**: organizer opens pairing (`open_court_pairing` → `handleOpenCourtPairing`, mints a token, stores its SHA-256 hash in `court_pairing_grants`, 10-minute expiry, rendered as QR by `apps/operator/src/pairingQr.jsx`) → umpire scans/pastes it (`apps/umpire/src/PairingScanner.jsx`) → `pairStation()` (`packages/client/src/index.js`) → `POST /pair-station` → `handlePairStation` (`packages/api/src/stationAuth.js`): creates a `court_devices` row, signs a custom HS256 "station JWT" (1-hour validity, secret `STATION_JWT_SECRET`) plus an opaque long-lived refresh token. Stored client-side in plain `localStorage` (`apps/umpire/src/stationSession.js`, key `tournament.courtStation`). Refreshed on 401 via `refreshStation()`. Station commands are restricted server-side to a whitelist (`packages/api/src/authz.js`, mirrored client-side in `packages/engine/src/liveSync.js`).

**Match list**: pull-based, refreshed on window focus/visibility and a manual "Refresh" button. **No realtime subscription in the umpire app** (confirmed: no `channel`/`realtime` usage anywhere under `apps/umpire/src`).

**Match start**: `start_match` → `handleStartMatch` → `assertTransitionMatch(..., "in_progress")` → `scoreStateForMatchStart` (`packages/engine/src/scoring.js`) builds initial score state from division config (`winTo`/`winBy`/`bestOf`/`isDoubles`/`timeoutsAllowed`).

**Coin toss**: `CoinTossPanel.jsx` (client-side animation using `crypto.getRandomValues`) → `coin_toss` command → `handleCoinToss`, idempotent by `event_id`, appends a `score_events` row and sets `matches.serving_team`/`coin_toss`.

**Live scoring (the core end-to-end flow)**:
1. UI → `sendScore(type, extra)` (`apps/umpire/src/App.jsx`).
2. **Optimistic apply**: `applyOptimisticScore` (`packages/engine/src/optimisticScore.js`), itself calling the same pure reducer `applyScoreEvent` (`packages/engine/src/scoring.js`) — updates local React state immediately.
3. **Network**: `sendCommand({ type: "score_event", payload: { match_id, event_id, seq, type, payload } })` → `POST /command`.
4. **Server authorize + domain**: `handleScoreEvent` (`handleCommand.js`) → `authorizeMatchOperation` (resolves station-vs-user identity) → match must be `in_progress` → dedupe by `event_id` → `applyScoreEvent`, re-derived server-side (fast-forwarded from cached state or fully re-reduced via `reduceScoreEvents` for out-of-order safety).
5. **DB write**: batched via `packages/api/src/writes.js` → `score_events` insert + `matches.score_state` upsert → `apply_official_writes` RPC (service-role-only).
6. **Realtime broadcast**: because `matches`/`score_events`/`match_results`/`court_assignments` are in the `supabase_realtime` publication, any subscriber (organizer desk, live-match window) receives the change automatically. The umpire app itself relies on its own optimistic state + the HTTP response, not realtime.
7. **Reconciliation**: on success, server-authoritative state is merged in, keeping whichever state has the higher `lastSeq` (`packages/engine/src/optimisticScore.js`). On failure, the optimistic update is rolled back and a fresh load is issued.
8. **Match completion/advancement**: when the reducer marks the match `completed`, `handleScoreEvent` calls `finishMatchIfWon` in the same request — writes `match_results` and patches the next bracket match's participant slots (`packages/engine/src/bracket.js` or `teamVsTeam.js`) in the same batch. `complete_match` → `handleCompleteMatch` is an explicit organizer/umpire confirmation step that re-derives the winner from stored events if not already finalized.

---

# Tournament Architecture

Centralized in `packages/engine/src/*.js`, exported through `packages/engine/src/index.js`. Pure functions (no I/O). Consumed by both the server (authoritative) and the clients (optimistic UI) — no duplicated logic elsewhere.

- **Lifecycle** (`lifecycle.js`) — explicit adjacency-list transition tables for tournament and match status; `assertTransitionTournament`/`assertTransitionMatch` throw `ILLEGAL_TRANSITION`.
- **Brackets** — single-elim seeding/generation/advancement + optional bronze match (`bracket.js`, **wired**); double-elim generation/advancement (`doubleElimination.js`, **built but not wired to any command/UI**).
- **Round robin / pools** (`roundRobin.js`, `poolPlay.js`, `standings.js`) — **built but not wired**.
- **Seeding** (`seeding.js`) — manual/random/DUPR/internal-ranking/team-ranking/previous-results strategies — **built but not wired** (DUPR seeding in particular reads a `playerDuprRatings` field that doesn't exist anywhere in the current schema).
- **Team-vs-team formats** (`teamVsTeam.js`, `teamRoundRobin.js`, `teamPlayoffs.js`) — the one multi-stage format that is fully wired end-to-end (round robin → qualifier selection → knockout playoffs, with same-team-avoidance seeding and bronze-medal advancement).
- **Audit/event logging** — every command commit writes both a `command_receipts` row (idempotency, keyed by client-generated `command_id`) and an `audit_logs` row, enforced structurally in the shared `commit()` helper (`handleCommand.js`), not per-handler.
- **Validation** — role/authorization validation lives in `packages/api/src/authz.js`, deliberately separate from the domain-pure engine.

**Only `single_elim` and `team_elimination` division formats are reachable end-to-end today.** `double_elim`, `round_robin`, and `pool` are accepted by the DB schema and contracts, and fully implemented and tested in the engine, but no command handler or UI wires them up. Treat this as a known gap, not a shipped feature, when asked to work on those formats.

---

# Match/Scoring Architecture

Event-sourced pickleball **side-out** scoring (not rally scoring). Core reducer: `packages/engine/src/scoring.js` — `createInitialScoreState`, `applyScoreEvent` (event types: `point`, `undo`, `timeout`, `coin_toss`), `reduceScoreEvents` (full replay from an ordered event list — this is the server's source-of-truth reconstruction path for out-of-order or missed events). Config knobs (`winTo`, `winBy: two|one|none`, `bestOf`, `isDoubles`, `timeoutsAllowed`) come from a division's `config` jsonb, read via `scoringSettings()` in `handleCommand.js`.

Every score event has a client-generated UUID (`event_id`) and monotonic `seq`; the server dedupes on `score_events.id` (unique `(match_id, seq)`) and rejects out-of-order `seq` with `OUT_OF_ORDER`. See Umpire Flow above for the full end-to-end write path.

---

# Database Architecture

Project: **Tournament App** (`evuvgxruavnadpbiehgb`, `ap-southeast-1`). Confirmed live-linked via `supabase/config.toml` and `supabase/.temp/linked-project.json`.

**⚠️ Two schemas exist on disk — only one is current:**
- `supabase/migrations/0001–0010` — **current, active** schema (this section).
- `supabase/migrations-applied/` (144 files, `01`–`144`) — **legacy PickleLive schema history** (players/accounts/events/clubs/matches/messages/posts/live_matches/friend_requests, DUPR integration, etc.). Not referenced by `config.toml`. Kept on disk for historical reference only. The base schema its earliest migration assumes (`01_mixmatch_core.sql`) is not itself defined anywhere in this folder — it predates this migration history (UNKNOWN origin, likely created via dashboard).

## Current schema — key tables (`supabase/migrations/0001_initial_schema.sql` unless noted)

| Table | Purpose |
|---|---|
| `profiles` | One row per `auth.users`; `platform_role` (`user`\|`admin`, trigger-protected) |
| `tournaments` | Owned by a profile; `status` enum; `settings` jsonb |
| `tournament_members` | Per-tournament role (`organizer`\|`admin`\|`umpire`\|`viewer`), unique per (tournament, user) |
| `divisions` | `format` (`single_elim`\|`double_elim`\|`round_robin`\|`pool`\|`team_elimination`), `config` jsonb |
| `persons` | Tournament-scoped roster entry, optional link to a `profiles`/`user_id` |
| `teams` / `team_members` | Team grouping for team-elimination format |
| `participants` / `participant_members` | Division-scoped registered entries (singles/doubles/team_pair) and their person slots |
| `courts` | Includes `station_public_id` (unique, for QR pairing) |
| `stages` | Per-division stage config |
| `matches` | Core match object: parent/child bracket links, round/bracket position, status, score_state jsonb, serving team, coin_toss jsonb, next-match/loser-next-match advancement pointers |
| `match_participants` | Slot A/B → participant or team |
| `score_events` | Event-sourced scoring log; id = event UUID PK; unique `(match_id, seq)` |
| `match_results` | Official completion snapshot |
| `court_assignments` / `umpire_assignments` | Current court/umpire per match |
| `court_devices` / `court_pairing_grants` | Added in `0006` — unattended court-station device auth |
| `command_receipts` | Idempotency ledger by `command_id` |
| `audit_logs` | Full audit trail of every command |

## Functions / triggers

| Function | Trigger | Purpose |
|---|---|---|
| `private.handle_new_user()` | `on_auth_user_created` on `auth.users` (AFTER INSERT) | Auto-create `profiles` row |
| `private.protect_platform_role()` | `protect_platform_role` on `profiles` (BEFORE UPDATE) | Block client changes to `platform_role` |
| `private.touch_updated_at()` | `tournaments_touch`, `divisions_touch`, `matches_touch` (BEFORE UPDATE) | Maintain `updated_at` |
| `private.is_tournament_member(uuid)` | — (RLS helper) | Membership check |
| `private.match_tournament_id(uuid)` | — (RLS helper) | Resolve match → tournament for RLS |
| `public.apply_official_writes(jsonb)` | — (SECURITY DEFINER, service_role only) | **Sole transactional write path** for the entire engine |

## RLS posture

`supabase/migrations/0004_rls.sql` (plus `0006_court_stations.sql`, which adds `court_devices`/`court_pairing_grants`): RLS **enabled and forced** on all 21 domain tables, deny-by-default. `SELECT` policies gated by tournament membership. The only write grant to `anon`/`authenticated` on any table is `UPDATE (display_name, updated_at)` on `profiles`. All real writes happen through `apply_official_writes`, `EXECUTE` granted only to `service_role`/`postgres`/`supabase_admin`. **Note**: `0004_rls.sql` never explicitly revoked the Supabase-default `UPDATE` grant on `profiles` before adding the narrow column grant (unlike every other table, which does both) — live-confirmed to have let `authenticated` users overwrite their own `profiles.created_at`. Fixed by `0010_profiles_update_grant_revoke.sql`, live-verified via `information_schema.column_privileges` and a real update-attempt test.

## Migration history (current schema)

| File | Purpose |
|---|---|
| `0001_initial_schema.sql` | Core schema, indexes |
| `0002_auth_profiles.sql` | Auth trigger, platform-role protection, updated_at triggers |
| `0003_official_writes.sql` | Initial `apply_official_writes` |
| `0004_rls.sql` | RLS helper functions + force-RLS policies on all tables |
| `0005_touch_updated_at_search_path.sql` | Security-advisor fix (mutable search_path) + unique index for team-elimination pair matches |
| `0006_court_stations.sql` | Court-station device auth tables; extends `apply_official_writes` |
| `0007_official_writes_present_columns.sql` | Bug fix: only write columns actually present in the payload (avoids NULL-overwriting defaults) |
| `0008_realtime.sql` | Enables Realtime on `matches`/`score_events`/`match_results`/`court_assignments` |
| `0009_desktop_updates_storage.sql` | Public storage bucket `desktop-updates` for Electron auto-update artifacts |
| `0010_profiles_update_grant_revoke.sql` | Security fix: revokes the broad default `UPDATE` grant on `profiles` from `anon`/`authenticated` before re-asserting the intended `display_name`/`updated_at`-only column grant, matching the pattern every other table already used |

**Note on the live migration ledger**: the local `supabase/migrations/` files are squashed/renamed relative to the project's actual 13-entry Supabase migration history (`list_migrations` shows 14 now, including `0010`), which still uses the original timestamp-prefixed version identifiers. CLI tooling (`supabase db push`/`migration list`/`migration repair`) may not recognize these local filenames as already-applied — reconcile before relying on CLI-driven migration workflows for this project.

**⚠️ Flag for follow-up**: `supabase/functions/{submit-match,dupr-webhook-receiver,link-dupr-account}` query tables (`matches.data` jsonb blob, `dupr_match_submissions`, `tournament_divisions`) that exist only in the **legacy** schema, not in `migrations/0001–0010`. These functions have no entry in `config.toml`. Whether they are dead code or intentionally still deployed against the legacy Supabase project is UNKNOWN — clarify with the user before touching or assuming either way.

---

# Realtime Architecture

Supabase Realtime `postgres_changes` — no custom WebSocket server, no polling as the primary mechanism for the operator app (the umpire app *is* poll-based; see Offline Architecture / Umpire Flow).

- Enabled at the DB level (`supabase/migrations/0008_realtime.sql`): `matches`, `score_events`, `match_results`, `court_assignments` added to the `supabase_realtime` publication, `REPLICA IDENTITY FULL` on each.
- Generic subscription hook: `useRealtimeChannel` (`apps/operator/src/useRealtimeChannel.js`), wraps events in a catch-up buffer (`createCatchupBuffer()`, `packages/engine/src/liveSync.js`) so events arriving before the initial load finishes are queued and replayed rather than lost.
- Channel names (centralized in `packages/engine/src/liveSync.js`):
  - `desk-live:{tournamentId}` — organizer desk-wide, used by `TournamentDesk.jsx`. Subscribes to `matches` (filtered by tournament), `match_results`, `court_assignments`.
  - `live-match:{matchId}` — single-match read-only scoreboard, used by `LiveMatchWindow.jsx`.
- Freshness/ordering safety: `isFresherRow`/`upsertById`/`applyMatchIfScoped` (`liveSync.js`) compare `score_state.lastSeq` (falling back to `updated_at`) so out-of-order or duplicate realtime payloads can never overwrite newer local state.
- **The umpire app has no realtime subscription** — deliberately pull-based (confirmed: no `channel`/`realtime` usage anywhere under `apps/umpire/src`).

---

# Offline Architecture

**No durable offline queue/outbox exists.** No IndexedDB, no localStorage-backed pending-command queue, no service worker (confirmed: no `indexedDB`/`outbox`/`serviceWorker`/`workbox` usage anywhere under `apps/`). `localStorage` usage is limited to `apps/umpire/src/stationSession.js`, which only stores court-station pairing credentials, not queued score events.

What exists instead is **optimistic-UI-with-rollback**, which is a weaker guarantee:
- `sendScore()` (`apps/umpire/src/App.jsx`) applies the score event to local state immediately, then fires the network request. On failure, it rolls the UI back to the pre-event snapshot, surfaces an error, and reloads from the server.
- If the app closes or the device goes offline before the request reaches the network, **the unsent point is silently lost** — nothing replays it on reconnect, because it was never persisted anywhere durable.
- Idempotency (`event_id`/`seq` dedup, `command_id` dedup) makes *retries of a request that did reach the network* safe, but does nothing for requests that never left the device.
- Reconnection recovery: both umpire screens reload on window focus/visibility change, and skip reloading while a score write is still in flight (to avoid clobbering an optimistic update with stale server data mid-flight).

**If a future task requires umpires to keep scoring reliably through a real network outage, this is a gap to design for, not an existing feature to build on.**

---

# Deployment Architecture

- **Vercel**: two independent projects — `tournament-operator` and `tournament-umpire` — each linked per-app (`apps/operator/.vercel/project.json`, `apps/umpire/.vercel/project.json`) and deployed via `vercel --prod` from inside each app directory, which uses that app's own `vercel.json`. **Four Vercel config files still exist** (`vercel.operator.json`, `vercel.umpire.json` at root; `apps/operator/vercel.json`, `apps/umpire/vercel.json` per-app) — redundant but not broken; the per-app link/deploy path above is the one actually used. Both `installCommand`s now include `--ignore-scripts` as a supply-chain hardening measure for the Vercel build environment.
- Both production URLs (`tournament-operator.vercel.app`, `tournament-umpire.vercel.app`) are confirmed, as of this release-hardening pass, to be serving the current repo's build (verified by exact bundle content-hash match against a local build, plus a passing live API test suite against the same backend both apps call).
- **Electron (Windows, operator)**: `npm run build:desktop -w @tournament/operator` → electron-builder + NSIS installer (`apps/operator/build/installer.nsh` also writes a desktop shortcut). Auto-update reads from the public Supabase Storage bucket `desktop-updates` (`supabase/migrations/0009_desktop_updates_storage.sql`, uploaded via `scripts/publish-desktop-update.mjs`) — confirmed this is a real, live-reachable feed, not a placeholder. The installer itself is confirmed **unsigned** (`Get-AuthenticodeSignature` → `NotSigned`); no certificate is configured anywhere in the builder config.
- **Capacitor (Android, umpire)**: `npm run build:android -w @tournament/umpire` then Gradle (`apps/umpire/android`). Requires JDK 17/21 (not 25). Release signing **is configured** — `apps/umpire/android/keystore.properties` and the JKS both exist on disk (kept out of version control) — and produces a genuinely signed `app-release.apk`/`app-release.aab`, confirmed via `apksigner verify --print-certs`. Physical on-device testing remains unverified (no device available in this environment).
- **No CI/CD** — no `.github/workflows` or other CI config found anywhere. Release verification is entirely manual, tracked in `docs/PUBLIC_RELEASE_AUDIT.md`, `docs/FINAL_PUBLIC_RELEASE_REPORT.md`, and (as of this pass) a full FINAL RELEASE READINESS AUDIT plus a POST-AUDIT RELEASE HARDENING pass captured in project history/commit messages rather than a separate report file.
- Per the most recent manual release report (dated 2026-08-29): hosted Supabase Auth Site URL and email confirmation were owner-action items pending against the live Supabase dashboard. **These are dashboard-only settings not visible from source — re-verify directly against the dashboard before relying on them**; nothing in this repo's code can confirm or deny their current state.
- **Version control**: this repository now has a real git history (previously had none — `git init` plus an initial commit was part of this hardening pass). Package versions diverge across workspaces (root `1.0.0`, operator `1.1.0`, umpire `1.3.0`); rather than inventing one misleading top-level version, the initial commit is tagged both `operator-v1.1.0` and `umpire-v1.3.0`.

---

# Important Files

| File | Role |
|---|---|
| `packages/api/src/handleCommand.js` | Every command handler; the authoritative mutation entry point |
| `packages/api/src/authz.js` | Role/authorization checks (organizer/umpire/station) |
| `packages/api/src/stationAuth.js` | JWT + custom station-JWT identity resolution, pairing/refresh |
| `packages/api/src/writes.js` | Batches writes into `apply_official_writes` |
| `packages/engine/src/index.js` | Barrel export for all pure domain logic |
| `packages/engine/src/scoring.js` | Core event-sourced scoring reducer |
| `packages/engine/src/lifecycle.js` | Tournament/match status machines |
| `packages/engine/src/bracket.js` | Single-elim bracket generation/advancement (wired) |
| `packages/engine/src/{doubleElimination,roundRobin,poolPlay,standings,seeding}.js` | Built but **not wired** — see Tournament Architecture |
| `packages/engine/src/liveSync.js` | Realtime channel names, catch-up buffer, freshness comparison |
| `packages/client/src/index.js` | Supabase client factory, auth redirect/callback helpers, station pairing |
| `apps/operator/src/{App.jsx,TournamentDesk.jsx}` | Organizer app UI and command orchestration |
| `apps/umpire/src/App.jsx` | Umpire app UI, scoring pipeline, both identity types |
| `supabase/migrations/0004_rls.sql` | RLS policy definitions (security-critical) |
| `supabase/migrations/0006_court_stations.sql`, `0007_official_writes_present_columns.sql` | Current `apply_official_writes` definition (security-critical) |
| `legacy/README.md` | Guardrail: do not connect legacy code to the Tournament Supabase project |
| `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/AUTHORIZATION.md`, `docs/API.md` | Existing hand-maintained docs, concise and accurate as of this audit |

---

# Important APIs

Single production endpoint: `POST https://evuvgxruavnadpbiehgb.supabase.co/functions/v1/command` (Edge Function `command`, `verify_jwt: true`). Local equivalent: `packages/api` (`POST /command`, Hono).

Request: `{ "command_id": "<uuid>", "type": "<command>", "payload": {...} }`, header `Authorization: Bearer <user access token>`.

| Command type | Who |
|---|---|
| `create_tournament` | any authenticated user (becomes organizer of that tournament) |
| `update_tournament`, `transition_tournament` | organizer/admin |
| `create_division`, `update_division` | organizer/admin |
| `add_person`, `create_team`, `add_team_member`, `remove_team_member`, `register_participant`, `remove_participant` | organizer/admin |
| `create_court`, `add_member` | organizer/admin |
| `generate_bracket`, `generate_team_elimination`, `generate_team_playoffs` | organizer/admin |
| `assign_court`, `assign_umpire`, `transition_match` | organizer/admin |
| `open_court_pairing` | organizer/admin |
| `start_match`, `coin_toss`, `score_event`, `complete_match` | assigned umpire, paired court station, or organizer/admin |

Duplicate `command_id` returns the stored result (`idempotent: true`). Duplicate `score_event`'s `event_id` returns the current reduced state without reapplying.

---

# Important Database Tables

See **Database Architecture** above for the full table list. The tables most relevant to any future change:
- `matches`, `score_events`, `match_results` — the live scoring path (realtime-enabled, `apply_official_writes`-only writes).
- `tournament_members` — the authorization source of truth.
- `command_receipts` / `audit_logs` — idempotency and audit; every handler writes both via the shared `commit()` helper.

---

# Important Migrations

`supabase/migrations/0001` through `0010` (current schema — see table under Database Architecture for what each does). Migrations are additive/append-only; `0005` and `0007` are bug-fix follow-ups to `0002` and `0003`/`0006` respectively, not reverts.

**Do not confuse these with `supabase/migrations-applied/` (144 files) — that is the unrelated legacy PickleLive schema history and is not applied to the current project.**

---

# Tests

- **Framework**: Vitest (`packages/engine`, `packages/api`, root/legacy) + Node's built-in `node --test` (`packages/contracts`, `apps/operator/electron/updatePolicy.test.cjs`).
- **Locations**: `packages/engine/src/*.test.js` (15 files), `packages/contracts/src/index.test.js`, `packages/api/src/*.test.js` (stationAuth, authz, live), `apps/operator/electron/updatePolicy.test.cjs`, legacy `src/lib/*.test.js` (11 files, legacy product only).
- **No Playwright/Cypress e2e suite** — `scripts/electron-*.mjs` are manual/ad hoc CDP-driven QA scripts, not automated tests.
- **No CI** — nothing runs these automatically; they must be run manually.

---

# Current Build/Test Status

(Executed during this audit — all read-only.)

| Command | Result |
|---|---|
| `npm test` | **PASS** — engine 218/218, contracts 4/4, api 11 passed / 3 skipped (live-integration tests gated behind `RUN_LIVE_API_TESTS=1`) |
| `npm run lint` | **PASS (non-functional)** — every current-product workspace (`api`, `client`, `contracts`, `engine`, `ui`, `operator`, `umpire`) runs a no-op stub (`node -e "process.exit(0)"`); nothing in the current product is actually linted |
| `npm run legacy:lint` | **FAIL** — 39 `no-unused-vars` errors in legacy `src/App.jsx` (legacy product only, pre-existing) |
| `npm run typecheck` | **NOT TESTED** — literal no-op stub printing "no TypeScript typecheck in this repo"; no real TypeScript checking exists anywhere in the repo despite Edge Functions being written in `.ts` |
| `npm run build` | Not re-run in this audit; per `docs/FINAL_PUBLIC_RELEASE_REPORT.md` (2026-08-29) it passed for both operator and umpire web builds — re-verify if relevant to a task |

---

# Known Issues

- **No durable offline queue for umpire scoring** — an unsent point is lost if the device drops before the request completes (see Offline Architecture).
- **`double_elim`, `round_robin`, `pool` division formats are built in the engine but not wired to any command handler or UI.** Only `single_elim` and `team_elimination` work end-to-end.
- **DUPR/seeding strategies in `packages/engine/src/seeding.js` are unwired** and reference a `playerDuprRatings` field absent from the current schema.
- **No player-facing app** — only operator and umpire apps exist.
- **`npm run lint` and `npm run typecheck` are non-functional stubs** for the current product — no real static analysis coverage exists.
- **No CI/CD** — all release verification is manual and tracked in dated markdown reports.
- **Windows installer is unsigned** — no code-signing certificate configured (`apps/operator/package.json`'s builder config has no `certificateFile`/`cscLink`); confirmed via `Get-AuthenticodeSignature` returning `NotSigned` on a freshly-built installer. SmartScreen will warn on install. Owner action required to obtain and wire a certificate, or accept unsigned distribution.
- **Windows/Electron runtime could not be conclusively verified in this repo's automation environment** — the packaged app launches and stays responsive but does not produce a visible window here; ruled out a crash (no logged Application Error event) and ruled out a missing display (other GUI apps show real windows on the same desktop). Most consistent with a known class of Electron/Chromium GPU-compositor initialization issue in constrained/virtualized rendering environments, not an app code defect (standard `BrowserWindow`/`app.whenReady()` pattern, no `show:false` gate). Verify on an ordinary physical Windows desktop before relying on this build.
- Android release signing **is** configured and produces genuinely signed APK/AAB output (see Deployment Architecture) — physical on-device testing remains **NOT VERIFIED** (no device available in this environment); this is a distinct, still-open owner/device gate.
- **Four redundant/overlapping Vercel config files** for two deployments.
- **Three Supabase Edge Functions (`submit-match`, `dupr-webhook-receiver`, `link-dupr-account`) reference tables that don't exist in the current schema** — status (dead code vs. deployed against the legacy project) is UNKNOWN; clarify before touching.
- **`profiles.platform_role` admin tier is dormant** — protected at the DB level but never set or checked by any command/UI.
- **`supabase/config.toml` sets `verify_jwt = false`** for the `command`/`pair-station` Edge Functions (verification happens inside the function code instead, documented inline) — this contradicts other docs in this repo claiming `verify_jwt = true`; the local file and the live dashboard function setting may have diverged (the local config does not push to the hosted dashboard). Reconcile directly against the live Supabase function settings before trusting either claim.
- Per the last manual release audit (2026-08-29): hosted Supabase Auth Site URL still pointed at `localhost`, email confirmation was off. **Re-verify current state against the live Supabase dashboard before assuming this is still true** — it is a dashboard-only setting not visible from source.
- As of this release-hardening pass: both `tournament-operator.vercel.app` and `tournament-umpire.vercel.app` are confirmed serving the current audited build (bundle content hash matches the local build exactly), git version control now exists (see below), and the `profiles` RLS gap above this list has been fixed and live-verified.

---

# Legacy / Duplicate Code

Classification scheme: **A. ACTIVE, B. PROBABLY ACTIVE, C. LEGACY, D. DUPLICATE, E. UNKNOWN.**

| Item | Classification | Evidence |
|---|---|---|
| `apps/operator`, `apps/umpire`, `packages/{engine,contracts,api,client,ui}`, `supabase/migrations/0001-0010`, `supabase/functions/{command,pair-station}` | **A. ACTIVE** | Current product, current schema, referenced by `config.toml`, tests passing |
| `packages/engine/src/{doubleElimination,roundRobin,poolPlay,standings,seeding}.js` | **B. PROBABLY ACTIVE (dormant)** | Real, tested code; not legacy; simply unreachable from any command/UI today |
| Root `src/`, `index.html`, root `vite.config.js`, root `dist/`, `supabase/migrations-applied/`, `supabase/functions/{submit-match,dupr-webhook-receiver,link-dupr-account,_shared}` | **C. LEGACY** | `legacy/README.md` explicit warning; distinct Supabase project (`qfyfomiqxouqftrgganh`); schema mismatch against current `migrations/` |
| `vercel.operator.json`, `vercel.umpire.json`, `apps/operator/vercel.json`, `apps/umpire/vercel.json` | **D. DUPLICATE** | Two alternate strategies (root-relative vs. per-app-relative `outputDirectory`/build command) for the same two Vercel deployments |
| `profiles.platform_role` admin tier | **E. UNKNOWN** | Exists in schema/trigger; never set or read by any command or UI found |
| Whether `submit-match`/`dupr-webhook-receiver`/`link-dupr-account` are dead code or still deployed against the legacy Supabase project | **E. UNKNOWN** | No `config.toml` entry; queries legacy-only tables; not confirmed either way |

---

# Architectural Rules

1. **The current architecture (Tournament product) is the baseline.** Do not redesign it based on personal preference.
2. **Two products, two Supabase projects — never cross-wire them.** Legacy PickleLive code/schema (`src/`, `migrations-applied/`, DUPR edge functions) must never be connected to the Tournament Supabase project (`evuvgxruavnadpbiehgb`), and vice versa.
3. **All domain logic lives in `packages/engine` and is pure.** New domain logic belongs there, not duplicated into `apps/operator` or `apps/umpire`.
4. **All writes go through `apply_official_writes` via the command API.** Never grant direct table write access to `anon`/`authenticated` roles.
5. **Migrations are append-only.** Add a new migration file; never edit an existing one in `supabase/migrations/`.
6. **Authorization is a server responsibility**, enforced in `packages/api/src/authz.js` and mirrored by RLS — not solely a frontend concern.
7. **Server never trusts client-declared identity** — every command re-verifies the JWT (or station JWT) server-side.

---

# Safe Change Rules

When asked to implement a future task:
1. Locate the existing implementation (this document + the existing `docs/*.md` files are the starting point; verify against current source, since code may have moved on).
2. Understand its dependencies — trace UI → command → engine → database, as mapped above.
3. Identify the smallest safe change.
4. Check what else depends on it (e.g., a change to `score_events`/`scoring.js` affects both apps' optimistic UI and the server's authoritative reducer — they must stay in sync since they're the same shared code).
5. Implement only the requested change — do not "clean up" the four redundant Vercel configs, wire up the dormant engine modules, or touch the legacy product unless specifically asked.
6. Run relevant tests (`npm test`, and the specific workspace's tests) before reporting done.
7. Report exactly what changed and what was intentionally left alone.

---

# Things That Must NOT Be Changed Without Explicit Approval

- `supabase/migrations/*` — append-only; never edit an existing migration file.
- RLS policies (`0004_rls.sql`) and `apply_official_writes` (`0006_court_stations.sql`/`0007_official_writes_present_columns.sql`) — security-critical; changes here affect every write path in the system.
- Anything in `supabase/migrations-applied/` or the legacy `src/`/root SPA — do not extend, "modernize," or connect to the current Supabase project.
- Authentication/session logic in `packages/client/src/index.js` and `packages/api/src/stationAuth.js` — touches production Auth and the custom desktop deep-link/station-JWT mechanisms.
- Deployment configuration (the four Vercel configs, `supabase/config.toml`, Electron auto-update/signing, Android keystore setup) — changes here can break live production deployments.
- Do not delete `packages/engine/src/{doubleElimination,roundRobin,poolPlay,standings,seeding}.js` as "unused" — they are real, tested, dormant features, not dead code.
