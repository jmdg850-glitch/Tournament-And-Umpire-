import { useState, useEffect } from "react";
import { Dupr } from "../../lib/dupr.js";
import { Cloud } from "../../lib/cloud.js";
import { Outbox } from "../../lib/outbox.js";
import { ReportIssueModal } from "../../modals/ReportIssueModal.jsx";
import { Card } from "../../components/ui/Card.jsx";
import { D } from "../../theme/tokens.js";

// Four states: a tournament match's own division decides eligibility
// server-side (submit-match/index.ts) — NOT_RATED means dupr_rated=false, so
// it was never actually sent to DUPR. "skipped" (missing a DUPR id) folds
// into FAILED — it's just as actionable/retryable, with its reason still
// shown via lastError below.
const STATUS_LABEL={not_rated:"Not Rated",pending:"Pending",submitting:"Pending",failed:"Failed",skipped:"Failed",submitted:"Synced"};
const STATUS_COLOR={not_rated:D.textMuted,pending:D.accent,submitting:D.accent,failed:D.red,skipped:D.red,submitted:D.green};

// Tournament-scoped DUPR sync status, sourced entirely from existing DUPR infra
// (Dupr.fetchSubmissionStatuses reads dupr_match_submissions, already used by casual
// History's own badges) — this is "surface + manual retry," not a new submission
// pipeline. submitDuprMatch is the same outbox kind endMatch's auto-submit already uses.
export function SyncCenterPanel({matches,registrations,currentUser,notify}){
  const [statuses,setStatuses]=useState({});
  const [duprLinked,setDuprLinked]=useState({});
  const [loading,setLoading]=useState(true);
  const [syncingRating,setSyncingRating]=useState(null);
  const [reportingMatchId,setReportingMatchId]=useState(null);

  const completed=matches.filter(m=>m.status==="completed"&&m.completedMatchId);

  useEffect(()=>{
    let alive=true;
    const ids=completed.map(m=>m.completedMatchId);
    Promise.all([
      ids.length?Dupr.fetchSubmissionStatuses(ids):Promise.resolve({}),
      (()=>{
        const accountIds=[...new Set(registrations.filter(r=>r.status!=="withdrawn").flatMap(r=>r.linkedAccountIds||[]))];
        return accountIds.length?Cloud.fetchAccountsDuprLinkStatus(accountIds):Promise.resolve({});
      })(),
    ]).then(([subs,linked])=>{
      if(!alive) return;
      setStatuses(subs); setDuprLinked(linked); setLoading(false);
    });
    return ()=>{ alive=false; };
  },[matches,registrations]); // eslint-disable-line react-hooks/exhaustive-deps

  const bucketOf=matchId=>{
    const s=statuses[matchId];
    // No row yet = not attempted/in flight (Outbox hasn't drained, or racing
    // with endMatch's own enqueue) — same PENDING bucket as an explicit
    // pending/submitting row, per the 4-state model.
    if(!s) return "pending";
    return s.status||"pending";
  };
  const buckets={not_rated:0,pending:0,failed:0,submitted:0};
  completed.forEach(m=>{
    const b=bucketOf(m.completedMatchId);
    const key=b==="submitting"?"pending":b==="skipped"?"failed":b;
    buckets[key]=(buckets[key]||0)+1;
  });

  const retry=matchId=>{
    Outbox.enqueue("submitDuprMatch",{matchId});
    Outbox.drain();
    notify?.("Submission queued");
  };

  const syncRating=async matchId=>{
    setSyncingRating(matchId);
    const res=await Dupr.syncRating(matchId);
    setSyncingRating(null);
    if(!res?.ok){ notify?.(res?.error||"Couldn't sync rating","err"); return; }
    const hasDelta=(res.teams||[]).some(t=>t.delta!=null);
    notify?.(hasDelta?"Rating synced":"DUPR hasn't calculated the rating impact yet");
  };

  // Every registered player with a linked account but no DUPR link — flattened same as
  // the Players tab, deduped by playerId (a player could appear in multiple registrations
  // across divisions, e.g. singles + doubles).
  const missingDupr=[];
  const seenPlayers=new Set();
  registrations.filter(r=>r.status!=="withdrawn").forEach(r=>{
    (r.playerIds||[]).forEach(pid=>{
      if(seenPlayers.has(pid)) return;
      seenPlayers.add(pid);
      const isLinkedAccount=(r.linkedAccountIds||[]).includes(pid);
      const hasDupr=isLinkedAccount?duprLinked[pid]:false;
      if(!hasDupr) missingDupr.push({playerId:pid,name:r.playerNames?.[pid]||"Player",hasAccount:isLinkedAccount});
    });
  });

  if(loading) return <div style={{textAlign:"center",padding:"30px 20px",color:D.textMuted,fontSize:13}}>Loading sync status…</div>;

  return(
    <div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8,marginBottom:16}}>
        {["not_rated","pending","failed","submitted"].map(b=>(
          <Card key={b} padding="12px 6px" style={{textAlign:"center"}}>
            <div style={{fontSize:18,fontWeight:900,color:STATUS_COLOR[b]}}>{buckets[b]||0}</div>
            <div style={{fontSize:9,color:D.textMuted,fontWeight:700,letterSpacing:"0.5px",marginTop:2}}>{STATUS_LABEL[b].toUpperCase()}</div>
          </Card>
        ))}
      </div>

      <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>MATCHES</div>
      {completed.length===0&&<div style={{textAlign:"center",padding:"16px",color:D.textMuted,fontSize:12,marginBottom:16}}>No completed matches yet.</div>}
      {completed.map(m=>{
        const s=statuses[m.completedMatchId];
        const bucket=bucketOf(m.completedMatchId);
        const displayBucket=bucket==="submitting"?"pending":bucket==="skipped"?"failed":bucket;
        return(
          <Card key={m.id} padding="11px 13px" style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:12,fontWeight:700,color:D.textPrimary}}>Round {m.round}{s?.lastError?" · "+s.lastError:""}</div>
              <div style={{fontSize:10,fontWeight:800,color:STATUS_COLOR[displayBucket],textTransform:"uppercase",letterSpacing:"0.5px"}}>{STATUS_LABEL[displayBucket]}</div>
            </div>
            {(displayBucket==="failed"||displayBucket==="not_rated")&&(
              <button onClick={()=>retry(m.completedMatchId)}
                style={{padding:"6px 12px",background:D.accentBg,border:"1px solid "+D.accent,borderRadius:14,color:D.accent,fontWeight:700,fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>
                Retry
              </button>
            )}
            {displayBucket==="submitted"&&(
              <button onClick={()=>syncRating(m.completedMatchId)} disabled={syncingRating===m.completedMatchId}
                style={{padding:"6px 12px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:14,color:D.textSecondary,fontWeight:700,fontSize:11,cursor:syncingRating===m.completedMatchId?"default":"pointer",whiteSpace:"nowrap"}}>
                {syncingRating===m.completedMatchId?"Syncing…":"Sync Rating"}
              </button>
            )}
            {s&&(
              <button onClick={()=>setReportingMatchId(m.completedMatchId)}
                title="Report an issue"
                style={{padding:"6px 8px",background:"transparent",border:"1px solid "+D.border,borderRadius:14,color:D.textMuted,fontWeight:700,fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>
                ⚠
              </button>
            )}
          </Card>
        );
      })}

      {reportingMatchId&&(
        <ReportIssueModal matchId={reportingMatchId} duprMatchCode={statuses[reportingMatchId]?.matchCode}
          currentUser={currentUser} notify={notify} onClose={()=>setReportingMatchId(null)}/>
      )}

      <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8,marginTop:8}}>PLAYERS MISSING DUPR ID</div>
      {missingDupr.length===0&&<div style={{textAlign:"center",padding:"16px",color:D.textMuted,fontSize:12}}>Everyone registered has DUPR linked.</div>}
      {missingDupr.map(p=>(
        <div key={p.playerId} style={{display:"flex",justifyContent:"space-between",padding:"6px 4px",fontSize:12,color:D.textSecondary}}>
          <span>{p.name}</span><span style={{color:D.textMuted}}>{p.hasAccount?"Not linked":"No account"}</span>
        </div>
      ))}
    </div>
  );
}
