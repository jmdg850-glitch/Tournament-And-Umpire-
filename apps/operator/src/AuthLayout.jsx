export default function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="auth-wrap">
      <div className="auth-panel">
        <div className="kicker">Tournament</div>
        <h1>{title}</h1>
        <div className="tape" />
        {subtitle ? <p className="muted">{subtitle}</p> : null}
        {children}
      </div>
    </div>
  );
}
