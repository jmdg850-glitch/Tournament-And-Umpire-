import { useState } from "react";
import { D } from "../../theme/tokens.js";


// Shared field helpers
export function ClubFld({label,value,onChange,placeholder,multi}){
  const s={width:"100%",background:D.surface,border:"1px solid "+D.border,borderRadius:10,padding:"12px 13px",color:D.textPrimary,fontSize:13,outline:"none",fontFamily:"inherit",boxSizing:"border-box"};
  return(
    <div style={{marginBottom:14}}>
      {label&&<div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1px",marginBottom:6}}>{label}</div>}
      {multi?<textarea value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={4} style={{...s,resize:"vertical"}}/>
        :<input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={s}/>}
    </div>
  );
}

export function ClubMapFld({label,value,onChange,placeholder}){
  const [showPicker,setShowPicker]=useState(false);
  const [searchQ,setSearchQ]=useState(value||"");

  // Popular PH pickleball venues as quick picks
  const QUICK_PICKS=[
    "SM Mall of Asia Arena, Pasay City",
    "Rizal Memorial Sports Complex, Manila",
    "BGC Central Park, Taguig",
    "Eastwood City, Libis, Quezon City",
    "Filinvest City, Alabang, Muntinlupa",
    "SM Seaside City Cebu, Cebu City",
    "Ayala Malls Solenad, Santa Rosa, Laguna",
    "Robinson's Galleria, EDSA, Quezon City",
    "Ynares Sports Arena, Pasig City",
    "PH Sports Complex, Luneta, Manila",
  ];

  // Filter quick picks based on search
  const filtered=searchQ.length>1
    ?QUICK_PICKS.filter(p=>p.toLowerCase().includes(searchQ.toLowerCase()))
    :QUICK_PICKS;

  const select=(loc)=>{
    onChange(loc);
    setSearchQ(loc);
    setShowPicker(false);
  };

  const mapEmbedUrl=value.trim()
    ?"https://maps.google.com/maps?q="+encodeURIComponent(value)+"&output=embed&z=15"
    :null;

  return(
    <div style={{marginBottom:14}}>
      <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1px",marginBottom:6}}>{label}</div>

      {/* Input row */}
      <div style={{position:"relative"}}>
        <svg style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",flexShrink:0,pointerEvents:"none"}} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={D.accent} strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        <input
          value={searchQ}
          onChange={e=>{setSearchQ(e.target.value);onChange(e.target.value);if(!showPicker)setShowPicker(true);}}
          onFocus={()=>setShowPicker(true)}
          placeholder={placeholder}
          style={{width:"100%",background:D.surface,border:"1.5px solid "+(showPicker?D.accent:D.border),borderRadius:showPicker?"10px 10px 0 0":10,padding:"12px 44px 12px 36px",color:D.textPrimary,fontSize:13,outline:"none",boxSizing:"border-box",transition:"border-color .15s"}}/>
        {searchQ.trim()&&(
          <button onClick={()=>{setSearchQ("");onChange("");setShowPicker(false);}}
            style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:D.textMuted,cursor:"pointer",fontSize:16,lineHeight:1,padding:0}}>×</button>
        )}
      </div>

      {/* Dropdown picker */}
      {showPicker&&(
        <div style={{background:D.surface,border:"1.5px solid "+D.accent,borderTop:"none",borderRadius:"0 0 10px 10px",maxHeight:220,overflowY:"auto",boxShadow:"0 8px 24px rgba(0,0,0,.12)"}}>
          {/* Quick picks label */}
          <div style={{fontSize:9,fontWeight:700,color:D.textMuted,letterSpacing:"1.5px",padding:"8px 12px 4px"}}>
            {searchQ.length>1?"MATCHING VENUES":"POPULAR VENUES IN PH"}
          </div>
          {filtered.map((loc,i)=>(
            <button key={i} onClick={()=>select(loc)}
              style={{width:"100%",padding:"10px 12px",background:"transparent",border:"none",borderBottom:"1px solid "+D.border,cursor:"pointer",textAlign:"left",display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:14,flexShrink:0}}>📍</span>
              <span style={{fontSize:13,color:D.textPrimary,flex:1}}>{loc}</span>
            </button>
          ))}
          {/* Manual entry option */}
          {searchQ.trim()&&!QUICK_PICKS.includes(searchQ)&&(
            <button onClick={()=>select(searchQ)}
              style={{width:"100%",padding:"10px 12px",background:D.accentBg,border:"none",cursor:"pointer",textAlign:"left",display:"flex",alignItems:"center",gap:10,borderRadius:"0 0 10px 10px"}}>
              <span style={{fontSize:14}}>✏️</span>
              <div>
                <div style={{fontSize:12,color:D.accent,fontWeight:700}}>Use: "{searchQ}"</div>
                <div style={{fontSize:10,color:D.textMuted}}>Set custom location</div>
              </div>
            </button>
          )}
          <button onClick={()=>setShowPicker(false)}
            style={{width:"100%",padding:"8px 12px",background:"transparent",border:"none",cursor:"pointer",color:D.textMuted,fontSize:12,borderTop:"1px solid "+D.border}}>
            Close ✕
          </button>
        </div>
      )}

      {/* Map preview + open buttons — shows when location is set */}
      {value.trim()&&!showPicker&&(
        <div style={{marginTop:8,borderRadius:12,overflow:"hidden",border:"1px solid "+D.border}}>
          {/* Embedded map iframe */}
          <iframe
            src={mapEmbedUrl}
            width="100%"
            height="160"
            style={{display:"block",border:"none"}}
            allowFullScreen
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            title="Location map"/>
          {/* Location label + open buttons */}
          <div style={{background:D.surface,padding:"10px 12px"}}>
            <div style={{fontSize:12,fontWeight:700,color:D.textPrimary,marginBottom:8,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>📍 {value}</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
              {[
                {label:"Google Maps",emoji:"🗺",url:"https://maps.google.com/?q="+encodeURIComponent(value)},
                {label:"Waze",       emoji:"🚗",url:"https://waze.com/ul?q="+encodeURIComponent(value)},
                {label:"Apple Maps", emoji:"🍎",url:"https://maps.apple.com/?q="+encodeURIComponent(value)},
              ].map(app=>(
                <button key={app.label}
                  onClick={()=>{
                    try{window.open(app.url,"_blank");}
                    catch{document.location.href=app.url;}
                  }}
                  style={{padding:"7px 4px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:9,cursor:"pointer",textAlign:"center"}}>
                  <div style={{fontSize:16,marginBottom:2}}>{app.emoji}</div>
                  <div style={{fontSize:9,color:D.textSecondary,fontWeight:600}}>{app.label}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ClubPriceFld({value,onChange}){
  return(
    <div style={{marginBottom:14}}>
      <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1px",marginBottom:6}}>ENTRY FEE PER PLAYER</div>
      <div style={{display:"flex",gap:6,marginBottom:8}}>
        {[0,50,100,150,200,300].map(p=>(
          <button key={p} onClick={()=>onChange(p)} style={{flex:1,padding:"8px 4px",borderRadius:20,border:"1.5px solid "+(value===p?D.accent:D.border),background:value===p?D.accent:"transparent",color:value===p?"#fff":D.textSecondary,fontWeight:700,fontSize:11,cursor:"pointer"}}>
            {p===0?"Free":"P"+p}
          </button>
        ))}
      </div>
      <input type="number" value={value} onChange={e=>onChange(Math.max(0,+e.target.value))} placeholder="Custom amount" style={{width:"100%",background:D.surface,border:"1px solid "+D.border,borderRadius:10,padding:"11px 13px",color:D.textPrimary,fontSize:13,outline:"none"}}/>
    </div>
  );
}
