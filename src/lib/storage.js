// localStorage wrapper — JSON in/out, never throws.
export const LS = {
  get:(k,d=null)=>{ try{const v=localStorage.getItem(k);return v?JSON.parse(v):d;}catch{return d;} },
  set:(k,v)=>{ try{localStorage.setItem(k,JSON.stringify(v));}catch{ /* best-effort, safe to ignore */ } },
  del:(k)=>{ try{localStorage.removeItem(k);}catch{ /* best-effort, safe to ignore */ } },
};
