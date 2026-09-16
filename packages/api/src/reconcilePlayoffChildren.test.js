import { createClient } from "@supabase/supabase-js";
import { createApp } from "./server.js";
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

// Regression coverage for a real production defect: reconcilePlayoffChildren()
// used to run after every match completion regardless of division format, but
// its child-match creation is only meaningful for team_elimination's two-level
// bracket (team matchup shell + nested pair match). On single_elim (a flat,
// one-level bracket with no children) it spuriously created a duplicate
// scheduled match with the same two players. See packages/api/src/handleCommand.js
// (reconcilePlayoffChildren's format guard).
describe.skipIf(!live)("reconcilePlayoffChildren format guard", () => {
  let organizer;
  let umpire;

  beforeAll(async () => {
    organizer = await signIn("organizer.dev@tournament.local", "dev-organizer-pass");
    umpire = await signIn("umpire.dev@tournament.local", "dev-umpire-pass");
  }, 30_000);

  test("Case A/D: completing a single_elim match creates no phantom child match", async () => {
    let r = await send(organizer.token, "create_tournament", { name: `RPC-A ${Date.now()}` });
    expect(r.body.ok).toBe(true);
    const tournamentId = r.body.result.tournament.id;

    r = await send(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration" });
    expect(r.body.ok).toBe(true);

    r = await send(organizer.token, "create_division", {
      tournament_id: tournamentId,
      name: "Single Elim Regression",
      format: "single_elim",
      config: { winTo: 2, winBy: "none", bestOf: 1, isDoubles: false },
    });
    expect(r.body.ok).toBe(true);
    const divisionId = r.body.result.division.id;

    const personIds = [];
    for (const name of ["RPC Player 1", "RPC Player 2"]) {
      r = await send(organizer.token, "add_person", { tournament_id: tournamentId, display_name: name });
      expect(r.body.ok).toBe(true);
      personIds.push(r.body.result.person.id);
    }

    for (const personId of personIds) {
      r = await send(organizer.token, "register_participant", {
        division_id: divisionId,
        kind: "singles",
        display_name: "RPC Participant",
        person_ids: [personId],
      });
      expect(r.body.ok).toBe(true);
    }

    r = await send(organizer.token, "create_court", { tournament_id: tournamentId, name: "RPC Court" });
    expect(r.body.ok).toBe(true);
    const courtId = r.body.result.court.id;

    r = await send(organizer.token, "add_member", { tournament_id: tournamentId, user_id: umpire.user.id, role: "umpire" });
    expect(r.body.ok).toBe(true);

    r = await send(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "registration_closed" });
    expect(r.body.ok).toBe(true);
    r = await send(organizer.token, "transition_tournament", { tournament_id: tournamentId, status: "ready" });
    expect(r.body.ok).toBe(true);

    r = await send(organizer.token, "generate_bracket", { division_id: divisionId });
    expect(r.body.ok).toBe(true);
    expect(r.body.result.match_count).toBe(1);

    const { data: matches, error } = await organizer.client.from("matches").select("*").eq("division_id", divisionId);
    expect(error).toBeNull();
    expect(matches.length).toBe(1);
    const matchId = matches[0].id;
    expect(matches[0].parent_match_id).toBeNull();

    r = await send(organizer.token, "assign_court", { match_id: matchId, court_id: courtId });
    expect(r.body.ok).toBe(true);
    r = await send(organizer.token, "assign_umpire", { match_id: matchId, user_id: umpire.user.id });
    expect(r.body.ok).toBe(true);

    r = await send(umpire.token, "start_match", { match_id: matchId });
    expect(r.body.ok).toBe(true);

    r = await send(umpire.token, "score_event", {
      match_id: matchId,
      event_id: crypto.randomUUID(),
      seq: 1,
      type: "point",
      payload: { team: "A" },
    });
    expect(r.body.ok).toBe(true);

    r = await send(umpire.token, "score_event", {
      match_id: matchId,
      event_id: crypto.randomUUID(),
      seq: 2,
      type: "point",
      payload: { team: "A" },
    });
    expect(r.body.ok).toBe(true);
    expect(r.body.result.match.status).toBe("completed");

    // Case A/D: no phantom child match — the pre-fix bug created exactly one
    // spurious `matches` row with parent_match_id = matchId here.
    const { data: allDivisionMatches, error: divErr } = await organizer.client
      .from("matches")
      .select("id, parent_match_id")
      .eq("division_id", divisionId);
    expect(divErr).toBeNull();
    expect(allDivisionMatches.length).toBe(1);

    const { data: children, error: childErr } = await organizer.client
      .from("matches")
      .select("id")
      .eq("parent_match_id", matchId);
    expect(childErr).toBeNull();
    expect(children.length).toBe(0);

    // handleCompleteMatch's "already complete" branch also calls
    // reconcilePlayoffChildren — exercise it too and confirm it stays a no-op.
    r = await send(organizer.token, "complete_match", { match_id: matchId });
    expect(r.body.ok).toBe(true);

    const { data: childrenAfterComplete, error: childErr2 } = await organizer.client
      .from("matches")
      .select("id")
      .eq("parent_match_id", matchId);
    expect(childErr2).toBeNull();
    expect(childrenAfterComplete.length).toBe(0);
  }, 120_000);
});
