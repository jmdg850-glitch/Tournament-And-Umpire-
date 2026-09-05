import { createClient } from "@supabase/supabase-js";
import { createApp } from "./src/server.js";
import { describe, expect, test, beforeAll } from "vitest";
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
      config: { winTo: 2, winBy: "none", bestOf: 1, isDoubles: true },
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

    const second = crypto.randomUUID();
    r = await send(umpire.token, "score_event", {
      match_id: matchId,
      event_id: second,
      seq: 3,
      type: "point",
      payload: { team: "A" },
    });
    expect(r.body.ok).toBe(true);
    expect(r.body.result.match.status).toBe("completed");

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
      config: { winTo: 1, winBy: "none", bestOf: 1, isDoubles: true, qualifierMode: "top_x", qualifierCount: 4 },
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
      await assignAndPlay(organizer.token, m.id, courtId, umpire.user.id, "A");
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
    await expectOk(umpire.token, "start_match", { match_id: semiPairs[0].id });
    await expectOk(umpire.token, "start_match", { match_id: semiPairs[1].id });
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

    const [s1, s2] = await Promise.all([
      send(umpire.token, "score_event", {
        match_id: semiPairs[0].id,
        event_id: crypto.randomUUID(),
        seq: 2,
        type: "point",
        payload: { team: "A" },
      }),
      send(umpire.token, "score_event", {
        match_id: semiPairs[1].id,
        event_id: crypto.randomUUID(),
        seq: 2,
        type: "point",
        payload: { team: "A" },
      }),
    ]);
    expect(s1.body.ok, JSON.stringify(s1.body)).toBe(true);
    expect(s2.body.ok, JSON.stringify(s2.body)).toBe(true);

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

    await assignAndPlay(organizer.token, bronze1.kids[0].id, courtId, umpire.user.id, "A");
    await assignAndPlay(organizer.token, final1.kids[0].id, courtId, umpire.user.id, "A");

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
      config: { winTo: 2, winBy: "none", bestOf: 1, isDoubles: true },
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
    r = await cmd(deviceToken, "coin_toss", {
      match_id: matchId,
      event_id: crypto.randomUUID(),
      seq: 1,
      result: "A",
      serving_team: "A",
    });
    expect(r.body.ok).toBe(true);
    r = await cmd(deviceToken, "score_event", {
      match_id: matchId,
      event_id: crypto.randomUUID(),
      seq: 2,
      type: "point",
      payload: { team: "A" },
    });
    expect(r.body.ok).toBe(true);
    r = await cmd(deviceToken, "score_event", {
      match_id: matchId,
      event_id: crypto.randomUUID(),
      seq: 3,
      type: "point",
      payload: { team: "A" },
    });
    expect(r.body.ok).toBe(true);
    expect(r.body.result.match.status).toBe("completed");

    r = await cmd(organizer.token, "revoke_court_device", { court_id: courtId });
    expect(r.body.ok).toBe(true);
    r = await cmd(deviceToken, "station_sync", {});
    expect(r.body.ok).toBe(false);
  }, 120_000);
});
