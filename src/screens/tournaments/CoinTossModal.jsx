import { useState } from "react";
import { motion } from "framer-motion";
import { Modal } from "../../components/ui/Modal.jsx";
import { D } from "../../theme/tokens.js";

// Before an umpire-controlled tournament match starts: tap Toss Coin, get a random
// HEADS or TAILS. That's the entire feature — per spec the toss never picks a team,
// never sets who serves, and is fully independent of score/standings/bracket
// advancement. Start Match stays disabled until a result exists.
export function CoinTossModal({teamALabel,teamBLabel,onStart,onToss,onClose}){
  const [flipping,setFlipping]=useState(false);
  const [result,setResult]=useState(null); // "heads" | "tails" | null

  const toss=()=>{
    if(flipping||result) return;
    setFlipping(true);
    setTimeout(()=>{
      const r=Math.random()<0.5?"heads":"tails";
      setResult(r);
      setFlipping(false);
      onToss?.(r);
    },700);
  };

  return(
    <Modal title="Coin Toss" onClose={onClose} width={360}>
      <div style={{textAlign:"center",padding:"10px 0 4px"}}>
        {(teamALabel||teamBLabel)&&
          <div style={{fontSize:12,color:D.textMuted,marginBottom:14}}>{teamALabel} vs {teamBLabel}</div>}
        <motion.div
          animate={flipping?{rotateY:[0,180,360,540,720]}:{rotateY:0}}
          transition={{duration:0.7,ease:"easeInOut"}}
          style={{width:80,height:80,borderRadius:"50%",background:D.accent,margin:"0 auto 20px",
            display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,fontWeight:900,color:"#fff"}}>
          {result?result==="heads"?"H":"T":"?"}
        </motion.div>

        {!result&&(
          <button onClick={toss} disabled={flipping}
            style={{padding:"12px 28px",background:D.accentBg,border:"1px solid "+D.accent,borderRadius:20,color:D.accent,fontWeight:700,fontSize:14,cursor:flipping?"default":"pointer",opacity:flipping?0.6:1}}>
            Toss Coin
          </button>
        )}

        {result&&(
          <>
            <div style={{fontSize:18,fontWeight:900,color:D.textPrimary,marginBottom:20,letterSpacing:"1px"}}>{result.toUpperCase()}</div>
            <button onClick={()=>onStart()}
              style={{width:"100%",padding:13,background:D.accent,border:"none",borderRadius:22,color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer"}}>
              Start Match
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
