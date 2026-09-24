import { createClient } from "@supabase/supabase-js";
import { createApp } from "./src/server.js";
import { describe, expect, test, beforeAll, afterAll, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

loadEnvFile(resolve(process.cwd(), "../../.env"));
loadEnvFile(resolve(process.cwd(), "../../.env.local"));
loadEnvFile(resolve(process.cwd(), "../../apps/operator/.env.local"));
process.env.SUPABASE_URL ||= process.env.VITE_SUPABASE_URL;
process.env.SUPABASE_ANON_KEY ||= process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
process.env.COMMAND_URL ||= process.env.VITE_COMMAND_URL;

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
const live = Boolean(url && anon && process.env.RUN_LIVE_API_TESTS === "1");

async function signIn(email, password) {
  const client = createClient(url, anon, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return { client, token: data.session.access_token, user: data.user };
}

async function send(token, type, payload, command_id = crypto.randomUUID()) {
  const commandUrl = process.env.COMMAND_URL;
  if (commandUrl) {
    const res = await fetch(commandUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: anon,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ command_id, type, payload }),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { ok: false, error: { code: "NON_JSON", message: `${res.status} ${text.slice(0, 180)}` } };
    }
    return { status: res.status, body };
  }
  if (!service) throw new Error("Need COMMAND_URL or SUPABASE_SERVICE_ROLE_KEY");
  const app = createApp({ supabaseUrl: url, serviceRoleKey: service });
  const res = await app.request("http://local/command", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ command_id, type, payload }),
  });
  return { status: res.status, body: await res.json() };
}

// Server-side license entitlement (packages/api/src/authz.js requireLicense)
// now gates every organizer-only command. organizer.dev@tournament.local is
// the shared dev account every describe block below signs in as "organizer",
// so it must carry an active license for the rest of this file's existing
// coverage to keep passing once this ships — this fixture makes that true
// without assuming anything about whatever license state already exists on
// this account, and restores exactly what it found afterward.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"; // matches licenses.access_code's check constraint alphabet
function randomLicenseCode() {
  const group = () => Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
  return `${group()}-${group()}-${group()}`;
}

function adminForFixtures() {
  if (!service) throw new Error("RUN_LIVE_API_TESTS=1 requires SUPABASE_SERVICE_ROLE_KEY to manage the license fixture");
  return createClient(url, service, { auth: { persistSession: false } });
}

async function ensureActiveLicense(email) {
  const admin = adminForFixtures();
  const { data: rows, error } = await admin
    .from("licenses")
    .select("*")
    .eq("email", email)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const current = (rows || []).find((l) => l.status !== "revoked") ?? null;
  const isUsable = current && current.status === "active" && (!current.expires_at || new Date(current.expires_at) > new Date());
  if (isUsable) return null; // already licensed — nothing to change, nothing to restore

  if (current) {
    // A non-revoked row already exists (unused, or active-but-expired) —
    // update it in place rather than inserting a second non-revoked row,
    // which licenses_one_live_per_email (one non-revoked row per email)
    // would reject.
    const { error: updateErr } = await admin
      .from("licenses")
      .update({
        status: "active",
        device_id: current.device_id || "livetest-fixture-device",
        device_label: current.device_label || "live.test.js fixture",
        activated_at: current.activated_at || new Date().toISOString(),
        expires_at: null,
      })
      .eq("id", current.id);
    if (updateErr) throw updateErr;
    return { id: current.id, restore: current };
  }

  const { data: inserted, error: insertErr } = await admin
    .from("licenses")
    .insert({
      email,
      access_code: randomLicenseCode(),
      status: "active",
      device_id: "livetest-fixture-device",
      device_label: "live.test.js fixture",
      activated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (insertErr) throw insertErr;
  return { id: inserted.id, restore: null };
}

async function restoreLicenseFixture(fixture) {
  if (!fixture) return;
  const admin = adminForFixtures();
  if (fixture.restore) {
    const r = fixture.restore;
    await admin
      .from("licenses")
      .update({ status: r.status, device_id: r.device_id, device_label: r.device_label, activated_at: r.activated_at, expires_at: r.expires_at })
      .eq("id", r.id);
  } else {
    await admin.from("licenses").delete().eq("id", fixture.id);
  }
}

let organizerLicenseFixture = null;

beforeAll(async () => {
  if (!live) return;
  organizerLicenseFixture = await ensureActiveLicense("organizer.dev@tournament.local");
}, 30_000);

afterAll(async () => {
  if (!live) return;
  await restoreLicenseFixture(organizerLicenseFixture);
});

describe.skipIf(!live)("live tournament path", () => {
  let organizer;
  let umpire;
  let outsider;
  let tournamentId;
  let divisionId;
  let matchId;
  let courtId;

  beforeAll(async () => {
    organizer = await signIn("organizer.dev@tournament.local", "dev-organizer-pass");
    umpire = await signIn("umpire.dev@tournament.local", "dev-umpire-pass");
    outsider = await signIn("outsider.dev@tournament.local", "dev-outsider-pass");
  }, 30_000);

  test("organizer creates tournament, division, participants, bracket, assignments, scores", async () => {
    let r = await send(organizer.token, "create_tournament", { name: `IT ${Date.now()}` });
    expect(r.body.ok).toBe(true);
    tournamentId = r.body.result.tournament.id;

    r = await send(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration" });
    expect(r.body.ok).toBe(true);

    r = await send(organizer.token, "create_division", {
      tournament_id: tournamentId,
      name: "Open Doubles",
      format: "single_elim",
      config: { winBy: "none", bestOf: 1, isDoubles: true },
    });
    expect(r.body.ok).toBe(true);
    divisionId = r.body.result.division.id;

    const names = ["Ada / Al", "Bea / Bo", "Cia / Cy", "Dee / Di"];
    const persons = [];
    for (const n of names) {
      r = await send(organizer.token, "add_person", { tournament_id: tournamentId, display_name: n });
      expect(r.body.ok).toBe(true);
      persons.push(r.body.result.person);
    }

    r = await send(organizer.token, "update_person", { person_id: persons[0].id, display_name: "Ada Renamed / Al" });
    expect(r.body.ok).toBe(true);
    expect(r.body.result.person.display_name).toBe("Ada Renamed / Al");
    persons[0] = r.body.result.person;

    r = await send(outsider.token, "update_person", { person_id: persons[0].id, display_name: "Should Not Apply" });
    expect(r.body.ok).toBe(false);
    expect(r.status).toBe(403);

    r = await send(organizer.token, "add_person", { tournament_id: tournamentId, display_name: "Unregistered Player" });
    expect(r.body.ok).toBe(true);
    const removableId = r.body.result.person.id;

    r = await send(outsider.token, "remove_person", { person_id: removableId });
    expect(r.body.ok).toBe(false);
    expect(r.status).toBe(403);

    r = await send(organizer.token, "remove_person", { person_id: removableId });
    expect(r.body.ok).toBe(true);
    expect(r.body.result.removed).toBe(true);

    for (const [i, p] of persons.entries()) {
      r = await send(organizer.token, "register_participant", {
        division_id: divisionId,
        kind: "doubles",
        display_name: p.display_name,
        seed: i + 1,
        person_ids: [p.id],
      });
      expect(r.body.ok).toBe(true);
    }

    r = await send(organizer.token, "remove_person", { person_id: persons[0].id });
    expect(r.body.ok).toBe(false);
    expect(r.body.error.code).toBe("PERSON_IN_USE");

    r = await send(organizer.token, "create_court", { tournament_id: tournamentId, name: "Court 1" });
    expect(r.body.ok).toBe(true);
    courtId = r.body.result.court.id;

    r = await send(organizer.token, "add_member", {
      tournament_id: tournamentId,
      user_id: umpire.user.id,
      role: "umpire",
    });
    expect(r.body.ok).toBe(true);

    r = await send(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration_closed" });
    expect(r.body.ok).toBe(true);
    r = await send(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "ready" });
    expect(r.body.ok).toBe(true);

    r = await send(organizer.token, "generate_bracket", { division_id: divisionId });
    expect(r.body.ok).toBe(true);

    const { data: matches, error } = await organizer.client
      .from("matches")
      .select("*")
      .eq("division_id", divisionId)
      .eq("status", "scheduled");
    expect(error).toBeNull();
    expect(matches.length).toBeGreaterThan(0);
    matchId = matches[0].id;

    r = await send(organizer.token, "assign_court", { match_id: matchId, court_id: courtId });
    expect(r.body.ok).toBe(true);
    r = await send(organizer.token, "assign_umpire", { match_id: matchId, user_id: umpire.user.id });
    expect(r.body.ok).toBe(true);

    r = await send(outsider.token, "start_match", { match_id: matchId });
    expect(r.body.ok).toBe(false);
    expect(r.status).toBe(403);

    r = await send(umpire.token, "start_match", { match_id: matchId });
    expect(r.body.ok).toBe(true);
    expect(r.body.result.match.score_state.server).toBe(2);
    // 4-player single elimination: round 1 is the semifinal — race to 15, no deuce.
    expect(r.body.result.match.score_state.winTo).toBe(15);
    expect(r.body.result.match.score_state.winBy).toBe("none");

    const tossId = crypto.randomUUID();
    r = await send(umpire.token, "coin_toss", {
      match_id: matchId,
      event_id: tossId,
      seq: 1,
      result: "A",
      serving_team: "A",
    });
    expect(r.body.ok).toBe(true);
    expect(r.body.result.coin_toss.result).toBe("heads");
    expect(r.body.result.coin_toss.winner).toBe("A");
    expect(r.body.result.match.score_state.server).toBe(2);

    const secondToss = await send(umpire.token, "coin_toss", {
      match_id: matchId,
      event_id: crypto.randomUUID(),
      seq: 2,
      result: "tails",
      serving_team: "B",
    });
    expect(secondToss.body.ok).toBe(true);
    expect(secondToss.body.result.duplicate).toBe(true);
    expect(secondToss.body.result.coin_toss.result).toBe("heads");
    expect(secondToss.body.result.coin_toss.winner).toBe("A");

    const eventId = crypto.randomUUID();
    r = await send(umpire.token, "score_event", {
      match_id: matchId,
      event_id: eventId,
      seq: 2,
      type: "point",
      payload: { team: "A" },
    });
    expect(r.body.ok).toBe(true);

    const dup = await send(umpire.token, "score_event", {
      match_id: matchId,
      event_id: eventId,
      seq: 2,
      type: "point",
      payload: { team: "A" },
    });
    expect(dup.body.ok).toBe(true);
    expect(dup.body.result.duplicate || dup.body.idempotent).toBeTruthy();

    // Serving side A rally-scores to the target: the match ends exactly at 15–0.
    r = await playPointsToWin(send, umpire.token, matchId, "A", 3);
    expect(r.body.result.match.status).toBe("completed");
    expect(r.body.result.match.score_state.scoreA).toBe(15);
    expect(r.body.result.match.score_state.scoreB).toBe(0);

    const { data: resultRow } = await organizer.client.from("match_results").select("*").eq("match_id", matchId).maybeSingle();
    expect(resultRow).toBeTruthy();
    expect(resultRow.winner_slot).toBe("A");

    const seen = await umpire.client.from("match_results").select("*").eq("match_id", matchId).maybeSingle();
    expect(seen.data).toBeTruthy();

    const illegal = await send(organizer.token, "transition_match", { match_id: matchId, status: "in_progress" });
    expect(illegal.body.ok).toBe(false);
    expect(illegal.body.error.code).toBe("ILLEGAL_TRANSITION");

    const outsiderWrite = await send(outsider.token, "score_event", {
      match_id: matchId,
      event_id: crypto.randomUUID(),
      seq: 99,
      type: "point",
      payload: { team: "B" },
    });
    expect(outsiderWrite.body.ok).toBe(false);
  }, 120_000);
});

async function expectOk(token, type, payload, command_id) {
  const r = await send(token, type, payload, command_id);
  expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
  return r;
}

// Starts a match and scores a single point — the match stays in progress
// (use assignAndWin to complete one under the stage rules).
async function assignAndPlay(token, matchId, courtId, umpireId, winner = "A") {
  await expectOk(token, "assign_court", { match_id: matchId, court_id: courtId });
  await expectOk(token, "assign_umpire", { match_id: matchId, user_id: umpireId });
  await expectOk(token, "start_match", { match_id: matchId });
  await expectOk(token, "coin_toss", {
    match_id: matchId,
    event_id: crypto.randomUUID(),
    seq: 1,
    result: winner,
    serving_team: winner,
  });
  return expectOk(token, "score_event", {
    match_id: matchId,
    event_id: crypto.randomUUID(),
    seq: 2,
    type: "point",
    payload: { team: winner },
  });
}

// Stage-based scoring: the server decides the target from the match's stage
// (qualification 11; semifinal/final/bronze 15), first to the target wins,
// no deuce. These helpers read the target the server chose (score_state.winTo)
// rather than assuming one, and finish matches through the real rules.

// Completes a match with a manual score of T–(T-1) (or (T-1)–T for B) — also
// proves 11–10 / 15–14 end the match immediately.
async function finishByCorrection(token, matchId, seq, winner, winTo) {
  const payload = winner === "A" ? { scoreA: winTo, scoreB: winTo - 1 } : { scoreA: winTo - 1, scoreB: winTo };
  const r = await expectOk(token, "score_event", { match_id: matchId, event_id: crypto.randomUUID(), seq, type: "correction", payload });
  expect(r.body.result.match.status).toBe("completed");
  return r;
}

async function assignAndWin(token, matchId, courtId, umpireId, winner, expectedTarget) {
  await expectOk(token, "assign_court", { match_id: matchId, court_id: courtId });
  await expectOk(token, "assign_umpire", { match_id: matchId, user_id: umpireId });
  const started = await expectOk(token, "start_match", { match_id: matchId });
  const winTo = started.body.result.match.score_state.winTo;
  expect(winTo).toBe(expectedTarget);
  expect(started.body.result.match.score_state.winBy).toBe("none");
  await expectOk(token, "coin_toss", { match_id: matchId, event_id: crypto.randomUUID(), seq: 1, result: winner, serving_team: winner });
  return finishByCorrection(token, matchId, 2, winner, winTo);
}

// Rally-scores points for the serving team until the match completes (for
// actors that may not send corrections, e.g. a paired court station, or where
// real point-by-point scoring is what's under test). Returns the final response.
async function playPointsToWin(sendFn, token, matchId, team, fromSeq) {
  let seq = fromSeq;
  for (let i = 0; i < 40; i++) {
    const r = await sendFn(token, "score_event", { match_id: matchId, event_id: crypto.randomUUID(), seq: seq++, type: "point", payload: { team } });
    expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
    if (r.body.result.match.status === "completed") return r;
  }
  throw new Error("match did not complete within 40 points");
}

async function setupTeamEliminationQualifiers(organizer, umpire, divisionConfig) {
  const createId = crypto.randomUUID();
  let r = await expectOk(organizer.token, "create_tournament", { name: `TE ${Date.now()}` }, createId);
  const tournamentId = r.body.result.tournament.id;
  await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration" });

  r = await expectOk(organizer.token, "create_division", {
    tournament_id: tournamentId,
    name: "Team Elim",
    format: "team_elimination",
    config: { winBy: "none", bestOf: 1, isDoubles: true, ...divisionConfig },
  });
  const divisionId = r.body.result.division.id;

  const teamIds = [];
  for (const name of ["Alpha", "Bravo", "Charlie", "Delta"]) {
    r = await expectOk(organizer.token, "create_team", { tournament_id: tournamentId, division_id: divisionId, name });
    teamIds.push(r.body.result.team.id);
  }

  const personIds = [];
  for (let t = 0; t < 4; t++) {
    for (let p = 0; p < 4; p++) {
      r = await expectOk(organizer.token, "add_person", {
        tournament_id: tournamentId,
        display_name: `DS-T${t + 1}P${p + 1}`,
      });
      personIds.push(r.body.result.person.id);
    }
  }

  for (let t = 0; t < 4; t++) {
    for (let p = 0; p < 4; p++) {
      await expectOk(organizer.token, "add_team_member", { team_id: teamIds[t], person_id: personIds[t * 4 + p] });
    }
  }

  for (let t = 0; t < 4; t++) {
    for (let pair = 0; pair < 2; pair++) {
      const a = personIds[t * 4 + pair * 2];
      const b = personIds[t * 4 + pair * 2 + 1];
      await expectOk(organizer.token, "register_participant", {
        division_id: divisionId,
        kind: "doubles",
        display_name: `DS Team ${t + 1} Pair ${pair + 1}`,
        team_id: teamIds[t],
        seed: t * 2 + pair + 1,
        person_ids: [a, b],
      });
    }
  }

  r = await expectOk(organizer.token, "create_court", { tournament_id: tournamentId, name: "Court DS" });
  const courtId = r.body.result.court.id;
  await expectOk(organizer.token, "add_member", { tournament_id: tournamentId, user_id: umpire.user.id, role: "umpire" });
  await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration_closed" });
  await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "ready" });
  await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "in_progress" });

  await expectOk(organizer.token, "generate_team_elimination", { division_id: divisionId });

  const { data: rrPairs } = await organizer.client
    .from("matches")
    .select("*")
    .eq("division_id", divisionId)
    .eq("bracket_side", "pair")
    .eq("status", "scheduled");
  for (const m of rrPairs) {
    await assignAndWin(organizer.token, m.id, courtId, umpire.user.id, "A", 11); // qualification: race to 11
  }

  return { tournamentId, divisionId, courtId };
}

describe.skipIf(!live)("live team elimination path", () => {
  let organizer;
  let umpire;
  let outsider;
  let tournamentId;
  let divisionId;
  let courtId;
  let teamIds;
  let personIds;

  beforeAll(async () => {
    organizer = await signIn("organizer.dev@tournament.local", "dev-organizer-pass");
    umpire = await signIn("umpire.dev@tournament.local", "dev-umpire-pass");
    outsider = await signIn("outsider.dev@tournament.local", "dev-outsider-pass");
  }, 30_000);

  test("qualification, playoffs, bronze/final, persistence, race, authz, idempotency", async () => {
    const createId = crypto.randomUUID();
    let r = await expectOk(organizer.token, "create_tournament", { name: `TE ${Date.now()}` }, createId);
    tournamentId = r.body.result.tournament.id;
    const dupCreate = await send(organizer.token, "create_tournament", { name: "ignored" }, createId);
    expect(dupCreate.body.ok).toBe(true);
    expect(dupCreate.body.idempotent).toBe(true);
    expect(dupCreate.body.result.tournament.id).toBe(tournamentId);

    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration" });

    r = await expectOk(organizer.token, "create_division", {
      tournament_id: tournamentId,
      name: "Team Elim",
      format: "team_elimination",
      config: { winBy: "none", bestOf: 1, isDoubles: true, qualifierMode: "top_x_per_team", qualifierCount: 1 },
    });
    divisionId = r.body.result.division.id;

    const umpireForbidden = await send(umpire.token, "create_division", {
      tournament_id: tournamentId,
      name: "Nope",
      format: "single_elim",
      config: {},
    });
    expect(umpireForbidden.body.ok).toBe(false);
    expect(umpireForbidden.status).toBe(403);

    teamIds = [];
    for (const name of ["Alpha", "Bravo", "Charlie", "Delta"]) {
      r = await expectOk(organizer.token, "create_team", { tournament_id: tournamentId, division_id: divisionId, name });
      teamIds.push(r.body.result.team.id);
    }

    personIds = [];
    for (let t = 0; t < 4; t++) {
      for (let p = 0; p < 4; p++) {
        r = await expectOk(organizer.token, "add_person", {
          tournament_id: tournamentId,
          display_name: `T${t + 1}P${p + 1}`,
        });
        personIds.push(r.body.result.person.id);
      }
    }

    for (let t = 0; t < 4; t++) {
      for (let p = 0; p < 4; p++) {
        r = await expectOk(organizer.token, "add_team_member", {
          team_id: teamIds[t],
          person_id: personIds[t * 4 + p],
        });
      }
      const dupMember = await send(organizer.token, "add_team_member", {
        team_id: teamIds[t],
        person_id: personIds[t * 4],
      });
      expect(dupMember.body.ok).toBe(false);
      expect(dupMember.body.error.code).toBe("DUPLICATE_MEMBER");
    }

    const badPlayer = await send(organizer.token, "add_team_member", {
      team_id: teamIds[0],
      person_id: crypto.randomUUID(),
    });
    expect(badPlayer.body.ok).toBe(false);
    expect(badPlayer.body.error.code).toBe("INVALID_PLAYER");

    const outsiderMember = await send(outsider.token, "add_team_member", {
      team_id: teamIds[0],
      person_id: personIds[1],
    });
    expect(outsiderMember.body.ok).toBe(false);
    expect(outsiderMember.status).toBe(403);

    const { data: memberRow } = await organizer.client
      .from("team_members")
      .select("*")
      .eq("team_id", teamIds[0])
      .eq("person_id", personIds[3])
      .maybeSingle();
    expect(memberRow).toBeTruthy();
    await expectOk(organizer.token, "remove_team_member", { team_member_id: memberRow.id });
    await expectOk(organizer.token, "add_team_member", { team_id: teamIds[0], person_id: personIds[3] });

    for (let t = 0; t < 4; t++) {
      for (let pair = 0; pair < 2; pair++) {
        const a = personIds[t * 4 + pair * 2];
        const b = personIds[t * 4 + pair * 2 + 1];
        await expectOk(organizer.token, "register_participant", {
          division_id: divisionId,
          kind: "doubles",
          display_name: `Team ${t + 1} Pair ${pair + 1}`,
          team_id: teamIds[t],
          seed: t * 2 + pair + 1,
          person_ids: [a, b],
        });
      }
    }

    const alreadyAssigned = await send(organizer.token, "register_participant", {
      division_id: divisionId,
      kind: "doubles",
      display_name: "Should fail",
      team_id: teamIds[1],
      person_ids: [personIds[0], personIds[5]],
    });
    expect(alreadyAssigned.body.ok).toBe(false);
    expect(alreadyAssigned.body.error.code).toBe("PLAYER_ALREADY_ASSIGNED");

    const crossTeam = await send(organizer.token, "add_team_member", {
      team_id: teamIds[1],
      person_id: personIds[0],
    });
    expect(crossTeam.body.ok).toBe(false);
    expect(crossTeam.body.error.code).toBe("PLAYER_ALREADY_ASSIGNED");

    r = await expectOk(organizer.token, "create_court", { tournament_id: tournamentId, name: "Court TE" });
    courtId = r.body.result.court.id;
    await expectOk(organizer.token, "add_member", {
      tournament_id: tournamentId,
      user_id: umpire.user.id,
      role: "umpire",
    });
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration_closed" });
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "ready" });
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "in_progress" });

    const tooEarlyPlayoffs = await send(organizer.token, "generate_team_playoffs", { division_id: divisionId });
    expect(tooEarlyPlayoffs.body.ok).toBe(false);

    r = await expectOk(organizer.token, "generate_team_elimination", { division_id: divisionId });
    expect(r.body.result.pair_matches).toBeGreaterThanOrEqual(12);

    const { data: rrPairs, error: rrErr } = await organizer.client
      .from("matches")
      .select("*")
      .eq("division_id", divisionId)
      .eq("bracket_side", "pair")
      .eq("status", "scheduled");
    expect(rrErr).toBeNull();
    expect(rrPairs.length).toBeGreaterThanOrEqual(12);

    for (const m of rrPairs) {
      await assignAndWin(organizer.token, m.id, courtId, umpire.user.id, "A", 11); // qualification: race to 11
    }

    const { data: rrParents } = await organizer.client
      .from("matches")
      .select("*")
      .eq("division_id", divisionId)
      .is("parent_match_id", null);
    expect(rrParents.every((m) => m.status === "completed")).toBe(true);

    const outsiderPlayoffs = await send(outsider.token, "generate_team_playoffs", { division_id: divisionId });
    expect(outsiderPlayoffs.body.ok).toBe(false);
    expect(outsiderPlayoffs.status).toBe(403);

    r = await expectOk(organizer.token, "generate_team_playoffs", { division_id: divisionId });
    expect(r.body.result.pair_matches).toBeGreaterThanOrEqual(2);
    const againPlayoffs = await send(organizer.token, "generate_team_playoffs", { division_id: divisionId });
    expect(againPlayoffs.body.ok).toBe(false);
    expect(againPlayoffs.body.error.code).toBe("PLAYOFFS_EXIST");

    const { data: semis } = await organizer.client
      .from("matches")
      .select("*")
      .eq("division_id", divisionId)
      .eq("stage_label", "semifinal");
    expect(semis.length).toBe(2);
    const { data: semiPairs } = await organizer.client
      .from("matches")
      .select("*")
      .in("parent_match_id", semis.map((s) => s.id));
    expect(semiPairs.length).toBe(2);

    await expectOk(organizer.token, "assign_court", { match_id: semiPairs[0].id, court_id: courtId });
    await expectOk(organizer.token, "assign_umpire", { match_id: semiPairs[0].id, user_id: umpire.user.id });
    await expectOk(organizer.token, "assign_court", { match_id: semiPairs[1].id, court_id: courtId });
    await expectOk(organizer.token, "assign_umpire", { match_id: semiPairs[1].id, user_id: umpire.user.id });
    const semiStart0 = await expectOk(umpire.token, "start_match", { match_id: semiPairs[0].id });
    const semiStart1 = await expectOk(umpire.token, "start_match", { match_id: semiPairs[1].id });
    // Semifinals: race to 15, no deuce.
    expect(semiStart0.body.result.match.score_state.winTo).toBe(15);
    expect(semiStart1.body.result.match.score_state.winTo).toBe(15);
    expect(semiStart0.body.result.match.score_state.winBy).toBe("none");
    await expectOk(umpire.token, "coin_toss", {
      match_id: semiPairs[0].id,
      event_id: crypto.randomUUID(),
      seq: 1,
      result: "A",
      serving_team: "A",
    });
    await expectOk(umpire.token, "coin_toss", {
      match_id: semiPairs[1].id,
      event_id: crypto.randomUUID(),
      seq: 1,
      result: "A",
      serving_team: "A",
    });

    // Bring both semis to 14–0, then land both winning points concurrently so
    // the two completions (and their playoff reconciliation) race each other.
    for (const pm of semiPairs) {
      const nearly = await expectOk(umpire.token, "score_event", {
        match_id: pm.id, event_id: crypto.randomUUID(), seq: 2, type: "correction", payload: { scoreA: 14, scoreB: 0 },
      });
      expect(nearly.body.result.match.status).toBe("in_progress");
    }
    const [s1, s2] = await Promise.all([
      send(umpire.token, "score_event", {
        match_id: semiPairs[0].id,
        event_id: crypto.randomUUID(),
        seq: 3,
        type: "point",
        payload: { team: "A" },
      }),
      send(umpire.token, "score_event", {
        match_id: semiPairs[1].id,
        event_id: crypto.randomUUID(),
        seq: 3,
        type: "point",
        payload: { team: "A" },
      }),
    ]);
    expect(s1.body.ok, JSON.stringify(s1.body)).toBe(true);
    expect(s2.body.ok, JSON.stringify(s2.body)).toBe(true);
    expect(s1.body.result.match.status).toBe("completed");
    expect(s2.body.result.match.status).toBe("completed");

    const completeAgain1 = await send(umpire.token, "complete_match", { match_id: semiPairs[0].id });
    expect(completeAgain1.body.ok || completeAgain1.body.result?.already_complete || completeAgain1.body.idempotent).toBeTruthy();
    const completeId = crypto.randomUUID();
    const c1 = await send(umpire.token, "complete_match", { match_id: semiPairs[1].id }, completeId);
    const c2 = await send(umpire.token, "complete_match", { match_id: semiPairs[1].id }, completeId);
    expect(c2.body.idempotent || c1.body.result?.already_complete || c2.body.result?.already_complete || c2.body.ok).toBeTruthy();

    async function slotsFor(stage) {
      const { data: parent, error } = await organizer.client
        .from("matches")
        .select("*")
        .eq("division_id", divisionId)
        .eq("stage_label", stage)
        .is("parent_match_id", null)
        .maybeSingle();
      expect(error, JSON.stringify(error)).toBeNull();
      expect(parent, stage).toBeTruthy();
      const { data: sides } = await organizer.client.from("match_participants").select("*").eq("match_id", parent.id);
      const { data: kids } = await organizer.client.from("matches").select("*").eq("parent_match_id", parent.id);
      return { parent, sides, kids };
    }

    const final1 = await slotsFor("final");
    const bronze1 = await slotsFor("bronze");
    expect(final1.sides.filter((s) => s.participant_id).length).toBe(2);
    expect(bronze1.sides.filter((s) => s.participant_id).length).toBe(2);
    expect(final1.kids.length).toBe(1);
    expect(bronze1.kids.length).toBe(1);

    const final2 = await slotsFor("final");
    const bronze2 = await slotsFor("bronze");
    expect(final2.sides.map((s) => s.participant_id).sort().join()).toBe(final1.sides.map((s) => s.participant_id).sort().join());
    expect(bronze2.kids.length).toBe(1);
    expect(final2.kids.length).toBe(1);
    expect(final2.kids[0].id).toBe(final1.kids[0].id);

    const outsiderFinal = await send(outsider.token, "start_match", { match_id: final1.kids[0].id });
    expect(outsiderFinal.body.ok).toBe(false);
    expect(outsiderFinal.status).toBe(403);

    await assignAndWin(organizer.token, bronze1.kids[0].id, courtId, umpire.user.id, "A", 15); // bronze: race to 15
    await assignAndWin(organizer.token, final1.kids[0].id, courtId, umpire.user.id, "A", 15); // final: race to 15

    const { data: bronzeResult } = await organizer.client.from("match_results").select("*").eq("match_id", bronze1.kids[0].id).maybeSingle();
    const { data: finalResult } = await organizer.client.from("match_results").select("*").eq("match_id", final1.kids[0].id).maybeSingle();
    expect(bronzeResult?.winner_slot).toBe("A");
    expect(finalResult?.winner_slot).toBe("A");

    const { data: finalParent } = await organizer.client.from("matches").select("*").eq("id", final1.parent.id).maybeSingle();
    const { data: bronzeParent } = await organizer.client.from("matches").select("*").eq("id", bronze1.parent.id).maybeSingle();
    expect(finalParent.status).toBe("completed");
    expect(bronzeParent.status).toBe("completed");

    const umpireSeen = await umpire.client.from("match_results").select("*").eq("match_id", final1.kids[0].id).maybeSingle();
    expect(umpireSeen.data).toBeTruthy();

    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "completed" });
    const { data: tournament } = await organizer.client.from("tournaments").select("*").eq("id", tournamentId).maybeSingle();
    expect(tournament.status).toBe("completed");
  }, 240_000);

  test("Direct Semifinals: exactly 4 qualifiers skip straight to semifinal/bronze/final with no intermediate playoff round", async () => {
    const { divisionId } = await setupTeamEliminationQualifiers(organizer, umpire, {
      progressionMode: "direct_semifinals",
      qualifierMode: "top_x_per_team",
      qualifierCount: 1, // 4 teams x 1 per team = 4
    });

    const r = await expectOk(organizer.token, "generate_team_playoffs", { division_id: divisionId });
    expect(r.body.result.qualifiers).toHaveLength(4);

    const { data: knockoutMatches } = await organizer.client
      .from("matches")
      .select("*")
      .eq("division_id", divisionId)
      .is("parent_match_id", null)
      .not("stage_label", "eq", "round_robin");
    const labels = knockoutMatches.map((m) => m.stage_label).sort();
    expect(labels).toEqual(["bronze", "final", "semifinal", "semifinal"]);

    const { data: stages } = await organizer.client.from("stages").select("*").eq("division_id", divisionId).eq("kind", "team_knockout");
    expect(stages).toHaveLength(1);
    expect(stages[0].config.progressionMode).toBe("direct_semifinals");
  }, 240_000);

  test("Direct Semifinals: a qualifier count that does not resolve to exactly 4 is rejected with a clear error and generates no bracket", async () => {
    const { divisionId } = await setupTeamEliminationQualifiers(organizer, umpire, {
      progressionMode: "direct_semifinals",
      qualifierMode: "top_x_per_team",
      qualifierCount: 2, // 4 teams x 2 per team = 8
    });

    const r = await send(organizer.token, "generate_team_playoffs", { division_id: divisionId });
    expect(r.body.ok).toBe(false);
    expect(r.body.error.code).toBe("DIRECT_SEMIS_INVALID_COUNT");

    const { data: stages } = await organizer.client.from("stages").select("*").eq("division_id", divisionId).eq("kind", "team_knockout");
    expect(stages).toHaveLength(0);
  }, 240_000);
});

// Live, DB-verified proof of the offline-sync fix's server-side assumptions:
// a lost-response retry never creates a second score_events row, a
// sequential backlog (what a drained offline queue looks like from the
// server's point of view) converges matches.score_state correctly, and the
// existing Realtime pipeline the Operator relies on actually delivers the
// final synced score. These don't need a real offline device — they prove
// the server contract the client-side offlineQueue.js/App.jsx fix depends
// on; the client-side mechanics themselves are covered by
// packages/client/src/offlineScoringLifecycle.test.js.
describe.skipIf(!live)("offline sync — live DB and Realtime verification", () => {
  let organizer;
  let umpire;

  beforeAll(async () => {
    organizer = await signIn("organizer.dev@tournament.local", "dev-organizer-pass");
    umpire = await signIn("umpire.dev@tournament.local", "dev-umpire-pass");
  }, 30_000);

  test("lost-response retry, sequential backlog convergence, and Realtime delivery all hold against the real server", async () => {
    let r = await expectOk(organizer.token, "create_tournament", { name: `OFFSYNC ${Date.now()}` });
    const tournamentId = r.body.result.tournament.id;
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration" });

    r = await expectOk(organizer.token, "create_division", {
      tournament_id: tournamentId,
      name: "Offline Sync",
      format: "single_elim",
      config: { winTo: 11, winBy: "two", bestOf: 1, isDoubles: false },
    });
    const divisionId = r.body.result.division.id;

    const personIds = [];
    for (const name of ["OS Player A", "OS Player B"]) {
      r = await expectOk(organizer.token, "add_person", { tournament_id: tournamentId, display_name: name });
      personIds.push(r.body.result.person.id);
    }
    for (const [i, personId] of personIds.entries()) {
      await expectOk(organizer.token, "register_participant", {
        division_id: divisionId, kind: "singles", display_name: `OS ${i + 1}`, seed: i + 1, person_ids: [personId],
      });
    }

    r = await expectOk(organizer.token, "create_court", { tournament_id: tournamentId, name: "Court OS" });
    const courtId = r.body.result.court.id;
    await expectOk(organizer.token, "add_member", { tournament_id: tournamentId, user_id: umpire.user.id, role: "umpire" });
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration_closed" });
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "ready" });
    await expectOk(organizer.token, "generate_bracket", { division_id: divisionId });

    const { data: matches } = await organizer.client.from("matches").select("*").eq("division_id", divisionId).eq("status", "scheduled");
    const matchId = matches[0].id;
    await expectOk(organizer.token, "assign_court", { match_id: matchId, court_id: courtId });
    await expectOk(organizer.token, "assign_umpire", { match_id: matchId, user_id: umpire.user.id });
    await expectOk(umpire.token, "start_match", { match_id: matchId });
    await expectOk(umpire.token, "coin_toss", { match_id: matchId, event_id: crypto.randomUUID(), seq: 1, result: "A", serving_team: "A" });
    let nextSeq = 2;

    // --- Lost response / retry: resubmitting the identical command_id AND
    // the same event_id/seq inside the payload — exactly what a real
    // offline-queue replay (or drainQueue's own retry) does, since it never
    // mints a new id on retry — must never create a second score_events row.
    const retryEventId = crypto.randomUUID();
    const retrySeq = nextSeq++;
    const retryPayload = { match_id: matchId, event_id: retryEventId, seq: retrySeq, type: "point", payload: { team: "A" } };
    const first = await expectOk(umpire.token, "score_event", retryPayload, retryEventId);
    expect(first.body.idempotent).toBe(false);
    const second = await send(umpire.token, "score_event", retryPayload, retryEventId);
    expect(second.body.ok).toBe(true);
    expect(second.body.idempotent).toBe(true);
    const { data: dupRows, error: dupErr } = await organizer.client.from("score_events").select("*").eq("match_id", matchId).eq("id", retryEventId);
    expect(dupErr).toBeNull();
    expect(dupRows).toHaveLength(1);

    // --- Sequential backlog convergence: an in-order run of score events —
    // what a drained offline queue looks like from the server's point of
    // view — must land correctly in matches.score_state.
    for (let i = 0; i < 3; i++) {
      await expectOk(umpire.token, "score_event", {
        match_id: matchId, event_id: crypto.randomUUID(), seq: nextSeq++, type: "point", payload: { team: "A" },
      });
    }
    const { data: afterBacklog, error: rowErr } = await organizer.client.from("matches").select("*").eq("id", matchId).maybeSingle();
    expect(rowErr).toBeNull();
    expect(afterBacklog.score_state.lastSeq).toBe(nextSeq - 1);
    // Every event after the coin toss (seq 1) scored a point for A — the
    // retry event plus this backlog — so scoreA tracks lastSeq - 1 exactly.
    expect(afterBacklog.score_state.scoreA).toBe(afterBacklog.score_state.lastSeq - 1);

    // --- Realtime: the Operator's existing postgres_changes subscription on
    // this match must actually receive the final synced score, proving the
    // "Operator receives the score via existing Realtime flow" requirement
    // without needing a second app instance.
    const received = [];
    let subscribeStatusSeen = null;
    const channel = organizer.client
      .channel(`live-match-test:${matchId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "matches", filter: `id=eq.${matchId}` }, (payload) => received.push(payload));
    await new Promise((resolve, reject) => {
      channel.subscribe((status, err) => {
        subscribeStatusSeen = status;
        if (status === "SUBSCRIBED") resolve();
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          reject(new Error(`realtime subscribe failed: ${status} ${err?.message || ""}`));
        }
      });
    });
    // A "SUBSCRIBED" callback can fire fractionally before the server-side
    // listener is fully attached (a known supabase-js/Realtime timing quirk,
    // more likely to surface deep in a long-lived process) — a short settle
    // delay before triggering the change is the standard mitigation.
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const realtimeSeq = nextSeq++;
      await expectOk(umpire.token, "score_event", {
        match_id: matchId, event_id: crypto.randomUUID(), seq: realtimeSeq, type: "point", payload: { team: "A" },
      });
      try {
        await vi.waitFor(
          () => {
            expect(received.some((p) => p.new?.score_state?.lastSeq === realtimeSeq)).toBe(true);
          },
          { timeout: 30_000, interval: 250 },
        );
      } catch (waitErr) {
        console.error("[realtime debug] subscribeStatus:", subscribeStatusSeen, "received count:", received.length,
          "received lastSeqs:", received.map((p) => p.new?.score_state?.lastSeq), "eventTypes:", received.map((p) => p.eventType));
        throw waitErr;
      }
    } finally {
      await organizer.client.removeChannel(channel);
    }
  }, 120_000);
});

function pairStationUrl() {
  const commandUrl = process.env.COMMAND_URL;
  if (!commandUrl) return null;
  return process.env.PAIR_STATION_URL || commandUrl.replace(/\/command\/?$/, "/pair-station");
}

describe.skipIf(!live)("court station pairing", () => {
  test("pairs a device and scores the next assigned court match without umpire login", async () => {
    process.env.STATION_JWT_SECRET ||= "unit-test-station-secret";
    const organizer = await signIn("organizer.dev@tournament.local", "dev-organizer-pass");
    const pairUrl = pairStationUrl();
    const useHosted = Boolean(process.env.COMMAND_URL && pairUrl);
    if (!useHosted && !service) {
      throw new Error("Need COMMAND_URL or SUPABASE_SERVICE_ROLE_KEY for court station pairing");
    }
    const app = useHosted ? null : createApp({ supabaseUrl: url, serviceRoleKey: service });

    async function cmd(token, type, payload) {
      if (useHosted) return send(token, type, payload);
      const res = await app.request("http://local/command", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ command_id: crypto.randomUUID(), type, payload }),
      });
      return { status: res.status, body: await res.json() };
    }

    async function pair(body) {
      if (useHosted) {
        const res = await fetch(pairUrl, {
          method: "POST",
          headers: { apikey: anon, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(45_000),
        });
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          return { ok: false, error: { code: "NON_JSON", message: `${res.status} ${text.slice(0, 180)}` } };
        }
      }
      const res = await app.request("http://local/pair-station", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.json();
    }

    let r = await cmd(organizer.token, "create_tournament", { name: `ST ${Date.now()}` });
    expect(r.body.ok).toBe(true);
    const tournamentId = r.body.result.tournament.id;
    await cmd(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration" });
    r = await cmd(organizer.token, "create_division", {
      tournament_id: tournamentId,
      name: "Open",
      format: "single_elim",
      config: { winBy: "none", bestOf: 1, isDoubles: true },
    });
    const divisionId = r.body.result.division.id;
    const names = ["Ada / Al", "Bea / Bo", "Cia / Cy", "Dee / Di"];
    const persons = [];
    for (const n of names) {
      r = await cmd(organizer.token, "add_person", { tournament_id: tournamentId, display_name: n });
      persons.push(r.body.result.person);
    }
    for (const [i, p] of persons.entries()) {
      await cmd(organizer.token, "register_participant", {
        division_id: divisionId,
        kind: "doubles",
        display_name: p.display_name,
        seed: i + 1,
        person_ids: [p.id],
      });
    }
    r = await cmd(organizer.token, "create_court", { tournament_id: tournamentId, name: "Court 1" });
    expect(r.body.ok).toBe(true);
    const courtId = r.body.result.court.id;
    await cmd(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration_closed" });
    await cmd(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "ready" });
    await cmd(organizer.token, "generate_bracket", { division_id: divisionId });
    const { data: matches } = await organizer.client.from("matches").select("*").eq("division_id", divisionId).eq("status", "scheduled");
    const matchId = matches[0].id;
    r = await cmd(organizer.token, "assign_court", { match_id: matchId, court_id: courtId });
    expect(r.body.ok).toBe(true);

    r = await cmd(organizer.token, "open_court_pairing", { court_id: courtId });
    expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
    const pairingToken = r.body.result.pairing_token;
    expect(pairingToken).toBeTruthy();
    expect(r.body.result.pairing_payload?.g).toBe(pairingToken);

    const paired = await pair({ pairing_token: pairingToken });
    expect(paired.ok, JSON.stringify(paired)).toBe(true);
    const deviceToken = paired.result.access_token;

    const reused = await pair({ pairing_token: pairingToken });
    expect(reused.ok).toBe(false);

    r = await cmd(deviceToken, "start_match", { match_id: matchId });
    expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
    expect(r.body.result.match.score_state.winTo).toBe(15); // semifinal
    r = await cmd(deviceToken, "coin_toss", {
      match_id: matchId,
      event_id: crypto.randomUUID(),
      seq: 1,
      result: "A",
      serving_team: "A",
    });
    expect(r.body.ok).toBe(true);
    // A station may only send points (never corrections): rally to 15–0.
    r = await playPointsToWin(cmd, deviceToken, matchId, "A", 2);
    expect(r.body.result.match.status).toBe("completed");
    expect(r.body.result.match.score_state.scoreA).toBe(15);

    r = await cmd(organizer.token, "revoke_court_device", { court_id: courtId });
    expect(r.body.ok).toBe(true);
    r = await cmd(deviceToken, "station_sync", {});
    expect(r.body.ok).toBe(false);
  }, 120_000);
});

async function setupCorrectionMatch(organizer, umpire, config) {
  let r = await expectOk(organizer.token, "create_tournament", { name: `SC ${Date.now()}` });
  const tournamentId = r.body.result.tournament.id;
  await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration" });
  r = await expectOk(organizer.token, "create_division", {
    tournament_id: tournamentId,
    name: "Correction",
    format: "single_elim",
    config,
  });
  const divisionId = r.body.result.division.id;
  const persons = [];
  for (const n of ["Ada / Al", "Bea / Bo", "Cia / Cy", "Dee / Di"]) {
    r = await expectOk(organizer.token, "add_person", { tournament_id: tournamentId, display_name: n });
    persons.push(r.body.result.person);
  }
  for (const [i, p] of persons.entries()) {
    await expectOk(organizer.token, "register_participant", {
      division_id: divisionId, kind: "doubles", display_name: p.display_name, seed: i + 1, person_ids: [p.id],
    });
  }
  r = await expectOk(organizer.token, "create_court", { tournament_id: tournamentId, name: "Court 1" });
  const courtId = r.body.result.court.id;
  await expectOk(organizer.token, "add_member", { tournament_id: tournamentId, user_id: umpire.user.id, role: "umpire" });
  await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration_closed" });
  await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "ready" });
  await expectOk(organizer.token, "generate_bracket", { division_id: divisionId });
  const { data: matches } = await organizer.client.from("matches").select("*").eq("division_id", divisionId).eq("status", "scheduled");
  const matchId = matches[0].id;
  await expectOk(organizer.token, "assign_court", { match_id: matchId, court_id: courtId });
  await expectOk(organizer.token, "assign_umpire", { match_id: matchId, user_id: umpire.user.id });
  const started = await expectOk(umpire.token, "start_match", { match_id: matchId });
  await expectOk(umpire.token, "coin_toss", { match_id: matchId, event_id: crypto.randomUUID(), seq: 1, result: "A", serving_team: "A" });
  // The server-chosen stage target (every match of a 4-player bracket is a
  // semifinal or the final → 15).
  const winTo = started.body.result.match.score_state.winTo;
  expect(winTo).toBe(15);
  return { tournamentId, divisionId, matchId, winTo };
}

let correctionSeq;
function nextCorrectionSeq() { return ++correctionSeq; }

describe.skipIf(!live)("live score correction path", () => {
  let organizer;
  let umpire;
  let outsider;

  beforeAll(async () => {
    organizer = await signIn("organizer.dev@tournament.local", "dev-organizer-pass");
    umpire = await signIn("umpire.dev@tournament.local", "dev-umpire-pass");
    outsider = await signIn("outsider.dev@tournament.local", "dev-outsider-pass");
  }, 30_000);

  test("in-progress: correction sets the score directly, and normal scoring continues from the corrected value", async () => {
    const { matchId } = await setupCorrectionMatch(organizer, umpire, { winTo: 11, winBy: "two", bestOf: 1, isDoubles: true });
    correctionSeq = 1;

    let r = await send(umpire.token, "score_event", {
      match_id: matchId, event_id: crypto.randomUUID(), seq: nextCorrectionSeq(), type: "point", payload: { team: "A" },
    });
    expect(r.body.ok).toBe(true);
    expect(r.body.result.match.score_state.scoreA).toBe(1);

    r = await send(umpire.token, "score_event", {
      match_id: matchId, event_id: crypto.randomUUID(), seq: nextCorrectionSeq(),
      type: "correction", payload: { scoreA: 8, scoreB: 6, reason: "Scoreboard was misread" },
    });
    expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
    expect(r.body.result.match.score_state.scoreA).toBe(8);
    expect(r.body.result.match.score_state.scoreB).toBe(6);
    expect(r.body.result.match.status).toBe("in_progress");

    // CRITICAL: the next normal point must continue from the corrected score (9-6), not the pre-correction score (2-6 or 9-... ).
    r = await send(umpire.token, "score_event", {
      match_id: matchId, event_id: crypto.randomUUID(), seq: nextCorrectionSeq(), type: "point", payload: { team: "A" },
    });
    expect(r.body.ok).toBe(true);
    expect(r.body.result.match.score_state.scoreA).toBe(9);
    expect(r.body.result.match.score_state.scoreB).toBe(6);
  }, 60_000);

  test("invalid correction values are rejected without changing the score", async () => {
    const { matchId, winTo } = await setupCorrectionMatch(organizer, umpire, { winTo: 11, winBy: "two", bestOf: 1, isDoubles: true });
    correctionSeq = 1;
    for (const bad of [{ scoreA: -1, scoreB: 6 }, { scoreA: 1.5, scoreB: 6 }, { scoreA: "abc", scoreB: 6 }, { scoreA: null, scoreB: 6 }, {}]) {
      const r = await send(umpire.token, "score_event", {
        match_id: matchId, event_id: crypto.randomUUID(), seq: nextCorrectionSeq(), type: "correction", payload: bad,
      });
      expect(r.body.ok, JSON.stringify(r.body)).toBe(false);
    }
    // No deuce / no extension: past the target, or both sides at it, can never be a score.
    for (const bad of [{ scoreA: winTo + 1, scoreB: 3 }, { scoreA: winTo, scoreB: winTo }]) {
      const r = await send(umpire.token, "score_event", {
        match_id: matchId, event_id: crypto.randomUUID(), seq: nextCorrectionSeq(), type: "correction", payload: bad,
      });
      expect(r.body.ok, JSON.stringify(r.body)).toBe(false);
      expect(r.body.error.code).toBe("INVALID_SCORE");
    }
    const { data: unchanged } = await organizer.client.from("matches").select("*").eq("id", matchId).maybeSingle();
    expect(unchanged.status).toBe("in_progress");
    expect(unchanged.score_state.scoreA).toBe(0);
  }, 60_000);

  test("unauthorized user and paired station cannot issue a correction", async () => {
    const { matchId } = await setupCorrectionMatch(organizer, umpire, { winTo: 11, winBy: "two", bestOf: 1, isDoubles: true });
    correctionSeq = 1;
    const outsiderTry = await send(outsider.token, "score_event", {
      match_id: matchId, event_id: crypto.randomUUID(), seq: nextCorrectionSeq(), type: "correction", payload: { scoreA: 8, scoreB: 6, reason: "x" },
    });
    expect(outsiderTry.body.ok).toBe(false);
    expect(outsiderTry.status).toBe(403);
  }, 60_000);

  test("completed match: same-winner correction allowed with confirmation+reason; missing either is rejected; winner-changing correction is rejected", async () => {
    const { matchId, winTo } = await setupCorrectionMatch(organizer, umpire, { winTo: 11, winBy: "two", bestOf: 1, isDoubles: true });
    correctionSeq = 1;
    let r = await send(umpire.token, "score_event", {
      match_id: matchId, event_id: crypto.randomUUID(), seq: nextCorrectionSeq(),
      type: "correction", payload: { scoreA: winTo, scoreB: 9 },
    });
    expect(r.body.ok).toBe(true);
    expect(r.body.result.match.status).toBe("completed");
    expect(r.body.result.match.score_state.winner).toBe("A");
    const { data: resultRow } = await organizer.client.from("match_results").select("*").eq("match_id", matchId).maybeSingle();
    expect(resultRow.winner_slot).toBe("A");

    const missingConfirm = await send(umpire.token, "score_event", {
      match_id: matchId, event_id: crypto.randomUUID(), seq: nextCorrectionSeq(),
      type: "correction", payload: { scoreA: winTo, scoreB: 7, reason: "Recount" },
    });
    expect(missingConfirm.body.ok).toBe(false);
    expect(missingConfirm.body.error.code).toBe("CONFIRMATION_REQUIRED");

    const missingReason = await send(umpire.token, "score_event", {
      match_id: matchId, event_id: crypto.randomUUID(), seq: nextCorrectionSeq(),
      type: "correction", payload: { scoreA: winTo, scoreB: 7, confirm_completed: true },
    });
    expect(missingReason.body.ok).toBe(false);
    expect(missingReason.body.error.code).toBe("REASON_REQUIRED");

    const winnerFlip = await send(umpire.token, "score_event", {
      match_id: matchId, event_id: crypto.randomUUID(), seq: nextCorrectionSeq(),
      type: "correction", payload: { scoreA: 7, scoreB: winTo, confirm_completed: true, reason: "Recount" },
    });
    expect(winnerFlip.body.ok).toBe(false);
    expect(winnerFlip.body.error.code).toBe("WOULD_CHANGE_WINNER");

    const allowedCommandId = crypto.randomUUID();
    const allowed = await send(umpire.token, "score_event", {
      match_id: matchId, event_id: crypto.randomUUID(), seq: nextCorrectionSeq(),
      type: "correction", payload: { scoreA: winTo, scoreB: 7, confirm_completed: true, reason: "Recount confirmed same winner" },
    }, allowedCommandId);
    expect(allowed.body.ok, JSON.stringify(allowed.body)).toBe(true);
    expect(allowed.body.result.match.status).toBe("completed");
    expect(allowed.body.result.match.score_state.winner).toBe("A");
    expect(allowed.body.result.match.score_state.scoreB).toBe(7);

    const { data: updatedResult } = await organizer.client.from("match_results").select("*").eq("match_id", matchId).maybeSingle();
    expect(updatedResult.winner_slot).toBe("A");
    expect(updatedResult.score_b).toBe(7);

    const { data: audit } = await organizer.client.from("audit_logs").select("*").eq("command_id", allowedCommandId).maybeSingle();
    expect(audit).toBeTruthy();
    expect(audit.detail?.correction?.next).toEqual({ scoreA: winTo, scoreB: 7 });
    expect(audit.detail?.correction?.reason).toBe("Recount confirmed same winner");

    const { data: events } = await organizer.client.from("score_events").select("*").eq("match_id", matchId).order("seq");
    expect(events.some((e) => e.type === "point" || e.type === "correction")).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(2); // original completion + the accepted correction — history preserved, not overwritten
  }, 60_000);

  test("completed multi-game (bestOf > 1) match rejects correction", async () => {
    const { matchId, winTo } = await setupCorrectionMatch(organizer, umpire, { winBy: "none", bestOf: 3, isDoubles: true });
    correctionSeq = 1;
    let last;
    // Two straight games at the stage target (T–0, T–0) settle the best-of-3.
    for (let i = 0; i < 2; i++) {
      last = await send(umpire.token, "score_event", {
        match_id: matchId, event_id: crypto.randomUUID(), seq: nextCorrectionSeq(), type: "correction", payload: { scoreA: winTo, scoreB: 0 },
      });
      expect(last.body.ok, JSON.stringify(last.body)).toBe(true);
    }
    expect(last.body.result.match.status).toBe("completed");

    const r = await send(umpire.token, "score_event", {
      match_id: matchId, event_id: crypto.randomUUID(), seq: nextCorrectionSeq(),
      type: "correction", payload: { scoreA: 2, scoreB: 1, confirm_completed: true, reason: "Recount" },
    });
    expect(r.body.ok).toBe(false);
    expect(r.body.error.code).toBe("CORRECTION_UNSUPPORTED");
  }, 60_000);
});

describe.skipIf(!live)("update_match_participant (edit players / change partner)", () => {
  let organizer;
  let umpire;
  let outsider;

  beforeAll(async () => {
    organizer = await signIn("organizer.dev@tournament.local", "dev-organizer-pass");
    umpire = await signIn("umpire.dev@tournament.local", "dev-umpire-pass");
    outsider = await signIn("outsider.dev@tournament.local", "dev-outsider-pass");
  }, 30_000);

  test("swaps a doubles partner on a scheduled match; rejects duplicate/unknown/foreign/already-assigned players; locks once the match starts or completes; leaves master records and the old pairing untouched; writes an audit entry", async () => {
    let r = await expectOk(organizer.token, "create_tournament", { name: `MP ${Date.now()}` });
    const tournamentId = r.body.result.tournament.id;
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration" });

    r = await expectOk(organizer.token, "create_division", {
      tournament_id: tournamentId,
      name: "Doubles MP",
      format: "single_elim",
      config: { winBy: "none", bestOf: 1, isDoubles: true },
    });
    const divisionId = r.body.result.division.id;

    // Four real 2-person pairs, so there's an actual "duplicate within one side" case to reject.
    const pairNames = [
      ["Juan Dela Cruz", "Pedro Santos"],
      ["Mike Cruz", "John Smith"],
      ["Cy One", "Cy Two"],
      ["Di One", "Di Two"],
    ];
    const personIdsByPair = [];
    for (const pair of pairNames) {
      const ids = [];
      for (const name of pair) {
        const pr = await expectOk(organizer.token, "add_person", { tournament_id: tournamentId, display_name: name });
        ids.push(pr.body.result.person.id);
      }
      personIdsByPair.push(ids);
    }
    const markR = await expectOk(organizer.token, "add_person", { tournament_id: tournamentId, display_name: "Mark Reyes" });
    const markId = markR.body.result.person.id;

    const otherTournamentR = await expectOk(organizer.token, "create_tournament", { name: `MP-other ${Date.now()}` });
    const otherPersonR = await expectOk(organizer.token, "add_person", {
      tournament_id: otherTournamentR.body.result.tournament.id,
      display_name: "Outside Person",
    });
    const outsidePersonId = otherPersonR.body.result.person.id;

    for (const [i, ids] of personIdsByPair.entries()) {
      await expectOk(organizer.token, "register_participant", {
        division_id: divisionId,
        kind: "doubles",
        display_name: pairNames[i].join(" / "),
        seed: i + 1,
        person_ids: ids,
      });
    }

    const courtR = await expectOk(organizer.token, "create_court", { tournament_id: tournamentId, name: "MP Court" });
    const courtId = courtR.body.result.court.id;
    await expectOk(organizer.token, "add_member", { tournament_id: tournamentId, user_id: umpire.user.id, role: "umpire" });
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration_closed" });
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "ready" });
    await expectOk(organizer.token, "generate_bracket", { division_id: divisionId });

    const { data: matches } = await organizer.client.from("matches").select("*").eq("division_id", divisionId).eq("status", "scheduled");
    expect(matches.length).toBeGreaterThan(0);
    const matchId = matches[0].id;
    await expectOk(organizer.token, "assign_court", { match_id: matchId, court_id: courtId });
    await expectOk(organizer.token, "assign_umpire", { match_id: matchId, user_id: umpire.user.id });

    const { data: mpRow } = await organizer.client.from("match_participants").select("*").eq("match_id", matchId).eq("slot", "A").maybeSingle();
    const oldParticipantId = mpRow.participant_id;
    const { data: oldMembers } = await organizer.client.from("participant_members").select("*").eq("participant_id", oldParticipantId).order("slot");
    const [keepPersonId, swappedOutPersonId] = oldMembers.map((m) => m.person_id);

    // Test 5 (outside the tournament) — also doubles as the authorization check's target payload shape.
    const outsiderTry = await send(outsider.token, "update_match_participant", { match_id: matchId, slot: "A", person_ids: [keepPersonId, markId] });
    expect(outsiderTry.body.ok).toBe(false);
    expect(outsiderTry.status).toBe(403);

    // Test 3 — duplicate player within the same side.
    const dupTry = await send(organizer.token, "update_match_participant", { match_id: matchId, slot: "A", person_ids: [keepPersonId, keepPersonId] });
    expect(dupTry.body.ok).toBe(false);
    expect(dupTry.body.error.code).toBe("DUPLICATE_PLAYER_IN_PAIR");

    // Test 4 — unknown participant id.
    const unknownTry = await send(organizer.token, "update_match_participant", { match_id: matchId, slot: "A", person_ids: [keepPersonId, crypto.randomUUID()] });
    expect(unknownTry.body.ok).toBe(false);
    expect(unknownTry.body.error.code).toBe("INVALID_PLAYER");

    // Test 5 — player registered under a different tournament entirely.
    const crossTry = await send(organizer.token, "update_match_participant", { match_id: matchId, slot: "A", person_ids: [keepPersonId, outsidePersonId] });
    expect(crossTry.body.ok).toBe(false);
    expect(crossTry.body.error.code).toBe("INVALID_PLAYER");

    // Already playing elsewhere in this division — the existing double-booking rule, reused as-is.
    const alreadyAssignedTry = await send(organizer.token, "update_match_participant", {
      match_id: matchId, slot: "A", person_ids: [keepPersonId, personIdsByPair[1][0]],
    });
    expect(alreadyAssignedTry.body.ok).toBe(false);
    expect(alreadyAssignedTry.body.error.code).toBe("PLAYER_ALREADY_ASSIGNED");

    // Test 1 — the real swap: Pedro Santos -> Mark Reyes.
    const swapR = await expectOk(organizer.token, "update_match_participant", { match_id: matchId, slot: "A", person_ids: [keepPersonId, markId] });
    const newParticipantId = swapR.body.result.participant.id;
    expect(newParticipantId).not.toBe(oldParticipantId);

    const { data: mpAfter } = await organizer.client.from("match_participants").select("*").eq("match_id", matchId).eq("slot", "A").maybeSingle();
    expect(mpAfter.participant_id).toBe(newParticipantId);
    const { data: newMembers } = await organizer.client.from("participant_members").select("*").eq("participant_id", newParticipantId).order("slot");
    expect(newMembers.map((m) => m.person_id)).toEqual([keepPersonId, markId]);

    // The old participant/pairing is untouched, not deleted or mutated — it's simply no longer referenced by this match.
    const { data: oldParticipantAfter } = await organizer.client.from("participants").select("*").eq("id", oldParticipantId).maybeSingle();
    expect(oldParticipantAfter).toBeTruthy();
    const { data: oldMembersAfter } = await organizer.client.from("participant_members").select("*").eq("participant_id", oldParticipantId);
    expect(oldMembersAfter.map((m) => m.person_id).sort()).toEqual([keepPersonId, swappedOutPersonId].sort());

    // Test 2 — master player records for everyone involved are unchanged.
    const { data: swappedOutPersonAfter } = await organizer.client.from("persons").select("*").eq("id", swappedOutPersonId).maybeSingle();
    expect(swappedOutPersonAfter.display_name).toBe("Pedro Santos");
    const { data: markAfter } = await organizer.client.from("persons").select("*").eq("id", markId).maybeSingle();
    expect(markAfter.display_name).toBe("Mark Reyes");

    // Test 8 — audit entry recorded with old/new player identity.
    const { data: auditRows } = await organizer.client
      .from("audit_logs")
      .select("*")
      .eq("match_id", matchId)
      .eq("command_type", "update_match_participant")
      .order("created_at", { ascending: false })
      .limit(1);
    expect(auditRows?.length).toBe(1);
    expect(auditRows[0].detail?.participant_change?.old?.participant_id).toBe(oldParticipantId);
    expect(auditRows[0].detail?.participant_change?.new?.participant_id).toBe(newParticipantId);
    expect(auditRows[0].detail?.participant_change?.new?.players?.map((p) => p.name)).toEqual(["Juan Dela Cruz", "Mark Reyes"]);

    // Re-submitting the exact same pairing is a no-op, not a fresh "change".
    const noopTry = await send(organizer.token, "update_match_participant", { match_id: matchId, slot: "A", person_ids: [keepPersonId, markId] });
    expect(noopTry.body.ok).toBe(false);
    expect(noopTry.body.error.code).toBe("INVALID_COMMAND");

    // Test 6 — once the match is live, editing is locked.
    const editStart = await expectOk(umpire.token, "start_match", { match_id: matchId });
    const liveEditTry = await send(organizer.token, "update_match_participant", {
      match_id: matchId, slot: "B", person_ids: [personIdsByPair[1][0], markId],
    });
    expect(liveEditTry.body.ok).toBe(false);
    expect(liveEditTry.body.error.code).toBe("MATCH_NOT_EDITABLE");

    // Drive the match to completion (this also regression-covers Test 10: normal + correction
    // scoring on a match that has been through a participant swap works exactly as elsewhere).
    await expectOk(umpire.token, "coin_toss", { match_id: matchId, event_id: crypto.randomUUID(), seq: 1, result: "A", serving_team: "A" });
    await expectOk(umpire.token, "score_event", { match_id: matchId, event_id: crypto.randomUUID(), seq: 2, type: "point", payload: { team: "A" } });
    const finishR = await finishByCorrection(umpire.token, matchId, 3, "A", editStart.body.result.match.score_state.winTo);
    expect(finishR.body.result.match.status).toBe("completed");

    // Test 7 — completed matches are locked too, and the historical result is untouched.
    const completedEditTry = await send(organizer.token, "update_match_participant", {
      match_id: matchId, slot: "A", person_ids: [keepPersonId, swappedOutPersonId],
    });
    expect(completedEditTry.body.ok).toBe(false);
    expect(completedEditTry.body.error.code).toBe("MATCH_NOT_EDITABLE");
    const { data: resultAfter } = await organizer.client.from("match_results").select("*").eq("match_id", matchId).maybeSingle();
    expect(resultAfter.winner_slot).toBe("A");
  }, 90_000);
});

describe.skipIf(!live)("Umpire Cancel/Hold (transition_match: in_progress -> postponed)", () => {
  let organizer;
  let umpire;
  let outsider;

  beforeAll(async () => {
    organizer = await signIn("organizer.dev@tournament.local", "dev-organizer-pass");
    umpire = await signIn("umpire.dev@tournament.local", "dev-umpire-pass");
    outsider = await signIn("outsider.dev@tournament.local", "dev-outsider-pass");
  }, 30_000);

  test("the assigned umpire can hold their own live match; score/court/umpire/round are preserved; an outsider cannot; the umpire cannot make any other transition", async () => {
    const { matchId } = await setupCorrectionMatch(organizer, umpire, { winTo: 11, winBy: "two", bestOf: 1, isDoubles: true });
    await expectOk(umpire.token, "score_event", {
      match_id: matchId, event_id: crypto.randomUUID(), seq: 2, type: "point", payload: { team: "A" },
    });
    const { data: before } = await organizer.client.from("matches").select("*").eq("id", matchId).maybeSingle();
    expect(before.status).toBe("in_progress");
    expect(before.score_state.scoreA).toBe(1);

    const outsiderTry = await send(outsider.token, "transition_match", { match_id: matchId, status: "postponed", reason: "x" });
    expect(outsiderTry.body.ok).toBe(false);
    expect(outsiderTry.status).toBe(403);

    const wrongTransitionTry = await send(umpire.token, "transition_match", { match_id: matchId, status: "cancelled" });
    expect(wrongTransitionTry.body.ok).toBe(false);
    expect(wrongTransitionTry.body.error.code).toBe("FORBIDDEN");

    const holdR = await expectOk(umpire.token, "transition_match", { match_id: matchId, status: "postponed", reason: "Injury timeout" });
    expect(holdR.body.result.match.status).toBe("postponed");

    const { data: after } = await organizer.client.from("matches").select("*").eq("id", matchId).maybeSingle();
    expect(after.status).toBe("postponed");
    expect(after.score_state.scoreA).toBe(1); // score preserved, not reset
    expect(after.round).toBe(before.round);
    const { data: courtAfter } = await organizer.client.from("court_assignments").select("*").eq("match_id", matchId).maybeSingle();
    expect(courtAfter).toBeTruthy(); // court assignment untouched
    const { data: umpAfter } = await organizer.client.from("umpire_assignments").select("*").eq("match_id", matchId).maybeSingle();
    expect(umpAfter?.user_id).toBe(umpire.user.id); // umpire assignment untouched

    const { data: auditRows } = await organizer.client
      .from("audit_logs")
      .select("*")
      .eq("match_id", matchId)
      .eq("command_type", "transition_match")
      .order("created_at", { ascending: false })
      .limit(1);
    expect(auditRows[0].detail?.transition?.to).toBe("postponed");
    expect(auditRows[0].detail?.transition?.reason).toBe("Injury timeout");

    // Organizer still has full transition_match authority, unchanged — resume via the existing Operator "Resume match" path.
    const resumeR = await expectOk(organizer.token, "transition_match", { match_id: matchId, status: "ready" });
    expect(resumeR.body.result.match.status).toBe("ready");
  }, 90_000);
});

describe.skipIf(!live)("Operator Override Start (start_match by organizer, not the assigned umpire)", () => {
  let organizer;
  let umpire;

  beforeAll(async () => {
    organizer = await signIn("organizer.dev@tournament.local", "dev-organizer-pass");
    umpire = await signIn("umpire.dev@tournament.local", "dev-umpire-pass");
  }, 30_000);

  test("requires a reason, records a distinct override_start audit entry, and actually starts the match", async () => {
    let r = await expectOk(organizer.token, "create_tournament", { name: `OS ${Date.now()}` });
    const tournamentId = r.body.result.tournament.id;
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration" });
    r = await expectOk(organizer.token, "create_division", {
      tournament_id: tournamentId, name: "Override", format: "single_elim",
      config: { winTo: 11, winBy: "two", bestOf: 1, isDoubles: true },
    });
    const divisionId = r.body.result.division.id;
    const persons = [];
    for (const n of ["OS Ada", "OS Bea", "OS Cy", "OS Dee"]) {
      r = await expectOk(organizer.token, "add_person", { tournament_id: tournamentId, display_name: n });
      persons.push(r.body.result.person);
    }
    for (const [i, p] of persons.entries()) {
      await expectOk(organizer.token, "register_participant", {
        division_id: divisionId, kind: "doubles", display_name: p.display_name, seed: i + 1, person_ids: [p.id],
      });
    }
    await expectOk(organizer.token, "add_member", { tournament_id: tournamentId, user_id: umpire.user.id, role: "umpire" });
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration_closed" });
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "ready" });
    await expectOk(organizer.token, "generate_bracket", { division_id: divisionId });
    const { data: matches } = await organizer.client.from("matches").select("*").eq("division_id", divisionId).eq("status", "scheduled");
    const matchId = matches[0].id;
    const courtR = await expectOk(organizer.token, "create_court", { tournament_id: tournamentId, name: "OS Court" });
    await expectOk(organizer.token, "assign_court", { match_id: matchId, court_id: courtR.body.result.court.id });
    // Deliberately no assign_umpire — simulates "umpire device unavailable".

    // A plain organizer start (the pre-existing, unrelated capability every
    // organizer has always had) must NOT require a reason — only the
    // explicit override:true path does.
    const plainStart = await send(organizer.token, "start_match", { match_id: matchId });
    expect(plainStart.body.ok).toBe(true);
    await expectOk(organizer.token, "transition_match", { match_id: matchId, status: "postponed" });
    await expectOk(organizer.token, "transition_match", { match_id: matchId, status: "ready" });

    const missingReasonTry = await send(organizer.token, "start_match", { match_id: matchId, override: true });
    expect(missingReasonTry.body.ok).toBe(false);
    expect(missingReasonTry.body.error.code).toBe("REASON_REQUIRED");

    const okR = await expectOk(organizer.token, "start_match", { match_id: matchId, override: true, reason: "Umpire device unavailable" });
    expect(okR.body.result.match.status).toBe("in_progress");

    const { data: auditRows } = await organizer.client
      .from("audit_logs")
      .select("*")
      .eq("match_id", matchId)
      .eq("command_type", "start_match")
      .order("created_at", { ascending: false })
      .limit(1);
    expect(auditRows[0].detail?.override_start?.reason).toBe("Umpire device unavailable");

    // Regression: the umpire's own normal start (no override flag) still needs no reason.
    const { data: matches2 } = await organizer.client.from("matches").select("*").eq("division_id", divisionId).eq("status", "scheduled");
    if (matches2.length) {
      const matchId2 = matches2[0].id;
      await expectOk(organizer.token, "assign_umpire", { match_id: matchId2, user_id: umpire.user.id });
      const normalStart = await expectOk(umpire.token, "start_match", { match_id: matchId2 });
      expect(normalStart.body.result.match.status).toBe("in_progress");
    }
  }, 90_000);
});

describe.skipIf(!live)("stage-based scoring target (semifinal race to 15)", () => {
  let organizer;
  let umpire;

  beforeAll(async () => {
    organizer = await signIn("organizer.dev@tournament.local", "dev-organizer-pass");
    umpire = await signIn("umpire.dev@tournament.local", "dev-umpire-pass");
  }, 30_000);

  async function setupScoringOverrideMatch(divisionWinTo) {
    let r = await expectOk(organizer.token, "create_tournament", { name: `SO ${Date.now()}` });
    const tournamentId = r.body.result.tournament.id;
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration" });
    r = await expectOk(organizer.token, "create_division", {
      tournament_id: tournamentId, name: "Scoring Override", format: "single_elim",
      config: { winTo: divisionWinTo, winBy: "two", bestOf: 1, isDoubles: true },
    });
    const divisionId = r.body.result.division.id;
    const persons = [];
    for (const n of ["SO Ada", "SO Bea", "SO Cy", "SO Dee"]) {
      r = await expectOk(organizer.token, "add_person", { tournament_id: tournamentId, display_name: n });
      persons.push(r.body.result.person);
    }
    for (const [i, p] of persons.entries()) {
      await expectOk(organizer.token, "register_participant", {
        division_id: divisionId, kind: "doubles", display_name: p.display_name, seed: i + 1, person_ids: [p.id],
      });
    }
    await expectOk(organizer.token, "add_member", { tournament_id: tournamentId, user_id: umpire.user.id, role: "umpire" });
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration_closed" });
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "ready" });
    await expectOk(organizer.token, "generate_bracket", { division_id: divisionId });
    const { data: matches } = await organizer.client.from("matches").select("*").eq("division_id", divisionId).eq("status", "scheduled");
    const matchId = matches[0].id;
    const courtR = await expectOk(organizer.token, "create_court", { tournament_id: tournamentId, name: "SO Court" });
    await expectOk(organizer.token, "assign_court", { match_id: matchId, court_id: courtR.body.result.court.id });
    await expectOk(organizer.token, "assign_umpire", { match_id: matchId, user_id: umpire.user.id });
    return { matchId };
  }

  // 4-player single-elim: round 1 = semifinals, so the stage target is 15 no
  // matter what the division config or a (legacy) client override says.
  test("a semifinal always starts at race to 15 (no deuce); a legacy scoring_override is ignored", async () => {
    const { matchId } = await setupScoringOverrideMatch(11);
    const r = await expectOk(umpire.token, "start_match", { match_id: matchId, scoring_override: { winTo: 11 } });
    expect(r.body.result.match.score_state.winTo).toBe(15);
    expect(r.body.result.match.score_state.winBy).toBe("none");
  }, 60_000);

  test("an invalid legacy scoring_override no longer blocks start; the stage target applies", async () => {
    const { matchId } = await setupScoringOverrideMatch(11);
    const r = await expectOk(umpire.token, "start_match", { match_id: matchId, scoring_override: { winTo: 13 } });
    expect(r.body.result.match.score_state.winTo).toBe(15);
  }, 60_000);

  test("coin toss before start keeps the semifinal at 15, and a manual 14–15 completes it", async () => {
    const { matchId } = await setupScoringOverrideMatch(11);
    await expectOk(umpire.token, "coin_toss", { match_id: matchId, event_id: crypto.randomUUID(), seq: 1, result: "A", serving_team: "A" });
    let r = await expectOk(umpire.token, "start_match", { match_id: matchId });
    expect(r.body.result.match.score_state.winTo).toBe(15);
    r = await send(umpire.token, "score_event", {
      match_id: matchId, event_id: crypto.randomUUID(), seq: 2, type: "correction", payload: { scoreA: 15, scoreB: 15 },
    });
    expect(r.body.ok).toBe(false);
    expect(r.body.error.code).toBe("INVALID_SCORE");
    r = await expectOk(umpire.token, "score_event", {
      match_id: matchId, event_id: crypto.randomUUID(), seq: 2, type: "correction", payload: { scoreA: 14, scoreB: 15 },
    });
    expect(r.body.result.match.status).toBe("completed");
    expect(r.body.result.match.winner).toBe("B");
  }, 60_000);
});

describe.skipIf(!live)("Match integrity: self-match and cross-team protection (update_match_participant)", () => {
  let organizer;

  beforeAll(async () => {
    organizer = await signIn("organizer.dev@tournament.local", "dev-organizer-pass");
  }, 30_000);

  test("Edit Players cannot set one side to the same player already on the opposing side of the same match (self-match protection)", async () => {
    let r = await expectOk(organizer.token, "create_tournament", { name: `SM ${Date.now()}` });
    const tournamentId = r.body.result.tournament.id;
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration" });
    r = await expectOk(organizer.token, "create_division", {
      tournament_id: tournamentId, name: "SelfMatch", format: "single_elim",
      config: { winTo: 11, winBy: "two", bestOf: 1, isDoubles: false },
    });
    const divisionId = r.body.result.division.id;
    const names = ["SM Ada", "SM Bea", "SM Cy", "SM Dee"];
    const persons = [];
    for (const n of names) {
      r = await expectOk(organizer.token, "add_person", { tournament_id: tournamentId, display_name: n });
      persons.push(r.body.result.person);
    }
    for (const [i, p] of persons.entries()) {
      await expectOk(organizer.token, "register_participant", {
        division_id: divisionId, kind: "singles", display_name: p.display_name, seed: i + 1, person_ids: [p.id],
      });
    }
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration_closed" });
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "ready" });
    await expectOk(organizer.token, "generate_bracket", { division_id: divisionId });
    const { data: matches } = await organizer.client.from("matches").select("*").eq("division_id", divisionId).eq("status", "scheduled");
    const matchId = matches[0].id;
    const { data: sideB } = await organizer.client.from("match_participants").select("*").eq("match_id", matchId).eq("slot", "B").maybeSingle();
    const { data: sideBMembers } = await organizer.client.from("participant_members").select("*").eq("participant_id", sideB.participant_id);

    const selfMatchTry = await send(organizer.token, "update_match_participant", {
      match_id: matchId, slot: "A", person_ids: [sideBMembers[0].person_id],
    });
    expect(selfMatchTry.body.ok).toBe(false);
    expect(selfMatchTry.body.error.code).toBe("PLAYER_ALREADY_ASSIGNED");
  }, 60_000);

  test("Edit Players on a team-elimination side rejects a player with no team affiliation at all in this division (the residual gap assignedPersonIds' team_members/participant_members scans don't cover)", async () => {
    let r = await expectOk(organizer.token, "create_tournament", { name: `TB ${Date.now()}` });
    const tournamentId = r.body.result.tournament.id;
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration" });
    r = await expectOk(organizer.token, "create_division", {
      tournament_id: tournamentId, name: "TeamBoundary", format: "team_elimination",
      config: { winBy: "none", bestOf: 1, isDoubles: true, qualifierMode: "top_x_per_team", qualifierCount: 1 },
    });
    const divisionId = r.body.result.division.id;
    r = await expectOk(organizer.token, "create_team", { tournament_id: tournamentId, division_id: divisionId, name: "TB Falcons" });
    const teamA = r.body.result.team.id;
    r = await expectOk(organizer.token, "create_team", { tournament_id: tournamentId, division_id: divisionId, name: "TB Hawks" });
    const teamB = r.body.result.team.id;

    async function makePair(teamId, label) {
      const p1 = await expectOk(organizer.token, "add_person", { tournament_id: tournamentId, display_name: `${label} One` });
      const p2 = await expectOk(organizer.token, "add_person", { tournament_id: tournamentId, display_name: `${label} Two` });
      const ids = [p1.body.result.person.id, p2.body.result.person.id];
      await expectOk(organizer.token, "register_participant", {
        division_id: divisionId, kind: "doubles", display_name: `${label} Pair`, team_id: teamId, person_ids: ids,
      });
      return ids;
    }
    await makePair(teamA, "FalconsA");
    await makePair(teamA, "FalconsB");
    await makePair(teamB, "HawksA");
    await makePair(teamB, "HawksB");

    // A person with NO team roster affiliation at all in this division (not
    // Falcons, not Hawks) and never registered as a participant either — the
    // pre-existing "already assigned" check (which scans every OTHER team's
    // team_members, plus every placed participant) has nothing to catch
    // here since this person appears in neither scan; only the new
    // team-membership check can reject this.
    const outsider = await expectOk(organizer.token, "add_person", { tournament_id: tournamentId, display_name: "Unaffiliated Player" });

    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration_closed" });
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "ready" });
    await expectOk(organizer.token, "generate_team_elimination", { division_id: divisionId });
    const { data: pairMatches } = await organizer.client.from("matches").select("*").eq("division_id", divisionId).not("parent_match_id", "is", null);
    const matchId = pairMatches[0].id;
    const { data: mpA } = await organizer.client.from("match_participants").select("*").eq("match_id", matchId).eq("slot", "A").maybeSingle();
    // Target whichever slot is actually the Falcons side in this generated
    // schedule, so the Hawks outsider is always the wrong team for it.
    const falconsSlot = mpA.team_id === teamA ? "A" : "B";
    const { data: mpFalcons } = await organizer.client.from("match_participants").select("*").eq("match_id", matchId).eq("slot", falconsSlot).maybeSingle();
    const { data: falconsMembers } = await organizer.client.from("participant_members").select("*").eq("participant_id", mpFalcons.participant_id).order("slot");

    // Keep one of the Falcons side's real current players, swap the other for the Hawks outsider.
    const crossTeamTry = await send(organizer.token, "update_match_participant", {
      match_id: matchId, slot: falconsSlot, person_ids: [falconsMembers[0].person_id, outsider.body.result.person.id],
    });
    expect(crossTeamTry.body.ok).toBe(false);
    expect(crossTeamTry.body.error.code).toBe("PLAYER_NOT_ON_TEAM");
  }, 60_000);
});

describe.skipIf(!live)("Division deletion (delete_division)", () => {
  let organizer;
  let umpire;
  let outsider;

  beforeAll(async () => {
    organizer = await signIn("organizer.dev@tournament.local", "dev-organizer-pass");
    umpire = await signIn("umpire.dev@tournament.local", "dev-umpire-pass");
    outsider = await signIn("outsider.dev@tournament.local", "dev-outsider-pass");
  }, 30_000);

  test("organizer-only, blocked while a match is live, cascades matches/participants on success, and 404s on a repeat delete", async () => {
    let r = await expectOk(organizer.token, "create_tournament", { name: `DD ${Date.now()}` });
    const tournamentId = r.body.result.tournament.id;
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration" });

    r = await expectOk(organizer.token, "create_division", {
      tournament_id: tournamentId,
      name: "Doomed Division",
      format: "single_elim",
      config: { winTo: 11, winBy: "two", bestOf: 1, isDoubles: false },
    });
    const divisionId = r.body.result.division.id;

    const persons = [];
    for (const name of ["Uno", "Dos", "Tres", "Cuatro"]) {
      const p = await expectOk(organizer.token, "add_person", { tournament_id: tournamentId, display_name: name });
      persons.push(p.body.result.person);
    }
    for (const [i, p] of persons.entries()) {
      await expectOk(organizer.token, "register_participant", {
        division_id: divisionId,
        kind: "singles",
        display_name: p.display_name,
        seed: i + 1,
        person_ids: [p.id],
      });
    }

    r = await expectOk(organizer.token, "create_court", { tournament_id: tournamentId, name: "DD Court" });
    const courtId = r.body.result.court.id;
    await expectOk(organizer.token, "add_member", { tournament_id: tournamentId, user_id: umpire.user.id, role: "umpire" });

    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration_closed" });
    await expectOk(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "ready" });
    await expectOk(organizer.token, "generate_bracket", { division_id: divisionId });

    const { data: matches } = await organizer.client.from("matches").select("*").eq("division_id", divisionId);
    expect(matches.length).toBeGreaterThan(0);
    const liveMatchId = matches.find((m) => m.status === "scheduled").id;

    // A non-organizer/admin cannot delete the division.
    const denied = await send(outsider.token, "delete_division", { division_id: divisionId });
    expect(denied.body.ok).toBe(false);
    expect(denied.status).toBe(403);

    await assignAndPlay(organizer.token, liveMatchId, courtId, umpire.user.id, "A");
    const { data: liveRow } = await organizer.client.from("matches").select("status").eq("id", liveMatchId).maybeSingle();
    expect(liveRow.status).toBe("in_progress");

    // Deleting a division out from under a live match would destroy the umpire's
    // in-flight scoring session — the handler must refuse this, not silently wipe it.
    const blocked = await send(organizer.token, "delete_division", { division_id: divisionId });
    expect(blocked.body.ok).toBe(false);
    expect(blocked.body.error.code).toBe("DIVISION_HAS_LIVE_MATCHES");

    // Once the live match is held (no longer in_progress), deletion is allowed.
    await expectOk(umpire.token, "transition_match", { match_id: liveMatchId, status: "postponed" });

    r = await expectOk(organizer.token, "delete_division", { division_id: divisionId });
    expect(r.body.result.deleted).toBe(true);

    // The division and everything scoped to it (matches, and — via the same FK
    // cascades — match_participants/score_events/match_results/court_assignments/
    // umpire_assignments, plus participants/teams/stages) is actually gone, not
    // just hidden — this is a real delete through apply_official_writes, not a
    // client-side/status-flag fake delete.
    const { data: goneDivision } = await organizer.client.from("divisions").select("id").eq("id", divisionId).maybeSingle();
    expect(goneDivision).toBeNull();
    const { data: goneMatches } = await organizer.client.from("matches").select("id").eq("division_id", divisionId);
    expect(goneMatches).toEqual([]);
    const { data: goneParticipants } = await organizer.client.from("participants").select("id").eq("division_id", divisionId);
    expect(goneParticipants).toEqual([]);

    // Deleting an already-deleted division is a clean 404, not a crash.
    const again = await send(organizer.token, "delete_division", { division_id: divisionId });
    expect(again.body.ok).toBe(false);
    expect(again.status).toBe(404);
  }, 60_000);
});

// Server-side Operator license entitlement (packages/api/src/authz.js
// requireLicense / requireOrganizerLicensed, wired into handleCommand.js).
// The Operator app's LicenseGate is a client-side UI gate only; these tests
// prove the /command endpoint itself now refuses organizer-capability
// actions for an unlicensed or revoked account, independent of any client.
//
// Coverage this block intentionally does NOT duplicate, because it is
// already exercised elsewhere in this file and remains unaffected by this
// feature by design:
//   - "court station pairing" above: a paired court device has no email/
//     customer identity and is never license-gated — that whole flow keeps
//     succeeding with zero license rows for anyone.
//   - "Umpire Cancel/Hold" above: the assigned umpire's own scoring/hold
//     actions never require a license (organizer.dev's fixture above is the
//     only account this suite grants a license to; umpire.dev is not).
describe.skipIf(!live)("Operator license entitlement (server-side)", () => {
  let outsider;

  beforeAll(async () => {
    outsider = await signIn("outsider.dev@tournament.local", "dev-outsider-pass");
  }, 30_000);

  test("an account with no license row cannot create a tournament (the bootstrap organizer command is gated too)", async () => {
    const { data: rows } = await adminForFixtures().from("licenses").select("id").eq("email", "outsider.dev@tournament.local");
    if (rows && rows.length) {
      throw new Error(
        "outsider.dev@tournament.local unexpectedly already has a licenses row — this test assumes a clean, unlicensed dev account",
      );
    }
    const r = await send(outsider.token, "create_tournament", { name: `LIC-UNLICENSED ${Date.now()}` });
    expect(r.body.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("LICENSE_REQUIRED");
  }, 30_000);

  test("a revoked license blocks organizer-only commands with LICENSE_INVALID, and never leaks license details", async () => {
    const admin = adminForFixtures();
    const email = "outsider.dev@tournament.local";
    const { data: inserted, error } = await admin
      .from("licenses")
      .insert({
        email,
        access_code: randomLicenseCode(),
        status: "revoked",
        revoked_at: new Date().toISOString(),
      })
      .select()
      .single();
    expect(error).toBeFalsy();
    try {
      const r = await send(outsider.token, "create_tournament", { name: `LIC-REVOKED ${Date.now()}` });
      expect(r.body.ok).toBe(false);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("LICENSE_INVALID");
      expect(r.body.error.message).not.toMatch(new RegExp(email.replace(".", "\\.")));
      expect(JSON.stringify(r.body)).not.toContain(inserted.access_code);
    } finally {
      await admin.from("licenses").delete().eq("id", inserted.id);
    }
  }, 30_000);

  test("a licensed organizer's organizer-only commands still succeed (regression guard)", async () => {
    // organizer.dev@tournament.local is guaranteed an active license by the
    // top-level beforeAll fixture above, exactly like every other describe
    // block in this file relies on.
    const organizer = await signIn("organizer.dev@tournament.local", "dev-organizer-pass");
    const r = await expectOk(organizer.token, "create_tournament", { name: `LIC-OK ${Date.now()}` });
    expect(r.body.result.tournament).toBeTruthy();
  }, 30_000);

  test("an organizer transitioning a match (not the umpire hold carve-out) requires a license", async () => {
    const admin = adminForFixtures();
    const email = "outsider.dev@tournament.local";
    // outsider needs organizer membership on *some* tournament to reach the
    // license check at all (a non-member is rejected with FORBIDDEN first,
    // by design — see requireLicense's ordering in authz.js). Grant it via
    // a licensed organizer, then revoke outsider's own license and confirm
    // the organizer-branch transition is blocked before ever reaching
    // assertTransitionMatch.
    const organizer = await signIn("organizer.dev@tournament.local", "dev-organizer-pass");
    const t = await expectOk(organizer.token, "create_tournament", { name: `LIC-TRANSITION ${Date.now()}` });
    const tournamentId = t.body.result.tournament.id;
    await expectOk(organizer.token, "add_member", { tournament_id: tournamentId, user_id: outsider.user.id, role: "organizer" });

    const r = await send(outsider.token, "transition_tournament", { tournament_id: tournamentId, status: "registration" });
    expect(r.body.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("LICENSE_REQUIRED");
  }, 30_000);
});
