import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { RECORDED_EXAMPLE } from '../example.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cases = JSON.parse(await readFile(new URL('../fixtures/cases.json', import.meta.url)));
const healthy = cases[0].input;
const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', woff2: 'font/woff2', png: 'image/png', json: 'application/json' };
const ALL_CLEAR = 'No broken layer found in what could be checked';

let server;
let browser;
let origin;
const served = [];

test.before(async () => {
  server = createServer(async (request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/$/, '/index.html');
    const file = path.join(ROOT, name);
    let status = 404;
    try {
      if (!file.startsWith(ROOT) || name.includes('/node_modules/') || name.includes('/.git')) throw new Error('outside');
      const content = await readFile(file);
      status = 200;
      response.writeHead(200, { 'Content-Type': TYPES[file.split('.').at(-1)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(content);
    } catch { response.writeHead(404).end(); }
    served.push({ name, status });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve));
});

async function open(width = 1440, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, ...options });
  const page = await context.newPage();
  const external = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    external.push(url.href);
    return route.abort();
  });
  await page.goto(origin, { waitUntil: 'networkidle' });
  return { context, page, external };
}

const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const segClass = (page, id) => page.getAttribute(`[data-seg="${id}"]`, 'class');
// The visible status word on a segment, without its screen-reader separator.
const segWord = async (page, id) => (await page.textContent(`[data-seg="${id}"] .seg-state`)).replace(/^: /, '');

async function fillIds(page, input = healthy) {
  await page.fill('#waba-id', input.wabaId);
  await page.fill('#app-id', input.appId);
  await page.fill('#phone-id', input.phoneNumberId);
  await page.fill('#callback-url', input.callbackUrl);
}

test('the recorded example matches the fixtures: healthy case with the different registered callback', () => {
  const expected = structuredClone(healthy);
  expected.responses.appSubscriptions = cases.find(item => item.name === 'different registered callback').overrides['responses.appSubscriptions'];
  assert.deepEqual(RECORDED_EXAMPLE, expected);
});

test('every file the page loads is served from the origin, and nothing else is requested', async () => {
  served.length = 0;
  const { context, external } = await open();
  try {
    assert.ok(served.length >= 6, JSON.stringify(served));
    assert.deepEqual(served.filter(item => item.status !== 200), []);
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

for (const width of [320, 390, 1440]) {
  test(`${width}px: product name and Check my setup come before the artwork; no sideways scroll before or after a result`, async () => {
    const { context, page } = await open(width);
    try {
      const top = async selector => (await page.locator(selector).boundingBox()).y;
      const art = await top('.specimen');
      if (width < 900) {
        assert.ok(await top('.hero-copy .label') < art, 'product name is above the art');
        assert.ok(await top('.actions .btn-primary') < art, 'Check my setup is above the art');
      }
      assert.match(await page.innerText('.hero-copy .label'), /webhook check/i);
      assert.equal(await overflow(page), 0);
      await page.click('#load-example');
      await page.locator('#summary').getByText('Broken at layer 3', { exact: false }).waitFor();
      assert.equal(await overflow(page), 0);
    } finally { await context.close(); }
  });
}

test('recorded example: one click reaches the layer 3 repair with no request and no storage', async () => {
  const { context, page, external } = await open(390);
  try {
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await page.click('#load-example');
    await page.locator('#summary').getByText('Broken at layer 3: App webhook subscription', { exact: false }).waitFor();
    assert.deepEqual(requests, []);
    assert.deepEqual(external, []);
    const state = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie }));
    assert.deepEqual(state, { local: 0, session: 0, cookies: '' });
    assert.equal(await page.isVisible('#recorded-tag'), true);
    assert.equal(await page.isVisible('#recorded-note'), true);
    assert.equal(await page.isVisible('#feedback'), false, 'no feedback issue for a recorded example');
    assert.equal(await page.isVisible('#repair'), false);
    assert.equal(await page.inputValue('#waba-id'), '1001');
    assert.equal(await page.isChecked('input[name="mode"][value="paste"]'), true);
    assert.equal(await page.inputValue('#user-token'), '');
    const fix = await page.innerText('.one-fix');
    assert.match(fix, /publish the workflow so n8n registers the Production URL/);
    assert.match(fix, /DO NOT\s*DELETE \/\{WABA_ID\}\/subscribed_apps/i);
    assert.match(await segClass(page, 1), /is-pass/);
    assert.match(await segClass(page, 3), /is-fail is-first/);
    for (const id of [4, 5]) assert.match(await segClass(page, id), /is-skipped/, `layer ${id} is not checked`);
    assert.equal(await segWord(page, 5), 'Not checked');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'summary', 'focus moves to the verdict');
    assert.equal(await page.evaluate(() => document.querySelector('#layer-3 details').open), true, 'the first fault shows its evidence');
    assert.equal(await page.evaluate(() => document.querySelector('#layer-1 details').open), false, 'later evidence stays folded');
  } finally { await context.close(); }
});

test('recorded example replaces typed entries only after an explicit choice', async () => {
  const { context, page } = await open();
  try {
    await page.fill('#waba-id', '777');
    await page.getByLabel('Use a token (GET only)').check();
    await page.fill('#user-token', 'typed-token-123');
    await page.click('#load-example');
    assert.equal(await page.isVisible('#example-confirm'), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'example-replace');
    assert.equal(await page.inputValue('#waba-id'), '777');
    assert.equal(await page.isVisible('#recorded-tag'), false);
    await page.click('#example-keep');
    assert.equal(await page.isVisible('#example-confirm'), false);
    assert.equal(await page.inputValue('#waba-id'), '777');
    await page.getByRole('button', { name: 'Load a recorded example' }).click();
    await page.click('#example-replace');
    await page.locator('#summary').getByText('Broken at layer 3', { exact: false }).waitFor();
    assert.equal(await page.inputValue('#waba-id'), '1001');
    assert.equal(await page.inputValue('#user-token'), '', 'the example clears a typed token');
    assert.equal(await page.isChecked('input[name="mode"][value="paste"]'), true);
    assert.equal(await page.isVisible('#token-fields'), false);
    // Editing any field makes it the visitor's own check again.
    await page.fill('#subscriptions-json', JSON.stringify(healthy.responses.appSubscriptions));
    assert.equal(await page.isVisible('#recorded-note'), false);
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText(ALL_CLEAR, { exact: false }).waitFor();
    assert.equal(await page.isVisible('#recorded-tag'), false);
    assert.equal(await page.isVisible('#feedback'), true);
    // Clear the form empties everything the example filled.
    await page.click('#load-example');
    await page.click('#example-replace');
    await page.locator('#summary').getByText('Broken at layer 3', { exact: false }).waitFor();
    await page.click('#example-clear');
    for (const id of ['waba-id', 'callback-url', 'waba-json', 'subscriptions-json']) assert.equal(await page.inputValue(`#${id}`), '');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'waba-id');
  } finally { await context.close(); }
});

test('keyboard: the path segments are links in layer order; Enter focuses that row and opens its evidence', async () => {
  const { context, page } = await open();
  try {
    await page.click('#load-example');
    await page.locator('#summary').getByText('Broken at layer 3', { exact: false }).waitFor();
    await page.focus('[data-seg="1"] a');
    const names = [];
    for (let i = 0; i < 5; i++) {
      names.push(await page.evaluate(() => [document.activeElement.getAttribute('href'), document.activeElement.textContent]));
      await page.keyboard.press('Tab');
    }
    assert.deepEqual(names.map(([href]) => href), ['#layer-1', '#layer-2', '#layer-3', '#layer-4', '#layer-5']);
    assert.deepEqual(names.map(([, text]) => text), ['Layer 1Callback URL: Pass', 'Layer 2WABA link: Pass', 'Layer 3App webhook: Broken', 'Layer 4Phone number: Not checked', 'Layer 5Challenge: Not checked']);
    await page.focus('[data-seg="2"] a');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'layer-2');
    assert.equal(await page.evaluate(() => document.querySelector('#layer-2 details').open), true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid', 'the focused row shows a ring');
  } finally { await context.close(); }
});

test('a new check clears the old path: no stale segments while Graph reads are pending or after an early stop', async () => {
  const { context, page } = await open();
  try {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await page.route('https://graph.facebook.com/**', async route => {
      await pending;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(healthy.responses.wabaApps) });
    });
    await page.click('#load-example');
    await page.locator('#summary').getByText('Broken at layer 3', { exact: false }).waitFor();
    assert.equal(await page.locator('.seg-link').count(), 5);
    // Token mode without a token stops early: the old result, its path and its tag are gone.
    await page.getByLabel('Use a token (GET only)').check();
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText('Enter an access token', { exact: false }).waitFor();
    assert.equal(await page.locator('.seg-link').count(), 0);
    assert.equal(await page.locator('.path .is-idle').count(), 5);
    assert.equal(await page.isVisible('#recorded-tag'), false);
    assert.equal(await page.getAttribute('.result', 'data-state'), null);
    // While the token reads are pending, the path stays unmarked and inert.
    await page.fill('#user-token', 'test-user-token');
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText('Checking', { exact: false }).waitFor();
    assert.equal(await page.locator('.seg-link').count(), 0);
    assert.equal(await page.locator('.path [class*="is-fail"], .path [class*="is-pass"]').count(), 0);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('.path .seg').first().click();
    release();
    await page.locator('.seg-link').first().waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('clear the form after a result returns the result to neutral, and the example still runs after it', async () => {
  const { context, page, external } = await open(390);
  try {
    const neutral = await page.evaluate(() => document.querySelector('#summary').textContent);
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await page.click('#load-example');
    await page.locator('#summary').getByText('Broken at layer 3', { exact: false }).waitFor();
    await page.click('#example-clear');
    assert.equal(await page.textContent('#summary'), neutral);
    assert.match(await page.getAttribute('#summary', 'class'), /\bempty\b/);
    assert.equal(await page.getAttribute('.result', 'data-state'), null);
    assert.equal(await page.locator('#fix > *').count(), 0, 'no One fix');
    assert.equal(await page.locator('#results > *').count(), 0, 'no layer rows');
    assert.equal(await page.locator('.seg-link').count(), 0);
    assert.equal(await page.locator('.path .is-idle').count(), 5);
    for (const id of ['recorded-tag', 'recorded-note', 'feedback', 'repair', 'form-error']) assert.equal(await page.isVisible(`#${id}`), false, `#${id} hidden`);
    assert.equal(await page.inputValue('#waba-id'), '');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'waba-id');
    await page.click('#load-example');
    await page.locator('#summary').getByText('Broken at layer 3', { exact: false }).waitFor();
    assert.match(await segClass(page, 3), /is-fail is-first/);
    assert.equal(await page.isVisible('#recorded-tag'), true);
    assert.deepEqual(requests, []);
    assert.deepEqual(external, []);
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, '']);
  } finally { await context.close(); }
});

test('first screen: an example result, the maker and Source on GitHub; the weekly email is linked in the footer', async () => {
  const { check, firstBlocking } = await import('../engine.js');
  const real = firstBlocking(check(RECORDED_EXAMPLE));
  for (const width of [390, 1440]) {
    const { context, page } = await open(width, { viewport: { width, height: width < 600 ? 844 : 900 } });
    try {
      // The sample is the recorded example's real verdict and fix, word for word, and sits on the first screen.
      assert.equal(await page.textContent('#sample-result .sample-verdict'), `Broken at layer ${real.id}: ${real.name}`);
      assert.equal((await page.textContent('#sample-result .sample-fix')).replace(/^One fix\s*/, ''), real.fix);
      assert.match(await page.textContent('#sample-label'), /^Example result/);
      // Verdict and fix come first and end on the first screen; the inputs follow them.
      for (const sel of ['.sample-verdict', '.sample-fix']) {
        const box = await page.locator(`#sample-result ${sel}`).boundingBox();
        assert.ok(box.y + box.height <= page.viewportSize().height, `${width}: ${sel} ends at ${box.y + box.height}`);
      }
      const order = await page.$$eval('#sample-result > *', kids => kids.map(k => k.className));
      assert.deepEqual(order, ['sample-tag', 'sample-verdict', 'sample-fix', 'sample-inputs']);
      const maker = page.locator('.maker a').first();
      assert.equal(await maker.textContent(), 'Made by CyberNative AI LLC, an AI-run company');
      assert.equal(await maker.getAttribute('href'), 'https://cybernative.ai/about/');
      assert.equal(await page.getAttribute('.maker a.maker-check', 'href'), 'https://cybernative.ai/about/#how-we-check');
      assert.equal((await page.textContent('.maker')).replace(/\s+/g, ' ').trim(), 'Made by CyberNative AI LLC, an AI-run company·How we check', 'Content\'s words, verbatim');
      const makerBox = await maker.boundingBox();
      assert.ok(makerBox.y + makerBox.height <= page.viewportSize().height, 'maker line on the first screen');
      assert.equal(await page.textContent('.site-header .source'), 'Source on GitHub');
      assert.equal(await page.isVisible('.site-header .source'), true);
      const email = page.locator('.site-footer a', { hasText: 'Get the weekly email: what breaks next' });
      assert.equal(await email.getAttribute('href'), 'https://cybernative.ai/breakage-calendar/#wbn-email-calendar');
      assert.equal(await page.locator('form, input').filter({ has: page.locator('xpath=ancestor::footer') }).count(), 0);
      assert.equal(await page.locator('.site-footer form').count(), 0, 'a link, not a form');
    } finally { await context.close(); }
  }
});

// Each byline link takes a 48 px tap: the rect and the hit test at its top and bottom edge both say so.
const bylineTargets = page => page.evaluate(() => [...document.querySelectorAll('.maker a')].map(a => {
  const range = document.createRange(); range.selectNodeContents(a);
  return { text: a.textContent, lines: new Set([...range.getClientRects()].map(r => Math.round(r.top))).size, boxes: [...a.getClientRects()].map(r => {
    const hits = y => { const e = document.elementFromPoint(r.left + Math.min(r.width / 2, 40), y); return !!e && a.contains(e); };
    return { height: r.height, top: hits(r.top + 1), bottom: hits(r.bottom - 1) };
  }) };
}));

test('48 px targets: each byline link and the header link; at 320 the header shows "GitHub" clear of the wordmark', async () => {
  for (const width of [320, 390, 1440]) {
    const { context, page } = await open(width);
    try {
      await page.evaluate(() => document.fonts.ready);
      const links = await bylineTargets(page);
      assert.equal(links.length, 2);
      for (const link of links) for (const box of link.boxes) assert.ok(box.height >= 48 && box.top && box.bottom, `${width}: ${link.text} ${JSON.stringify(box)}`);
      assert.equal(links[1].lines, 1, `${width}: the second link is never split`);
      const header = page.getByRole('banner').getByRole('link', { name: 'Source on GitHub', exact: true });
      const box = await header.boundingBox();
      assert.ok(box.height >= 48, `${width}: header link ${box.height} px`);
      const wordmark = await page.locator('.wordmark').boundingBox();
      assert.ok(box.x - (wordmark.x + wordmark.width) >= 16, `${width}: ${box.x - (wordmark.x + wordmark.width)} px between wordmark and link`);
      const pre = await page.locator('.site-header .source-pre').boundingBox();
      assert.equal(pre.width > 1, width >= 360, `${width}: "Source on" shown only from 360 px`);
      assert.equal(await overflow(page), 0);
    } finally { await context.close(); }
  }
});

test('the example result gives way to a real result, and returns when the form is cleared', async () => {
  const { context, page } = await open(390);
  try {
    assert.equal(await page.isVisible('#sample-result'), true);
    // A visitor's own check, not the example, also hides it.
    await fillIds(page);
    await page.fill('#waba-json', JSON.stringify(healthy.responses.wabaApps));
    await page.fill('#phone-json', JSON.stringify(healthy.responses.phone));
    await page.fill('#waba-phones-json', JSON.stringify(healthy.responses.wabaPhones));
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText(ALL_CLEAR, { exact: false }).waitFor();
    assert.equal(await page.isVisible('#sample-result'), false);
    await page.click('#example-clear').catch(() => {});
    await page.click('#load-example');
    await page.locator('#example-replace').click();
    await page.locator('#summary').getByText('Broken at layer 3').waitFor();
    assert.equal(await page.isVisible('#sample-result'), false);
    assert.equal(await page.locator('text=Broken at layer 3').filter({ visible: true }).count(), 1, 'one visible layer-3 verdict');
    await page.click('#example-clear');
    assert.equal(await page.isVisible('#sample-result'), true);
  } finally { await context.close(); }
});

test('unknown stays unknown: an omitted optional layer 3 is Not checked, a failed read is Cannot check, never Pass', async () => {
  const { context, page } = await open();
  try {
    await fillIds(page);
    await page.fill('#waba-json', JSON.stringify(healthy.responses.wabaApps));
    await page.fill('#phone-json', JSON.stringify(healthy.responses.phone));
    await page.fill('#waba-phones-json', JSON.stringify(healthy.responses.wabaPhones));
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText(ALL_CLEAR, { exact: false }).waitFor();
    const three = await segClass(page, 3);
    assert.match(three, /is-skipped/);
    assert.doesNotMatch(three, /is-pass|is-first/);
    assert.equal(await segWord(page, 3), 'Not checked');
    assert.match(await segClass(page, 4), /is-pass/);
    assert.match(await segClass(page, 5), /is-manual/);
    assert.equal(await segWord(page, 5), 'You run it');
    assert.equal(await page.locator('.is-first').count(), 0);
    assert.equal(await page.locator('.one-fix').count(), 0);
    // A layer 3 read that fails is marked Cannot check, still not a pass, and the optional layer does not stop the check.
    await page.fill('#subscriptions-json', '{"error": {"code": 190, "message": "Invalid OAuth access token."}}');
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.locator('[data-seg="3"].is-cannot').waitFor();
    assert.doesNotMatch(await segClass(page, 3), /is-pass|is-first/);
    assert.equal(await segWord(page, 3), 'Cannot check');
    assert.match(await segClass(page, 4), /is-pass/);
  } finally { await context.close(); }
});

test('a very long Graph error wraps at 320px and marks layer 2 as the first thing to fix', async () => {
  const { context, page } = await open(320);
  try {
    await fillIds(page);
    await page.fill('#waba-json', JSON.stringify({ error: { code: 190, message: `Error validating access token ${'x'.repeat(2400)} and ${'very long words '.repeat(60)}` } }));
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText('Cannot check layer 2', { exact: false }).waitFor();
    assert.match(await segClass(page, 2), /is-cannot is-first/);
    assert.equal(await overflow(page), 0);
    const box = await page.locator('.result').boundingBox();
    assert.ok(box.x + box.width <= 320, JSON.stringify(box));
  } finally { await context.close(); }
});

test('empty and malformed input: a field error first, then a malformed paste is Cannot check, not Pass', async () => {
  const { context, page } = await open();
  try {
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    assert.match(await page.innerText('#form-error'), /WhatsApp Business Account ID must contain digits only/);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'waba-id');
    assert.equal(await page.locator('.seg-link').count(), 0, 'no result path without a check');
    await fillIds(page);
    await page.fill('#waba-json', '{"data": [ {not json');
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText('Cannot check layer 2', { exact: false }).waitFor();
    assert.match(await segClass(page, 2), /is-cannot/);
    assert.match(await page.innerText('#layer-2'), /Could not parse the pasted subscribed_apps JSON/);
    for (const id of [3, 4, 5]) assert.match(await segClass(page, id), /is-skipped/);
  } finally { await context.close(); }
});

test('the DELETE warning sits with the fix for layers 2 and 3 only', async () => {
  for (const [name, expectWarning] of [['empty subscribed_apps', true], ['phone outside WABA', false]]) {
    const { context, page } = await open();
    try {
      const input = structuredClone(healthy);
      for (const [key, value] of Object.entries(cases.find(item => item.name === name).overrides)) input.responses[key.split('.')[1]] = value;
      await fillIds(page, input);
      await page.fill('#waba-json', JSON.stringify(input.responses.wabaApps));
      await page.fill('#phone-json', JSON.stringify(input.responses.phone));
      await page.fill('#waba-phones-json', JSON.stringify(input.responses.wabaPhones));
      await page.getByRole('button', { name: 'Find the broken layer' }).click();
      await page.locator('.one-fix').waitFor();
      assert.equal((await page.innerText('.one-fix')).includes('subscribed_apps to clear this'), expectWarning, name);
    } finally { await context.close(); }
  }
});

test('without JavaScript the page explains why and hides the form that cannot run', async () => {
  const { context, page } = await open(390, { javaScriptEnabled: false });
  try {
    assert.equal(await page.isVisible('.nojs'), true);
    assert.match(await page.innerText('.nojs'), /needs JavaScript, which is off/);
    assert.equal(await page.isVisible('#check-form'), false);
    assert.equal(await page.isVisible('.result'), false);
    assert.equal(await page.isVisible('#load-example'), false);
    assert.equal(await page.isVisible('#delete-warning'), true, 'the conflict warning still reads without JS');
    assert.equal(await page.isVisible('.route'), true, 'delivery order still reads without JS');
    assert.equal(await overflow(page), 0);
  } finally { await context.close(); }
});

test('the share card is a 1200x630 PNG and the page declares it so', async () => {
  const png = await readFile(new URL('../assets/og-card.png', import.meta.url));
  assert.deepEqual([...png.subarray(1, 4)].map(byte => String.fromCharCode(byte)).join(''), 'PNG');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /og:image" content="https:\/\/cybernative-ai\.github\.io\/whatsapp-webhook-check\/assets\/og-card\.png"/);
  assert.match(html, /og:image:width" content="1200"/);
  assert.match(html, /og:image:height" content="630"/);
});

test('W1: the page states one input count, the same way in the lede, the reads line and the form', async () => {
  const { context, page } = await open(1440);
  try {
    const text = sel => page.textContent(sel).then(t => t.replace(/\s+/g, ' ').trim());
    const COUNT = 'three Graph API responses, plus an optional fourth for layer 3';
    assert.ok((await text('.lede')).includes(`Paste ${COUNT}, and get one fix`));
    assert.match(await text('.reads'), /^The three reads, .* The optional fourth, for layer 3, is GET \/\{APP_ID\}\/subscriptions, which needs an app token\./);
    assert.match(await text('#check .sub'), /^Your IDs and URL first, then three responses, plus an optional fourth for layer 3\./);
    const legends = await page.$$eval('#check-form legend', ls => ls.map(l => l.textContent.replace(/\s+/g, ' ').trim()));
    assert.equal(legends[0], '1 Your IDs and URL They fill in the reads in step 2, and the check compares each response with them.');
    assert.equal(legends[1], '2 What Meta returns Three responses, plus an optional fourth for layer 3.');
    // Three paste boxes in step 2, and the fourth is the optional layer 3 read.
    assert.equal(await page.locator('#paste-fields textarea').count(), 3);
    assert.match(await text('label[for="subscriptions-json"]'), /^Layer 3 · App webhook, the optional fourth response/);
    // The IDs really do fill in the reads.
    await page.fill('#waba-id', '1001');
    assert.equal(await page.textContent('code.read[data-read="waba"]'), 'GET /1001/subscribed_apps');
  } finally { await context.close(); }
});

test('W1: the example panel shows the recorded inputs word for word, the failing one marked, under its verdict and fix', async () => {
  const { check, firstBlocking } = await import('../engine.js');
  const E = RECORDED_EXAMPLE, R = E.responses;
  const blocking = firstBlocking(check(E));
  const { context, page } = await open(1440);
  try {
    const rows = await page.$$eval('#sample-result .sample-reads li', lis => lis.map(li => ({
      layer: li.dataset.sampleLayer, tag: li.querySelector('.sr-num').textContent,
      reads: [...li.querySelectorAll('.sr-pair')].map(p => [p.querySelector('.sr-read').textContent, p.querySelector('.sr-value').textContent]),
      broken: li.classList.contains('is-broken'), mark: li.querySelector('.sr-mark')?.textContent ?? null })));
    assert.deepEqual(rows, [
      { layer: '1', tag: 'Layer 1', reads: [['n8n Production URL', E.callbackUrl]], broken: false, mark: null },
      { layer: '2', tag: 'Layer 2', reads: [[`GET /${E.wabaId}/subscribed_apps`, `"id": "${R.wabaApps.data[0].whatsapp_business_api_data.id}"`]], broken: false, mark: null },
      { layer: '3', tag: 'Layer 3', reads: [[`GET /${E.appId}/subscriptions`, `"callback_url": "${R.appSubscriptions.data[0].callback_url}"`]], broken: true, mark: 'Broken' },
      // Layer 4: the phone_numbers read supplies the id, so it comes first, then the read of that id.
      { layer: '4', tag: 'Layer 4', reads: [
        [`GET /${E.wabaId}/phone_numbers`, `"id": "${R.wabaPhones.data[0].id}"`],
        [`GET /${E.phoneNumberId}?fields=…`, `"platform_type": "${R.phone.platform_type}"`],
      ], broken: false, mark: null },
    ]);
    assert.equal(R.wabaPhones.data[0].id, E.phoneNumberId, 'the second layer 4 read uses the id the first returns');
    assert.equal(blocking.id, 3, 'the marked read is the layer the engine stops at');
    assert.ok(R.appSubscriptions, 'the example includes the fourth response');
    assert.equal((await page.textContent('#sample-result .sample-inputs .sample-key')).replace(/\s+/g, ' ').trim(), 'What it was given, by layer · includes the optional fourth read (layer 3)');
    // Each line's read is one the page asks for.
    const reads = await page.$$eval('code.read', cs => cs.map(c => c.dataset.read));
    assert.deepEqual(reads, ['waba', 'phone', 'phones', 'subscriptions']);
  } finally { await context.close(); }
});

test('W3: the example lists each layer once, tagged with a word, never a bare number', async () => {
  const { context, page } = await open(390);
  try {
    const tags = await page.$$eval('#sample-result .sample-reads li', lis => lis.map(li => [li.dataset.sampleLayer, li.querySelector('.sr-num').textContent]));
    assert.deepEqual(tags, [['1', 'Layer 1'], ['2', 'Layer 2'], ['3', 'Layer 3'], ['4', 'Layer 4']]);
    // Layer 4's two reads sit in one row: the tag spans both, and the second read is below the first.
    const box = sel => page.locator(`#sample-result li[data-sample-layer="4"] ${sel}`).first().boundingBox();
    const pairs = await page.locator('#sample-result li[data-sample-layer="4"] .sr-pair').evaluateAll(ps => ps.map(p => p.getBoundingClientRect().top));
    assert.equal(pairs.length, 2);
    assert.ok(pairs[1] > pairs[0]);
    const tag = await box('.sr-num'), first = await box('.sr-pair');
    assert.ok(tag.x + tag.width <= first.x, 'the tag stays left of the reads');
  } finally { await context.close(); }
  // At 320 the tag goes above its reads, so no read wraps.
  const narrow = await open(320);
  try {
    const lines = await narrow.page.$$eval('#sample-result .sr-read', rs => rs.map(r => Math.round(r.getBoundingClientRect().height / parseFloat(getComputedStyle(r).lineHeight))));
    assert.deepEqual(lines, [1, 1, 1, 1, 1]);
  } finally { await narrow.context.close(); }
});

test('W4: the layer map says the page checks 1 to 4 and you run 5, a curl the result writes even without a verify token', async () => {
  const { check } = await import('../engine.js');
  const { appSubscriptions, ...three } = RECORDED_EXAMPLE.responses;
  // A run that reaches layer 5 with no verify token still writes the curl, with a placeholder token.
  const passing = { ...RECORDED_EXAMPLE, callbackUrl: 'https://n8n.example.com/webhook/abc', verifyToken: '', responses: three };
  const five = check(passing)[4];
  assert.equal(five.status, 'not checked');
  assert.match(five.evidence.command, /^curl -i '.*hub\.verify_token=%3CVERIFY_TOKEN%3E/);
  const { context, page } = await open(1440);
  try {
    const text = sel => page.textContent(sel).then(t => t.replace(/\s+/g, ' ').trim());
    assert.equal(await text('#layers-caption'), 'Five layers · the page checks 1–4; you run 5');
    assert.equal(await text('.layer-map li:last-child code'), 'a curl the result writes for you to run');
  } finally { await context.close(); }
  // At 390 the caption's tail moves to the next line whole, so no word sits alone on a line.
  const narrow = await open(390);
  try {
    const lines = await narrow.page.$eval('#layers-caption .tail', e => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e.parentElement).lineHeight)));
    assert.equal(lines, 1);
  } finally { await narrow.context.close(); }
});

test('two-part lines: the "·" sits where plain text puts it when both parts share a line, and is hidden when the tail starts its own line', async () => {
  const seen = new Set();
  for (const width of [320, 390, 1440]) {
    const { context, page } = await open(width);
    try {
      const rows = await page.$$eval('.sep-wrap', els => els.map(el => {
        el.scrollIntoView({ block: 'center' });
        const box = el.getBoundingClientRect(), tail = el.querySelector('.tail'), sep = tail.querySelector('.sep').getBoundingClientRect();
        const firstGlyph = node => { const r = document.createRange(); r.setStart(node, 0); r.setEnd(node, 1); return r.getClientRects()[0]; };
        const word = firstGlyph(tail.lastChild), head = el.firstChild.nodeType === 3 ? el.firstChild : el.firstChild.firstChild;
        const r = document.createRange(); r.selectNodeContents(head); const headRects = r.getClientRects(), headEnd = headRects[headRects.length - 1];
        // The same line as plain text, unwrapped, measures where the tail's first word would sit.
        const plain = el.cloneNode(false); plain.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;width:auto';
        const ph = document.createElement(el.firstChild.nodeType === 3 ? 'span' : el.firstChild.tagName); ph.textContent = head.data;
        const pt = document.createElement(tail.tagName); pt.textContent = tail.textContent; pt.className = 'plain-tail';
        plain.append(ph, ' ', pt); el.parentElement.append(plain);
        const pr = document.createRange(); pr.setStart(pt.firstChild, 2); pr.setEnd(pt.firstChild, 3);
        const ph1 = document.createRange(); ph1.selectNodeContents(ph.firstChild);
        const plainOffset = pr.getClientRects()[0].left - [...ph1.getClientRects()].pop().right; plain.remove();
        return { id: el.id || el.className + ':' + head.data.slice(0, 12), wrapped: word.top > headEnd.top + 1 && Math.abs(word.left - box.left) <= 1,
          dotHit: tail.querySelector('.sep').contains(document.elementFromPoint((sep.left + sep.right) / 2 - 2, (sep.top + sep.bottom) / 2)),
          // Every line of the tail's words starts inside the clip, including lines it wraps onto inside itself.
          textLeft: (() => { const t = document.createRange(); t.setStart(tail.lastChild, 0); t.setEnd(tail.lastChild, tail.lastChild.length); return Math.min(...[...t.getClientRects()].map(x => x.left)) - box.left; })(),
          sepRight: sep.right - box.left, sepLeft: sep.left - box.left, offset: word.left - headEnd.right, plainOffset };
      }));
      assert.equal(rows.length, 5);
      for (const row of rows) {
        seen.add(row.wrapped);
        assert.ok(row.textLeft >= -0.5, `${width}: no word of the tail is clipped: ${JSON.stringify(row)}`);
        if (row.wrapped) assert.ok(row.sepRight <= 0.5 && !row.dotHit, `${width}: the dot sits left of the clip edge, clipped: ${JSON.stringify(row)}`);
        else {
          assert.ok(row.sepLeft >= 0 && row.dotHit, `${width}: the dot is inside the line and shows: ${JSON.stringify(row)}`);
          assert.ok(Math.abs(row.offset - row.plainOffset) <= 1.5, `${width}: head-to-tail spacing matches plain text: ${JSON.stringify(row)}`);
        }
      }
    } finally { await context.close(); }
  }
  assert.deepEqual([...seen].sort(), [false, true], 'both forms occur across 320, 390 and 1440');
});

test('W2: layer 3 is checked only when its response is pasted, and the two orders are connected', async () => {
  const { check } = await import('../engine.js');
  const { appSubscriptions, ...three } = RECORDED_EXAMPLE.responses;
  assert.equal(check({ ...RECORDED_EXAMPLE, responses: three })[2].status, 'not checked');
  assert.equal(check(RECORDED_EXAMPLE)[2].status, 'fail');
  // A WABA override counts only when the phone number has no override of its own.
  const override = { data: [{ whatsapp_business_api_data: { id: RECORDED_EXAMPLE.appId }, override_callback_uri: 'https://other.example.com/hook' }] };
  const phone = own => ({ ...RECORDED_EXAMPLE.responses.phone, webhook_configuration: own ? { phone_number: RECORDED_EXAMPLE.callbackUrl } : {} });
  assert.equal(check({ ...RECORDED_EXAMPLE, responses: { ...three, wabaApps: override, phone: phone(true) } })[1].status, 'pass');
  assert.equal(check({ ...RECORDED_EXAMPLE, responses: { ...three, wabaApps: override, phone: phone(false) } })[1].status, 'fail');
  const { context, page } = await open(1440);
  try {
    assert.equal((await page.textContent('.layer-map li:nth-child(2) b')).replace(/\s+/g, ' '), 'WhatsApp Business Account (WABA) → app link · WABA override', 'WABA spelled out where it first shows at 1440');
    assert.equal((await page.textContent('.layer-map li:nth-child(3) b')).replace(/\s+/g, ' '), 'App webhook · optional: checked when you paste its response');
    assert.match(await page.textContent('.layers-figure figcaption'), /The two orders meet here: a WABA override \(layer 2\) counts only when the phone number \(layer 4\) has no override of its own, so the check uses the layer 4 read to judge layer 2\./);
    assert.equal(await page.textContent('#tested-limit'), 'Limit Tested on recorded response shapes, not a live WhatsApp account.');
  } finally { await context.close(); }
});
