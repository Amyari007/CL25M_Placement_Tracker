/**
 * Browser end-to-end test of the hosted build against the local mock
 * platform (real migrations + real edge-function handlers).
 *
 *   npx vite-node tests/e2e/run.ts -- <path to web build dir>
 *
 * Prints PASS/FAIL per check and exits non-zero on any failure.
 */
import http from 'node:http';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Page, BrowserContext } from 'playwright';
// Playwright is pre-installed globally (NODE_PATH), not a project dependency.
const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
import ExcelJS from 'exceljs';
import { startMock } from './mock-supabase';

const DIST = process.argv[process.argv.length - 1];
const OUT = path.resolve(process.env.E2E_OUT ?? '/tmp/e2e-shots');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const API_PORT = 54321;
const WEB_PORT = 4173;
const ADMIN = { email: 'admin@example.org', password: 'Admin-Pass-For-Tests-1' };
const COORD = 'coord.one@example.org';
const COORD_PW = 'Vellore-Chennai-Trivandrum-26';
const PIN = '480913';

const results: { name: string; ok: boolean; info?: string }[] = [];
function check(name: string, ok: boolean, info?: string) {
  results.push({ name, ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mock = await startMock({ port: API_PORT, adminEmail: ADMIN.email, adminPassword: ADMIN.password });
const html = readFileSync(path.join(DIST, 'index.html'));
// Serve with the same security headers the live site gets (scripts/security-headers.mjs).
// @ts-expect-error plain .mjs helper
const { headersFile } = await import('../../scripts/security-headers.mjs');
const secHeaders = Object.fromEntries(
  (headersFile(html.toString('utf8'), `http://127.0.0.1:${API_PORT}`) as string)
    .split('\n').slice(1).map((l) => l.trim()).filter(Boolean).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()])
    .filter(([k]) => k !== 'Strict-Transport-Security'),
);
const web = http.createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html', ...secHeaders }).end(html));
await new Promise<void>((r) => web.listen(WEB_PORT, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${WEB_PORT}/`;

const browser = await chromium.launch();
console.log('serving with CSP:', String(secHeaders['Content-Security-Policy']).slice(0, 90) + '…');
const pageErrors: string[] = [];
async function newPage(ctx: BrowserContext) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => pageErrors.push(e.message));
  if (process.env.E2E_DEBUG) p.on('response', async (r) => r.url().includes('/functions/') && console.log('  [net]', r.status(), r.url(), r.status() >= 500 ? await r.text().catch(() => '') : ''));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|realtime|Failed to load resource/.test(m.text())) pageErrors.push(m.text());
    if (/Content Security Policy|Refused to/.test(m.text())) pageErrors.push('CSP: ' + m.text());
  });
  return p;
}
const text = (p: Page) => p.evaluate(() => document.body.innerText);
async function clickText(p: Page, label: string, exact = true) {
  const btn = p.getByRole('button', { name: label, exact });
  const target = (await btn.count()) ? btn : p.getByRole('menuitem', { name: label, exact });
  await target.first().click({ timeout: 10_000 });
  await sleep(350);
}
async function studentSignIn(p: Page, roll: string, code: string, name?: string) {
  await p.goto(BASE + '#/login');
  await p.fill('input[autocomplete=username]', roll);
  await p.fill('input[type=password]', code);
  await clickText(p, 'Sign in');
  await sleep(800);
  if (name) {
    await p.fill('input[autocomplete=name]', name);
    await clickText(p, 'Save and continue');
    await sleep(800);
  }
}
async function addAndSubmit(p: Page, companies: string[]) {
  for (const c of companies) {
    await p.fill('#add-company', c);
    await p.keyboard.press('Enter');
    await sleep(200);
  }
  await clickText(p, 'Submit Applications');
  await sleep(1000);
}
async function staffSignIn(p: Page, email: string, password: string) {
  await p.goto(BASE + '#/admin/login');
  await sleep(300);
  await p.fill('input[type=email]', email);
  await p.fill('input[type=password]', password);
  await clickText(p, 'Sign in');
  await sleep(1200);
}

try {
  /* ---------------------------------------------------------- students */
  const sctx = await browser.newContext();
  const sp = await newPage(sctx);
  await studentSignIn(sp, 'CL25M002', '4176', 'Student Two');
  await addAndSubmit(sp, ['Commotion', 'Philips']);
  check('student can sign in, onboard and submit', /Commotion/.test(await text(sp)) && /How many students applied/i.test(await text(sp)));
  await sp.getByRole('button', { name: 'Account menu' }).click();
  await clickText(sp, 'Sign out');
  await studentSignIn(sp, 'CL25M003', '4328', 'Student Three');
  await addAndSubmit(sp, ['COMMOTION Pvt Ltd', 'GE Healthcare']);
  const st = await text(sp);
  check('student pie counts distinct students across spellings', /Commotion[\s\S]{0,80}2/.test(st));
  await sp.screenshot({ path: `${OUT}/01-student.png`, fullPage: true });
  await sctx.close();

  /* ---------------------------------------------------------- admin */
  const actx = await browser.newContext({ acceptDownloads: true });
  const ap = await newPage(actx);
  await staffSignIn(ap, ADMIN.email, 'wrong-password');
  check('wrong admin password gives the generic message', /Incorrect email or password/.test(await text(ap)));
  await staffSignIn(ap, ADMIN.email, ADMIN.password);
  check('admin signs in through staff-login', /Overview|Students/.test(await text(ap)) && (await ap.evaluate(() => location.hash)).startsWith('#/admin'));
  await sleep(800);
  check('admin sees student names', /Student Two/.test(await text(ap)));
  const dlWait = ap.waitForEvent('download', { timeout: 15_000 });
  await clickText(ap, 'Export data', false);
  const dl = await dlWait.catch(async (e) => {
    console.log('export page text:', (await text(ap)).slice(0, 400));
    throw e;
  });
  const xl = new ExcelJS.Workbook();
  await xl.xlsx.readFile(await dl.path());
  check('admin export still works (3 sheets)', xl.worksheets.length === 3, xl.worksheets.map((w) => w.name).join(', '));

  await ap.goto(BASE + '#/admin/security');
  await sleep(800);
  await clickText(ap, 'Add coordinator');
  await ap.fill('[role=dialog] input[type=email]', COORD);
  await clickText(ap, 'Issue login');
  await sleep(800);
  const temp = (await ap.locator('[role=dialog] .font-mono').textContent())?.trim() ?? '';
  check('admin issues a coordinator login with a one-time password', /^[A-Za-z0-9]{18}$/.test(temp));
  await clickText(ap, 'Done');
  await clickText(ap, 'Companies');
  await ap.fill('[role=dialog] textarea', 'Commotion');
  await clickText(ap, 'Save');
  await sleep(600);
  check('admin assigns a company', /Companies: Commotion/.test(await text(ap)));
  await ap.screenshot({ path: `${OUT}/02-admin-security.png`, fullPage: true });

  /* ---------------------------------------------------------- coordinator, first computer */
  const c1 = await browser.newContext({ acceptDownloads: true });
  const cp = await newPage(c1);
  await staffSignIn(cp, COORD, temp);
  check('coordinator lands on step 1 (choose a 6-digit PIN)', /Choose a 6-digit PIN/.test(await text(cp)));
  check('coordinator sees no data before onboarding', !/CL25M00|Student Two|Student Three/.test(await text(cp)));
  await cp.fill('input[inputmode=numeric] >> nth=0', '111111');
  await cp.fill('input[inputmode=numeric] >> nth=1', '111111');
  await clickText(cp, 'Save PIN');
  await sleep(800);
  check('a simple PIN is refused', /not a simple pattern/.test(await text(cp)));
  await cp.fill('input[inputmode=numeric] >> nth=0', PIN);
  await cp.fill('input[inputmode=numeric] >> nth=1', PIN);
  await clickText(cp, 'Save PIN');
  await sleep(1500);
  check('after the PIN: step 2 asks for an own password', /Choose your own password/.test(await text(cp)));
  await cp.fill('input[autocomplete=new-password] >> nth=0', 'short');
  await cp.fill('input[autocomplete=new-password] >> nth=1', 'short');
  await clickText(cp, 'Save password');
  check('short password refused', /at least 12/.test(await text(cp)));
  await cp.fill('input[autocomplete=new-password] >> nth=0', COORD_PW);
  await cp.fill('input[autocomplete=new-password] >> nth=1', COORD_PW);
  await clickText(cp, 'Save password');
  await sleep(1200);
  check('step 3 asks to register this computer', /Register this computer/.test(await text(cp)));
  await clickText(cp, 'Register this computer');
  await sleep(2000);
  const dash = await text(cp);
  check('coordinator dashboard loads after registration', /Your companies/.test(dash) && /Commotion/.test(dash));
  check('dashboard shows no names or roll numbers', !/Student Two|Student Three|CL25M0/.test(dash));
  await cp.screenshot({ path: `${OUT}/03-coordinator-dashboard.png`, fullPage: true });
  await clickText(cp, 'Applicants');
  await sleep(1000);
  const sheet = await cp.locator('[role=dialog]').innerText();
  check('applicant list shows roll numbers only', /CL25M002/.test(sheet) && /CL25M003/.test(sheet) && !/Student Two|Student Three/.test(sheet));
  await cp.screenshot({ path: `${OUT}/04-coordinator-applicants.png` });
  const [cdl] = await Promise.all([cp.waitForEvent('download'), clickText(cp, 'Export .xlsx')]);
  const cx = new ExcelJS.Workbook();
  await cx.xlsx.readFile(await cdl.path());
  const cells: string[] = [];
  cx.worksheets[0].eachRow((r) => r.eachCell((c) => cells.push(String(c.value))));
  check('company export: one sheet, roll numbers, no names', cx.worksheets.length === 1 && cells.includes('CL25M002') && !cells.join(' ').match(/Student Two|Student Three/), cdl.suggestedFilename());
  await clickText(cp, 'Close');
  await clickText(cp, 'Outreach');
  await cp.selectOption('[role=dialog] select >> nth=0', 'contacted');
  await cp.fill('[role=dialog] input[maxlength="300"]', 'Confirm test slot');
  await clickText(cp, 'Save');
  await sleep(1000);
  check('coordinator saves outreach', /Contacted/.test(await text(cp)) && /Confirm test slot/.test(await text(cp)));

  await cp.locator('table[aria-label="Students per company"] button', { hasText: 'Commotion' }).click();
  await sleep(1000);
  const viaPie = await cp.locator('[role=dialog]').innerText();
  check('clicking a company in the chart lists its roll numbers', /CL25M002/.test(viaPie) && /CL25M003/.test(viaPie) && !/Student Two|Student Three/.test(viaPie));
  await clickText(cp, 'Close');
  await cp.locator('table[aria-label="Students per company"] button', { hasText: 'Philips' }).click();
  await sleep(1000);
  check('an unassigned company says it is not assigned', /not assigned to you/.test(await cp.locator('[role=dialog]').innerText()));
  await clickText(cp, 'Close');

  /* ---------------------------------------------------------- second computer (fresh browser storage) */
  const c2 = await browser.newContext();
  const cp2 = await newPage(c2);
  await staffSignIn(cp2, COORD, COORD_PW);
  check('second sign-in asks for the PIN', /Enter your PIN/.test(await text(cp2)));
  if (/Enter your PIN/.test(await text(cp2))) {
    await cp2.fill('input[inputmode=numeric]', PIN);
    await clickText(cp2, 'Continue');
    await sleep(1500);
  }
  const t2 = await text(cp2);
  check('another browser with the right password + PIN is refused', /not the registered device/.test(t2) && !/CL25M0|Commotion/.test(t2));
  await cp2.screenshot({ path: `${OUT}/05-unregistered-browser.png`, fullPage: true });
  // direct API call from that browser with its valid token, without a device signature
  const direct = await cp2.evaluate(async () => {
    const s = JSON.parse(localStorage.getItem('cl25m-auth') ?? '{}');
    const r = await fetch('http://127.0.0.1:54321/functions/v1/coordinator-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.access_token}` },
      body: JSON.stringify({ action: 'applicants', payload: JSON.stringify({ company: 'Commotion' }) }),
    });
    return { status: r.status, body: await r.text() };
  });
  check('direct API request from the unregistered browser is refused', direct.status === 403 && !/CL25M0/.test(direct.body), String(direct.status));
  const directDb = await cp2.evaluate(async () => {
    const s = JSON.parse(localStorage.getItem('cl25m-auth') ?? '{}');
    const h = { Authorization: `Bearer ${s.access_token}`, apikey: 'x' };
    const a = await (await fetch('http://127.0.0.1:54321/rest/v1/applications?select=*', { headers: h })).json();
    const b = await (await fetch('http://127.0.0.1:54321/rest/v1/students?select=id,roll_number', { headers: h })).json();
    const c = await fetch('http://127.0.0.1:54321/rest/v1/rpc/admin_student_names', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' });
    return { a: a.length, b: b.length, c: c.status };
  });
  check('coordinator token reads nothing directly from the database', directDb.a === 0 && directDb.b === 0 && directDb.c === 403, JSON.stringify(directDb));

  /* ---------------------------------------------------------- admin sees alerts, approves replacement */
  await clickText(ap, 'Refresh');
  await sleep(1200);
  const sec = await text(ap);
  check('admin sees an "Unregistered browser" alert', /Unregistered browser/.test(sec));
  check('activity log shows the export and list view', /Exported applicant list/.test(sec) && /Viewed applicant list/.test(sec));
  await ap.screenshot({ path: `${OUT}/06-admin-alerts.png`, fullPage: true });
  await clickText(ap, 'New computer');
  await clickText(ap, 'Approve replacement');
  await sleep(800);
  check('replacement approval recorded', /replacement approved, waiting/.test(await text(ap)));

  // first computer stops working
  await cp.reload();
  await sleep(1500);
  check('old computer is signed out after the replacement approval', /Placement coordination|Sign in/.test(await text(cp)) && !/Your companies/.test(await text(cp)));

  // second computer: its old sign-in was ended too; it signs in again and registers
  await cp2.reload();
  await sleep(1500);
  await staffSignIn(cp2, COORD, COORD_PW);
  if (/Enter your PIN/.test(await text(cp2))) {
    await cp2.fill('input[inputmode=numeric]', PIN);
    await clickText(cp2, 'Continue');
    await sleep(1500);
  }
  check('approved new computer may register', /Register this computer/.test(await text(cp2)));
  await clickText(cp2, 'Register this computer');
  await sleep(2000);
  check('new computer reaches the dashboard', /Your companies/.test(await text(cp2)));

  /* ---------------------------------------------------------- suspension */
  await clickText(ap, 'Refresh');
  await sleep(1000);
  await clickText(ap, 'Suspend');
  await ap.locator('[role=alertdialog] button', { hasText: 'Suspend' }).click();
  await sleep(1000);
  check('admin sees the coordinator as suspended', /Suspended/i.test(await text(ap)));
  await cp2.reload();
  await sleep(1500);
  check('suspended coordinator gets no data', !/Your companies/.test(await text(cp2)));
  await ap.screenshot({ path: `${OUT}/07-admin-suspended.png`, fullPage: true });

  /* ---------------------------------------------------------- server-side evidence */
  const ev = await mock.owner<{ event_type: string; outcome: string }>(`select event_type, outcome from private.audit_events order by id`);
  const has = (t: string, o: string) => ev.some((e) => e.event_type === t && e.outcome === o);
  check('audit: staff sign-in success and failure', has('auth.login', 'success') && has('auth.login', 'failure'));
  check('audit: coordinator view/export success', has('coord.applicants', 'success') && has('coord.export', 'success'));
  check('audit: unregistered device denied', has('device.unrecognized', 'denied'));
  check('audit: admin export and security actions', has('admin.export', 'success') && has('admin.device_replacement_approved', 'success') && has('admin.coordinator_suspended', 'success'));
} catch (e) {
  check('scenario ran to completion', false, (e as Error).message.split('\n')[0]);
  for (const ctx of browser.contexts()) for (const pg of ctx.pages()) console.log('--- page', pg.url(), '\n', (await text(pg).catch(() => '')).slice(0, 1200));
}

check('no unexpected browser errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
await mock.close();
web.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
