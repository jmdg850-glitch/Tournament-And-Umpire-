import { chromium } from "playwright";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const context = browser.contexts()[0];
const page = context.pages()[0];
if (!page) {
  console.error("no page");
  process.exit(1);
}
await page.waitForLoadState("domcontentloaded");
const title = await page.title();
const body = await page.locator("body").innerText();
console.log("title", title);
console.log("body_start", body.slice(0, 400).replaceAll("\n", " | "));
const email = page.getByLabel("Email");
if (await email.count()) {
  await email.fill("organizer.dev@tournament.local");
  await page.getByLabel("Password").fill("dev-organizer-pass");
  await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
  await page.waitForTimeout(4000);
  const after = await page.locator("body").innerText();
  console.log("after_start", after.slice(0, 500).replaceAll("\n", " | "));
  const dash = after.includes("Dashboard") || after.includes("OPERATOR DESK") || after.includes("Active tournaments");
  console.log("dashboard", dash);
}
await browser.close();
