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

let server;
let browser;
let origin;

test.before(async () => {
  server = createServer(async (request, response) => {
    const file = { '/': 'index.html', '/index.html': 'index.html', '/page.js': 'page.js', '/engine.js': 'engine.js' }[new URL(request.url, 'http://localhost').pathname];
    if (!file) { response.writeHead(404).end(); return; }
    const content = await readFile(new URL(`../${file}`, import.meta.url));
    response.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : 'text/javascript', 'Cache-Control': 'no-store' });
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

async function newPage(wabaApps = fixture.responses.wabaApps) {
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
  await page.fill('#callback-url', 'https://n8n.example.com/webhook/abc');
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
    await page.getByLabel('Read Graph with tokens (GET only)').check();
    await page.fill('#user-token', 'test-user-token');
    await page.fill('#app-token', 'test-app-token');
    await page.getByRole('button', { name: 'Check layers' }).click();
    await page.getByText('No failure found in checked layers.', { exact: false }).waitFor();
    assert.equal(requests.length, 4, JSON.stringify(requests));
    assert.ok(requests.every(item => item.url.startsWith('https://graph.facebook.com/v25.0/') && item.method === 'GET'));
    assert.ok(requests.every(item => !item.url.includes('test-user-token') && !item.url.includes('test-app-token')));
    assert.ok(requests.some(item => item.authorization === 'Bearer test-user-token'));
    assert.ok(requests.some(item => item.authorization === 'Bearer test-app-token'));
    assert.deepEqual(external, []);
    assert.equal(await page.inputValue('#user-token'), '');
    assert.equal(await page.inputValue('#app-token'), '');
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
    await page.getByRole('button', { name: 'Check layers' }).click();
    await page.getByText('No failure found in checked layers.', { exact: false }).waitFor();
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
    await page.getByLabel('Read Graph with tokens (GET only)').check();
    await page.fill('#user-token', 'test-user-token');
    await page.getByRole('button', { name: 'Check layers' }).click();
    await page.getByText('First layer needing attention: 2.', { exact: false }).waitFor();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'GET');
    assert.match(requests[0].url, /\/v25\.0\/1001\/subscribed_apps$/);
    assert.match(await page.locator('#results').innerText(), /curl -X POST 'https:\/\/graph\.facebook\.com\/v25\.0\/1001\/subscribed_apps'/);
    assert.deepEqual(external, []);
    await assertNoStorage(page, context);
  } finally { await context.close(); }
});
