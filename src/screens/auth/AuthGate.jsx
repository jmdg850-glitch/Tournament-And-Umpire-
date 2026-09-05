import { LoginScreen } from "./LoginScreen.jsx";
import { SignUpScreen } from "./SignUpScreen.jsx";

// =
// AUTH GATE — Login & Sign Up screens
// =
export function AuthGate({authScreen,setAuthScreen,onSignUp,onLogIn,onForgotPassword}){
  if(authScreen==="signup")   return <SignUpScreen onSignUp={onSignUp} onGoLogin={()=>setAuthScreen("login")}/>;
  return <LoginScreen onLogIn={onLogIn} onForgotPassword={onForgotPassword} onGoSignUp={()=>setAuthScreen("signup")}/>;
}
