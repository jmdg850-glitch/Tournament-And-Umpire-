import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";

// Wires the Android hardware/gesture Back button into the exact same
// gestureBack() chain the swipe-back gesture already uses (deepest local
// drill-down handler -> close panel -> screen history), so there is exactly
// one definition of "what Back means here" across touch and hardware input.
// Without this, Capacitor's default behavior with no 'backButton' listener is
// to exit/background the app immediately, bypassing all in-app navigation.
//
// `canGoBack()` must report whether gestureBack() has anything to do (a
// registered drill-down handler, an open panel, or screen history to pop).
// When it doesn't, we exit the app — matching standard Android back-button
// semantics at the root of a bottom-tab app.
export function useAndroidBackButton(gestureBack, canGoBack){
  useEffect(()=>{
    if(!Capacitor.isNativePlatform()) return;
    const handle = CapacitorApp.addListener("backButton", ()=>{
      if(canGoBack()) gestureBack();
      else CapacitorApp.exitApp();
    });
    return ()=>{ handle.then(h=>h.remove()).catch(()=>{}); };
  },[gestureBack,canGoBack]);
}
