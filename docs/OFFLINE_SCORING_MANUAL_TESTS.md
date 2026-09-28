# Offline Umpire Scoring — Manual Device Test Plan

Automated tests (`packages/client/src/offlineSync.test.js` and friends) prove the queue, sequencing, sync and conflict logic against a fake server, and a real-Chromium harness proves the IndexedDB path. They do **not** prove behaviour on a real phone or PC. Every row below must pass before offline umpire scoring is described as production-safe.

**Environment:** run against the **dev/staging** Supabase project, never production. Use a throwaway tournament with one `single_elim` division, two courts, and one umpire account plus one court-station pairing.

**How to verify "server data":** after each sync, check the match in the Operator desk (a separate online device): score, `lastSeq` (Match detail / live window), and match status. If you have read access to the dev DB, `select seq, type, payload from score_events where match_id = '<id>' order by seq` must show exactly one row per action, no duplicates and no gaps.

Record for every row: app version, device model/OS, PASS/FAIL, the server score, the `score_events` count, and notes.

## A. Android (umpire app, Capacitor build)

| # | Scenario | Steps | Pass criteria |
|---|---|---|---|
| A1 | Online scoring | Start a match online, score 5 points | Server shows 5 events; status line shows nothing, or "SYNCED" briefly |
| A2 | Airplane mode | Turn on airplane mode mid-match, score 4 points | Each tap shows immediately; the badge reads "OFFLINE — N saved on this device"; "Confirmed by server: x–y" shows the last synced score |
| A3 | Wi-Fi with no internet | Connect to a router with its WAN unplugged, score 3 points | Taps are never blocked. Each request gives up within ~15 s; the points stay "saved on this device" |
| A4 | Close the app while offline | With unsynced points, swipe the app away. Reopen it while still offline | The Matches / Court screen shows "Saved on this device" with the match. Opening it shows the same local score and the unsynced count |
| A5 | Android process death | With unsynced points: Developer options → "Don't keep activities", or `adb shell am kill app.tournament.umpire` from the background. Reopen offline | Same as A4. Nothing lost |
| A6 | Phone restart | With unsynced points, reboot the phone. Reopen offline | Same as A4 |
| A7 | Keep scoring after reopen | After A4–A6, score 2 more points offline | New points continue the sequence (the server later shows no gaps and no 409) |
| A8 | Reconnect | Turn the network back on (the app is in the foreground) | "SYNCING…" then "SYNCED". The server has every point exactly once, and its score equals the local score |
| A9 | Lost response / timeout | On a very poor link (walk out of Wi-Fi range mid-tap), score, then reconnect | No duplicate events on the server; the local score equals the server score |
| A10 | Double tap | Tap a point button twice as fast as possible, 10 times | The server gets one event per deliberate tap; no two events for one physical double tap |
| A11 | Correction offline | Offline: Edit score, then score a point, then reconnect | Both sync. The correction and the point have consecutive seqs. No "Sync conflict" |
| A12 | Token expiry (human umpire) | Score offline, keep the app open offline for more than 1 hour, then reconnect | Syncs without any "conflict" or discard prompt |
| A13 | Token expiry (court station) | Station-paired device: leave a match open for more than 1 hour, keep scoring online | Scoring keeps syncing (the station token refreshes itself) |
| A14 | Cold start offline with expired session | Human umpire: score offline, close the app, wait more than 1 hour, reopen offline | Expected (by design): the sign-in screen, with a notice that N actions are saved. Reconnect → session restored → the actions sync. **Nothing lost** |
| A15 | Two devices, same match | Put the phone and a second device on the same match offline; score different points on each. Reconnect A, then B | A syncs. B shows "Sync conflict" with the server score and its own score; nothing is deleted. Test "Keep server score" (the entries are archived) and "Apply this device's score as a correction" (one correction appears on the server) |
| A16 | Reverse reconnect order | Repeat A15, reconnecting B first | Symmetric result |
| A17 | Sign-out with pending | Offline with unsynced points, tap Sign out | A warning dialog appears. After signing out and signing in as a **different** umpire online, nothing is sent (the notice shows it belongs to another account). Signing back in as the original umpire → it syncs |
| A18 | Unpair with pending | Station with unsynced points, tap Unpair | A warning dialog appears; the entries stay on the device and are never sent by a new pairing |
| A19 | Server 5xx | (Staging only) make the command function return 503 briefly | Points stay "saved on this device" and are **not** rolled back; they sync once the server recovers |
| A20 | Start match offline | Offline, open an assigned (not started) match and tap Start | Clear "needs an internet connection" message; the match does not start locally |

## B. Windows

### B-1. Umpire in a desktop browser (Chrome/Edge)

| # | Scenario | Pass criteria |
|---|---|---|
| B1 | Online scoring | As A1 |
| B2 | Disconnect the network adapter, score 4 points | As A2 |
| B3 | Close the browser completely, reopen the umpire URL **while still online**, then go offline and open the saved match | The saved match reopens with the local score. (A web page cannot load from a cold start with no network: there is no service worker. That is expected.) |
| B4 | Reconnect | As A8 |
| B5 | Two tabs of the umpire app open, score in one, reconnect | Exactly one set of events reaches the server (single sync worker across tabs) |
| B6 | PC restart with unsynced points (browser reopened online) | Nothing lost; syncs |

### B-2. Operator desktop app (Electron)

| # | Scenario | Pass criteria |
|---|---|---|
| B7 | Offline organizer action (for example, add a player) | The error "Couldn't reach the server — this change was not confirmed…" is shown (or, after about 30 s with no answer, "No response from the server…"); nothing is queued; no "queued" toast |
| B8 | Old queue from a previous version | Install the previous version, queue a change offline, upgrade, and sign in | A banner offers "Send as <you>" or "Don't send". Nothing is sent until you choose |
| B9 | Multiple windows | With a banner-confirmed old entry, open Live, Bracket and Match display popouts, then reconnect | Exactly one copy reaches the server (check `command_receipts` / `audit_logs` count = 1) |
| B10 | Renderer reload / app restart / PC restart with an old entry pending | The entry is still listed; nothing is lost |

### B-3. Operator offline tournament data (Electron)

Prepare: sign in online, open the dashboard, then open the test tournament's desk once and wait a few seconds (this saves it on the PC).

| # | Scenario | Pass criteria |
|---|---|---|
| B11 | Disconnect Wi-Fi/Ethernet with the dashboard and desk open; switch windows (focus reloads) | Tournaments, matches, brackets and scores stay on screen. The banner reads "Offline — working from saved tournament data (saved …)". No "Failed to fetch", no blank screen |
| B12 | Offline, fully quit the Operator; wait **more than 1 hour**; reopen it offline | It opens without the sign-in screen, with the banner "Offline — sign-in not verified…", and shows the saved dashboard and desk. Any change is refused with "…this change was NOT sent" |
| B13 | Offline, open the Bracket and Match display popouts for the saved tournament | Both render from saved data with the offline banner. A tournament never opened on this PC shows "…isn't saved on this device yet…" instead of spinning |
| B14 | Reconnect after B12 | Within ~30 s (or right away on reconnect) the banner clears, data refreshes from the server, and changes work again. After **more than 7 days** offline, or after an explicit Sign out, reopening offline shows the sign-in screen (by design) |

## C. Sign-off

- [ ] All of A1–A20 pass on at least one real Android device (record the model and Android version).
- [ ] All of B1–B14 pass on a real Windows 10/11 machine.
- [ ] Server data checked for every sync row (event counts, no duplicates, no gaps).
- [ ] Any FAIL is filed with its steps and the `score_events` dump before the release decision.
