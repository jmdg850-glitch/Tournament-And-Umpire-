import { BrandLogo } from "@tournament/ui";

/** The sidebar brand mark, shared by the dashboard shell and the tournament-desk
 * shell so the two never drift out of sync with each other. The rail is dark
 * navy, so it carries the white RESETIQ logo. */
export default function AppBrand() {
  return (
    <>
      <h1><BrandLogo variant="horizontal" tone="white" /></h1>
      <div className="kicker">Control</div>
    </>
  );
}
