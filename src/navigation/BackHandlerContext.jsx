import { createContext, useContext, useEffect } from "react";

// Lets a mounted screen/panel register "I have my own internal Back step" — e.g. ClubsScreen
// closing an open club dashboard, CalendarScreen closing an event detail, SettingsScreen closing
// a sub-panel. The handler is the EXACT same setter/callback the component's own visible
// Close/Back button already calls, so gesture-back and the on-screen button are provably
// identical — never two parallel implementations of "what does Back mean here."
export const BackHandlerContext = createContext(null);
export function useRegisterBackHandler(handler, active=true){
  const ctx = useContext(BackHandlerContext);
  useEffect(()=>{
    if(!active || !handler || !ctx) return;
    return ctx.register(handler);
  },[handler,active,ctx]);
}
