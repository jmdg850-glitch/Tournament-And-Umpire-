import { LS } from "./storage.js";

// =
// DEVICE NOTIFICATIONS (foreground / while app is open)
// Uses the browser Notification API. Real background push (app closed) needs a
// service worker + Web Push server — that's a separate step.
// =
export const Notify = {
  supported: (typeof window!=="undefined" && typeof Notification!=="undefined"),
  isEnabled(){ try{ return LS.get("pl6_notif_on",false)===true && this.permission()==="granted"; }catch{ return false; } },
  setEnabled(v){ try{ LS.set("pl6_notif_on",!!v); }catch{ /* best-effort, safe to ignore */ } },
  permission(){ try{ return this.supported?Notification.permission:"unsupported"; }catch{ return "unsupported"; } },
  async request(){
    try{
      if(!this.supported) return "unsupported";
      const p=await Notification.requestPermission();
      return p;
    }catch{ return "denied"; }
  },
  show(title, body, opts={}){
    try{
      if(!this.supported || !this.isEnabled()) return;
      const n=new Notification(title,{ body, tag:opts.tag, icon:opts.icon });
      if(opts.onClick) n.onclick=()=>{ try{ window.focus(); opts.onClick(); n.close(); }catch{ /* best-effort, safe to ignore */ } };
      setTimeout(()=>{ try{ n.close(); }catch{ /* best-effort, safe to ignore */ } }, 6000);
    }catch{ /* best-effort, safe to ignore */ }
  },
};
