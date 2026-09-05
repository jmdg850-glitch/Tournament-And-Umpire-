import { useState } from "react";
import { LOG_CAT_ICON, LOG_LEVEL_META, Log, fmtLogTime, useLogs } from "../../lib/log.js";
import { downloadText, today } from "../../lib/utils.js";
import { Panel } from "../../components/ui/Panel.jsx";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog.jsx";
import { D, alpha } from "../../theme/tokens.js";


// Content-only viewer (no fixed positioning) so it can live inside the Admin
// tab OR the full-screen LogsPanel. Reads live from the Log store.
export function LogViewer({notify}){
  const logs = useLogs();
  const [level,setLevel] = useState("all");
  const [cat,setCat]     = useState("all");
  const [q,setQ]         = useState("");
  const [openId,setOpenId] = useState(null);
  const [confirmClear,setConfirmClear] = useState(false);

  const levelCounts = {debug:0,info:0,success:0,warn:0,error:0};
  logs.forEach(e=>{ if(levelCounts[e.level]!=null) levelCounts[e.level]++; });
  const errCount = levelCounts.error, warnCount = levelCounts.warn;

  const ql = q.trim().toLowerCase();
  const filtered = logs.filter(e=>{
    if(level!=="all" && e.level!==level) return false;
    if(cat!=="all"   && e.category!==cat) return false;
    if(ql){
      const hay = (e.action+" "+e.actor+" "+e.category+" "+(e.meta?JSON.stringify(e.meta):"")).toLowerCase();
      if(!hay.includes(ql)) return false;
    }
    return true;
  }).slice().reverse(); // newest first

  const doExport = async (fmt)=>{
    const text = Log.export(fmt);
    if(!text){ notify&&notify("Nothing to export","err"); return; }
    const ok = await downloadText(`picklelive-logs-${today()}.${fmt}`, text, fmt==="csv"?"text/csv":"application/json");
    if(ok===null) return; // user canceled the native save dialog - not an error, stay quiet
    notify&&notify(ok?`Exported ${fmt.toUpperCase()} (${filtered.length>0?logs.length:0} entries)`:"Export failed", ok?"ok":"err");
  };
  const doClear = ()=>setConfirmClear(true);
  const runClear = ()=>{ Log.clear(); setOpenId(null); notify&&notify("Logs cleared"); };

  const chip = (key,label,count,active,onClick,color)=>(
    <button key={key} onClick={onClick} className="press"
      style={{padding:"5px 11px",borderRadius:20,fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",
        border:`1px solid ${active?color:D.border}`,background:active?alpha(color,9):D.surface,color:active?color:D.textSecondary}}>
      {label}{count!=null && <span style={{opacity:.7,marginLeft:5}}>{count}</span>}
    </button>
  );

  return(
    <div>
      {/* Summary strip */}
      <div style={{display:"flex",gap:8,marginBottom:12}}>
        {[{l:"TOTAL",v:logs.length,c:D.accent},{l:"ERRORS",v:errCount,c:D.red},{l:"WARNINGS",v:warnCount,c:D.amber}].map(s=>(
          <div key={s.l} style={{flex:1,background:D.surface,border:`1px solid ${D.border}`,borderRadius:12,padding:"11px 8px",textAlign:"center"}}>
            <div style={{fontSize:22,fontWeight:900,color:s.c,fontVariantNumeric:"tabular-nums"}}>{s.v}</div>
            <div style={{fontSize:9,fontWeight:700,color:D.textMuted,letterSpacing:"1px",marginTop:2}}>{s.l}</div>
          </div>
        ))}
      </div>

      {/* Search */}
      <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search logs…"
        style={{width:"100%",background:D.surface,border:`1px solid ${D.border}`,borderRadius:10,padding:"10px 13px",
          color:D.textPrimary,fontSize:13,outline:"none",marginBottom:10}}/>

      {/* Level filter chips */}
      <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:6,marginBottom:6}}>
        {chip("all","All",logs.length,level==="all",()=>setLevel("all"),D.accent)}
        {Log.LEVELS.map(l=>chip(l,LOG_LEVEL_META[l].label,levelCounts[l],level===l,()=>setLevel(l),LOG_LEVEL_META[l].color))}
      </div>

      {/* Category filter */}
      <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:8,marginBottom:12}}>
        {chip("catall","All types",null,cat==="all",()=>setCat("all"),D.blue)}
        {Log.CATEGORIES.map(c=>chip("cat_"+c,(LOG_CAT_ICON[c]||"")+" "+c,null,cat===c,()=>setCat(c),D.blue))}
      </div>

      {/* Actions */}
      <div style={{display:"flex",gap:8,marginBottom:14}}>
        <button onClick={()=>doExport("json")} className="press" style={{flex:1,padding:"9px",background:D.blueBg,border:`1px solid ${D.blue}`,borderRadius:10,color:D.blue,fontSize:12,fontWeight:700,cursor:"pointer"}}>⬇ JSON</button>
        <button onClick={()=>doExport("csv")} className="press" style={{flex:1,padding:"9px",background:D.greenBg,border:`1px solid ${D.green}`,borderRadius:10,color:D.green,fontSize:12,fontWeight:700,cursor:"pointer"}}>⬇ CSV</button>
        <button onClick={doClear} className="press" style={{flex:1,padding:"9px",background:D.redBg,border:`1px solid ${D.red}`,borderRadius:10,color:D.red,fontSize:12,fontWeight:700,cursor:"pointer"}}>Clear</button>
      </div>

      {/* Entries */}
      {filtered.length===0 ? (
        <div style={{textAlign:"center",padding:"40px 20px",color:D.textMuted}}>
          <div style={{fontSize:34,marginBottom:10}}>🗒️</div>
          <div style={{fontSize:13,fontWeight:600}}>{logs.length===0?"No log entries yet":"No entries match your filters"}</div>
          <div style={{fontSize:11,marginTop:4}}>{logs.length===0?"App activity and errors will appear here.":"Try clearing the search or filters."}</div>
        </div>
      ) : filtered.map(e=>{
        const m = LOG_LEVEL_META[e.level] || LOG_LEVEL_META.info;
        const open = openId===e.id;
        const hasMeta = e.meta && Object.keys(e.meta).length>0;
        return(
          <div key={e.id} onClick={()=>hasMeta&&setOpenId(open?null:e.id)}
            role={hasMeta?"button":undefined} tabIndex={hasMeta?0:undefined}
            onKeyDown={e2=>{if(hasMeta&&e2.key==="Enter"){e2.preventDefault();setOpenId(open?null:e.id);}}}
            style={{background:D.surface,border:`1px solid ${D.border}`,borderLeft:`3px solid ${m.dot}`,borderRadius:10,
              padding:"10px 12px",marginBottom:7,cursor:hasMeta?"pointer":"default"}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:9,fontWeight:800,letterSpacing:"0.5px",color:m.color,background:m.bg,borderRadius:5,padding:"2px 6px",flexShrink:0}}>{m.label}</span>
              <span style={{fontSize:13,flexShrink:0}}>{LOG_CAT_ICON[e.category]||"•"}</span>
              <div style={{flex:1,minWidth:0,fontSize:12.5,fontWeight:600,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:open?"normal":"nowrap"}}>{e.action}</div>
              <span style={{fontSize:10,color:D.textMuted,flexShrink:0}}>{fmtLogTime(e.ts)}</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4,paddingLeft:2}}>
              <span style={{fontSize:10,color:D.textSecondary}}>{e.actor}</span>
              <span style={{fontSize:10,color:D.textLight}}>·</span>
              <span style={{fontSize:10,color:D.textMuted,textTransform:"capitalize"}}>{e.category}</span>
              {hasMeta && <span style={{fontSize:10,color:D.blue,marginLeft:"auto"}}>{open?"▲ hide":"▼ details"}</span>}
            </div>
            {open && hasMeta && (
              <pre style={{marginTop:8,background:D.cardEl,border:`1px solid ${D.border}`,borderRadius:8,padding:"9px 11px",
                fontSize:11,color:D.textSecondary,overflowX:"auto",whiteSpace:"pre-wrap",wordBreak:"break-word",fontFamily:"monospace"}}>
                {JSON.stringify(e.meta,null,2)}
              </pre>
            )}
          </div>
        );
      })}
      {confirmClear&&(
        <ConfirmDialog title={"Clear all "+logs.length+" log entries?"} message="This cannot be undone." confirmLabel="Clear Logs" destructive
          onConfirm={()=>{setConfirmClear(false);runClear();}}
          onCancel={()=>setConfirmClear(false)}/>
      )}
    </div>
  );
}


// Full-screen wrapper (opened from Settings).
export function LogsPanel({onClose,notify}){
  return(
    <Panel title="Activity & Logs" sub="App events · diagnostics · errors" onClose={onClose}>
      <LogViewer notify={notify}/>
    </Panel>
  );
}
