export default function AppShell({ navLabel = "Sections", nav, railFoot, children, overlay }) {
  return (
    <div className="app-shell">
      <div className="app-body">
        <aside className="rail">
          <h1>Tournament</h1>
          <div className="eyebrow">Control</div>
          <nav className="rail-nav" aria-label={navLabel}>
            {nav}
          </nav>
          <div className="rail-foot">{railFoot}</div>
        </aside>
        <main className="main">{children}</main>
      </div>
      {overlay}
    </div>
  );
}
