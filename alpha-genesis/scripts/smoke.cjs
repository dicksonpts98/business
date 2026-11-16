// Browser smoke check: loads every dashboard screen against a running server, fails on console errors or
// empty screens, and saves screenshots. Usage: node scripts/smoke.cjs [baseUrl] [outDir]
const { chromium } = require("playwright");
const { mkdirSync } = require("node:fs");
(async () => {
const base = process.argv[2] || "http://127.0.0.1:8000";
const out = process.argv[3] || "artifacts";
mkdirSync(out, { recursive: true });
const screens = ["command", "radar", "twins", "traps", "darwin", "arena", "skeptic", "paper", "learning", "settings"];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: Number(process.env.DSF || 1) });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(`${page.url()}: ${m.text()}`));
page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
let failed = false;
for (const s of screens) {
  await page.goto(`${base}/#/${s}`);
  await page.reload();
  await page.waitForSelector("section", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const panels = await page.locator("section").count();
  const text = await page.locator("main").innerText();
  const bad = panels < 2 || /Backend unreachable|NaN|undefined/.test(text);
  if (bad) failed = true;
  console.log(`${bad ? "FAIL" : "ok  "} ${s.padEnd(9)} panels=${panels} chars=${text.length}`);
  await page.screenshot({ path: `${out}/${s}.png`, fullPage: true });
}
await browser.close();
if (errors.length) { console.log("console errors:\n" + errors.slice(0, 20).join("\n")); failed = true; }
process.exit(failed ? 1 : 0);
})();
