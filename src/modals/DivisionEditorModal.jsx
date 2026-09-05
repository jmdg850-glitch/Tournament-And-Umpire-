import { useState } from "react";
import { Modal } from "../components/ui/Modal.jsx";
import { Input } from "../components/ui/Input.jsx";
import { Toggle } from "../components/ui/Toggle.jsx";
import { FilterChipGroup } from "../components/ui/FilterChip.jsx";
import { D } from "../theme/tokens.js";

// "rrk_preset" isn't a real division.format value — it's a UI-only chip that maps to
// format:"pool_to_knockout" with poolCount forced to 1, so "one round robin group,
// then knockout the top N" reuses the exact same (already-tested) pool-play engine
// instead of a bespoke 6th format. See formatChipValue/onFormatChange below.
const FORMATS=[{value:"round_robin",label:"Round Robin"},{value:"single_elimination",label:"Single Elimination"},
  {value:"double_elimination",label:"Double Elimination"},{value:"pool_play",label:"Pool Play"},
  {value:"pool_to_knockout",label:"Pool to Knockout"},{value:"rrk_preset",label:"Round Robin + Knockout"},
  {value:"team_elimination",label:"Team Elimination"}];
const BEST_OF=[{value:1,label:"Single Game"},{value:3,label:"Best of 3"},{value:5,label:"Best of 5"}];
const POOL_KNOCKOUT_FORMATS=[{value:"single_elimination",label:"Single Elimination"},{value:"double_elimination",label:"Double Elimination"}];
const WIN_BY=[{value:"two",label:"Win By 2"},{value:"one",label:"Win By 1"},{value:"none",label:"None"}];
const ELIMINATION_PARTICIPANT_MODES=[{value:"top_x",label:"Top 4 Overall"},{value:"top_x_per_team",label:"Top X Per Team"},{value:"manual",label:"Manual"}];
const SAME_TEAM_POLICIES=[{value:"allow_anywhere",label:"Allow Anywhere"},{value:"avoid_quarterfinals",label:"Avoid in Quarterfinals"},
  {value:"avoid_semis",label:"Avoid in Semifinals"},{value:"avoid_until_final",label:"Avoid Until Final"}];

// Create/edit a division within a tournament — the unit that actually carries a
// format (round robin / single elimination) and its own registrations/bracket.
export function DivisionEditorModal({division,onSave,onClose}){
  const [name,setName]=useState(division?.name||"");
  const [category,setCategory]=useState(division?.category||"");
  const [skillLevel,setSkillLevel]=useState(division?.skillLevel||"");
  const [isDoubles,setIsDoubles]=useState(division?.isDoubles ?? true);
  const [format,setFormat]=useState(division?.format||"round_robin");
  const [winTo,setWinTo]=useState(division?.winTo||11);
  const [bestOf,setBestOf]=useState(division?.bestOf||1);
  const [hasBronzeMatch,setHasBronzeMatch]=useState(division?.hasBronzeMatch||false);
  const [top4Playoffs,setTop4Playoffs]=useState(division?.top4Playoffs||false);
  const [poolCount,setPoolCount]=useState(division?.poolCount||4);
  const [poolAdvanceCount,setPoolAdvanceCount]=useState(division?.poolAdvanceCount||2);
  const [poolKnockoutFormat,setPoolKnockoutFormat]=useState(division?.poolKnockoutFormat||"single_elimination");
  const [winBy,setWinBy]=useState(division?.winBy||"two");
  const [timeoutsAllowed,setTimeoutsAllowed]=useState(division?.timeoutsAllowed||"");
  const [duprRated,setDuprRated]=useState(division?.duprRated||false);
  // "never"/"all" (135) were dead legacy defaults nothing in the app ever read — normalize
  // them away here rather than surfacing an option that no longer means anything.
  const [eliminationParticipantMode,setEliminationParticipantMode]=useState(
    ["top_x_per_team","manual"].includes(division?.eliminationParticipantMode)?division.eliminationParticipantMode:"top_x");
  const [eliminationParticipantCount,setEliminationParticipantCount]=useState(division?.eliminationParticipantCount||2);
  const [sameTeamMatchupPolicy,setSameTeamMatchupPolicy]=useState(
    ["avoid_quarterfinals","avoid_semis","avoid_until_final"].includes(division?.sameTeamMatchupPolicy)?division.sameTeamMatchupPolicy:"allow_anywhere");
  const isPoolFormat=format==="pool_play"||format==="pool_to_knockout";
  const isRrkPreset=format==="pool_to_knockout"&&poolCount===1;
  const formatChipValue=isRrkPreset?"rrk_preset":format;
  const usesBronzeEligibleKnockout=format==="single_elimination"||(format==="pool_to_knockout"&&poolKnockoutFormat==="single_elimination");
  const onFormatChange=v=>{
    if(v==="rrk_preset"){ setFormat("pool_to_knockout"); setPoolCount(1); setPoolAdvanceCount(4); }
    else setFormat(v);
  };
  const valid=name.trim().length>0;
  const locked=!!division; // format can't change once matches may already exist

  return(
    <Modal title={division?"Edit Division":"New Division"} onClose={onClose} width={420}>
      <Input label="Division Name" value={name} onChange={setName} placeholder="Mixed Doubles 4.0"/>
      <div style={{display:"flex",gap:10}}>
        <div style={{flex:1}}><Input label="Category" value={category} onChange={setCategory} placeholder="Mixed Doubles"/></div>
        <div style={{flex:1}}><Input label="Skill Level" value={skillLevel} onChange={setSkillLevel} placeholder="4.0"/></div>
      </div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 2px",marginBottom:13}}>
        <div style={{fontSize:13,fontWeight:600,color:D.textPrimary}}>Doubles</div>
        <Toggle value={isDoubles} onChange={setIsDoubles} label="Doubles"/>
      </div>
      <div style={{marginBottom:13}}>
        <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>FORMAT</div>
        <FilterChipGroup options={FORMATS} value={formatChipValue} onChange={locked?()=>{}:onFormatChange}/>
        {locked&&<div style={{fontSize:11,color:D.textMuted,marginTop:6}}>Format can't change after a division is created.</div>}
      </div>
      {usesBronzeEligibleKnockout&&(
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 2px",marginBottom:13}}>
          <div>
            <div style={{fontSize:13,fontWeight:600,color:D.textPrimary}}>Bronze Match (3rd Place)</div>
            <div style={{fontSize:11,color:D.textMuted}}>Adds a playoff between the two semifinal losers.</div>
          </div>
          <Toggle value={hasBronzeMatch} onChange={setHasBronzeMatch} label="Bronze Match (3rd Place)"/>
        </div>
      )}
      {format==="round_robin"&&(
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 2px",marginBottom:13}}>
          <div>
            <div style={{fontSize:13,fontWeight:600,color:D.textPrimary}}>Top 4 Playoffs</div>
            <div style={{fontSize:11,color:D.textMuted}}>Auto-generates Semifinal / Final / Battle for Bronze once the round robin finishes.</div>
          </div>
          <Toggle value={top4Playoffs} onChange={setTop4Playoffs} label="Top 4 Playoffs"/>
        </div>
      )}
      {isPoolFormat&&(
        <>
          <div style={{display:"flex",gap:10}}>
            {!isRrkPreset&&<div style={{flex:1}}><Input label="Number of Pools" type="number" value={poolCount} onChange={v=>setPoolCount(+v||1)}/></div>}
            <div style={{flex:1}}><Input label={isRrkPreset?"Advance to Knockout: Top N":"Advance per Pool"} type="number" value={poolAdvanceCount} onChange={v=>setPoolAdvanceCount(+v||1)}/></div>
          </div>
          {format==="pool_to_knockout"&&(
            <div style={{marginBottom:13}}>
              <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>KNOCKOUT FORMAT</div>
              <FilterChipGroup options={POOL_KNOCKOUT_FORMATS} value={poolKnockoutFormat} onChange={setPoolKnockoutFormat}/>
            </div>
          )}
        </>
      )}
      {format==="team_elimination"&&(
        <>
          <div style={{fontSize:11,color:D.textMuted,marginBottom:13}}>
            Team Elimination runs a round robin where every Team plays every other Team —
            each pair on one Team faces a different pair on the other in a balanced rotation.
            Assign pairs to Teams in the division's Team Groups tab once it's created.
          </div>
          <div style={{marginBottom:13}}>
            <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>ELIMINATION PARTICIPANTS</div>
            <FilterChipGroup options={ELIMINATION_PARTICIPANT_MODES} value={eliminationParticipantMode} onChange={setEliminationParticipantMode}/>
            <div style={{fontSize:11,color:D.textMuted,marginTop:6}}>
              {eliminationParticipantMode==="top_x"&&"Top 4 individual pairs by round-robin record advance, regardless of Team."}
              {eliminationParticipantMode==="top_x_per_team"&&"Top X individual pairs from EACH Team advance — not Top X overall."}
              {eliminationParticipantMode==="manual"&&"Choose exactly which pairs advance once the round robin finishes."}
            </div>
          </div>
          {eliminationParticipantMode==="top_x_per_team"&&(
            <div style={{marginBottom:13}}>
              <Input label="Top X Per Team" type="number" value={eliminationParticipantCount} onChange={v=>setEliminationParticipantCount(+v||1)}/>
            </div>
          )}
          <div style={{marginBottom:13}}>
            <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>SAME-TEAM MATCHUPS</div>
            <FilterChipGroup options={SAME_TEAM_POLICIES} value={sameTeamMatchupPolicy} onChange={setSameTeamMatchupPolicy}/>
            <div style={{fontSize:11,color:D.textMuted,marginTop:6}}>
              Controls how hard the bracket tries to keep pairs from the same Team apart before the Final.
              A same-Team Final can still happen if that's the actual result.
            </div>
          </div>
        </>
      )}
      <div style={{display:"flex",gap:10}}>
        <div style={{flex:1}}><Input label="Win To" type="number" value={winTo} onChange={v=>setWinTo(+v||11)}/></div>
        <div style={{flex:1}}><Input label="Timeouts (blank = default)" type="number" value={timeoutsAllowed} onChange={v=>setTimeoutsAllowed(v.replace(/[^0-9]/g,""))}/></div>
      </div>
      <div style={{marginBottom:13}}>
        <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>WIN BY</div>
        <FilterChipGroup options={WIN_BY} value={winBy} onChange={setWinBy}/>
      </div>
      <div style={{marginBottom:13}}>
        <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>GAMES PER MATCH</div>
        <FilterChipGroup options={BEST_OF} value={bestOf} onChange={setBestOf}/>
      </div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 2px",marginBottom:13}}>
        <div>
          <div style={{fontSize:13,fontWeight:600,color:D.textPrimary}}>DUPR Rated Event</div>
          <div style={{fontSize:11,color:D.textMuted}}>Completed matches can be submitted to DUPR. Players need a linked DUPR account.</div>
        </div>
        <Toggle value={duprRated} onChange={setDuprRated} label="DUPR Rated Event"/>
      </div>
      <button onClick={()=>valid&&onSave({name:name.trim(),category:category.trim(),skillLevel:skillLevel.trim(),isDoubles,format,winTo:+winTo||11,bestOf:+bestOf||1,
          hasBronzeMatch:usesBronzeEligibleKnockout&&hasBronzeMatch,
          top4Playoffs:format==="round_robin"&&top4Playoffs,
          poolCount:isPoolFormat?(+poolCount||1):null, poolAdvanceCount:isPoolFormat?(+poolAdvanceCount||1):null,
          poolKnockoutFormat:format==="pool_to_knockout"?poolKnockoutFormat:null,
          sameTeamMatchupPolicy:format==="team_elimination"?sameTeamMatchupPolicy:"allow_anywhere",
          eliminationParticipantMode:format==="team_elimination"?eliminationParticipantMode:"top_x",
          eliminationParticipantCount:format==="team_elimination"&&eliminationParticipantMode==="top_x_per_team"?(+eliminationParticipantCount||1):null,
          winBy, timeoutsAllowed:timeoutsAllowed?+timeoutsAllowed:null, duprRated})}
        disabled={!valid}
        style={{width:"100%",padding:13,background:valid?D.accent:D.cardEl,border:"none",borderRadius:22,color:valid?"#fff":D.textMuted,fontWeight:700,fontSize:14,cursor:valid?"pointer":"default"}}>
        {division?"Save Changes":"Create Division"}
      </button>
    </Modal>
  );
}
