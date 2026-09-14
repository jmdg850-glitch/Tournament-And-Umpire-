/** The sidebar brand mark, shared by the dashboard shell and the tournament-desk
 * shell so the two never drift out of sync with each other. */
export default function AppBrand() {
  return (
    <>
      <h1>Tournament</h1>
      <div className="kicker">Control</div>
    </>
  );
}
