import { BrandLogo } from "@tournament/ui";

export default function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="auth-wrap">
      <div className="auth-panel">
        <BrandLogo variant="horizontal" tone="color" className="auth-logo" />
        <h1>{title}</h1>
        <div className="tape" />
        {subtitle ? <p className="muted">{subtitle}</p> : null}
        {children}
      </div>
    </div>
  );
}
