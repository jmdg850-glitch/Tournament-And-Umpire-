// Excel/CSV roster import with duplicate detection against the existing roster.
// xlsx (~700KB) is dynamically imported so it never loads until a user
// actually opens the roster-import flow, instead of shipping in the main bundle.
import { uid, today, clamp } from "./utils.js";

// normalize a name/phone/email for duplicate comparison
const dupKey = v=>String(v||"").trim().toLowerCase();

async function parseArrayBuffer(arrayBuffer,onOk,onErr,existingPlayers){
  try{
    const XLSX = await import("xlsx");
    const wb=XLSX.read(new Uint8Array(arrayBuffer),{type:"array"});
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:""});
    if(rows.length<2){onErr("File is empty.");return;}
    const hdr=rows[0].map(h=>String(h).toLowerCase());
    const ni=hdr.findIndex(h=>h.includes("name")||h.includes("player"));
    const hi=hdr.findIndex(h=>h.includes("hand"));
    const si=hdr.findIndex(h=>h.includes("skill")||h.includes("rating"));
    const ei=hdr.findIndex(h=>h.includes("email"));
    const pi=hdr.findIndex(h=>h.includes("phone")||h.includes("contact"));
    const gi=hdr.findIndex(h=>h.includes("gender")||h.includes("sex"));
    const ci=hdr.findIndex(h=>h.includes("category"));
    const totalRows=rows.length-1;
    const players=[]; const errors=[]; let skipped=0;
    // Duplicate keys already on the organizer's roster (name, plus phone/email if present)
    const seenNames=new Set((existingPlayers||[]).map(p=>dupKey(p.name)));
    const seenPhones=new Set((existingPlayers||[]).filter(p=>p.phone).map(p=>dupKey(p.phone)));
    const seenEmails=new Set((existingPlayers||[]).filter(p=>p.email).map(p=>dupKey(p.email)));
    for(let i=1;i<rows.length;i++){
      const row=rows[i];const rawName=ni>=0?row[ni]:row[0];
      const name=String(rawName==null?"":rawName).trim();
      if(!name){errors.push({row:i+1,reason:"Missing player name"});continue;}
      const email=dupKey(ei>=0?row[ei]:"");
      const phone=dupKey(pi>=0?row[pi]:"");
      const nameKey=dupKey(name);
      const isDup = (phone&&seenPhones.has(phone)) || (email&&seenEmails.has(email)) || (!phone&&!email&&seenNames.has(nameKey));
      if(isDup){skipped++;continue;}
      seenNames.add(nameKey); if(phone)seenPhones.add(phone); if(email)seenEmails.add(email);
      const sk=parseFloat(si>=0?row[si]:3.0);
      const skill=isNaN(sk)?3.0:clamp(sk,2,8);
      const genderRaw=String(gi>=0?row[gi]:"").trim().toLowerCase();
      const gender=genderRaw.startsWith("m")?"Male":genderRaw.startsWith("f")?"Female":genderRaw?"Other":"";
      const catName=ci>=0?String(row[ci]==null?"":row[ci]).trim():"";
      players.push({id:uid(),name,hand:String(hi>=0?row[hi]:"Right").toLowerCase().startsWith("l")?"Left":"Right",
        gender,rating:skill,singlesRating:skill,doublesRating:skill,source:"import",
        email:String(ei>=0?row[ei]:"").trim(),phone:String(pi>=0?row[pi]:"").trim(),
        wins:0,losses:0,photo:null,joinDate:today(),...(catName?{catName}:{})});
    }
    onOk({players,totalRows,imported:players.length,skipped,errors});
  }catch{onErr("Could not read file.");}
}

export function parseFile(file,onOk,onErr,existingPlayers){
  const r=new FileReader();
  r.onload=e=>parseArrayBuffer(e.target.result,onOk,onErr,existingPlayers);
  r.readAsArrayBuffer(file);
}

// Electron-only path: the native open-file dialog (window.electronAPI.openFileDialog)
// returns a filesystem path, not a File object, so there's no FileReader to hand this
// to — read it via the preload-exposed IPC channel instead (see electron/ipc/dialogs.cjs).
export async function parseFilePath(filePath,onOk,onErr,existingPlayers){
  try{
    const buffer = await window.electronAPI.readFile(filePath);
    await parseArrayBuffer(buffer,onOk,onErr,existingPlayers);
  }catch{onErr("Could not read file.");}
}
