/**
 * Browser smoke check.
 *
 * This exists because a build that compiles is not evidence that an application
 * runs. It drives a real Chromium against the real API and the real database,
 * asserts that the 3D canvas actually acquires a WebGL context, walks the parity
 * views, and fails on any console error or unhandled rejection.
 *
 * Usage: node scripts/smoke.mjs [baseUrl]
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5173';
const outDir = process.env.SMOKE_OUT ?? 'artifacts/smoke';
mkdirSync(outDir, { recursive: true });

const failures = [];
const consoleErrors = [];

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`);
    failures.push(name);
  }
}

/**
 * Resolve the pre-installed Chromium.
 *
 * Playwright's own lookup expects the browser revision that matches its
 * version, which need not be the revision this image ships. Rather than pin a
 * revision number that will rot, discover the executable under
 * PLAYWRIGHT_BROWSERS_PATH and fall back to Playwright's resolution.
 */
function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  const candidates = readdirSync(root)
    .filter((entry) => entry.startsWith('chromium'))
    // Prefer a full chrome build over the headless shell.
    .sort((a, b) => (a.includes('headless') ? 1 : 0) - (b.includes('headless') ? 1 : 0))
    .flatMap((entry) => [
      join(root, entry, 'chrome-linux', 'chrome'),
      join(root, entry, 'chrome-linux', 'headless_shell'),
    ]);
  return candidates.find((path) => existsSync(path));
}

const executablePath = findChromium();
console.log(`Chromium: ${executablePath ?? "Playwright's own resolution"}`);

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  // SwiftShader gives a real software WebGL context, so the canvas assertions
  // below test the actual renderer rather than a stub.
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

const failedRequests = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
page.on('response', (response) => {
  if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
});

console.log(`\nSupplyQuest HQ smoke check against ${baseUrl}\n`);

await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.topbar', { timeout: 20_000 });

/* --- honest mode reporting ------------------------------------------------ */
const modeBadge = await page.locator('.mode-badge').first().textContent();
check('mode badge states the execution mode plainly',
  modeBadge !== null && /DEMO DATA|LIVE/.test(modeBadge), `saw ${JSON.stringify(modeBadge)}`);

await page.waitForSelector('.conn-live, .conn-reconnecting', { timeout: 20_000 });
check('event stream connects', await page.locator('.conn-live').count() > 0);

/* --- the 3D office really is WebGL --------------------------------------- */
await page.waitForSelector('.office-wrap canvas', { timeout: 30_000 });
const gl = await page.evaluate(() => {
  const canvas = document.querySelector('.office-wrap canvas');
  if (canvas === null) return { ok: false, reason: 'no canvas' };
  const context =
    canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false })
    ?? canvas.getContext('webgl');
  if (context === null) return { ok: false, reason: 'no webgl context on the canvas' };
  return {
    ok: true,
    width: canvas.width,
    height: canvas.height,
    renderer: context.getParameter(context.VERSION),
    drawingBufferWidth: context.drawingBufferWidth,
  };
});
check('the office canvas holds a live WebGL context', gl.ok === true, gl.reason ?? '');
check('the canvas has a real drawing buffer',
  (gl.drawingBufferWidth ?? 0) > 100, `drawingBufferWidth=${gl.drawingBufferWidth}`);

/*
 * Confirm the office is genuinely painted.
 *
 * Reading the WebGL canvas back from inside the page is unreliable: the drawing
 * buffer is swapped after each frame, and even with preserveDrawingBuffer the
 * result varies by driver. So instead we screenshot the canvas element through
 * the browser's compositor — which is exactly what a person would see — and
 * analyse those pixels. This needs no test-only flag in production code.
 */
async function sampleRenderedCanvas() {
  const shot = await page.locator('.office-wrap canvas').screenshot();
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const off = new OffscreenCanvas(image.width, image.height);
    const ctx = off.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, off.width, off.height);
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4 * 53) {
      // Quantise so anti-aliasing noise does not inflate the count.
      seen.add(`${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`);
    }
    return seen.size;
  }, shot.toString('base64'));
}

let painted = 0;
const paintDeadline = Date.now() + 25_000;
while (Date.now() < paintDeadline) {
  painted = await sampleRenderedCanvas();
  if (painted > 12) break;
  await page.waitForTimeout(600);
}
check('the office renders a real scene, not a flat fill', painted > 12,
  `${painted} distinct quantised colours in the composited canvas`);

// Unselected agents carry a compact chip; the full nameplate is reserved for
// the selected or hovered agent so labels cannot bury the office.
const nameplates = await page.locator('.name-chip').count();
check('every agent carries an identifying chip in the scene', nameplates > 0, `${nameplates} found`);
check('no full nameplate is shown until an agent is selected or hovered',
  await page.locator('.nameplate').count() === 0);
const roomSigns = await page.locator('.room-sign').count();
check('all eleven office zones are signed', roomSigns === 11, `${roomSigns} found`);

await page.screenshot({ path: `${outDir}/01-office.png` });

/* --- the keyboard roster mirrors the scene -------------------------------- */
const rosterButtons = await page.locator('.office-roster li button').count();
check('keyboard-reachable agent roster mirrors the scene',
  rosterButtons === nameplates, `${rosterButtons} roster vs ${nameplates} scene chips`);

/* --- clicking an agent opens the inspector ------------------------------- */
await page.locator('.office-roster li button').first().click();
await page.waitForSelector('.inspector-head h2', { timeout: 10_000 });
const inspected = await page.locator('.inspector-head h2').textContent();
check('selecting an agent opens its inspector', (inspected ?? '').length > 0, `saw ${JSON.stringify(inspected)}`);
check('the inspector states the role authority limits',
  (await page.getByText('Authority limits').count()) > 0);
await page.screenshot({ path: `${outDir}/02-inspector.png` });

/* --- parity views -------------------------------------------------------- */
await page.getByRole('button', { name: /^2\s*Table$/ }).click().catch(async () => {
  await page.locator('.nav-views button', { hasText: 'Table' }).click();
});
await page.waitForSelector('.data-table tbody tr', { timeout: 10_000 });
const tableRows = await page.locator('.data-table tbody tr').count();
check('the table view lists tasks', tableRows > 0, `${tableRows} rows`);
await page.screenshot({ path: `${outDir}/03-table.png` });

await page.locator('.nav-views button', { hasText: 'Board' }).click();
await page.waitForSelector('.kanban-column', { timeout: 10_000 });
check('the board view renders every lifecycle column',
  await page.locator('.kanban-column').count() === 6);
await page.screenshot({ path: `${outDir}/04-board.png` });

await page.locator('.nav-views button', { hasText: 'Workflow' }).click();
await page.waitForSelector('.graph-canvas', { timeout: 10_000 });
await page.getByRole('button', { name: /Load default product workflow/ }).click();
await page.getByRole('button', { name: /^Validate$/ }).click();
await page.waitForSelector('.graph-validation', { timeout: 10_000 });
const validationText = await page.locator('.graph-validation').first().textContent();
check('the default workflow validates against the server validator',
  (validationText ?? '').includes('Valid'), `saw ${JSON.stringify((validationText ?? '').slice(0, 90))}`);
const flowNodes = await page.locator('.react-flow__node').count();
check('the graph editor renders the workflow nodes', flowNodes >= 12, `${flowNodes} nodes`);
await page.screenshot({ path: `${outDir}/05-workflow.png` });

/* --- approvals: the content-bound hash is visible ------------------------ */
await page.locator('.nav-views button', { hasText: 'Approvals' }).click();
await page.waitForSelector('.approval', { timeout: 10_000 });
check('a pending approval is shown', await page.locator('.approval').count() > 0);
check('the approval shows its content hash',
  (await page.locator('.approval-facts').first().textContent() ?? '').includes('Content hash'));
check('the approval names the exact amount',
  /\d+\.\d{2}\s+CAD/.test(await page.locator('.approval-facts').first().textContent() ?? ''));
await page.screenshot({ path: `${outDir}/06-approvals.png` });

/* --- evidence labelling -------------------------------------------------- */
await page.locator('.nav-zones button', { hasText: 'Research studio' }).click();
await page.waitForSelector('.evidence-item', { timeout: 10_000 });
const labels = await page.locator('.evidence-item .label').allTextContents();
check('owner-supplied URLs are labelled UNVERIFIED_LEAD, not observations',
  labels.includes('UNVERIFIED_LEAD'), `labels: ${[...new Set(labels)].join(', ')}`);
check('synthetic demo findings are labelled as such',
  labels.includes('SYNTHETIC_DEMO'));
await page.screenshot({ path: `${outDir}/07-evidence.png` });

/* --- finance honesty ----------------------------------------------------- */
await page.locator('.nav-zones button', { hasText: 'Finance room' }).click();
await page.waitForSelector('.scenario', { timeout: 10_000 });
const financeText = await page.locator('.view-dashboard').textContent() ?? '';
check('finance states that contribution is not net profit',
  financeText.includes('not net profit'));
check('the unconfirmed duty classification surfaces as a diagnostic',
  /HS_CODE_UNCONFIRMED|DUTY/.test(financeText));
check('a downside scenario is present beside the base case',
  financeText.includes('downside'));
await page.screenshot({ path: `${outDir}/08-finance.png` });

/* --- compliance never claims approval ------------------------------------ */
await page.locator('.nav-zones button', { hasText: 'Compliance library' }).click();
await page.waitForSelector('.notice-warn', { timeout: 10_000 });
const complianceText = await page.locator('.view-dashboard').textContent() ?? '';
check('compliance states it is not legal advice',
  complianceText.includes('not legal advice'));
check('compliance never displays an AI legal approval',
  !/legally approved|AI approved/i.test(complianceText));
await page.screenshot({ path: `${outDir}/09-compliance.png` });

/* --- refresh preserves state and does not duplicate history -------------- */
await page.locator('.nav-views button', { hasText: 'Table' }).click();
await page.waitForSelector('.data-table tbody tr');
const beforeReload = await page.locator('.timeline-item').count();
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conn-live', { timeout: 20_000 });
await page.waitForTimeout(1500);
const afterReload = await page.locator('.timeline-item').count();
check('a refresh rebuilds the timeline rather than losing it', afterReload > 0, `${afterReload} items`);
check('a refresh does not double the visible history',
  afterReload <= beforeReload + 5,
  `before ${beforeReload}, after ${afterReload}`);

/* --- responsive at phone width ------------------------------------------- */
await page.setViewportSize({ width: 400, height: 900 });
await page.waitForTimeout(600);
const overflow = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('no horizontal overflow at 400px wide', overflow <= 1, `${overflow}px of overflow`);
await page.screenshot({ path: `${outDir}/10-mobile.png`, fullPage: false });

/* --- console hygiene ----------------------------------------------------- */
// Console error text does not carry the URL, so failed requests are tracked
// separately and asserted by URL. Nothing is excluded by pattern.
check('no failed network requests during the walkthrough', failedRequests.length === 0,
  failedRequests.slice(0, 3).join(' | '));
check('no console errors during the walkthrough', consoleErrors.length === 0,
  consoleErrors.slice(0, 3).join(' | '));

await browser.close();

console.log(`\nScreenshots written to ${outDir}/`);
if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) FAILED:`);
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
console.log('\nAll smoke checks passed.\n');
