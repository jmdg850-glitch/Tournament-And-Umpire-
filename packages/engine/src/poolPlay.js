// Pool play + pool-to-knockout — N independent round-robins, then existing knockout generators.

import { generateRoundRobinSchedule } from "./roundRobin.js";
import { buildTournamentStandings } from "./standings.js";
import { generateBracket } from "./bracket.js";
import { generateDoubleEliminationBracket } from "./doubleElimination.js";

export function assignPools(registrations, poolCount, makePoolId) {
  const n = Math.max(1, Math.min(poolCount || 1, registrations.length));
  const pools = Array.from({ length: n }, (_, i) => ({ id: makePoolId ? makePoolId(i) : "pool_" + i, registrations: [] }));
  let dir = 1, idx = 0;
  registrations.forEach(r => {
    pools[idx].registrations.push(r);
    if (dir === 1 && idx === n - 1) dir = -1;
    else if (dir === -1 && idx === 0) dir = 1;
    else idx += dir;
  });
  return pools;
}

export function generatePoolSchedules(pools, makeId) {
  const genId = makeId || (() => "tm_" + Math.random().toString(36).slice(2, 10));
  return pools.flatMap(pool => {
    const { rounds } = generateRoundRobinSchedule(pool.registrations);
    return rounds.flatMap(rnd => rnd.matches.filter(m => !m.isBye).map(m => ({
      id: genId(), poolId: pool.id, round: rnd.round,
      registrationAId: m.registrationAId, registrationBId: m.registrationBId, status: "scheduled",
    })));
  });
}

export function buildPoolStandings(pool, matches) {
  return buildTournamentStandings(pool.registrations, matches.filter(m => m.poolId === pool.id));
}

export function selectAdvancers(pools, matches, advanceCount) {
  return pools.flatMap(pool => {
    const standings = buildPoolStandings(pool, matches);
    return standings.slice(0, advanceCount)
      .map(row => pool.registrations.find(r => r.id === row.registrationId))
      .filter(Boolean);
  });
}

export function generateKnockoutFromPools(advancers, format, opts = {}) {
  const generate = format === "double_elimination" ? generateDoubleEliminationBracket : generateBracket;
  return generate(advancers, opts);
}
