import { useReducer } from "react";

// =
// GLOBAL SWIPE NAVIGATION — a small custom in-app history stack (NOT react-router; screen
// switching here is plain useState, not routes, so a full router migration would touch nearly
// every component for a capability — deep-linking — nobody asked for). Two lightweight layers:
//   1. Screen history stack (this hook) — the sequence of visited top-level `screen` values.
//   2. Local drill-down handlers (BackHandlerContext below) — a component with its own internal
//      sub-view (e.g. an open event/club/settings-sub-panel) can register a "handle my own back
//      step first" function, checked before the screen stack ever moves.
// =
export function historyReducer(state, action){
  switch(action.type){
    case "PUSH": {
      if(state.stack[state.index]===action.screen) return state; // no-op re-navigating to the same screen
      const trimmed = state.stack.slice(0, state.index+1); // drop any stale "forward" branch
      return { stack:[...trimmed, action.screen], index: trimmed.length };
    }
    case "BACK":    return state.index>0 ? {...state, index:state.index-1} : state;
    case "FORWARD": return state.index<state.stack.length-1 ? {...state, index:state.index+1} : state;
    default: return state;
  }
}
export function useAppHistory(getInitialScreen){
  // Lazy init (third useReducer arg) so a localStorage read only ever happens once, on mount —
  // matching the lazy useState(()=>LS.get(...)) convention used for every other persisted value
  // in this file — instead of re-running on every render.
  const [state, dispatch] = useReducer(historyReducer, getInitialScreen, (get)=>({stack:[typeof get==="function"?get():get], index:0}));
  return {
    current: state.stack[state.index],
    canGoBack: state.index>0,
    canGoForward: state.index<state.stack.length-1,
    push: (s)=>dispatch({type:"PUSH",screen:s}),
    back: ()=>dispatch({type:"BACK"}),
    forward: ()=>dispatch({type:"FORWARD"}),
  };
}
