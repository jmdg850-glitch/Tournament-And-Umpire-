import { useState, useEffect, useCallback } from "react";
import { Panel } from "../../components/ui/Panel.jsx";
import { FilterChipGroup } from "../../components/ui/FilterChip.jsx";
import { Avatar } from "../../components/ui/Avatar.jsx";
import { RegistrationModal } from "../../modals/RegistrationModal.jsx";
import { RoundRobinScheduleView } from "./RoundRobinScheduleView.jsx";
import { BracketView } from "./BracketView.jsx";
import { PoolScheduleView } from "./PoolScheduleView.jsx";
import { StandingsPanel } from "./StandingsPanel.jsx";
import { TeamStandingsPanel } from "./TeamStandingsPanel.jsx";
import { IndividualQualificationStandingsPanel } from "./IndividualQualificationStandingsPanel.jsx";
import { groupRegistrationsByTeam } from "../../lib/tournamentTeamVsTeam.js";
import { buildTeamStandingsFromRoundRobin, rankIndividualPairsForSemifinals } from "../../lib/tournamentTeamRoundRobin.js";
import { selectQualifiers, hasKnockoutStageStarted } from "../../lib/tournamentTeamPlayoffs.js";
import { TeamsPanel } from "./TeamsPanel.jsx";
import { TeamGroupsPanel } from "./TeamGroupsPanel.jsx";
import { UmpirePickerModal } from "./UmpirePickerModal.jsx";
import { Cloud } from "../../lib/cloud.js";
import { Outbox } from "../../lib/outbox.js";
import { LS } from "../../lib/storage.js";
import { assignCourtsToRoundRobinSchedule } from "../../lib/tournamentRoundRobin.js";
import { seedRandom, seedByDuprRating, seedByInternalRanking, seedByPreviousResults, seedByTeamRanking } from "../../lib/tournamentSeeding.js";
import { uid } from "../../lib/utils.js";
import { D } from "../../theme/tokens.js";

const SEED_METHODS=[{value:"random",label:"Random"},{value:"dupr",label:"DUPR"},{value:"internal",label:"Internal Rating"},{value:"previous",label:"Previous Results"}];

const teamNameOf=(registrations,id)=>{
  if(!id) return "TBD";
  const r=registrations.find(x=>x.id===id);
  return r ? Object.values(r.playerNames||{}).join(" / ")||"Unnamed" : "—";
};
const nameForMatch=(registrations,m)=>teamNameOf(registrations,m.registrationAId)+" vs "+teamNameOf(registrations,m.registrationBId);

export function DivisionDetailPanel({division,directory=[],accountsDirectory=[],courts=[],canEdit,currentUser,onStartMatch,onClose,notify}){
  const [tab,setTab]=useState("registrations");
  const [umpirePickerMatch,setUmpirePickerMatch]=useState(null);
  // LS-mirrored per division id — same reasoning as TournamentDetailPanel's own mirroring:
  // this panel fully unmounts on close, so without this a cold offline reopen shows empty
  // until Cloud reconnects.
  const [registrations,setRegistrations]=useState(()=>LS.get("pl6_dregs_"+division.id,[]));
  const [matches,setMatches]=useState(()=>LS.get("pl6_dmatches_"+division.id,[]));
  const [pools,setPools]=useState(()=>LS.get("pl6_dpools_"+division.id,[]));
  const [teamGroups,setTeamGroups]=useState(()=>LS.get("pl6_dteamgroups_"+division.id,[]));
  const [teamMatchups,setTeamMatchups]=useState(()=>LS.get("pl6_dteammatchups_"+division.id,[]));
  const [showRegister,setShowRegister]=useState(false);
  // Account-level DUPR link status for the Players tab badge — same batch RPC
  // and pattern as SyncCenterPanel's identical lookup (accounts.dupr_id isn't
  // directly readable for other users' rows, only this narrow boolean is).
  const [duprLinked,setDuprLinked]=useState({});

  useEffect(()=>{ LS.set("pl6_dregs_"+division.id,registrations); },[registrations,division.id]);
  useEffect(()=>{ LS.set("pl6_dmatches_"+division.id,matches); },[matches,division.id]);
  useEffect(()=>{ LS.set("pl6_dpools_"+division.id,pools); },[pools,division.id]);
  useEffect(()=>{ LS.set("pl6_dteamgroups_"+division.id,teamGroups); },[teamGroups,division.id]);
  useEffect(()=>{ LS.set("pl6_dteammatchups_"+division.id,teamMatchups); },[teamMatchups,division.id]);

  useEffect(()=>{
    let alive=true;
    const accountIds=[...new Set(registrations.filter(r=>r.status!=="withdrawn").flatMap(r=>r.linkedAccountIds||[]))];
    (accountIds.length?Cloud.fetchAccountsDuprLinkStatus(accountIds):Promise.resolve({})).then(m=>{ if(alive) setDuprLinked(m); });
    return ()=>{ alive=false; };
  },[registrations]);

  useEffect(()=>{
    let alive=true;
    // Additive merge, not a wholesale replace — this Panel fully unmounts on close and remounts
    // fresh on reopen, so a registration/match just created via Outbox may not have drained to
    // Supabase yet the next time this effect runs.
    Cloud.fetchRegistrations(division.id).then(rows=>{
      if(alive) setRegistrations(prev=>{
        const ids=new Set(rows.map(r=>r.id));
        const localOnly=prev.filter(r=>!ids.has(r.id));
        return [...rows,...localOnly];
      });
    });
    Cloud.fetchTournamentMatches(division.id).then(rows=>{
      if(alive) setMatches(prev=>{
        const ids=new Set(rows.map(m=>m.id));
        const localOnly=prev.filter(m=>!ids.has(m.id));
        return [...rows,...localOnly];
      });
    });
    let matchesChannel=null,registrationsChannel=null;
    Cloud.subscribeTournamentMatches(division.id,(mapped,eventType)=>{
      setMatches(prev=>{
        if(eventType==="DELETE") return prev.filter(m=>m.id!==mapped.id);
        const exists=prev.some(m=>m.id===mapped.id);
        return exists ? prev.map(m=>m.id===mapped.id?mapped:m) : [...prev,mapped];
      });
    }).then(c=>{ if(alive) matchesChannel=c; else if(c) Cloud.removeChannel(c); });
    Cloud.subscribeRegistrations(division.id,(mapped,eventType)=>{
      setRegistrations(prev=>{
        if(eventType==="DELETE") return prev.filter(r=>r.id!==mapped.id);
        const exists=prev.some(r=>r.id===mapped.id);
        return exists ? prev.map(r=>r.id===mapped.id?mapped:r) : [...prev,mapped];
      });
    }).then(c=>{ if(alive) registrationsChannel=c; else if(c) Cloud.removeChannel(c); });
    return ()=>{ alive=false; if(matchesChannel) Cloud.removeChannel(matchesChannel); if(registrationsChannel) Cloud.removeChannel(registrationsChannel); };
  },[division.id]);

  // Pool Play / Pool-to-Knockout groups — only ever populated for those two formats,
  // but harmless to always fetch/subscribe (empty result for every other format).
  useEffect(()=>{
    let alive=true;
    Cloud.fetchPools(division.id).then(rows=>{
      if(alive) setPools(prev=>{
        const ids=new Set(rows.map(p=>p.id));
        const localOnly=prev.filter(p=>!ids.has(p.id));
        return [...rows,...localOnly];
      });
    });
    let poolsChannel=null;
    Cloud.subscribePools(division.id,(mapped,eventType)=>{
      setPools(prev=>{
        if(eventType==="DELETE") return prev.filter(p=>p.id!==mapped.id);
        const exists=prev.some(p=>p.id===mapped.id);
        return exists ? prev.map(p=>p.id===mapped.id?mapped:p) : [...prev,mapped];
      });
    }).then(c=>{ if(alive) poolsChannel=c; else if(c) Cloud.removeChannel(c); });
    return ()=>{ alive=false; if(poolsChannel) Cloud.removeChannel(poolsChannel); };
  },[division.id]);

  // Team Elimination "Team Groups" — only ever populated for that format, but harmless to
  // always fetch/subscribe (empty result for every other format), same reasoning as pools above.
  useEffect(()=>{
    let alive=true;
    Cloud.fetchTeams(division.id).then(rows=>{
      if(alive) setTeamGroups(prev=>{
        const ids=new Set(rows.map(t=>t.id));
        const localOnly=prev.filter(t=>!ids.has(t.id));
        return [...rows,...localOnly];
      });
    });
    let teamsChannel=null;
    Cloud.subscribeTeams(division.id,(mapped,eventType)=>{
      setTeamGroups(prev=>{
        if(eventType==="DELETE") return prev.filter(t=>t.id!==mapped.id);
        const exists=prev.some(t=>t.id===mapped.id);
        return exists ? prev.map(t=>t.id===mapped.id?mapped:t) : [...prev,mapped];
      });
    }).then(c=>{ if(alive) teamsChannel=c; else if(c) Cloud.removeChannel(c); });
    return ()=>{ alive=false; if(teamsChannel) Cloud.removeChannel(teamsChannel); };
  },[division.id]);

  // Team Elimination "Team Matchups" — the true bracket unit (Team A vs Team B).
  // Only ever populated for team_elimination, same additive-merge/fetch+subscribe
  // pattern as Team Groups above.
  useEffect(()=>{
    let alive=true;
    Cloud.fetchTeamMatchups(division.id).then(rows=>{
      if(alive) setTeamMatchups(prev=>{
        const ids=new Set(rows.map(m=>m.id));
        const localOnly=prev.filter(m=>!ids.has(m.id));
        return [...rows,...localOnly];
      });
    });
    let matchupsChannel=null;
    Cloud.subscribeTeamMatchups(division.id,(mapped,eventType)=>{
      setTeamMatchups(prev=>{
        if(eventType==="DELETE") return prev.filter(m=>m.id!==mapped.id);
        const exists=prev.some(m=>m.id===mapped.id);
        return exists ? prev.map(m=>m.id===mapped.id?mapped:m) : [...prev,mapped];
      });
    }).then(c=>{ if(alive) matchupsChannel=c; else if(c) Cloud.removeChannel(c); });
    return ()=>{ alive=false; if(matchupsChannel) Cloud.removeChannel(matchupsChannel); };
  },[division.id]);

  const onCreateTeamGroup=useCallback(name=>{
    const team={id:"tteam_"+uid(),tournamentId:division.tournamentId,divisionId:division.id,organizerId:division.organizerId,name,color:null};
    Outbox.enqueue("createTeam",{team});
    setTeamGroups(prev=>[...prev,team]);
    Outbox.drain();
  },[division.tournamentId,division.id,division.organizerId]);

  const onRenameTeamGroup=useCallback((id,patch)=>{
    Outbox.enqueue("updateTeam",{id,patch});
    setTeamGroups(prev=>prev.map(t=>t.id===id?{...t,...patch}:t));
    Outbox.drain();
  },[]);

  const onSetTeamBracketGroup=useCallback((id,bracketGroup)=>{
    Outbox.enqueue("updateTeam",{id,patch:{bracketGroup}});
    setTeamGroups(prev=>prev.map(t=>t.id===id?{...t,bracketGroup}:t));
    Outbox.drain();
  },[]);

  const onDeleteTeamGroup=useCallback(id=>{
    Outbox.enqueue("deleteTeam",{id});
    setTeamGroups(prev=>prev.filter(t=>t.id!==id));
    // DB cascades team_id -> null via "on delete set null", but local state needs the
    // same update for immediate UI consistency (this panel doesn't re-fetch registrations
    // just because a team was deleted).
    setRegistrations(prev=>prev.map(r=>r.teamId===id?{...r,teamId:null}:r));
    Outbox.drain();
  },[]);

  const onAssignRegistrationToTeamGroup=useCallback((registrationId,teamGroupId)=>{
    Outbox.enqueue("updateRegistration",{id:registrationId,patch:{teamId:teamGroupId}});
    setRegistrations(prev=>prev.map(r=>r.id===registrationId?{...r,teamId:teamGroupId}:r));
  },[]);

  const onRegister=useCallback(rows=>{
    Outbox.enqueue("bulkCreateRegistrations",{rows});
    setRegistrations(prev=>[...prev,...rows]);
    notify?.(rows.length>1?rows.length+" entrants registered":"Registered");
    setShowRegister(false);
  },[notify]);

  // "player added to a match" notification — fired once per real-player match row (skips TBD
  // bracket shells, which have no registrationAId/registrationBId yet) at the moment this panel
  // itself creates rows with both sides already known. Cloud.sendNotificationOnce (migration 144)
  // makes this safe to call again for the same match+player without duplicating — needed because
  // Outbox retries can call these generation handlers' resulting writes more than once.
  const notifyMatchAssigned=useCallback(row=>{
    if(!row.registrationAId||!row.registrationBId) return;
    const regA=registrations.find(r=>r.id===row.registrationAId);
    const regB=registrations.find(r=>r.id===row.registrationBId);
    [[regA,regB],[regB,regA]].forEach(([mine,opp])=>{
      (mine?.linkedAccountIds||[]).forEach(userId=>{
        Cloud.sendNotificationOnce({
          userId, type:"match_assigned", title:"🔔 New Match",
          body:division.name+" · vs "+teamNameOf(registrations,opp?.id)+(row.round?(" · Round "+row.round):""),
          matchId:row.id, actorId:currentUser?.id, actorName:currentUser?.name,
        });
      });
    });
  },[registrations,division.name,currentUser]);

  const onGenerate=useCallback(rows=>{
    Outbox.enqueue("bulkCreateTournamentMatches",{rows});
    setMatches(rows);
    rows.forEach(notifyMatchAssigned);
    notify?.("Schedule generated");
  },[notify,notifyMatchAssigned]);

  // Team Elimination: generation produces TWO row sets — the team-matchup shells
  // (tournament_team_matchups) and round-1's individual pair matches
  // (tournament_matches, same table/outbox kind every other format's matches use).
  const onGenerateTeamMatchups=useCallback((matchupRows,pairRows)=>{
    Outbox.enqueue("bulkCreateTeamMatchups",{rows:matchupRows});
    Outbox.enqueue("bulkCreateTournamentMatches",{rows:pairRows});
    setTeamMatchups(matchupRows);
    setMatches(prev=>[...prev,...pairRows]);
    Outbox.drain();
    pairRows.forEach(notifyMatchAssigned);
    notify?.("Bracket generated");
  },[notify,notifyMatchAssigned]);

  // Elimination-bracket (Semifinal/Quarterfinal/.../Bronze/Final) generation AND
  // regeneration share this one path — BracketView.jsx computes the qualifier-shell rows
  // (already stamped with tournamentId/divisionId/organizerId) and calls this with them.
  // Regeneration never touches round_robin-stage rows, and is blocked entirely (by
  // BracketView, before this is ever called) once any knockout-stage match has started —
  // this only re-checks defensively, never silently discarding real results.
  const onGenerateOrRegenerateQualifierBracket=useCallback((shellMatchups,shellPairs,manualQualifierIds)=>{
    const existing=teamMatchups.filter(m=>m.stage&&m.stage!=="round_robin");
    if(existing.length){
      if(hasKnockoutStageStarted(teamMatchups,matches)){
        notify?.("Can't regenerate — a Quarterfinal/Semifinal/Final match has already started.","err");
        return;
      }
      const existingIds=new Set(existing.map(m=>m.id));
      Outbox.enqueue("deleteTeamMatchupsBulk",{ids:[...existingIds]});
      setTeamMatchups(prev=>prev.filter(m=>!existingIds.has(m.id)));
      setMatches(prev=>prev.filter(m=>!existingIds.has(m.teamMatchupId)));
    }
    if(manualQualifierIds) Outbox.enqueue("updateDivision",{id:division.id,patch:{manualQualifierIds}});
    Outbox.enqueue("bulkCreateTeamMatchups",{rows:shellMatchups});
    Outbox.enqueue("bulkCreateTournamentMatches",{rows:shellPairs});
    setTeamMatchups(prev=>[...prev,...shellMatchups]);
    setMatches(prev=>[...prev,...shellPairs]);
    Outbox.drain();
    shellPairs.forEach(notifyMatchAssigned);
    notify?.(existing.length?"Bracket regenerated":"Bracket generated");
  },[teamMatchups,matches,division.id,notify,notifyMatchAssigned]);

  // Pool Play: creates the pool rows, assigns each pool's registrations their pool_id,
  // and bulk-inserts the per-pool round-robin schedule — three existing outbox kinds
  // (createPool/updateRegistration/bulkCreateTournamentMatches), no new write path.
  const onGeneratePools=useCallback((generatedPools,scheduleRows)=>{
    generatedPools.forEach(pool=>{
      Outbox.enqueue("createPool",{pool:{id:pool.id,tournamentId:division.tournamentId,divisionId:division.id,organizerId:division.organizerId,name:"Pool "+String.fromCharCode(65+generatedPools.indexOf(pool))}});
      pool.registrations.forEach(r=>Outbox.enqueue("updateRegistration",{id:r.id,patch:{poolId:pool.id}}));
    });
    Outbox.enqueue("bulkCreateTournamentMatches",{rows:scheduleRows});
    setPools(prev=>[...prev,...generatedPools.map((p,i)=>({id:p.id,tournamentId:division.tournamentId,divisionId:division.id,organizerId:division.organizerId,name:"Pool "+String.fromCharCode(65+i)}))]);
    setRegistrations(prev=>prev.map(r=>{
      const pool=generatedPools.find(p=>p.registrations.some(x=>x.id===r.id));
      return pool?{...r,poolId:pool.id}:r;
    }));
    setMatches(scheduleRows);
    Outbox.drain();
    scheduleRows.forEach(notifyMatchAssigned);
    notify?.("Pools generated");
  },[division.tournamentId,division.id,division.organizerId,notify,notifyMatchAssigned]);

  // Pool-to-Knockout: hands the pool-phase advancers to the same bulkCreateTournamentMatches
  // outbox kind BracketView.jsx's own "Generate Bracket" button uses — the resulting rows
  // are indistinguishable from a plain single/double-elim division from this point on.
  const onGenerateKnockout=useCallback(rows=>{
    Outbox.enqueue("bulkCreateTournamentMatches",{rows});
    setMatches(prev=>[...prev,...rows]);
    rows.forEach(notifyMatchAssigned);
    notify?.("Knockout bracket generated");
  },[notify,notifyMatchAssigned]);

  // Wraps the parent-owned onStartMatch (ultimately App.jsx's startTournamentMatch) the same
  // way onAssignCourt/assignUmpire below pair their own Outbox write with an immediate local
  // patch — startTournamentMatch's write and this panel's `matches` state live in different
  // components, so without this the Start Match button/LIVE indicator only updated once the
  // Supabase realtime echo of that write came back, not at click time. startTournamentMatch
  // now returns the started live-match object (truthy) or a falsy value on its own guard
  // returns (missing entrant / invalid matchup), so this never marks a blocked start as active.
  const handleStartMatch=useCallback(m=>{
    const started=onStartMatch(m,division,registrations);
    if(started) setMatches(prev=>prev.map(x=>x.id===m.id?{...x,status:"in_progress"}:x));
  },[onStartMatch,division,registrations]);

  const onAssignCourt=useCallback((matchId,courtId)=>{
    Outbox.enqueue("updateTournamentMatch",{id:matchId,patch:{courtId}});
    setMatches(prev=>prev.map(m=>m.id===matchId?{...m,courtId}:m));
  },[]);

  const onAutoAssignCourts=useCallback(()=>{
    // A court explicitly marked cleaning/maintenance/occupied (Court Management, in
    // TournamentDetailPanel's Courts tab) must never receive an auto-assigned match even
    // if it's still `active` in the casual sense — status defaults to "available" for
    // every court that's never had it set, so this is a no-op filter until an organizer
    // actually uses Court Management.
    const activeCourtIds=courts.filter(c=>c.active&&(c.status||"available")==="available").map(c=>c.id);
    const patches=assignCourtsToRoundRobinSchedule(matches,activeCourtIds);
    if(!patches.length){ notify?.("No unassigned matches (or no active courts)","err"); return; }
    Outbox.enqueue("bulkUpdateTournamentMatches",{patches});
    setMatches(prev=>prev.map(m=>{ const p=patches.find(x=>x.matchId===m.id); return p?{...m,...p.patch}:m; }));
    notify?.(patches.length+" court"+(patches.length!==1?"s":"")+" assigned");
  },[matches,courts,notify]);

  // Umpire assignment is unilateral (no accept/decline queue) — two plain columns on
  // tournament_matches, same pattern as courtId/refereeName above. Widens the match's
  // permission surface via RLS (migration 127), notifies the assignee, and records the
  // assignment in the audit log — mirrors the notify+audit pattern used for match
  // completion elsewhere in this file's sibling panels.
  const assignUmpire=useCallback((match,umpireId,umpireName)=>{
    const patch={umpireId,umpireName,umpireAssignedAt:umpireId?new Date().toISOString():null};
    Outbox.enqueue("updateTournamentMatch",{id:match.id,patch});
    setMatches(prev=>prev.map(m=>m.id===match.id?{...m,...patch}:m));
    Outbox.drain();
    if(umpireId){
      Cloud.sendNotification({userId:umpireId,type:"umpire_assigned",title:"You've been assigned as umpire",
        body:division.name+" · "+nameForMatch(registrations,match),matchId:match.id,actorId:currentUser?.id,actorName:currentUser?.name});
      Cloud.appendAuditLog({tournamentMatchId:match.id,organizerId:division.organizerId,actorId:currentUser?.id,actorName:currentUser?.name,
        action:"umpire_assigned",detail:{umpireId,umpireName}});
      notify?.("Umpire assigned");
    } else {
      Cloud.appendAuditLog({tournamentMatchId:match.id,organizerId:division.organizerId,actorId:currentUser?.id,actorName:currentUser?.name,
        action:"umpire_removed",detail:null});
      notify?.("Umpire removed");
    }
  },[division.name,division.organizerId,registrations,currentUser,notify]);

  const onSetRegistrationStatus=useCallback((id,status)=>{
    Outbox.enqueue("updateRegistration",{id,patch:{status}});
    setRegistrations(prev=>prev.map(r=>r.id===id?{...r,status}:r));
  },[]);

  const isDoubles=division.isDoubles!==false;

  // Manual seeding: a direct per-row seed number edit. Everything BracketView.jsx reads
  // to seed a freshly-generated bracket is registration.seed (sorted ascending, unseeded
  // last) — writing here is the entire "Manual" seeding method, no separate UI needed.
  const [seedMethod,setSeedMethod]=useState("random");
  const onSetSeed=useCallback((id,seed)=>{
    Outbox.enqueue("updateRegistration",{id,patch:{seed}});
    setRegistrations(prev=>prev.map(r=>r.id===id?{...r,seed}:r));
  },[]);

  // Random/DUPR/Internal Rating/Previous Results: computes a full order via
  // tournamentSeeding.js's pure functions, then writes seed=1..N back onto every
  // non-withdrawn registration (same field Manual editing above writes).
  const applyAutoSeed=useCallback(async()=>{
    const active=registrations.filter(r=>r.status!=="withdrawn");
    if(active.length<2){ notify?.("Need at least 2 active registrations to seed","err"); return; }
    let ordered=active;
    if(seedMethod==="random") ordered=seedRandom(active);
    else if(seedMethod==="dupr") ordered=seedByDuprRating(active);
    else if(seedMethod==="internal") ordered=seedByInternalRanking(active,directory,isDoubles);
    else if(seedMethod==="previous"){
      const accountIds=[...new Set(active.flatMap(r=>[...(r.linkedAccountIds||[]),...(r.playerIds||[])]))];
      const historyMap=await Cloud.fetchAccountTournamentHistory(accountIds);
      ordered=seedByPreviousResults(active,historyMap);
    }
    else if(seedMethod==="team") ordered=seedByTeamRanking(active,directory,isDoubles);
    const seedOf=new Map(ordered.map((r,i)=>[r.id,i+1]));
    ordered.forEach(r=>{
      const seed=seedOf.get(r.id);
      if(r.seed!==seed) Outbox.enqueue("updateRegistration",{id:r.id,patch:{seed}});
    });
    setRegistrations(prev=>prev.map(r=>seedOf.has(r.id)?{...r,seed:seedOf.get(r.id)}:r));
    Outbox.drain();
    notify?.("Seeding applied");
  },[registrations,directory,isDoubles,seedMethod,notify]);

  // Merges two single-player ("pending partner") registrations into one 2-player
  // registration — the second is withdrawn rather than deleted, consistent with how
  // every other registration-lifecycle action in this panel (Check In/Withdraw/Reinstate)
  // uses status, not row deletion. Both writes go through the existing updateRegistration
  // outbox kind — no new kind needed since player_ids/player_names are already jsonb.
  const onPairTeams=useCallback(pairs=>{
    pairs.forEach(({aId,bId})=>{
      const regA=registrations.find(r=>(r.playerIds||[]).length===1&&r.playerIds[0]===aId);
      const regB=registrations.find(r=>(r.playerIds||[]).length===1&&r.playerIds[0]===bId);
      if(!regA||!regB) return;
      const patch={
        playerIds:[aId,bId],
        playerNames:{...regA.playerNames,...regB.playerNames},
        playerGenders:{...regA.playerGenders,...regB.playerGenders},
        playerAges:{...regA.playerAges,...regB.playerAges},
        playerDuprRatings:{...regA.playerDuprRatings,...regB.playerDuprRatings},
        linkedAccountIds:[...(regA.linkedAccountIds||[]),...(regB.linkedAccountIds||[])],
      };
      Outbox.enqueue("updateRegistration",{id:regA.id,patch});
      Outbox.enqueue("updateRegistration",{id:regB.id,patch:{status:"withdrawn"}});
      setRegistrations(prev=>prev.map(r=>{
        if(r.id===regA.id) return {...r,...patch};
        if(r.id===regB.id) return {...r,status:"withdrawn"};
        return r;
      }));
    });
    notify?.(pairs.length+" team"+(pairs.length!==1?"s":"")+" formed");
  },[registrations,notify]);

  // One row per player, not per registration — a doubles registration bundles 2 players
  // under one row everywhere else in this panel, but the Players tab needs each player
  // individually visible (with their DUPR/internal ranking/seed/status/partner), so this
  // flattens playerNames/playerDuprRatings/playerGenders/playerAges (all already loaded,
  // no new fetch) into one entry per player id.
  const playersFlat=registrations.flatMap(r=>{
    const ids=Object.keys(r.playerNames||{});
    return ids.map(pid=>({
      key:r.id+"_"+pid, playerId:pid, name:r.playerNames[pid]||"Player",
      dupr:r.playerDuprRatings?.[pid]||null, gender:r.playerGenders?.[pid]||null, age:r.playerAges?.[pid]||null,
      seed:r.seed??null, status:r.status, registrationId:r.id, linked:(r.linkedAccountIds||[]).includes(pid),
      partnerName:ids.length>1?r.playerNames[ids.find(x=>x!==pid)]:null,
    }));
  });

  const isPoolFormat=division.format==="pool_play"||division.format==="pool_to_knockout";
  // Once pool-to-knockout's bracket phase has been generated, its matches carry no
  // poolId (they came from generateKnockoutFromPools, same shape as a plain single/
  // double-elim division) — that's what distinguishes "still in the pool phase" from
  // "knockout bracket exists," so the Schedule tab knows which view to render.
  const hasKnockoutMatches=isPoolFormat&&matches.some(m=>!m.poolId);
  const tabs=[
    {value:"registrations",label:"Registrations · "+registrations.length},
    {value:"players",label:"Players · "+playersFlat.length},
    ...(isDoubles?[{value:"teams",label:"Teams"}]:[]),
    ...(division.format==="team_elimination"?[{value:"teamGroups",label:"Team Groups · "+teamGroups.length}]:[]),
    {value:"schedule",label:(division.format==="round_robin"||(isPoolFormat&&!hasKnockoutMatches))?"Schedule":"Bracket"},
    {value:"standings",label:"Standings"},
  ];

  // "Team Ranking" only makes sense where registrations carry a teamId to rank by.
  const seedMethodOptions=division.format==="team_elimination"?[...SEED_METHODS,{value:"team",label:"Team Ranking"}]:SEED_METHODS;

  return(
    <Panel title={division.name} sub={(division.category||"")+(division.skillLevel?" · "+division.skillLevel:"")} onClose={onClose}>
      <div style={{marginBottom:16}}><FilterChipGroup options={tabs} value={tab} onChange={setTab}/></div>

      {tab==="registrations"&&(
        <>
          {canEdit&&<button onClick={()=>setShowRegister(true)}
            style={{width:"100%",padding:11,background:D.accentBg,border:"1px solid "+D.accent,borderRadius:20,color:D.accent,fontWeight:700,fontSize:13,cursor:"pointer",marginBottom:14}}>
            + Register {division.isDoubles?"Team":"Player"}
          </button>}
          {canEdit&&registrations.length>=2&&(
            <div style={{marginBottom:14}}>
              <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>SEED (MANUAL — EDIT # BELOW — OR AUTO-SEED)</div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <div style={{flex:1}}><FilterChipGroup options={seedMethodOptions} value={seedMethod} onChange={setSeedMethod}/></div>
                <button onClick={applyAutoSeed}
                  style={{padding:"8px 14px",background:D.accent,border:"none",borderRadius:16,color:"#fff",fontWeight:700,fontSize:11,cursor:"pointer",flexShrink:0}}>
                  Apply
                </button>
              </div>
            </div>
          )}
          {registrations.length===0&&<div style={{textAlign:"center",padding:"30px 20px",color:D.textMuted,fontSize:13}}>No one registered yet.</div>}
          {registrations.map(r=>{
            const withdrawn=r.status==="withdrawn";
            const playerIds=Object.keys(r.playerNames||{});
            const details=playerIds.map(pid=>{
              const bits=[r.playerGenders?.[pid],r.playerAges?.[pid]?r.playerAges[pid]+"y":null,r.playerDuprRatings?.[pid]?"DUPR "+r.playerDuprRatings[pid]:null].filter(Boolean);
              return bits.length?bits.join(" · "):null;
            }).filter(Boolean);
            return(
              <div key={r.id} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 4px",borderBottom:"1px solid "+D.border,opacity:withdrawn?0.55:1}}>
                <Avatar name={Object.values(r.playerNames||{})[0]||"?"} size={30} color={D.accent}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:700,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    {r.teamName||Object.values(r.playerNames||{}).join(" / ")}
                  </div>
                  {r.teamName&&<div style={{fontSize:11,color:D.textSecondary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{Object.values(r.playerNames||{}).join(" / ")}</div>}
                  <div style={{fontSize:10,color:D.textMuted}}>{details.join(" · ")}</div>
                  {withdrawn&&<div style={{fontSize:9,fontWeight:800,color:D.red,letterSpacing:"0.5px",marginTop:2}}>WITHDRAWN</div>}
                </div>
                {canEdit?(
                  <input type="number" min="1" value={r.seed??""} placeholder="Seed"
                    onChange={e=>onSetSeed(r.id,e.target.value?+e.target.value:null)}
                    style={{width:44,flexShrink:0,background:D.cardEl,border:"1px solid "+D.border,borderRadius:8,padding:"5px 4px",color:D.textPrimary,fontSize:11,textAlign:"center",outline:"none"}}/>
                ) : (r.seed?<span style={{fontSize:10,color:D.textMuted,flexShrink:0}}>#{r.seed}</span>:null)}
                {canEdit&&(
                  <div style={{display:"flex",gap:6,flexShrink:0}}>
                    {r.status==="registered"&&<button onClick={()=>onSetRegistrationStatus(r.id,"checked_in")}
                      style={{padding:"5px 10px",background:D.greenBg,border:"1px solid "+D.green,borderRadius:14,color:D.green,fontWeight:700,fontSize:10,cursor:"pointer"}}>Check In</button>}
                    {!withdrawn&&<button onClick={()=>onSetRegistrationStatus(r.id,"withdrawn")}
                      style={{padding:"5px 10px",background:D.redBg,border:"1px solid "+D.red,borderRadius:14,color:D.red,fontWeight:700,fontSize:10,cursor:"pointer"}}>Withdraw</button>}
                    {withdrawn&&<button onClick={()=>onSetRegistrationStatus(r.id,"registered")}
                      style={{padding:"5px 10px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:14,color:D.textSecondary,fontWeight:700,fontSize:10,cursor:"pointer"}}>Reinstate</button>}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      {tab==="players"&&(
        <>
          {playersFlat.length===0&&<div style={{textAlign:"center",padding:"30px 20px",color:D.textMuted,fontSize:13}}>No players registered yet.</div>}
          {playersFlat.map(p=>{
            const acct=directory.find(x=>x.id===p.playerId);
            const ranking=acct?(division.isDoubles?acct.doublesRating:acct.singlesRating):null;
            const withdrawn=p.status==="withdrawn";
            // DUPR link status is id-based only (the linked account's own dupr_id, or the
            // roster row's directly-set dupr_id) — never derived from name matching. See
            // PlayerPicker's identical hasDupr logic in RegistrationModal.jsx.
            const hasDuprLink=!!acct?.duprId || (p.linked&&!!duprLinked[p.playerId]);
            return(
              <div key={p.key} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 4px",borderBottom:"1px solid "+D.border,opacity:withdrawn?0.55:1}}>
                <Avatar name={p.name} size={30} color={D.accent}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:700,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</div>
                  <div style={{fontSize:10,color:D.textMuted}}>
                    {[p.seed?"Seed #"+p.seed:null,p.dupr?"DUPR "+p.dupr:null,ranking!=null?"Rating "+(+ranking).toFixed(1):null,p.partnerName?"w/ "+p.partnerName:null].filter(Boolean).join(" · ")}
                  </div>
                  <div style={{fontSize:9,fontWeight:700,color:hasDuprLink?D.green:D.textMuted,marginTop:2}}>
                    {hasDuprLink?"🟢 DUPR Linked":"⚪ DUPR Not Linked"}
                  </div>
                </div>
                <span style={{fontSize:9,fontWeight:800,color:withdrawn?D.red:p.status==="checked_in"?D.green:D.textMuted,letterSpacing:"0.5px",textTransform:"uppercase",flexShrink:0}}>{p.status}</span>
              </div>
            );
          })}
        </>
      )}

      {tab==="teams"&&isDoubles&&
        <TeamsPanel division={division} registrations={registrations} directory={directory} onPairTeams={onPairTeams} notify={notify}/>}

      {tab==="teamGroups"&&division.format==="team_elimination"&&
        <TeamGroupsPanel registrations={registrations} teamGroups={teamGroups}
          onCreateTeamGroup={onCreateTeamGroup} onRenameTeamGroup={onRenameTeamGroup}
          onDeleteTeamGroup={onDeleteTeamGroup} onAssignRegistrationToTeamGroup={onAssignRegistrationToTeamGroup}
          onSetTeamBracketGroup={onSetTeamBracketGroup}/>}

      {tab==="schedule"&&(division.format==="round_robin"&&division.top4Playoffs
        ? (<>
            <RoundRobinScheduleView division={division} registrations={registrations}
              matches={matches.filter(m=>!m.bracketSide)} courts={courts}
              onGenerate={onGenerate} onAssignCourt={onAssignCourt} onAutoAssignCourts={onAutoAssignCourts}
              onStartMatch={handleStartMatch}
              canEdit={canEdit} onOpenUmpirePicker={setUmpirePickerMatch} eliminationRound/>
            {matches.some(m=>m.bracketSide)&&(
              <div style={{marginTop:24}}>
                <div style={{fontSize:12,fontWeight:900,color:D.textSecondary,letterSpacing:"1px",marginBottom:10}}>PLAYOFFS</div>
                <BracketView division={division} registrations={registrations}
                  matches={matches.filter(m=>m.bracketSide)}
                  onGenerate={onGenerate} onStartMatch={handleStartMatch}
                  canEdit={canEdit} onOpenUmpirePicker={setUmpirePickerMatch}
                  bronzeLabel="Battle for Bronze"/>
              </div>
            )}
          </>)
        : division.format==="round_robin"
        ? <RoundRobinScheduleView division={division} registrations={registrations} matches={matches} courts={courts}
            onGenerate={onGenerate} onAssignCourt={onAssignCourt} onAutoAssignCourts={onAutoAssignCourts}
            onStartMatch={handleStartMatch}
            canEdit={canEdit} onOpenUmpirePicker={setUmpirePickerMatch}/>
        : isPoolFormat&&!hasKnockoutMatches
        ? <PoolScheduleView division={division} registrations={registrations} matches={matches} pools={pools} courts={courts}
            onGeneratePools={onGeneratePools} onAssignCourt={onAssignCourt} onGenerateKnockout={onGenerateKnockout}
            onStartMatch={handleStartMatch}
            canEdit={canEdit} onOpenUmpirePicker={setUmpirePickerMatch}/>
        : <BracketView division={division} registrations={registrations} matches={matches}
            teamGroups={teamGroups} teamMatchups={teamMatchups}
            onGenerate={onGenerate} onGenerateTeamMatchups={onGenerateTeamMatchups}
            onGenerateOrRegenerateQualifierBracket={onGenerateOrRegenerateQualifierBracket}
            onStartMatch={handleStartMatch}
            canEdit={canEdit} onOpenUmpirePicker={setUmpirePickerMatch}/>)}

      {tab==="standings"&&division.format==="team_elimination"&&(()=>{
        const grouped=groupRegistrationsByTeam(registrations.filter(r=>r.status!=="withdrawn"),teamGroups);
        const standings=grouped.ok?buildTeamStandingsFromRoundRobin(grouped.teams,teamMatchups):[];
        const ranked=grouped.ok?rankIndividualPairsForSemifinals(grouped.teams,teamMatchups,matches):[];
        // Same qualification-mode logic App.jsx/BracketView.jsx use to actually build the
        // bracket — kept here only to decide which rows get the "QUALIFIED" highlight.
        const mode=division.eliminationParticipantMode==="manual"?"manual":division.eliminationParticipantMode==="top_x_per_team"?"top_x_per_team":"top_x";
        let qualifiedIds;
        if(mode==="manual") qualifiedIds=new Set(division.manualQualifierIds||[]);
        else {
          const perTeamCount=grouped.ok?(grouped.teams[0]?.pairs.length||1):1;
          const count=mode==="top_x_per_team"?Math.max(1,Math.min(division.eliminationParticipantCount||1,perTeamCount)):4;
          qualifiedIds=new Set(selectQualifiers(ranked,mode,count).map(p=>p.registrationId));
        }
        return (
          <>
            <TeamStandingsPanel standings={standings} teamGroups={teamGroups}/>
            <div style={{fontSize:12,fontWeight:900,color:D.textSecondary,letterSpacing:"1px",margin:"24px 0 8px"}}>INDIVIDUAL QUALIFICATION STANDINGS</div>
            <IndividualQualificationStandingsPanel rankedPairs={ranked} registrations={registrations} teamGroups={teamGroups} qualifiedIds={qualifiedIds}/>
          </>
        );
      })()}
      {tab==="standings"&&division.format!=="team_elimination"&&<StandingsPanel registrations={registrations}
        matches={(division.format==="round_robin"&&division.top4Playoffs)?matches.filter(m=>!m.bracketSide):matches}/>}

      {showRegister&&<RegistrationModal division={division} directory={directory} organizerId={division.organizerId}
        tournamentId={division.tournamentId} existingRegistrations={registrations} onRegister={onRegister} onClose={()=>setShowRegister(false)}/>}

      {umpirePickerMatch&&<UmpirePickerModal match={umpirePickerMatch} accountsDirectory={accountsDirectory}
        onAssign={(umpireId,umpireName)=>assignUmpire(umpirePickerMatch,umpireId,umpireName)}
        onClose={()=>setUmpirePickerMatch(null)}/>}
    </Panel>
  );
}
