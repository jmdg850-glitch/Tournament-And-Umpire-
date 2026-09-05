import { Panel } from "../components/ui/Panel.jsx";
import { Card } from "../components/ui/Card.jsx";
import { D } from "../theme/tokens.js";


// ================================================================
// COURT MANAGER MODAL
// ================================================================
export function CourtMgrModal({courts,onAdd,onRename,onRecolor,onToggleActive,onDelete,onClose,notify}){
  const COLORS=[D.accent,D.blue,D.amber,D.red,D.purple,D.orange];
  const add=()=>{onAdd();notify("Court added");};
  const del=id=>{if(courts.length<=1){notify("Keep at least one court","err");return;}onDelete(id);};
  return(
    <Panel title="Manage Courts" onClose={onClose}
      headerRight={<button onClick={add} style={{padding:"8px 16px",background:D.accent,border:"none",borderRadius:22,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer"}}>+ Add</button>}>
      {courts.map(c=>(
        <Card key={c.id} padding="13px 14px" style={{marginBottom:10}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
            <div style={{width:12,height:12,borderRadius:6,background:c.color,flexShrink:0}}/>
            <input value={c.name} onChange={e=>onRename(c.id,e.target.value)} style={{flex:1,background:D.cardEl,border:"1px solid "+D.border,borderRadius:10,padding:"8px 10px",color:D.textPrimary,fontSize:13,outline:"none"}}/>
            <button onClick={()=>onToggleActive(c.id,!c.active)} style={{padding:"5px 10px",borderRadius:20,border:"1px solid "+(c.active?D.accent:D.border),background:c.active?D.accentBg:"transparent",color:c.active?D.accent:D.textMuted,fontSize:11,fontWeight:700,cursor:"pointer"}}>{c.active?"Active":"Inactive"}</button>
            <button onClick={()=>del(c.id)} style={{width:28,height:28,borderRadius:14,background:D.redBg,border:"none",color:D.red,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>×</button>
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {COLORS.map(col=>(
              <button key={col} onClick={()=>onRecolor(c.id,col)} style={{width:26,height:26,borderRadius:13,background:col,border:c.color===col?"2.5px solid "+D.textPrimary:"1.5px solid transparent",cursor:"pointer",flexShrink:0}}/>
            ))}
          </div>
        </Card>
      ))}
    </Panel>
  );
}
