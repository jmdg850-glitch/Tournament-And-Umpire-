import { Component } from "react";
import { Log } from "../../lib/log.js";
import { D } from "../../theme/tokens.js";
import { Btn } from "./Btn.jsx";

// React error boundaries must be class components — there is no hook
// equivalent (getDerivedStateFromError/componentDidCatch have no useX form).
// Only renders the fallback on an actual crash in its subtree; the working
// path is a plain passthrough, so this changes nothing visually until that
// happens.
export class ErrorBoundary extends Component{
  constructor(props){
    super(props);
    this.state={hasError:false};
  }

  static getDerivedStateFromError(){
    return {hasError:true};
  }

  componentDidCatch(error,info){
    Log.error("error","Caught by ErrorBoundary: "+(error?.message||error),
      {stack:error?.stack?String(error.stack).slice(0,800):undefined,componentStack:info?.componentStack?.slice(0,800)});
  }

  render(){
    if(!this.state.hasError) return this.props.children;
    return(
      <div style={{padding:"40px 20px",textAlign:"center"}}>
        <div style={{fontSize:32,marginBottom:10}}>⚠️</div>
        <div style={{fontWeight:700,color:D.textPrimary,marginBottom:6}}>Something went wrong in this view</div>
        <div style={{fontSize:12,color:D.textMuted,marginBottom:16}}>The error has been logged. Reloading this view usually fixes it.</div>
        <Btn label="Reload" onClick={()=>this.setState({hasError:false})}/>
      </div>
    );
  }
}
