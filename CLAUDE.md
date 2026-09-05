# Operating Rules for This Repository

This is an **existing, production-oriented tournament platform**, not a greenfield project. The current implementation is the **authoritative baseline**. Do not redesign, refactor, or "improve" it beyond what a task explicitly asks for. When in doubt, read more code — do not guess or improvise architecture.

Required reading before any task: **`docs/CLAUDE_PROJECT_CONTEXT.md`** — the architecture/feature/database reference for this repo (two products: current **Tournament** platform vs. legacy **PickleLive**; full data flows; known gaps). This file (`CLAUDE.md`) governs *how* to work; that file describes *what exists*. Re-read the relevant sections before every task — code may have moved on since the audit date noted there.

## 1. Before touching any code

1. Read `docs/CLAUDE_PROJECT_CONTEXT.md` (at least the sections relevant to the task).
2. Identify the exact app/package involved (`apps/operator`, `apps/umpire`, `packages/engine`, `packages/api`, `packages/contracts`, `packages/client`, `packages/ui`, `supabase/*`, or legacy root `src/`).
3. Identify the exact files responsible for the requested behavior — don't assume, grep/read to confirm.
4. Trace the relevant data flow: UI → command → `packages/api/src/handleCommand.js` → `packages/engine` → `apply_official_writes` → Postgres → Realtime, as applicable.
5. If a shared module is involved (`packages/engine`, `packages/client`, `packages/contracts`, `packages/ui`), identify every consumer before changing it (see §4).
6. Classify which subsystem(s) the task touches: Organizer / Umpire / Tournament engine / Match engine / API-command layer / Database / Realtime / Authentication / Android / Windows / Legacy PickleLive.
7. State a short **change plan** (in-scope files, what will change, why) before editing.

## 2. Scope lock

Every task gets an explicit in-scope / out-of-scope list. Example:

> TASK: "Fix umpire score submission."
> IN SCOPE: `apps/umpire/src/App.jsx`, `packages/api/src/handleCommand.js` (score_event handler), `packages/engine/src/scoring.js`, relevant tests.
> OUT OF SCOPE: organizer UI, authentication, bracket generation, database schema, legacy PickleLive, unrelated components.

Only modify files necessary to accomplish the requested task.

## 3. No unrelated refactoring

Do not: rewrite working architecture; rename files/folders in bulk; reorganize directories; swap libraries or upgrade dependencies without approval; rewrite working components "while you're in there"; redesign the database; touch unrelated migrations; delete code because it looks old or unused; remove dormant functionality (§9); modify legacy PickleLive (§8), DUPR functionality, bracket formats, or authentication unless the task specifically asks for it.

A task is not permission to improve everything nearby. Implement the smallest safe change that satisfies the literal request — "fix X" is not "redesign X"; "add Y" is not "refactor the system around Y."

## 4. Shared code safety rule

Before changing anything in `packages/engine`, `packages/client`, `packages/contracts`, or `packages/ui`, trace every consumer first. These packages flow into both apps:

```
packages/engine → packages/api (server, authoritative) → apps/operator + apps/umpire (client, optimistic UI)
```

A change to `packages/engine/src/scoring.js`, for example, affects the server's authoritative reducer *and* both apps' optimistic local state, because they call the exact same function. Never assume a shared-code change is isolated to the app you're currently looking at.

## 5. Domain engine protection (`packages/engine`)

Before modifying it:
1. Identify all callers (grep across `packages/api` and both `apps/*`).
2. Identify all tests (`packages/engine/src/*.test.js` — currently 15 files).
3. Determine whether the behavior is shared by organizer and umpire.
4. Determine whether command handlers in `packages/api/src/handleCommand.js` depend on it.
5. Run `npm test -w @tournament/engine` before and after the change.

Never modify scoring or tournament rules casually — this is the core of the product.

## 6. Database protection

Never modify `supabase/migrations/*`, RLS policies, database functions, or triggers unless the task explicitly requires it. Migrations are append-only — never edit an existing file.

If a database change appears necessary, **stop and explain**:
1. Why it's necessary.
2. Which tables are affected.
3. Which RLS policies are affected.
4. What existing functionality could be affected.
5. What migration would be required.

Wait for explicit approval before writing or applying it. Do not confuse `supabase/migrations/` (current schema) with `supabase/migrations-applied/` (legacy — see §8).

## 7. Legacy code protection

Treat as legacy, hands-off unless explicitly requested: root `src/`, root `index.html`/`vite.config.js`/`dist/`, `supabase/migrations-applied/`, and the DUPR edge functions (`supabase/functions/{submit-match,dupr-webhook-receiver,link-dupr-account,_shared}`). Never modify them just because they appear unused, and never connect them to the current Tournament Supabase project (`evuvgxruavnadpbiehgb`) — see `legacy/README.md`.

## 8. Dormant feature protection

`packages/engine` contains real, tested functionality that is not wired into any command handler or UI: double elimination (`doubleElimination.js`), round robin (`roundRobin.js`), pool play (`poolPlay.js`), and DUPR-based seeding (`seeding.js`). Do not wire, delete, simplify, or refactor these without an explicit request — they are deliberately dormant, not dead code.

## 9. Authentication protection

Do not modify Supabase Auth flow, JWT handling, authorization (`packages/api/src/authz.js`), RLS, redirect handling, desktop deep-link auth (`packages/client/src/index.js`, `apps/operator/electron/main.cjs`), or the station-JWT scheme (`packages/api/src/stationAuth.js`) unless authentication is explicitly part of the task. If it is touched, do a focused security review and regression test before reporting done.

## 10. Realtime / scoring protection

Preserve the existing authoritative pipeline:

```
client → command → authorization → engine → apply_official_writes → Postgres → realtime
```

Never make client-side state the source of truth, or bypass `apply_official_writes` for a "quicker" write path. This is a deliberate architectural property, not an oversight.

## 11. Offline claims

The umpire app (`apps/umpire`) has **no durable offline queue** — confirmed in the audit. Never claim "offline scoring is supported" unless durable offline synchronization has actually been implemented and tested. If a device disconnects before a scoring request reaches the server, the point may be lost — treat it as such in any user-facing statement or design discussion.

## 12. Test-first verification

Baseline (as of the last full audit): `npm test` = 233 passing (218 `@tournament/engine` + 4 `@tournament/contracts` + 11 `@tournament/api`, 3 skipped live-integration tests gated behind `RUN_LIVE_API_TESTS=1`). `npm run lint` and `npm run typecheck` are non-functional no-op stubs for the current product — do not cite them as real verification.

Before modifying important logic, run the smallest relevant existing test suite. After modifying:
1. Run relevant tests.
2. Run broader tests when practical (`npm test` at root).
3. Build affected apps (`npm run build -w @tournament/operator` / `@tournament/umpire`) when the change could affect a build.
4. Check for regressions.

Never claim tests pass unless they were actually run. If a test cannot run, report **BLOCKED** and explain why.

## 13. Failure handling

If something breaks during implementation: identify the regression, determine which change caused it, revert the unrelated change if necessary, fix the root cause, re-run relevant tests. Do not immediately rewrite unrelated code to make a failure "go away." Never hide failures.

## 14. Before/After report

For every implementation task, report:

- **BEFORE**: current behavior, relevant files, known limitation.
- **CHANGE**: files modified, what changed, why.
- **AFTER**: tests run, build result, behavior verified.
- **REGRESSION CHECK**: unrelated systems checked, results.

## 15. Stop conditions

Stop and ask the user before proceeding if: the request conflicts with the current architecture; multiple valid architectural approaches exist; a database migration appears necessary; authentication/security must change; a legacy module may need reactivating; a dormant feature (§8) may need wiring; a shared domain rule needs to change; requirements are ambiguous; or implementing the request would require broad unrelated changes. Do not guess.

## 16. Architectural changes require explicit approval

These are never implicit, even if they seem like a natural improvement: replacing Supabase; replacing the API/command architecture; replacing `packages/engine`; changing event sourcing; changing the scoring architecture; replacing React/Vite; replacing Capacitor or Electron; changing the authentication architecture; changing the database architecture.

## 17. The goal

Make the requested change. Preserve existing working functionality. Minimize regression risk. Verify the result. Not "produce the most elegant code possible."
