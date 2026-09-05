import { useState } from "react";
import { Modal } from "../components/ui/Modal.jsx";
import { FilterChipGroup } from "../components/ui/FilterChip.jsx";
import { Cloud } from "../lib/cloud.js";
import { D } from "../theme/tokens.js";

const ISSUE_TYPES=[
  {value:"incorrect_score",label:"Incorrect Score"},
  {value:"wrong_player",label:"Wrong Player"},
  {value:"incorrect_result",label:"Incorrect Result"},
  {value:"dupr_submission_issue",label:"DUPR Submission Issue"},
  {value:"other",label:"Other"},
];

// Report a problem with a specific match (score/player/result/DUPR submission)
// for staff to review manually — purely informational (support_requests table,
// migration 133); never touches the match or its DUPR submission itself.
export function ReportIssueModal({matchId,duprMatchCode,currentUser,onClose,notify}){
  const [issueType,setIssueType]=useState("incorrect_score");
  const [description,setDescription]=useState("");
  const [busy,setBusy]=useState(false);

  const submit=async()=>{
    if(!currentUser?.id) return;
    setBusy(true);
    const res=await Cloud.reportMatchIssue({reporterId:currentUser.id,matchId,duprMatchCode,issueType,description});
    setBusy(false);
    if(res?.ok){ notify?.("Issue reported — our team will follow up"); onClose(); }
    else notify?.(res?.error||"Couldn't submit report","err");
  };

  return(
    <Modal title="Report an Issue" onClose={onClose} width={380}>
      <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>ISSUE TYPE</div>
      <div style={{marginBottom:14}}>
        <FilterChipGroup options={ISSUE_TYPES} value={issueType} onChange={setIssueType}/>
      </div>
      <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>DESCRIPTION (OPTIONAL)</div>
      <textarea value={description} onChange={e=>setDescription(e.target.value)} placeholder="What went wrong?" rows={4}
        style={{width:"100%",background:D.cardEl,border:"1px solid "+D.border,borderRadius:9,padding:"11px 13px",color:D.white,fontSize:13,fontFamily:"inherit",resize:"vertical",marginBottom:16,boxSizing:"border-box"}}/>
      <div style={{fontSize:11,color:D.textMuted,marginBottom:16,lineHeight:1.5}}>
        This sends a report to our support team — it won't change or delete the match or its DUPR submission.
      </div>
      <button onClick={submit} disabled={busy}
        style={{width:"100%",padding:13,background:D.accent,border:"none",borderRadius:22,color:"#fff",fontWeight:700,fontSize:14,cursor:busy?"default":"pointer",opacity:busy?0.7:1}}>
        {busy?"Sending…":"Submit Report"}
      </button>
    </Modal>
  );
}
