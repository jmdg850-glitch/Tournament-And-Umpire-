// TOURNAMENT EXPORT — Excel/CSV only (PDF/certificates are a "coming soon" stub in the
// UI, not implemented here). CSV goes straight through the existing downloadText()
// primitive unchanged. .xlsx dynamically imports the `xlsx` package the same way
// xlsxImport.js's import side already does, so the ~700KB lib never loads until an
// organizer actually exports — and writes through downloadText's `isBase64` flag, since
// that's the only way binary content can safely cross both the Electron IPC channel and a
// web <a download> Blob.

import { downloadText } from "./utils.js";

function toCsvValue(v){
  const s=v==null?"":String(v);
  return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
}
function rowsToCsv(headers,rows){
  return [headers.join(","), ...rows.map(r=>r.map(toCsvValue).join(","))].join("\n");
}
function safeName(s){
  return (s||"export").replace(/[^a-z0-9\-_. ]/gi,"_");
}

export async function exportStandingsCsv(tournamentName,divisionName,standings,nameFor){
  const headers=["Rank","Player/Team","Wins","Losses","Games Won","Games Lost","Points For","Points Against","Point Diff","Avg Score"];
  const rows=standings.map(s=>[s.rank,nameFor(s.registrationId),s.wins,s.losses,s.gamesWon,s.gamesLost,s.pointsFor,s.pointsAgainst,s.pointDiff,s.averageScore]);
  return downloadText(safeName(tournamentName+"-"+divisionName+"-standings")+".csv", rowsToCsv(headers,rows), "text/csv");
}

export async function exportResultsCsv(tournamentName,rows){
  const headers=["Award","Player/Team","Division","Notes"];
  const csv=rowsToCsv(headers,rows.map(r=>[r.award,r.name,r.division||"—",r.notes||""]));
  return downloadText(safeName(tournamentName+"-results")+".csv", csv, "text/csv");
}

/** @param {{name:string,headers:string[],rows:any[][]}[]} sheets one entry per tab */
export async function exportSheetsXlsx(filename,sheets){
  const XLSX=await import("xlsx");
  const wb=XLSX.utils.book_new();
  sheets.forEach(({name,headers,rows})=>{
    const ws=XLSX.utils.aoa_to_sheet([headers,...rows]);
    XLSX.utils.book_append_sheet(wb,ws,name.slice(0,31));
  });
  const base64=XLSX.write(wb,{type:"base64",bookType:"xlsx"});
  return downloadText(safeName(filename)+".xlsx", base64, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", true);
}
