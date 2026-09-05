import { useState } from "react";
import { Modal } from "../components/ui/Modal.jsx";
import { Input } from "../components/ui/Input.jsx";
import { FilterChipGroup } from "../components/ui/FilterChip.jsx";
import { D } from "../theme/tokens.js";

const TYPES=[{value:"singles",label:"Singles"},{value:"doubles",label:"Doubles"},{value:"mixed",label:"Mixed"}];

// Create/edit a tournament's own metadata (name/venue/dates/logo/banner/type/description).
// Divisions, registration, and format live one level down (DivisionEditorModal).
export function TournamentEditorModal({tournament,onSave,onClose}){
  const [name,setName]=useState(tournament?.name||"");
  const [venue,setVenue]=useState(tournament?.venue||"");
  const [logoUrl,setLogoUrl]=useState(tournament?.logoUrl||"");
  const [bannerUrl,setBannerUrl]=useState(tournament?.bannerUrl||"");
  const [types,setTypes]=useState(tournament?.types||[]);
  const [startDate,setStartDate]=useState(tournament?.startDate||"");
  const [endDate,setEndDate]=useState(tournament?.endDate||"");
  const [description,setDescription]=useState(tournament?.description||"");
  const valid=name.trim().length>0;

  return(
    <Modal title={tournament?"Edit Tournament":"New Tournament"} onClose={onClose} width={420}>
      <Input label="Tournament Name" value={name} onChange={setName} placeholder="Summer Slam 2026"/>
      <Input label="Venue" value={venue} onChange={setVenue} placeholder="Riverside Courts"/>
      <div style={{display:"flex",gap:10}}>
        <div style={{flex:1}}><Input label="Start Date" type="date" value={startDate} onChange={setStartDate}/></div>
        <div style={{flex:1}}><Input label="End Date" type="date" value={endDate} onChange={setEndDate}/></div>
      </div>
      <div style={{marginBottom:13}}>
        <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>TYPE</div>
        <FilterChipGroup options={TYPES} value={types} onChange={setTypes} multi/>
      </div>
      <Input label="Logo URL (optional)" value={logoUrl} onChange={setLogoUrl} placeholder="https://…"/>
      <Input label="Banner URL (optional)" value={bannerUrl} onChange={setBannerUrl} placeholder="https://…"/>
      <div style={{marginBottom:13}}>
        <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:6}}>DESCRIPTION</div>
        <textarea value={description} onChange={e=>setDescription(e.target.value)} rows={3}
          style={{width:"100%",background:D.cardEl,border:"1px solid "+D.border,borderRadius:9,padding:"11px 13px",color:D.textPrimary,fontSize:13,resize:"vertical",boxSizing:"border-box",fontFamily:"inherit"}}/>
      </div>
      <button onClick={()=>valid&&onSave({name:name.trim(),venue:venue.trim(),logoUrl:logoUrl.trim()||null,bannerUrl:bannerUrl.trim()||null,types,startDate:startDate||null,endDate:endDate||null,description:description.trim()})}
        disabled={!valid}
        style={{width:"100%",padding:13,background:valid?D.accent:D.cardEl,border:"none",borderRadius:22,color:valid?"#fff":D.textMuted,fontWeight:700,fontSize:14,cursor:valid?"pointer":"default"}}>
        {tournament?"Save Changes":"Create Tournament"}
      </button>
    </Modal>
  );
}
