/*
 * Verification harness for the 75 Hard Ledger.
 *
 * There is nothing to unit-test — the app is one file with no exports — so this
 * drives the real page in headless Chromium and asserts on what it actually
 * does. It serves the repo itself on an ephemeral port, because localStorage
 * and downloads behave differently over file://.
 *
 *   cd test && npm install && npx playwright install chromium && npm test
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'hard75.v1';

/* ---------- a static server, so the harness is one command ---------- */

const TYPES = { '.html': 'text/html', '.md': 'text/markdown', '.json': 'application/json' };
const server = createServer((req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel === '/' ? 'index.html' : rel);
  readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] || 'text/plain' });
    res.end(buf);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/index.html`;

/* ---------- harness ---------- */

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/* Day 1 is Mon 17 Aug 2026; the override puts us on day 16, a Tuesday, so
   "yesterday" is a normal day and the meal rotation is mid-stride. */
const BASE = {
  version: 1, setupDone: true, startDate: '2026-08-17', attempt: 1,
  history: [], days: {},
  settings: { morning: '06:00', evening: '20:00', lastBackupAt: null, dateOverride: '2026-09-01' }
};

async function fresh(browser, state = {}, opts = {}) {
  const ctx = await browser.newContext({ colorScheme: opts.colorScheme || 'light' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const seeded = JSON.stringify({ ...BASE, ...state, settings: { ...BASE.settings, ...(state.settings || {}) } });
  await page.addInitScript(([k, v, hosted]) => {
    localStorage.setItem(k, v);
    // stand in for the claude.ai artifact viewer, which declines the download
    if (hosted) {
      window.claude = { use: () => Promise.resolve({ save: () => Promise.reject({ code: 'declined' }) }) };
    }
  }, [KEY, seeded, !!opts.hosted]);
  await page.goto(URL_);
  await page.waitForSelector('#view .card');
  page.__errors = errors;
  return { ctx, page };
}

const readState = page => page.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
const isClosed = page => page.locator('#done-slot .banner.done').count().then(n => n > 0);

// Log a fully compliant day through the UI, with overrides for the rule under test.
async function logDay(page, o = {}) {
  const water = o.water ?? 8, m1 = o.min1 ?? 45, m2 = o.min2 ?? 45;
  const outdoor2 = o.outdoor2 ?? true, from = o.from ?? 100, to = o.to ?? 130;

  for (const k of ['noAlcohol', 'diet', 'noCheat', 'photo']) {
    await page.click(`[data-act="toggle"][data-k="${k}"]`);
  }
  if (water > 0) await page.click(`.drop[data-i="${water - 1}"]`);
  if (outdoor2) await page.click('[data-act="wo-out"][data-i="1"]');   // outdoors is opt-in
  await page.fill('[data-act="wo-min"][data-i="0"]', String(m1));
  await page.fill('[data-act="wo-min"][data-i="1"]', String(m2));
  await page.fill('[data-act="book"]', 'Endurance');
  await page.fill('[data-act="pfrom"]', String(from));
  await page.fill('[data-act="pto"]', String(to));
}

const browser = await chromium.launch();
const allErrors = [];

/* ---------- the seven rules actually block a day from closing ---------- */
console.log('\nRule enforcement');
{
  const cases = [
    ['closes when all seven are met', {}, true],
    ['3.5 L of water will not close the day', { water: 7 }, false],
    ['two indoor workouts will not close the day', { outdoor2: false }, false],
    ['a 44-minute second session will not close the day', { min2: 44 }, false],
    ['9 pages will not close the day', { from: 100, to: 109 }, false]
  ];
  for (const [name, o, expected] of cases) {
    const { ctx, page } = await fresh(browser);
    await logDay(page, o);
    const closed = await isClosed(page);
    check(name, closed === expected, `day closed = ${closed}, expected ${expected}`);
    allErrors.push(...page.__errors);
    await ctx.close();
  }
}

/* ---------- the fail flow archives and resets ---------- */
console.log('\nFail flow');
{
  const { ctx, page } = await fresh(browser);
  await logDay(page, { water: 5 });
  await page.click('[data-act="fail"]');
  await page.selectOption('[data-act="fail-reason"]', { label: 'Short of 4 L water' });
  await page.click('[data-act="fail-confirm"]');
  await page.waitForTimeout(200);
  const s = await readState(page);
  check('attempt increments', s.attempt === 2, `attempt = ${s.attempt}`);
  check('previous run archived', s.history.length === 1 && s.history[0].reason === 'Short of 4 L water',
    JSON.stringify(s.history).slice(0, 80));
  check('restarts at day 1 tomorrow', s.startDate === '2026-09-02', `startDate = ${s.startDate}`);
  check('undo is offered', await page.locator('[data-act="undo"]').count() > 0);

  await page.click('[data-act="undo"]');
  await page.waitForTimeout(150);
  const u = await readState(page);
  check('undo restores the attempt', u.attempt === 1 && u.startDate === '2026-08-17' && u.history.length === 0,
    `attempt ${u.attempt}, start ${u.startDate}, history ${u.history.length}`);
  allErrors.push(...page.__errors);
  await ctx.close();
}

/* ---------- export -> clear site data -> import ---------- */
console.log('\nBackup round-trip');
{
  const { ctx, page } = await fresh(browser);
  await logDay(page);
  await page.click('[data-nav="setup"]');
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('[data-act="export"]')
  ]);
  const json = readFileSync(await dl.path(), 'utf8');
  const before = await readState(page);
  await ctx.close();

  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto(URL_);                       // no seed: this is a cleared browser
  await page2.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('hard75'); });
  await page2.reload();
  await page2.waitForSelector('#view .card');
  const empty = await page2.evaluate(k => localStorage.getItem(k), KEY);
  check('site data really was cleared', empty === null || JSON.parse(empty).setupDone === false,
    String(empty).slice(0, 60));

  const tmp = join(tmpdir(), 'h75-import.json');
  writeFileSync(tmp, json);
  await page2.click('[data-nav="setup"]').catch(() => {});
  await page2.setInputFiles('input[data-act="import"]', tmp);
  await page2.waitForTimeout(300);
  const after = await readState(page2);
  const d = BASE.settings.dateOverride;
  check('import restores the day record',
    JSON.stringify(after.days[d]) === JSON.stringify(before.days[d]),
    JSON.stringify(after.days[d]));
  check('import restores start date and attempt',
    after.startDate === before.startDate && after.attempt === before.attempt);
  await ctx2.close();
}

/* ---------- the calendar file ---------- */
console.log('\nCalendar file');
{
  const { ctx, page } = await fresh(browser);
  await page.click('[data-nav="setup"]');
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('[data-act="ics"]')
  ]);
  const ics = readFileSync(await dl.path(), 'utf8');
  const daily = (ics.match(/FREQ=DAILY;COUNT=75/g) || []).length;
  check('two daily series of 75 repeats', daily === 2, `found ${daily}`);
  check('no TZID and no UTC Z on timed events — floating local time, no DST drift',
    !/TZID/.test(ics) && !/DTSTART:\d{8}T\d{6}Z/.test(ics));
  check('both cook series present',
    /BYDAY=SU;COUNT=11/.test(ics) && /BYDAY=WE;COUNT=11/.test(ics));
  check('day 75 all-day event on the right date',
    /DTSTART;VALUE=DATE:20261030/.test(ics));
  const longLines = ics.split('\r\n').filter(l => Buffer.byteLength(l) > 75);
  check('all lines folded to 75 octets (RFC 5545)', longLines.length === 0,
    `${longLines.length} over-long lines, longest ${Math.max(0, ...longLines.map(l => l.length))}`);
  // unfolding must give back exactly what was escaped, em dashes intact
  check('folded lines unfold cleanly', ics.replace(/\r\n /g, '').includes('SUMMARY:75 Hard — close the day'));
  allErrors.push(...page.__errors);
  await ctx.close();
}

/* ---------- the dark theme paints its own background ---------- */
console.log('\nDark theme');
{
  for (const [name, opts, expect] of [
    ['system dark', { colorScheme: 'dark' }, 'rgb(15, 18, 22)'],
    ['system light', { colorScheme: 'light' }, 'rgb(238, 240, 241)']
  ]) {
    const { ctx, page } = await fresh(browser, {}, opts);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check(`${name}: body paints an opaque background`, bg === expect, `got ${bg}`);
    await ctx.close();
  }
  const { ctx, page } = await fresh(browser, {}, { colorScheme: 'light' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('data-theme="dark" overrides a light system', bg === 'rgb(15, 18, 22)', `got ${bg}`);
  await ctx.close();
}

/* ---------- self-containment ---------- */
console.log('\nSelf-containment');
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const offsite = [];
  page.on('request', r => { if (new URL(r.url()).port !== String(server.address().port)) offsite.push(r.url()); });
  await page.goto(URL_);
  await page.waitForSelector('#view .card');
  await page.click('[data-act="begin"]');
  for (const nav of ['cal', 'meals', 'stats', 'setup']) {
    await page.click(`[data-nav="${nav}"]`);
    await page.waitForTimeout(80);
  }
  check('no request ever leaves the page', offsite.length === 0, offsite.join(', '));
  const src = readFileSync(join(ROOT, 'index.html'), 'utf8');
  check('no doctype, html, head or body tags', !/<!doctype|<html|<head[ >]|<body[ >]/i.test(src));
  check('no external references in the source', !/<script\s+src|<link\s|@import|https?:\/\/\S+\.(js|css|woff)/i.test(src));
  await ctx.close();
}

/* ---------- regressions ---------- */
console.log('\nRegressions');
{
  // editing yesterday must not rewrite what the app thinks the date is
  const { ctx, page } = await fresh(browser);
  await page.click('[data-nav="cal"]');
  await page.click('[data-act="day"][data-d="2026-08-31"]');
  await page.click('[data-act="edit-day"]');
  await page.waitForSelector('[data-act="back-to-today"]');
  await page.fill('[data-act="notes"]', 'back-filled yesterday');
  await page.click('.drop[data-i="3"]');
  await page.waitForTimeout(150);
  const s = await readState(page);
  check('edits land on yesterday', (s.days['2026-08-31'] || {}).notes === 'back-filled yesterday' &&
    s.days['2026-08-31'].water === 4, JSON.stringify(s.days['2026-08-31'] || {}).slice(0, 80));
  check('today is left alone', !s.days['2026-09-01'] || s.days['2026-09-01'].water === 0);
  check('the real date is never rewritten', s.settings.dateOverride === '2026-09-01',
    `dateOverride = ${s.settings.dateOverride}`);
  check('the fail button is out of reach while back-filling',
    await page.locator('[data-act="fail"]').count() === 0);

  await page.click('[data-act="back-to-today"]');
  await page.waitForSelector('[data-act="fail"]');
  check('back to today restores the normal view',
    await page.locator('[data-act="back-to-today"]').count() === 0);

  await page.click('[data-nav="cal"]');
  await page.click('[data-act="day"][data-d="2026-08-31"]');
  await page.click('[data-act="edit-day"]');
  await page.waitForSelector('[data-act="back-to-today"]');
  await page.reload();
  await page.waitForSelector('#view .card');
  check('a reload lands back on today',
    await page.locator('[data-act="back-to-today"]').count() === 0);
  await ctx.close();
}
{
  // a declined download must not silence the backup nag
  const { ctx, page } = await fresh(browser, {}, { hosted: true });
  await page.click('[data-nav="setup"]');
  await page.click('[data-act="export"]');
  await page.waitForTimeout(400);
  const s = await readState(page);
  check('a declined export does not record a backup',
    s.settings.lastBackupAt === null, `lastBackupAt = ${s.settings.lastBackupAt}`);
  await ctx.close();
}
{
  // blocked storage warns once, never a modal per keystroke
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let dialogs = 0;
  page.on('dialog', d => { dialogs++; d.dismiss(); });
  await page.addInitScript(([k, v]) => {
    localStorage.setItem(k, v);
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, val) {
      if (key === 'hard75.v1') throw new DOMException('quota', 'QuotaExceededError');
      return real.call(this, key, val);
    };
  }, [KEY, JSON.stringify(BASE)]);
  await page.goto(URL_);
  await page.waitForSelector('#view .card');
  await page.type('[data-act="notes"]', 'twelve chars');
  await page.waitForTimeout(200);
  check('blocked storage raises no native dialogs', dialogs === 0, `${dialogs} dialogs`);
  check('blocked storage is surfaced once', await page.locator('body > .toast').count() === 1);
  await page.click('[data-nav="today"]');
  check('and stays visible in the day view',
    (await page.locator('#view').textContent()).includes('Not saving'));
  await ctx.close();
}
{
  // a second toast must not orphan the first
  const { ctx, page } = await fresh(browser);
  await page.click('[data-nav="setup"]');
  await page.click('[data-act="export"]');
  await page.waitForTimeout(120);
  await page.click('[data-act="export"]');
  await page.waitForTimeout(120);
  check('toasts do not stack up and orphan each other',
    await page.locator('body > .toast').count() <= 1);
  await ctx.close();
}
{
  // the outdoors requirement must not be pre-satisfied
  const { ctx, page } = await fresh(browser);
  const on = await page.locator('[data-act="wo-out"][data-i="1"]').getAttribute('data-on');
  check('outdoors is opt-in, not the default', on === '0', `workout 2 outdoor default = ${on}`);
  await ctx.close();
}
{
  // a new book must not silently read as zero pages
  const { ctx, page } = await fresh(browser);
  await page.fill('[data-act="pfrom"]', '210');
  await page.fill('[data-act="pto"]', '12');
  await page.waitForTimeout(100);
  const txt = (await page.locator('#pages-status').textContent()).trim();
  const view = await page.locator('#view').textContent();
  check('finishing before the start page is explained, not silently 0',
    !/^0 \//.test(txt) || /new book|before you started|start page/i.test(view),
    `status reads "${txt}" with no explanation`);
  await ctx.close();
}
{
  // the shopping list must be for the cook you are about to do
  for (const [date, label, want] of [
    ['2026-08-23', 'Sunday (cook night)', 'B1'],
    ['2026-08-22', 'Saturday (shopping for tomorrow)', 'B1'],
    ['2026-08-19', 'Wednesday (cook night)', 'A2'],
    ['2026-08-21', 'Friday (no cook nearby)', 'A2']
  ]) {
    const { ctx, page } = await fresh(browser, { settings: { dateOverride: date } });
    await page.click('[data-nav="meals"]');
    const key = await page.locator('[data-act="copy-list"]').getAttribute('data-key');
    check(`${label} shows list ${want}`, key === want, `shopping list shown = ${key}`);
    await ctx.close();
  }
}
{
  // the rotation must not split a cook from the days it feeds, whatever day 1 is
  const keys = [];
  for (const date of ['2026-08-23', '2026-08-24']) {   // the Sunday cook, then the Monday it feeds
    const { ctx, page } = await fresh(browser, { startDate: '2026-08-20', settings: { dateOverride: date } });
    await page.click('[data-nav="meals"]');
    keys.push(await page.locator('[data-act="copy-list"]').getAttribute('data-key'));
    await ctx.close();
  }
  check('a Thursday start keeps Sunday\'s cook and Monday\'s meals on one rotation',
    keys[0] === keys[1], `Sunday shops ${keys[0]}, Monday eats from ${keys[1]}`);
}
{
  // the photo rule is a plain checkbox — no image storage anywhere
  const { ctx, page } = await fresh(browser);
  check('no file input for images', await page.locator('input[type="file"][accept*="image"]').count() === 0);
  await page.click('[data-act="toggle"][data-k="photo"]');
  await page.waitForTimeout(100);
  const s = await readState(page);
  check('the photo box ticks straight away',
    (s.days[BASE.settings.dateOverride] || {}).photo === true,
    JSON.stringify(s.days[BASE.settings.dateOverride] || {}).slice(0, 60));
  const dbs = await page.evaluate(() =>
    indexedDB.databases ? indexedDB.databases().then(l => l.map(d => d.name)) : []);
  check('nothing is written to IndexedDB', !dbs.includes('hard75'), JSON.stringify(dbs));
  await ctx.close();
}
{
  // a fail must keep the run's records rather than deleting them
  const { ctx, page } = await fresh(browser);
  await page.fill('[data-act="weight"]', '83.4');
  await page.waitForTimeout(100);
  await page.click('[data-act="fail"]');
  await page.click('[data-act="fail-confirm"]');
  await page.waitForTimeout(200);
  const s = await readState(page);
  const arch = s.history[0].days || {};
  check('the failed run keeps its weights and notes',
    (arch['2026-09-01'] || {}).weight === 83.4, JSON.stringify(arch).slice(0, 80));
  check('reached-day and clean-day counts are separate',
    s.history[0].reachedDay === 15 && s.history[0].daysCompleted === 0,
    `reached ${s.history[0].reachedDay}, clean ${s.history[0].daysCompleted}`);
  await ctx.close();
}

await browser.close();
server.close();

const uniq = [...new Set(allErrors)];
if (uniq.length) { console.log('\nConsole/page errors:'); uniq.forEach(e => console.log('  ! ' + e)); }
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailing:');
  failures.forEach(f => console.log('  - ' + f));
}
process.exit(fail ? 1 : 0);
