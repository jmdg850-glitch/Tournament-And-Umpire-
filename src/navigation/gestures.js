// Walks up from a touch's target element; true if it started inside a genuinely horizontally
// scrollable ancestor (e.g. the "My Clubs" card strip) — those keep working as horizontal
// scrollers, never triggering screen navigation.
export function isInsideHorizontalScroller(node){
  let el = node;
  let hops = 0;
  while(el && el!==document.body && hops<40){
    try{
      const cs = window.getComputedStyle(el);
      if((cs.overflowX==="auto"||cs.overflowX==="scroll") && el.scrollWidth>el.clientWidth+1) return true;
    }catch{ /* ignore */ }
    el = el.parentElement;
    hops++;
  }
  return false;
}
