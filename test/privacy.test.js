import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import test from 'node:test';
import { chromium } from 'playwright';

const fixture = JSON.parse(await readFile(new URL('../fixtures/cases.json', import.meta.url)))[0].input;
const bodyForPath = (path, wabaApps) => {
  if (path.endsWith('/subscribed_apps')) return wabaApps;
  if (path.endsWith('/subscriptions')) return fixture.responses.appSubscriptions;
  if (path.endsWith('/phone_numbers')) return fixture.responses.wabaPhones;
  if (path.includes('/3003')) return fixture.responses.phone;
  throw new Error(`Unexpected Graph path: ${path}`);
};

const STATIC_FILES = ['index.html', 'page.js', 'engine.js', 'style.css', 'assets/mark.svg',
  ...['Fraunces144ptSoft-SemiBold', 'IBMPlexSans-Regular', 'IBMPlexSans-SemiBold', 'IBMPlexMono-Regular-Latin1', 'IBMPlexMono-Medium-Latin1'].map(name => `assets/fonts/${name}.woff2`)];
const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', woff2: 'font/woff2' };
const ALL_CLEAR = 'No broken layer found in what could be checked';

let server;
let browser;
let origin;

test.before(async () => {
  server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const file = path === '/' ? 'index.html' : STATIC_FILES.find(name => `/${name}` === path);
    if (!file) { response.writeHead(404).end(); return; }
    const content = await readFile(new URL(`../${file}`, import.meta.url));
    response.writeHead(200, { 'Content-Type': TYPES[file.split('.').at(-1)], 'Cache-Control': 'no-store' });
    response.end(content);
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

async function newPage(wabaApps = fixture.responses.wabaApps, callbackUrl = 'https://n8n.example.com/webhook/abc') {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__storageWrites = [];
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (...args) {
      window.__storageWrites.push(['storage', ...args]);
      return original.apply(this, args);
    };
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get() { return cookie.get.call(document); },
      set(value) { window.__storageWrites.push(['cookie', value]); return cookie.set.call(document, value); },
    });
  });
  const external = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.origin === 'https://graph.facebook.com') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bodyForPath(url.pathname, wabaApps)) });
    external.push(url.href);
    return route.abort();
  });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.fill('#waba-id', '1001');
  await page.fill('#app-id', '2002');
  await page.fill('#phone-id', '3003');
  await page.fill('#callback-url', callbackUrl);
  return { context, page, external };
}

async function assertNoStorage(page, context) {
  const state = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie, writes: window.__storageWrites }));
  assert.deepEqual(state, { local: 0, session: 0, cookies: '', writes: [] });
  assert.deepEqual(await context.cookies(), []);
}

test('token mode sends only GETs to pinned Graph host, with no token in any URL or storage', async () => {
  const { context, page, external } = await newPage();
  try {
    const requests = [];
    page.on('request', request => requests.push({ url: request.url(), method: request.method(), authorization: request.headers().authorization }));
    await page.getByLabel('Use a token (GET only)').check();
    await page.fill('#user-token', 'test-user-token');
    await page.fill('#subscriptions-json', JSON.stringify(fixture.responses.appSubscriptions));
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText(ALL_CLEAR, { exact: false }).waitFor();
    assert.equal(requests.length, 3, JSON.stringify(requests));
    assert.ok(requests.every(item => item.url.startsWith('https://graph.facebook.com/v25.0/') && item.method === 'GET'));
    assert.ok(requests.every(item => !item.url.includes('test-user-token')));
    assert.ok(requests.every(item => item.authorization === 'Bearer test-user-token'));
    assert.ok(!requests.some(item => item.url.includes('/2002/subscriptions')), 'the app subscription read is never fetched with a token');
    assert.deepEqual(external, []);
    assert.equal(await page.inputValue('#user-token'), '');
    await assertNoStorage(page, context);
  } finally { await context.close(); }
});

test('paste mode makes zero requests after page load and writes no storage', async () => {
  const { context, page, external } = await newPage();
  try {
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await page.fill('#waba-json', JSON.stringify(fixture.responses.wabaApps));
    await page.fill('#subscriptions-json', JSON.stringify(fixture.responses.appSubscriptions));
    await page.fill('#phone-json', JSON.stringify(fixture.responses.phone));
    await page.fill('#waba-phones-json', JSON.stringify(fixture.responses.wabaPhones));
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText(ALL_CLEAR, { exact: false }).waitFor();
    assert.deepEqual(requests, []);
    assert.deepEqual(external, []);
    await assertNoStorage(page, context);
  } finally { await context.close(); }
});

test('missing WABA link shows exact user-run POST without sending one', async () => {
  const { context, page, external } = await newPage({ data: [] });
  try {
    const requests = [];
    page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
    await page.getByLabel('Use a token (GET only)').check();
    await page.fill('#user-token', 'test-user-token');
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText('Broken at layer 2', { exact: false }).waitFor();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'GET');
    assert.match(requests[0].url, /\/v25\.0\/1001\/subscribed_apps$/);
    assert.match(await page.locator('.result').innerText(), /curl -X POST 'https:\/\/graph\.facebook\.com\/v25\.0\/1001\/subscribed_apps'/);
    assert.deepEqual(external, []);
    await assertNoStorage(page, context);
  } finally { await context.close(); }
});

test('paste mode is the default and the page never asks for an app secret or app token', async () => {
  const { context, page } = await newPage();
  try {
    assert.equal(await page.isChecked('input[name="mode"][value="paste"]'), true);
    assert.equal(await page.isVisible('#waba-json'), true);
    assert.equal(await page.locator('input[type="password"]').count(), 1, 'only the one user-token field');
    assert.equal(await page.locator('#app-token').count(), 0);
    const labels = await page.locator('label').allInnerTexts();
    assert.ok(!labels.some(text => /app secret|app token/i.test(text.split('\n')[0])), 'no input is labelled as an app secret or app token');
    assert.match(await page.locator('#layer3-note').innerText(), /Never paste an app secret or app token into this page/);
    await page.getByLabel('Use a token (GET only)').check();
    assert.match(await page.locator('#token-note').innerText(), /only to graph\.facebook\.com.*not stored/s);
  } finally { await context.close(); }
});

test('token mode: a layer 3 error is marked cannot check and the phone reads still run', async () => {
  const { context, page, external } = await newPage();
  try {
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await page.getByLabel('Use a token (GET only)').check();
    await page.fill('#user-token', 'test-user-token');
    await page.fill('#subscriptions-json', '{"error": {"code": 190, "message": "Invalid OAuth access token."}}');
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText(ALL_CLEAR, { exact: false }).waitFor();
    assert.equal(await page.locator('[data-layer="3"] .status').innerText(), 'CANNOT CHECK');
    assert.equal(await page.locator('[data-layer="4"] .status').innerText(), 'PASS');
    assert.ok(requests.some(url => /\/v25\.0\/3003\?/.test(url)) && requests.some(url => url.endsWith('/1001/phone_numbers')), JSON.stringify(requests));
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test('a custom webhook path shows a warning and the check continues', async () => {
  const custom = 'https://n8n.example.com/hooks/abc';
  const { context, page } = await newPage(fixture.responses.wabaApps, custom);
  try {
    await page.fill('#waba-json', JSON.stringify(fixture.responses.wabaApps));
    await page.fill('#subscriptions-json', JSON.stringify({ data: [{ ...fixture.responses.appSubscriptions.data[0], callback_url: custom }] }));
    await page.fill('#phone-json', JSON.stringify(fixture.responses.phone));
    await page.fill('#waba-phones-json', JSON.stringify(fixture.responses.wabaPhones));
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText(ALL_CLEAR, { exact: false }).waitFor();
    assert.equal(await page.locator('[data-layer="1"] .status').innerText(), 'WARNING');
    assert.match(await page.locator('[data-layer="1"]').innerText(), /N8N_ENDPOINT_WEBHOOK/);
    assert.equal(await page.locator('[data-layer="4"] .status').innerText(), 'PASS');
  } finally { await context.close(); }
});

test('feedback links open a pre-filled public issue carrying no IDs, URL, or token', async () => {
  const { context, page } = await newPage({ data: [] });
  try {
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    assert.equal(await page.isVisible('#feedback'), false, 'no feedback prompt before a result');
    await page.getByLabel('Use a token (GET only)').check();
    await page.fill('#user-token', 'test-user-token');
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText('Broken at layer 2', { exact: false }).waitFor();
    assert.equal(await page.getByText('Did this find your problem?').isVisible(), true);
    for (const [id, answer] of [['#feedback-yes', 'Yes'], ['#feedback-no', 'No']]) {
      const href = await page.getAttribute(id, 'href');
      const url = new URL(href);
      assert.equal(`${url.origin}${url.pathname}`, 'https://github.com/CyberNative-AI/whatsapp-webhook-check/issues/new');
      assert.equal(await page.getAttribute(id, 'target'), '_blank');
      const text = `${url.searchParams.get('title')}\n${url.searchParams.get('body')}`;
      assert.match(text, new RegExp(`Did the check find your problem\\?\\*\\* ${answer}`));
      assert.match(text, /Broken at layer 2: WABA app link/);
      for (const secret of ['1001', '2002', '3003', 'n8n.example.com', 'webhook/abc', 'test-user-token', 'Example App']) assert.ok(!text.includes(secret), `${secret} leaked into the issue`);
    }
    assert.ok(requests.every(url => !url.startsWith('https://github.com')), 'showing the links sends nothing to GitHub');
    await assertNoStorage(page, context);
  } finally { await context.close(); }
});
