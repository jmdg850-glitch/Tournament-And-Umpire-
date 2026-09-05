import { useCallback, useEffect, useState } from "react";
import { LS } from "../lib/storage.js";

const KEY = "theme"; // "light" | "dark" | "system"
const MQ = "(prefers-color-scheme: dark)";

function resolve(mode){
  if(mode==="system") return window.matchMedia(MQ).matches?"dark":"light";
  return mode;
}

function apply(mode){
  document.documentElement.dataset.theme = resolve(mode);
}

// Wired to the CSS :root[data-theme="dark"] block in tokens.css. Applies
// synchronously outside React (no flash) — call once near the app root.
export function useTheme(){
  const [theme,setThemeState]=useState(()=>LS.get(KEY,"system"));

  useEffect(()=>{
    apply(theme);
    if(theme!=="system") return;
    const mq=window.matchMedia(MQ);
    const onChange=()=>apply("system");
    mq.addEventListener("change",onChange);
    return ()=>mq.removeEventListener("change",onChange);
  },[theme]);

  const setTheme=useCallback((mode)=>{
    LS.set(KEY,mode);
    setThemeState(mode);
  },[]);

  return {theme,setTheme};
}
