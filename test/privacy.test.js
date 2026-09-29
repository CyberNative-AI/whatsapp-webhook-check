import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import test from 'node:test';
import { chromium } from 'playwright';

const fixture = JSON.parse(await readFile(new URL('../fixtures/cases.json', import.meta.url)))[0].input;
const bodyForPath = (path, wabaApps, phone = fixture.responses.phone) => {
  if (path.endsWith('/subscribed_apps')) return wabaApps;
  if (path.endsWith('/subscriptions')) return fixture.responses.appSubscriptions;
  if (path.endsWith('/phone_numbers')) return fixture.responses.wabaPhones;
  if (path.includes('/3003')) return phone;
  throw new Error(`Unexpected Graph path: ${path}`);
};

const STATIC_FILES = ['index.html', 'page.js', 'engine.js', 'style.css', 'assets/mark.svg',
  ...['Fraunces144ptSoft-SemiBold', 'IBMPlexSans-Regular', 'IBMPlexSans-SemiBold', 'IBMPlexMono-Regular-Latin1', 'IBMPlexMono-Medium-Latin1'].map(name => `assets/fonts/${name}.woff2`)];
const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', woff2: 'font/woff2' };
const ALL_CLEAR = 'No broken layer found in what could be checked';

// Leak control: FEEDBACK_LEAK_CONTROL=1 serves a page.js that appends the pasted callback URL to the
// feedback issue body. The feedback canary tests below must then fail.
const LEAK_TARGET = "url.searchParams.set('body', body);";
// Repair leak control: REPAIR_LEAK_CONTROL=1 serves a page.js that appends the pasted callback URL to the
// repair mailto when a result is shown. The repair canary assertions below must then fail.
const REPAIR_LEAK_TARGET = '  repair.hidden = false;\n';
async function servedSource(file) {
  const content = await readFile(new URL(`../${file}`, import.meta.url));
  if (file !== 'page.js') return content;
  let source = content.toString('utf8');
  if (process.env.FEEDBACK_LEAK_CONTROL === '1') {
    assert.ok(source.includes(LEAK_TARGET), 'leak control mutation target exists');
    source = source.replace(LEAK_TARGET, "url.searchParams.set('body', `${body}\\n${byId('callback-url').value}`);");
  }
  if (process.env.REPAIR_LEAK_CONTROL === '1') {
    assert.ok(source.includes(REPAIR_LEAK_TARGET), 'repair leak control mutation target exists');
    source = source.replace(REPAIR_LEAK_TARGET, `${REPAIR_LEAK_TARGET}  byId('repair-mail').href += encodeURIComponent(\`\\n\${byId('callback-url').value}\`);\n`);
  }
  return source;
}

let server;
let browser;
let origin;

test.before(async () => {
  server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const file = path === '/' ? 'index.html' : STATIC_FILES.find(name => `/${name}` === path);
    if (!file) { response.writeHead(404).end(); return; }
    const content = await servedSource(file);
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

async function newPage(wabaApps = fixture.responses.wabaApps, callbackUrl = 'https://n8n.example.com/webhook/abc', phone = fixture.responses.phone) {
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
    if (url.origin === 'https://graph.facebook.com') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bodyForPath(url.pathname, wabaApps, phone)) });
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
    const phoneRead = new URL(requests.find(item => /\/v25\.0\/3003\?/.test(item.url)).url);
    assert.ok(phoneRead.searchParams.get('fields').split(',').includes('webhook_configuration'), 'the phone read includes the override field');
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

test('token mode: a phone override is read in the same 3 GETs and its removal is shown, never sent', async () => {
  const phone = { ...fixture.responses.phone, webhook_configuration: { phone_number: 'https://override.example.org/phone-webhook', application: 'https://n8n.example.com/webhook/abc' } };
  const { context, page, external } = await newPage(fixture.responses.wabaApps, 'https://n8n.example.com/webhook/abc', phone);
  try {
    const requests = [];
    page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
    await page.getByLabel('Use a token (GET only)').check();
    await page.fill('#user-token', 'test-user-token');
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText('Broken at layer 4', { exact: false }).waitFor();
    assert.equal(requests.length, 3, JSON.stringify(requests));
    assert.ok(requests.every(item => item.method === 'GET'));
    const result = await page.locator('.result').innerText();
    assert.match(result, /override URL, https:\/\/override\.example\.org\/phone-webhook/);
    assert.ok(result.includes(`curl -X POST 'https://graph.facebook.com/v25.0/3003' -H 'Authorization: Bearer <USER_ACCESS_TOKEN>' -H 'Content-Type: application/json' -d '{"webhook_configuration":{"override_callback_uri":""}}'`));
    assert.deepEqual(external, []);
    await assertNoStorage(page, context);
  } finally { await context.close(); }
});

const WABA_OVERRIDE = { data: [{ whatsapp_business_api_data: { id: '2002', name: 'Example App' }, override_callback_uri: 'https://override.example.org/webhook' }] };
const phoneWith = phoneNumber => ({ ...fixture.responses.phone, webhook_configuration: { phone_number: phoneNumber, whatsapp_business_account: 'https://override.example.org/webhook', application: 'https://n8n.example.com/webhook/abc' } });

test('token mode: a WABA override does not stop the check before the phone read; phone = URL finds nothing broken', async () => {
  const { context, page, external } = await newPage(WABA_OVERRIDE, 'https://n8n.example.com/webhook/abc', phoneWith('https://n8n.example.com/webhook/abc'));
  try {
    const requests = [];
    page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
    await page.getByLabel('Use a token (GET only)').check();
    await page.fill('#user-token', 'test-user-token');
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText(ALL_CLEAR, { exact: false }).waitFor();
    assert.equal(requests.length, 3, JSON.stringify(requests));
    assert.ok(requests.every(item => item.method === 'GET'));
    const result = await page.locator('.result').innerText();
    assert.match(result, /does not route this number, because the phone number has its own override/);
    assert.ok(!result.includes('subscribed_apps with no body'), 'no WABA removal is offered');
    assert.deepEqual(external, []);
    await assertNoStorage(page, context);
  } finally { await context.close(); }
});

test('token mode: with both overrides elsewhere, the first broken layer is 4 and the fix is the phone removal', async () => {
  const { context, page, external } = await newPage(WABA_OVERRIDE, 'https://n8n.example.com/webhook/abc', phoneWith('https://override.example.org/phone-webhook'));
  try {
    const requests = [];
    page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
    await page.getByLabel('Use a token (GET only)').check();
    await page.fill('#user-token', 'test-user-token');
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText('Broken at layer 4', { exact: false }).waitFor();
    assert.equal(requests.length, 3, JSON.stringify(requests));
    assert.ok(requests.every(item => item.method === 'GET'));
    const fix = await page.locator('.one-fix').innerText();
    assert.ok(fix.includes(`-d '{"webhook_configuration":{"override_callback_uri":""}}'`));
    assert.ok(!(await page.locator('.result').innerText()).includes('subscribed_apps with no body'));
    assert.deepEqual(external, []);
    await assertNoStorage(page, context);
  } finally { await context.close(); }
});

// Feedback canaries: every verdict path, in both modes, with distinctive synthetic inputs.
// The prefilled issue may hold only fixed text; none of these values may reach it, raw, decoded or encoded.
const C = {
  token: 'EAAtestSECRET7731', waba: '998877665544332', app: '887766554433221', phone: '776655443322110', other: '665544332211009',
  tel: '+15550001234', telSpaced: '+1 555 000 1234', appName: 'CanaryAppLeakco', biz: 'CanaryBizName',
  host: 'leak-canary.example', callback: 'https://leak-canary.example/webhook/abc', verify: 'canary-verify-42',
  overrideHost: 'override-canary.example',
};
const canaryInput = value => JSON.parse(JSON.stringify(value)
  .replaceAll('1001', C.waba).replaceAll('2002', C.app).replaceAll('3003', C.phone).replaceAll('4444', C.other)
  .replaceAll('+1 555 0100', C.tel).replaceAll('+1 555 0101', C.telSpaced)
  .replaceAll('Example App', C.appName).replaceAll('WA DevX Webhook Events', C.appName).replaceAll('"Example"', `"${C.biz}"`)
  .replaceAll('n8n.example.com', C.host).replaceAll('override.example.org', C.overrideHost));
const allFixtures = JSON.parse(await readFile(new URL('../fixtures/cases.json', import.meta.url)));
const canaryCases = allFixtures.map(item => {
  const input = structuredClone(fixture);
  for (const [path, value] of Object.entries(item.overrides ?? {})) {
    const keys = path.split('.');
    let cursor = input;
    for (const key of keys.slice(0, -1)) cursor = cursor[key];
    cursor[keys.at(-1)] = value;
  }
  return { name: item.name, input: canaryInput(input) };
});
const healthy = canaryInput(fixture);
canaryCases.push(
  { name: 'custom path warning', input: { ...healthy, callbackUrl: `https://${C.host}/hooks/abc` } },
  { name: 'layer 3 Graph error', input: { ...healthy, responses: { ...healthy.responses, appSubscriptions: { error: { message: 'x', type: 'OAuthException', code: 190 } } } } },
  { name: 'layer 3 invalid JSON', input: { ...healthy, responses: { ...healthy.responses, appSubscriptions: `{not json ${C.waba}` } } },
  { name: 'layer 3 error and broken phone', input: { ...healthy, responses: { ...healthy.responses, appSubscriptions: { error: { message: 'x', code: 100 } }, wabaPhones: { data: [{ id: C.other, display_phone_number: C.telSpaced }] } } } },
  { name: 'layer 3 error and phone override', input: { ...healthy, responses: { ...healthy.responses, appSubscriptions: { error: { message: 'x', code: 190 } }, phone: { ...healthy.responses.phone, webhook_configuration: { phone_number: `https://${C.overrideHost}/phone`, whatsapp_business_account: `https://${C.overrideHost}/waba`, application: C.callback } } } } },
);

function feedbackLeaks(href) {
  const url = new URL(href);
  const forms = [href, decodeURIComponent(href), `${url.searchParams.get('title')}\n${url.searchParams.get('body')}`];
  const found = [];
  for (const value of Object.values(C)) {
    for (const needle of [value, encodeURIComponent(value), encodeURIComponent(value).replaceAll('%20', '+')]) if (forms.some(form => form.includes(needle))) found.push(value);
  }
  if (forms.some(form => /curl|hub\.challenge|hub\.verify_token|"data"|callback_url|override_callback_uri|webhook_configuration/.test(form))) found.push('command or JSON');
  return [...new Set(found)];
}

const REPAIR_PAGE = 'https://cybernative.ai/services/automation-repair/';
const REPAIR_SUBJECT = 'Workflow repair: WhatsApp webhook check';
const REPAIR_MAILTO = `mailto:hello@cybernative.ai?subject=${encodeURIComponent(REPAIR_SUBJECT)}&body=${encodeURIComponent('What the workflow should do:\n\n\nWhat happens instead:\n\n\nRemove credentials from the workflow export before you attach it. Use redacted or made-up records. Never send tokens or keys.')}`;
function repairLeaks(href) {
  const forms = [href, decodeURIComponent(href)];
  const found = [];
  for (const value of Object.values(C)) {
    for (const needle of [value, encodeURIComponent(value), encodeURIComponent(value).replaceAll('%20', '+')]) if (forms.some(form => form.includes(needle))) found.push(value);
  }
  if (forms.some(form => /curl|hub\.challenge|hub\.verify_token|"data"|callback_url|override_callback_uri|webhook_configuration|https?:\/\//.test(form))) found.push('command, JSON or URL');
  return [...new Set(found)];
}

async function feedbackFor(input, mode) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { responses } = input;
  const graphBody = path => path.endsWith('/subscribed_apps') ? responses.wabaApps : path.endsWith('/phone_numbers') ? responses.wabaPhones : responses.phone;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.origin === 'https://graph.facebook.com') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(graphBody(url.pathname)) });
    return route.abort();
  });
  try {
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.fill('#waba-id', input.wabaId);
    await page.fill('#app-id', input.appId);
    await page.fill('#phone-id', input.phoneNumberId);
    await page.fill('#callback-url', input.callbackUrl);
    const text = value => typeof value === 'string' ? value : JSON.stringify(value);
    if (mode === 'token') {
      await page.getByLabel('Use a token (GET only)').check();
      await page.fill('#user-token', C.token);
    } else {
      await page.fill('#waba-json', text(responses.wabaApps));
      await page.fill('#phone-json', text(responses.phone));
      await page.fill('#waba-phones-json', text(responses.wabaPhones));
    }
    await page.fill('#subscriptions-json', text(responses.appSubscriptions));
    await page.click('#verify-toggle');
    await page.fill('#verify-token', C.verify);
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.waitForSelector('#feedback:not([hidden])', { timeout: 5000 });
    return {
      summary: (await page.innerText('#summary')).split('\n')[0], yes: await page.getAttribute('#feedback-yes', 'href'), no: await page.getAttribute('#feedback-no', 'href'),
      repairVisible: await page.isVisible('#repair'), mail: await page.getAttribute('#repair-mail', 'href'), repairPage: await page.getAttribute('#repair-page', 'href'),
    };
  } finally { await context.close(); }
}

for (const { name, input } of canaryCases) {
  for (const mode of ['paste', 'token']) {
    test(`feedback and repair links carry no canary: ${name} [${mode}]`, async t => {
      const result = await feedbackFor(input, mode);
      t.diagnostic(`${name} [${mode}] -> ${result.summary}`);
      for (const href of [result.yes, result.no]) assert.deepEqual(feedbackLeaks(href), [], `leak in ${href}`);
      assert.equal(result.repairVisible, true, 'the repair route is shown after every result');
      assert.deepEqual(repairLeaks(result.mail), [], `leak in the repair mailto ${result.mail}`);
      assert.equal(result.mail, REPAIR_MAILTO, 'the repair mailto is fixed text only');
      assert.equal(result.repairPage, REPAIR_PAGE);
    });
  }
}

test('repair route: hidden before a result, then one quiet line after a fix and on cannot check', async () => {
  const { context, page } = await newPage({ data: [] });
  try {
    assert.equal(await page.isVisible('#repair'), false, 'no repair route before a check runs');
    await page.fill('#waba-json', '{"data": []}');
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText('Broken at layer 2', { exact: false }).waitFor();
    assert.equal(await page.isVisible('.one-fix'), true);
    assert.equal(await page.isVisible('#repair'), true, 'shown after a fix');
    const order = await page.evaluate(() => ['#summary', '#fix', '#feedback', '#repair'].map(sel => document.querySelector(sel)).every((node, i, all) => !i || all[i - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
    assert.ok(order, 'the repair route comes after the verdict, the fix and the feedback question');
    const text = await page.innerText('#repair');
    assert.match(text, /reproduce the failure first, and if we can’t, you pay nothing/);
    assert.match(text, /fixed price and an acceptance test that passes on your side/);
    assert.match(text, /never tokens or keys/);
    assert.match(text, /Meta-side causes, such as an account in review or a disabled number, are outside repair/);
    assert.doesNotMatch(text, /\$|\bdays?\b|hours?|guarantee/i, 'no price or time promise');
    assert.equal(await page.getAttribute('#repair-mail', 'href'), REPAIR_MAILTO);
    assert.equal(new URL(await page.getAttribute('#repair-mail', 'href')).searchParams.get('subject'), REPAIR_SUBJECT);
    assert.equal(await page.getAttribute('#repair-page', 'href'), REPAIR_PAGE);
    assert.equal(await page.getAttribute('#repair-page', 'target'), '_blank', 'the result stays open');

    await page.fill('#waba-json', '{"error": {"code": 190, "message": "Invalid OAuth access token."}}');
    await page.getByRole('button', { name: 'Find the broken layer' }).click();
    await page.getByText('Cannot check layer 2', { exact: false }).waitFor();
    assert.equal(await page.isVisible('#repair'), true, 'shown on cannot check');
    assert.equal(await page.getAttribute('#repair-mail', 'href'), REPAIR_MAILTO);
  } finally { await context.close(); }
});
