import { useState } from "react";
import { generateBracket } from "../../lib/tournamentBracket.js";
import { generateDoubleEliminationBracket } from "../../lib/tournamentDoubleElimination.js";
import { groupRegistrationsByTeam } from "../../lib/tournamentTeamVsTeam.js";
import { generateTeamRoundRobinMatchups, buildTeamStandingsFromRoundRobin, rankIndividualPairsForSemifinals } from "../../lib/tournamentTeamRoundRobin.js";
import { selectQualifiers, generateQualifierBracketShell, hasKnockoutStageStarted } from "../../lib/tournamentTeamPlayoffs.js";
import { TeamStandingsPanel } from "./TeamStandingsPanel.jsx";
import { ManualQualifierPickerModal } from "./ManualQualifierPickerModal.jsx";
import { Btn } from "../../components/ui/Btn.jsx";
import { Card } from "../../components/ui/Card.jsx";
import { D } from "../../theme/tokens.js";

const nameFor=(registrations,id)=>{
  if(!id) return "TBD";
  const r=registrations.find(x=>x.id===id);
  return r ? Object.values(r.playerNames||{}).join(" / ")||"Unnamed" : "—";
};

function roundLabel(round,totalRounds){
  const fromEnd=totalRounds-round;
  if(fromEnd===0) return "Final";
  if(fromEnd===1) return "Semifinal";
  if(fromEnd===2) return "Quarterfinal";
  return "Round "+round;
}

// One match card — shared by the single/double-elimination winners bracket,
// the losers bracket, the grand final, AND every individual pair match inside
// a Team Elimination team-matchup card, so there's exactly one place that
// draws "a match."
function MatchCard({m,registrations,onStartMatch,canEdit,onOpenUmpirePicker}){
  const isBye=m.status==="bye";
  const isCancelled=m.status==="cancelled";
  // "scheduled" (not just "pending") must also be startable — advanceBracket/
  // advanceBronzeMatchSlot set a match to "scheduled" the moment its SECOND slot
  // fills via advancement (see tournamentBracket.js), which is exactly what happens
  // once both semifinals of a 4+-entrant bracket complete and feed the Final/Bronze.
  // Without this, the Final/Bronze would sit fully filled but permanently unstartable.
  const canStart=(m.status==="pending"||m.status==="scheduled")&&m.registrationAId&&m.registrationBId;
  return(
    <Card padding="9px 11px" style={{opacity:isBye||isCancelled?0.55:1}}>
      {[{id:m.registrationAId,winner:m.winner==="A"},{id:m.registrationBId,winner:m.winner==="B"}].map((slot,i)=>(
        <div key={i} style={{padding:"5px 0",fontSize:12,fontWeight:slot.winner?800:600,color:slot.winner?D.green:D.textPrimary,borderTop:i?"1px solid "+D.border:"none",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
          {nameFor(registrations,slot.id)}
        </div>
      ))}
      {canStart&&<button onClick={()=>onStartMatch(m)}
        style={{marginTop:8,width:"100%",padding:"6px 0",background:D.accent,border:"none",borderRadius:14,color:"#fff",fontWeight:700,fontSize:11,cursor:"pointer"}}>
        Start Match
      </button>}
      {m.status==="in_progress"&&<div style={{marginTop:6,display:"flex",alignItems:"center",gap:5,justifyContent:"center"}}>
        <span style={{width:6,height:6,borderRadius:3,background:D.red,animation:"pulse 1s infinite"}}/>
        <span style={{fontSize:10,fontWeight:700,color:D.red}}>LIVE</span>
      </div>}
      {isBye&&<div style={{fontSize:9,color:D.textMuted,textAlign:"center",marginTop:4,fontWeight:700,letterSpacing:"0.5px"}}>BYE</div>}
      {isCancelled&&<div style={{fontSize:9,color:D.textMuted,textAlign:"center",marginTop:4,fontWeight:700,letterSpacing:"0.5px"}}>NOT NEEDED</div>}
      {canEdit&&onOpenUmpirePicker&&!isBye&&!isCancelled&&m.status!=="completed"&&(
        <button onClick={()=>onOpenUmpirePicker(m)}
          style={{marginTop:6,width:"100%",padding:"4px 0",background:m.umpireName?D.accentBg:D.cardEl,border:"1px solid "+(m.umpireName?D.accent:D.border),borderRadius:12,color:m.umpireName?D.accent:D.textSecondary,fontWeight:700,fontSize:9,cursor:"pointer"}}>
          {m.umpireName?"🎽 "+m.umpireName:"+ Assign Umpire"}
        </button>
      )}
    </Card>
  );
}

// Bracket-tree connector between a pair of matches in one round and the match
// they feed in the next round. A real sibling element (not a ::before/::after
// pseudo-element) to keep the app's "no CSS files, inline D.*-styled JSX"
// convention intact instead of introducing bracket-specific rules into
// base.css for this one screen. Positioned at the vertical midpoint of its
// two-card wrapper, bridging the round-to-round gap (28px, matching
// BracketColumns' own `gap`) — an approximation, not a card-height-measured
// line, but correct often enough (match cards are near-uniform height) to
// close the "no visual bracket tree" gap the redesign audit flagged as the
// single biggest miss in this screen.
function BracketConnector(){
  return(
    <div aria-hidden style={{position:"absolute",right:-28,top:"25%",bottom:"25%",width:28,
      borderTop:"2px solid "+D.borderHi,borderBottom:"2px solid "+D.borderHi,borderRight:"2px solid "+D.borderHi,
      borderTopRightRadius:8,borderBottomRightRadius:8,pointerEvents:"none"}}/>
  );
}

// One bracket's worth of round columns (a "side" of a double-elim bracket, or
// the whole thing for single elimination). `labelFor(round)` lets each side
// pick its own round-naming scheme (Final/Semifinal for winners, plain "LB
// Round N" for losers — no semifinal-style naming attempted there).
function BracketColumns({matches,registrations,onStartMatch,labelFor,canEdit,onOpenUmpirePicker}){
  const byRound=new Map();
  matches.forEach(m=>{ if(!byRound.has(m.round)) byRound.set(m.round,[]); byRound.get(m.round).push(m); });
  const rounds=[...byRound.keys()].sort((a,b)=>a-b);
  return(
    <div style={{display:"flex",gap:28,paddingBottom:8}}>
      {rounds.map((rnd,i)=>{
        const rows=byRound.get(rnd).sort((a,b)=>a.bracketPosition-b.bracketPosition);
        const nextRows=byRound.get(rounds[i+1]);
        // Only draw connectors for the well-defined 2:1 case (single elimination,
        // and most double-elimination rounds) — a losers-bracket "compaction"
        // round that doesn't halve 2:1 renders without a connector instead of
        // drawing a line that would misrepresent who plays whom.
        const connects=!!nextRows&&rows.length>0&&rows.length===nextRows.length*2;
        return(
          <div key={rnd} style={{display:"flex",flexDirection:"column",justifyContent:"space-around",minWidth:190,gap:16}}>
            <div style={{fontSize:11,fontWeight:800,color:D.textMuted,letterSpacing:"0.5px",textAlign:"center"}}>{labelFor(rnd)}</div>
            {connects
              ? Array.from({length:rows.length/2}).map((_,p)=>(
                  <div key={p} style={{position:"relative",display:"flex",flexDirection:"column",gap:16}}>
                    <MatchCard m={rows[p*2]} registrations={registrations} onStartMatch={onStartMatch} canEdit={canEdit} onOpenUmpirePicker={onOpenUmpirePicker}/>
                    <MatchCard m={rows[p*2+1]} registrations={registrations} onStartMatch={onStartMatch} canEdit={canEdit} onOpenUmpirePicker={onOpenUmpirePicker}/>
                    <BracketConnector/>
                  </div>
                ))
              : rows.map(m=>
                  <MatchCard key={m.id} m={m} registrations={registrations} onStartMatch={onStartMatch} canEdit={canEdit} onOpenUmpirePicker={onOpenUmpirePicker}/>
                )}
          </div>
        );
      })}
    </div>
  );
}

// A Team Elimination bracket "card" — TEAM A vs TEAM B, with a running win-count
// header, wrapping the existing MatchCard (unmodified) once per individual pair
// match inside it. The team that wins is highlighted green, same convention
// MatchCard already uses for a winning pair. Pair matches are grouped into
// "ROTATION N" bands of pairsPerMatchup matches each — pairSlot was assigned by
// buildPairMatchesForMatchup as rotation*N + i + 1, so the rotation a match
// belongs to is derivable purely from pairSlot + the team size, no stored column.
function TeamMatchupCard({matchup,pairMatches,teamGroups,registrations,onStartMatch,canEdit,onOpenUmpirePicker}){
  const teamName=id=>{ if(!id) return "TBD"; const t=teamGroups.find(x=>x.id===id); return t?t.name:"—"; };
  const isBye=matchup.status==="bye";
  const sorted=[...pairMatches].sort((a,b)=>(a.pairSlot??0)-(b.pairSlot??0));
  const started=sorted.some(pm=>pm.status!=="pending"&&pm.status!=="scheduled");
  const statusLabel=
    isBye ? "BYE" :
    matchup.status==="completed" ? teamName(matchup.winnerTeamId)+" wins" :
    started ? "In Progress" : "Not Started";

  // Knockout/Semifinal/Bronze/Final: the actual competitors are the two QUALIFIED
  // PAIRS (matchup.pairAId/pairBId), not a full team roster — pairsPerMatchup===1
  // is the structural signal (set only by generateQualifierBracketShell). team_a_id/
  // team_b_id are informational team-of-origin captions only from this stage on
  // (they may legitimately be equal, when both semifinalists share a team), so
  // this renders the one child match via the existing MatchCard (which highlights
  // by registrationId, not teamId) instead of the team win-count header below.
  if(matchup.pairsPerMatchup===1){
    // A knockout-round BYE (non-power-of-2 qualifier count) auto-advances one PAIR with no
    // opponent at all — falling through to the generic team-rotation card below would show
    // a confusing "Team vs TBD, 0-0" header instead of the advancing pair's own name.
    if(isBye){
      const advancingId=matchup.pairAId||matchup.pairBId;
      return(
        <Card padding="10px 12px" style={{minWidth:190,opacity:0.75}}>
          <div style={{fontSize:9,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",textAlign:"center",marginBottom:6,textTransform:"uppercase"}}>{teamName(matchup.teamAId||matchup.teamBId)}</div>
          <div style={{padding:"5px 0",fontSize:12,fontWeight:800,color:D.textPrimary,textAlign:"center"}}>{nameFor(registrations,advancingId)}</div>
          <div style={{fontSize:9,fontWeight:800,color:D.textMuted,textAlign:"center",letterSpacing:"0.5px",textTransform:"uppercase",marginTop:8}}>BYE</div>
        </Card>
      );
    }
    const pairMatch=sorted[0];
    return(
      <div style={{background:D.surface,border:"1px solid "+D.border,borderRadius:14,padding:"10px 12px",minWidth:190}}>
        <div style={{fontSize:9,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",textAlign:"center",marginBottom:6,textTransform:"uppercase"}}>{teamName(matchup.teamAId)} vs {teamName(matchup.teamBId)}</div>
        {pairMatch
          ? <MatchCard m={pairMatch} registrations={registrations} onStartMatch={onStartMatch} canEdit={canEdit} onOpenUmpirePicker={onOpenUmpirePicker}/>
          : <div style={{fontSize:11,color:D.textMuted,textAlign:"center",padding:"14px 0"}}>Waiting for result…</div>}
        <div style={{fontSize:9,fontWeight:800,color:matchup.status==="completed"?D.green:D.textMuted,textAlign:"center",letterSpacing:"0.5px",textTransform:"uppercase",marginTop:8}}>
          {statusLabel}
        </div>
      </div>
    );
  }

  const n=matchup.pairsPerMatchup||0;
  const rotations=new Map();
  if(n>0){
    for(const pm of sorted){
      const rot=Math.floor(((pm.pairSlot??1)-1)/n)+1;
      if(!rotations.has(rot)) rotations.set(rot,[]);
      rotations.get(rot).push(pm);
    }
  }
  return(
    <div style={{background:D.surface,border:"1px solid "+D.border,borderRadius:14,padding:"10px 12px",opacity:isBye?0.55:1,minWidth:190}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:12,fontWeight:800,marginBottom:2}}>
        <span style={{color:matchup.status==="completed"&&matchup.winnerTeamId===matchup.teamAId?D.green:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{teamName(matchup.teamAId)}</span>
        <span style={{color:D.textMuted,flexShrink:0,marginLeft:6}}>{matchup.teamAWins}</span>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:12,fontWeight:800,marginBottom:8,paddingBottom:8,borderBottom:"1px solid "+D.border}}>
        <span style={{color:matchup.status==="completed"&&matchup.winnerTeamId===matchup.teamBId?D.green:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{teamName(matchup.teamBId)}</span>
        <span style={{color:D.textMuted,flexShrink:0,marginLeft:6}}>{matchup.teamBWins}</span>
      </div>
      {!isBye&&(
        <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:8}}>
          {[...rotations.entries()].map(([rot,rows])=>(
            <div key={rot}>
              <div style={{fontSize:9,fontWeight:800,color:D.textMuted,letterSpacing:"0.5px",marginBottom:5,textTransform:"uppercase"}}>Rotation {rot}</div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {rows.map(pm=>
                  <MatchCard key={pm.id} m={pm} registrations={registrations} onStartMatch={onStartMatch} canEdit={canEdit} onOpenUmpirePicker={onOpenUmpirePicker}/>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{fontSize:9,fontWeight:800,color:matchup.status==="completed"?D.green:D.textMuted,textAlign:"center",letterSpacing:"0.5px",textTransform:"uppercase"}}>
        {statusLabel}
      </div>
    </div>
  );
}

// TeamMatchupColumns — parallel to BracketColumns, but groups team MATCHUPS by
// round (not individual pair matches), rendering one TeamMatchupCard per matchup.
// Reads each matchup's own persisted `stageLabel` (Elimination Round/Semifinal/
// Final/Champions Round Robin/etc — see tournamentTeamGroups.js) rather than
// arithmetic distance-from-final; `labelFor(round)` is only a fallback for rows
// generated before this column existed (stageLabel null), never for new ones.
function TeamMatchupColumns({teamMatchups,matches,teamGroups,registrations,onStartMatch,labelFor,canEdit,onOpenUmpirePicker}){
  const byRound=new Map();
  teamMatchups.forEach(m=>{ if(!byRound.has(m.round)) byRound.set(m.round,[]); byRound.get(m.round).push(m); });
  const rounds=[...byRound.keys()].sort((a,b)=>a-b);
  return(
    <div style={{display:"flex",gap:28,paddingBottom:8}}>
      {rounds.map(rnd=>{
        const rowsInRound=byRound.get(rnd).sort((a,b)=>a.bracketPosition-b.bracketPosition);
        const label=rowsInRound[0]?.stageLabel||labelFor(rnd);
        return(
          <div key={rnd} style={{display:"flex",flexDirection:"column",justifyContent:"space-around",gap:16}}>
            <div style={{fontSize:11,fontWeight:800,color:D.textMuted,letterSpacing:"0.5px",textAlign:"center"}}>{label}</div>
            {rowsInRound.map(matchup=>
              <TeamMatchupCard key={matchup.id} matchup={matchup}
                pairMatches={matches.filter(m=>m.teamMatchupId===matchup.id)}
                teamGroups={teamGroups} registrations={registrations}
                onStartMatch={onStartMatch} canEdit={canEdit} onOpenUmpirePicker={onOpenUmpirePicker}/>
            )}
          </div>
        );
      })}
    </div>
  );
}

const TEAM_ELIM_ERROR_MESSAGES={
  unassigned_pairs: n=>`${n} pair${n!==1?"s":""} have no Team assigned. Assign every pair to a Team in the Team Groups tab before generating.`,
  too_few_teams: ()=>"Need at least 2 teams with pairs assigned before generating.",
  uneven_team_sizes: teams=>"Every team must have the same number of pairs.\n\n"+teams.map(t=>`${t.teamName}: ${t.count} pair${t.count!==1?"s":""}`).join("\n"),
  team_too_small: teams=>"Every team needs at least 2 pairs — each pair must face a different opponent pair each rotation.\n\n"+teams.filter(t=>t.count<2).map(t=>`${t.teamName}: ${t.count} pair${t.count!==1?"s":""}`).join("\n"),
};

export function BracketView({division,registrations,matches,teamGroups=[],teamMatchups=[],onGenerate,onGenerateTeamMatchups,onGenerateOrRegenerateQualifierBracket,onStartMatch,canEdit,onOpenUmpirePicker,bronzeLabel="🥉 3RD PLACE"}){
  const [zoom,setZoom]=useState(1);
  // Only ever set for team_elimination — every other format always succeeds today.
  const [generateError,setGenerateError]=useState(null);
  const [showManualPicker,setShowManualPicker]=useState(false);
  // Set only right after an organizer-triggered Regenerate/Manual generation whose same-team
  // policy couldn't be fully satisfied — the automatic round-robin-completion trigger
  // (App.jsx) has no UI surface to show this to, so it's reported here instead, the one
  // place an organizer is actively looking at the bracket they just built.
  const [conflictNotice,setConflictNotice]=useState(null);
  // A pool_to_knockout division's knockout phase (generated by
  // tournamentPoolPlay.js's generateKnockoutFromPools) produces matches shaped exactly
  // like a plain double-elimination bracket (bracketSide/loserNextMatchId etc.) whenever
  // its chosen knockout format is double elimination — this must render as such even
  // though division.format itself is "pool_to_knockout", not "double_elimination".
  const isDoubleElim=division.format==="double_elimination"
    ||(division.format==="pool_to_knockout"&&division.poolKnockoutFormat==="double_elimination");
  const isTeamElim=division.format==="team_elimination";

  const hasBracket=isTeamElim?teamMatchups.length>0:matches.length>0;

  if(!hasBracket){
    // Withdrawn entrants must never be seeded into a freshly-generated bracket.
    const activeRegistrations=registrations.filter(r=>r.status!=="withdrawn");
    const grouped=isTeamElim?groupRegistrationsByTeam(activeRegistrations,teamGroups):null;
    const canGenerate=isTeamElim?!!grouped?.ok:activeRegistrations.length>=2;
    return(
      <div style={{textAlign:"center",padding:"36px 20px"}}>
        <div style={{fontSize:32,marginBottom:10}}>🏆</div>
        <div style={{fontWeight:700,color:D.textPrimary,marginBottom:6}}>No bracket yet</div>
        <div style={{fontSize:12,color:D.textMuted,marginBottom:16}}>
          {isTeamElim
            ? `${activeRegistrations.length} pairs registered across ${teamGroups.length} team${teamGroups.length!==1?"s":""} — every Team plays every other Team in a round robin, Top 4 advance to Semifinals, Battle for Bronze, and the Final.`
            : `${activeRegistrations.length} registered — seeds the bracket and assigns byes automatically.`}
        </div>
        {generateError&&<div style={{fontSize:12,color:D.red,background:D.redBg,border:"1px solid "+D.red,borderRadius:12,padding:"12px 14px",marginBottom:16,whiteSpace:"pre-line",textAlign:"left"}}>{generateError}</div>}
        <Btn label="Generate Bracket" color={D.accent} radius={22} disabled={!canGenerate} onClick={()=>{
            if(isTeamElim){
              const g=groupRegistrationsByTeam(activeRegistrations,teamGroups);
              if(!g.ok){
                const msg=g.error==="unassigned_pairs"?TEAM_ELIM_ERROR_MESSAGES.unassigned_pairs(g.unassignedCount)
                  :g.error==="too_few_teams"?TEAM_ELIM_ERROR_MESSAGES.too_few_teams()
                  :g.error==="team_too_small"?TEAM_ELIM_ERROR_MESSAGES.team_too_small(g.teams)
                  :TEAM_ELIM_ERROR_MESSAGES.uneven_team_sizes(g.teams);
                setGenerateError(msg);
                return;
              }
              setGenerateError(null);
              const makeId=()=>"ttm_"+Math.random().toString(36).slice(2,10);
              const {teamMatchups:matchupRows,pairMatches}=generateTeamRoundRobinMatchups(g.teams,{makeId});
              const stampedMatchups=matchupRows.map(m=>({...m,tournamentId:division.tournamentId,divisionId:division.id,organizerId:division.organizerId}));
              const stampedPairs=pairMatches.map(m=>({...m,tournamentId:division.tournamentId,divisionId:division.id,organizerId:division.organizerId}));
              onGenerateTeamMatchups(stampedMatchups,stampedPairs);
              return;
            }
            const seeded=[...activeRegistrations].sort((a,b)=>(a.seed??999)-(b.seed??999));
            const generate=isDoubleElim?generateDoubleEliminationBracket:generateBracket;
            const genOpts=isDoubleElim
              ? {makeId:()=>"tm_"+Math.random().toString(36).slice(2,10)}
              : {makeId:()=>"tm_"+Math.random().toString(36).slice(2,10), bronzeMatch:!!division.hasBronzeMatch};
            const rows=generate(seeded, genOpts).map(m=>({
              ...m, tournamentId:division.tournamentId, divisionId:division.id, organizerId:division.organizerId,
            }));
            onGenerate(rows);
          }}/>
      </div>
    );
  }

  if(isTeamElim){
    // Legacy brackets generated under the old knockout model never set `stage` —
    // that shape (nextMatchupId/loserNextMatchupId slot-advancement, Pair-i-vs-
    // Pair-i matches) is incompatible with this layout. Rather than mis-render
    // them, point the organizer at regenerating.
    const isLegacy=teamMatchups.length>0&&teamMatchups.every(m=>!m.stage);
    if(isLegacy){
      return(
        <div style={{textAlign:"center",padding:"36px 20px"}}>
          <div style={{fontSize:32,marginBottom:10}}>⚠️</div>
          <div style={{fontWeight:700,color:D.textPrimary,marginBottom:6}}>Bracket needs to be regenerated</div>
          <div style={{fontSize:12,color:D.textMuted,maxWidth:340,margin:"0 auto"}}>
            This bracket was generated with a previous version of Team Elimination. Delete it and generate a new one to use the current round-robin format.
          </div>
        </div>
      );
    }
    const roundRobinRows=teamMatchups.filter(m=>m.stage==="round_robin");
    // "knockout" covers every pre-semifinal round (Quarterfinal, Round of 16, ...); the
    // literal "semifinal" stage is always the single round that feeds Bronze — together
    // they're every knockout-round matchup, grouped by round below instead of one hardcoded
    // "SEMIFINALS" section, so an arbitrary qualifier count renders correctly.
    const knockoutRows=teamMatchups.filter(m=>m.stage==="knockout"||m.stage==="semifinal");
    const knockoutRoundsPresent=[...new Set(knockoutRows.map(m=>m.round))].sort((a,b)=>a-b);
    const finalRow=teamMatchups.find(m=>m.stage==="final");
    const bronzeRow=teamMatchups.find(m=>m.stage==="bronze");
    const teamsGrouped=groupRegistrationsByTeam(registrations.filter(r=>r.status!=="withdrawn"),teamGroups);
    const standings=teamsGrouped.ok?buildTeamStandingsFromRoundRobin(teamsGrouped.teams,teamMatchups):[];
    const ranked=teamsGrouped.ok?rankIndividualPairsForSemifinals(teamsGrouped.teams,teamMatchups,matches):[];
    const roundRobinComplete=roundRobinRows.length>0&&roundRobinRows.every(m=>m.status==="completed");
    const hasKnockoutShell=knockoutRows.length>0||!!finalRow||!!bronzeRow;
    const knockoutStarted=hasKnockoutStageStarted(teamMatchups,matches);
    const mode=division.eliminationParticipantMode==="manual"?"manual":division.eliminationParticipantMode==="top_x_per_team"?"top_x_per_team":"top_x";

    const stampRows=(shellMatchups,shellPairs)=>({
      shellMatchups:shellMatchups.map(m=>({...m,tournamentId:division.tournamentId,divisionId:division.id,organizerId:division.organizerId})),
      shellPairs:shellPairs.map(m=>({...m,tournamentId:division.tournamentId,divisionId:division.id,organizerId:division.organizerId})),
    });
    const nextStartRound=()=>Math.max(0,...roundRobinRows.map(m=>m.round))+1;

    const onRegenerate=()=>{
      if(mode==="manual"){ setShowManualPicker(true); return; }
      const perTeamCount=teamsGrouped.ok?(teamsGrouped.teams[0]?.pairs.length||1):1;
      const count=mode==="top_x_per_team"?Math.max(1,Math.min(division.eliminationParticipantCount||1,perTeamCount)):4;
      const qualifiers=selectQualifiers(ranked,mode,count);
      if(qualifiers.length<2) return;
      const {teamMatchups:shellMatchups,pairMatches:shellPairs,conflicts}=generateQualifierBracketShell(qualifiers,{
        makeId:()=>"ttm_"+Math.random().toString(36).slice(2,10), startRound:nextStartRound(),
        sameTeamPolicy:division.sameTeamMatchupPolicy||"allow_anywhere",
      });
      setConflictNotice(conflicts.length>0?"Same-Team separation is not possible with the selected participants. The bracket uses the best valid arrangement.":null);
      const stamped=stampRows(shellMatchups,shellPairs);
      onGenerateOrRegenerateQualifierBracket(stamped.shellMatchups,stamped.shellPairs,null);
    };

    const onManualGenerate=(selectedIds)=>{
      const selectedSet=new Set(selectedIds);
      const qualifiers=ranked.filter(p=>selectedSet.has(p.registrationId));
      const {teamMatchups:shellMatchups,pairMatches:shellPairs,conflicts}=generateQualifierBracketShell(qualifiers,{
        makeId:()=>"ttm_"+Math.random().toString(36).slice(2,10), startRound:nextStartRound(),
        sameTeamPolicy:division.sameTeamMatchupPolicy||"allow_anywhere",
      });
      setConflictNotice(conflicts.length>0?"Same-Team separation is not possible with the selected participants. The bracket uses the best valid arrangement.":null);
      const stamped=stampRows(shellMatchups,shellPairs);
      onGenerateOrRegenerateQualifierBracket(stamped.shellMatchups,stamped.shellPairs,selectedIds);
      setShowManualPicker(false);
    };
    return(
      <div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:6,marginBottom:10,flexWrap:"wrap"}}>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {canEdit&&roundRobinComplete&&mode==="manual"&&!hasKnockoutShell&&(
              <button onClick={()=>setShowManualPicker(true)}
                style={{padding:"7px 14px",background:D.accentBg,border:"1px solid "+D.accent,borderRadius:16,color:D.accent,fontWeight:700,fontSize:11,cursor:"pointer"}}>
                Select Qualifying Pairs
              </button>
            )}
            {canEdit&&roundRobinComplete&&hasKnockoutShell&&!knockoutStarted&&(
              <button onClick={onRegenerate}
                style={{padding:"7px 14px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:16,color:D.textSecondary,fontWeight:700,fontSize:11,cursor:"pointer"}}>
                Regenerate Bracket
              </button>
            )}
          </div>
          <div style={{display:"flex",gap:6}}>
            <button onClick={()=>setZoom(z=>Math.max(0.6,z-0.15))} aria-label="Zoom out" style={{width:28,height:28,borderRadius:14,background:D.cardEl,border:"1px solid "+D.border,color:D.textPrimary,cursor:"pointer"}}>−</button>
            <button onClick={()=>setZoom(z=>Math.min(1.6,z+0.15))} aria-label="Zoom in" style={{width:28,height:28,borderRadius:14,background:D.cardEl,border:"1px solid "+D.border,color:D.textPrimary,cursor:"pointer"}}>+</button>
          </div>
        </div>
        {canEdit&&roundRobinComplete&&hasKnockoutShell&&knockoutStarted&&(
          <div style={{fontSize:11,color:D.textMuted,marginBottom:10}}>Bracket can't be regenerated once a Quarterfinal/Semifinal/Final match has started.</div>
        )}
        {conflictNotice&&(
          <div style={{fontSize:12,color:D.textSecondary,background:D.cardEl,border:"1px solid "+D.border,borderRadius:12,padding:"10px 14px",marginBottom:14}}>{conflictNotice}</div>
        )}
        <div style={{overflowX:"auto",transform:"scale("+zoom+")",transformOrigin:"top left"}}>
          <div style={{marginBottom:20}}>
            <div style={{fontSize:12,fontWeight:900,color:D.textSecondary,letterSpacing:"1px",marginBottom:8}}>TEAM ROUND ROBIN</div>
            <TeamMatchupColumns teamMatchups={roundRobinRows} matches={matches} teamGroups={teamGroups} registrations={registrations}
              onStartMatch={onStartMatch} canEdit={canEdit} onOpenUmpirePicker={onOpenUmpirePicker}
              labelFor={rnd=>"Round "+rnd}/>
          </div>
          {standings.length>0&&(
            <div style={{marginBottom:20}}>
              <div style={{fontSize:12,fontWeight:900,color:D.textSecondary,letterSpacing:"1px",marginBottom:8}}>STANDINGS</div>
              <TeamStandingsPanel standings={standings} teamGroups={teamGroups}/>
            </div>
          )}
          {knockoutRoundsPresent.length>0?knockoutRoundsPresent.map(rnd=>{
            const rowsInRound=knockoutRows.filter(m=>m.round===rnd).sort((a,b)=>a.bracketPosition-b.bracketPosition);
            const label=rowsInRound[0]?.stageLabel||("Round "+rnd);
            return(
              <div key={rnd} style={{marginBottom:20}}>
                <div style={{fontSize:12,fontWeight:900,color:D.textSecondary,letterSpacing:"1px",marginBottom:8}}>{label.toUpperCase()}</div>
                <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
                  {rowsInRound.map(m=>(
                    <div key={m.id} style={{minWidth:190}}>
                      <TeamMatchupCard matchup={m} pairMatches={matches.filter(pm=>pm.teamMatchupId===m.id)}
                        teamGroups={teamGroups} registrations={registrations}
                        onStartMatch={onStartMatch} canEdit={canEdit} onOpenUmpirePicker={onOpenUmpirePicker}/>
                    </div>
                  ))}
                </div>
              </div>
            );
          }):(
            <div style={{marginBottom:20}}>
              <div style={{fontSize:12,fontWeight:900,color:D.textSecondary,letterSpacing:"1px",marginBottom:8}}>ELIMINATION BRACKET</div>
              <div style={{fontSize:12,color:D.textMuted}}>
                {!roundRobinComplete
                  ? "The elimination bracket will be generated once every Team Round Robin matchup above is complete."
                  : mode==="manual"
                  ? "Select which pairs qualify to generate the elimination bracket."
                  : ranked.length<2
                  ? "Not enough qualified pairs yet — the elimination bracket needs at least 2."
                  : "The elimination bracket will be generated shortly."}
              </div>
            </div>
          )}
          {finalRow&&(
            <div style={{marginBottom:20}}>
              <div style={{fontSize:12,fontWeight:900,color:D.textSecondary,letterSpacing:"1px",marginBottom:8}}>FINAL</div>
              <div style={{minWidth:190}}>
                <TeamMatchupCard matchup={finalRow} pairMatches={matches.filter(m=>m.teamMatchupId===finalRow.id)}
                  teamGroups={teamGroups} registrations={registrations}
                  onStartMatch={onStartMatch} canEdit={canEdit} onOpenUmpirePicker={onOpenUmpirePicker}/>
              </div>
            </div>
          )}
          {bronzeRow&&(<>
            <div style={{fontSize:12,fontWeight:900,color:D.textSecondary,letterSpacing:"1px",margin:"20px 0 8px"}}>{bronzeLabel}</div>
            <div style={{minWidth:190}}>
              <TeamMatchupCard matchup={bronzeRow} pairMatches={matches.filter(m=>m.teamMatchupId===bronzeRow.id)}
                teamGroups={teamGroups} registrations={registrations}
                onStartMatch={onStartMatch} canEdit={canEdit} onOpenUmpirePicker={onOpenUmpirePicker}/>
            </div>
          </>)}
        </div>
        {showManualPicker&&(
          <ManualQualifierPickerModal rankedPairs={ranked} registrations={registrations} teamGroups={teamGroups}
            initialSelectedIds={division.manualQualifierIds||[]}
            onGenerate={onManualGenerate} onClose={()=>setShowManualPicker(false)}/>
        )}
      </div>
    );
  }

  if(isDoubleElim){
    const winners=matches.filter(m=>m.bracketSide==="winners");
    const losers=matches.filter(m=>m.bracketSide==="losers");
    const final=matches.find(m=>m.bracketSide==="final");
    const winnersTotalRounds=Math.max(0,...winners.map(m=>m.round));
    return(
      <div>
        <div style={{display:"flex",justifyContent:"flex-end",gap:6,marginBottom:10}}>
          <button onClick={()=>setZoom(z=>Math.max(0.6,z-0.15))} aria-label="Zoom out" style={{width:28,height:28,borderRadius:14,background:D.cardEl,border:"1px solid "+D.border,color:D.textPrimary,cursor:"pointer"}}>−</button>
          <button onClick={()=>setZoom(z=>Math.min(1.6,z+0.15))} aria-label="Zoom in" style={{width:28,height:28,borderRadius:14,background:D.cardEl,border:"1px solid "+D.border,color:D.textPrimary,cursor:"pointer"}}>+</button>
        </div>
        <div style={{overflowX:"auto",transform:"scale("+zoom+")",transformOrigin:"top left"}}>
          <div style={{fontSize:12,fontWeight:900,color:D.textSecondary,letterSpacing:"1px",marginBottom:8}}>WINNERS BRACKET</div>
          <BracketColumns matches={winners} registrations={registrations} onStartMatch={onStartMatch}
            canEdit={canEdit} onOpenUmpirePicker={onOpenUmpirePicker}
            labelFor={rnd=>roundLabel(rnd,winnersTotalRounds)}/>
          {losers.length>0&&(<>
            <div style={{fontSize:12,fontWeight:900,color:D.textSecondary,letterSpacing:"1px",margin:"20px 0 8px"}}>LOSERS BRACKET</div>
            <BracketColumns matches={losers} registrations={registrations} onStartMatch={onStartMatch}
              canEdit={canEdit} onOpenUmpirePicker={onOpenUmpirePicker}
              labelFor={rnd=>"LB Round "+rnd}/>
          </>)}
          {final&&(<>
            <div style={{fontSize:12,fontWeight:900,color:D.textSecondary,letterSpacing:"1px",margin:"20px 0 8px"}}>GRAND FINAL</div>
            <div style={{minWidth:190}}><MatchCard m={final} registrations={registrations} onStartMatch={onStartMatch} canEdit={canEdit} onOpenUmpirePicker={onOpenUmpirePicker}/></div>
          </>)}
        </div>
      </div>
    );
  }

  const bronze=matches.find(m=>m.bracketSide==="bronze");
  const mainMatches=bronze?matches.filter(m=>m.bracketSide!=="bronze"):matches;
  const totalRounds=Math.max(0,...mainMatches.map(m=>m.round));
  return(
    <div>
      <div style={{display:"flex",justifyContent:"flex-end",gap:6,marginBottom:10}}>
        <button onClick={()=>setZoom(z=>Math.max(0.6,z-0.15))} aria-label="Zoom out" style={{width:28,height:28,borderRadius:14,background:D.cardEl,border:"1px solid "+D.border,color:D.textPrimary,cursor:"pointer"}}>−</button>
        <button onClick={()=>setZoom(z=>Math.min(1.6,z+0.15))} aria-label="Zoom in" style={{width:28,height:28,borderRadius:14,background:D.cardEl,border:"1px solid "+D.border,color:D.textPrimary,cursor:"pointer"}}>+</button>
      </div>
      <div style={{overflowX:"auto",transform:"scale("+zoom+")",transformOrigin:"top left"}}>
        <BracketColumns matches={mainMatches} registrations={registrations} onStartMatch={onStartMatch}
          canEdit={canEdit} onOpenUmpirePicker={onOpenUmpirePicker}
          labelFor={rnd=>roundLabel(rnd,totalRounds)}/>
        {bronze&&(<>
          <div style={{fontSize:12,fontWeight:900,color:D.textSecondary,letterSpacing:"1px",margin:"20px 0 8px"}}>{bronzeLabel}</div>
          <div style={{minWidth:190}}><MatchCard m={bronze} registrations={registrations} onStartMatch={onStartMatch} canEdit={canEdit} onOpenUmpirePicker={onOpenUmpirePicker}/></div>
        </>)}
      </div>
    </div>
  );
}
