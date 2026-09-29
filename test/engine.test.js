import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { check, firstBlocking, firstProblem } from '../engine.js';

const fixtures = JSON.parse(await readFile(new URL('../fixtures/cases.json', import.meta.url)));
const base = fixtures[0].input;

function withOverrides(fixture) {
  const input = structuredClone(base);
  for (const [path, value] of Object.entries(fixture.overrides ?? {})) {
    const keys = path.split('.');
    let cursor = input;
    for (const key of keys.slice(0, -1)) cursor = cursor[key];
    cursor[keys.at(-1)] = value;
  }
  return input;
}

for (const fixture of fixtures) {
  test(`first failing layer: ${fixture.name}`, () => {
    assert.ok(fixture.sources.length, 'fixture source citation is required');
    const layers = check(withOverrides(fixture));
    assert.deepEqual(layers.map(item => item.id), [1, 2, 3, 4, 5]);
    assert.ok(layers.every(item => ['pass', 'warn', 'fail', 'not checked'].includes(item.status)));
    assert.ok(layers.every(item => 'evidence' in item && typeof item.fix === 'string' && item.fix.length > 0));
    const first = layers.find(item => item.status === 'fail' || item.message.startsWith('Cannot check:'));
    assert.equal(first?.id ?? null, fixture.expected.id, `first failing layer for ${fixture.name}`);
    if (first) {
      assert.ok(first.message.includes(fixture.expected.message), `first failing message for ${fixture.name}: ${first.message}`);
      assert.equal(first.status, fixture.expected.status ?? 'fail');
      assert.ok(layers.slice(0, first.id - 1).every(item => item.status === 'pass'));
    } else {
      assert.equal(layers[4].status, 'not checked', 'challenge is manual');
    }
  });
}

test('optional app subscription can be omitted without a false pass', () => {
  const input = withOverrides({ overrides: { 'responses.appSubscriptions': undefined } });
  const layers = check(input);
  assert.equal(layers[2].status, 'not checked');
  assert.match(layers[2].message, /Optional app subscription was not checked/);
  assert.equal(layers[3].status, 'pass');
});

test('incomplete phone membership page cannot prove absence', () => {
  const input = withOverrides({ overrides: { 'responses.wabaPhones': { data: [], paging: { next: 'next-page' } } } });
  const layers = check(input);
  assert.equal(layers[3].status, 'not checked');
  assert.match(layers[3].message, /Cannot check/);
});

test('a layer 3 Graph error is marked cannot check and layer 4 still runs', () => {
  for (const error of [{ code: 190, message: 'Invalid OAuth access token.' }, { code: 100, message: 'Unsupported get request.' }, { code: 'invalid JSON', message: 'Could not parse.' }]) {
    const layers = check(withOverrides({ overrides: { 'responses.appSubscriptions': { error } } }));
    assert.equal(layers[2].status, 'not checked');
    assert.match(layers[2].message, /^Cannot check:/);
    assert.equal(layers[3].status, 'pass', 'phone check runs after an optional layer 3 error');
    assert.equal(firstBlocking(layers), null);
    assert.equal(firstProblem(layers).id, 3);
  }
});

test('a layer 3 error does not hide a broken phone at layer 4', () => {
  const layers = check(withOverrides({ overrides: {
    'responses.appSubscriptions': { error: { code: 190, message: 'Invalid OAuth access token.' } },
    'responses.wabaPhones': { data: [{ id: '9999' }] },
  } }));
  assert.equal(layers[2].status, 'not checked');
  assert.equal(layers[3].status, 'fail');
  assert.match(layers[3].message, /Phone number is not in the supplied WABA/);
  assert.equal(firstBlocking(layers).id, 4);
});

test('a layer 2 Graph error still stops the later layers', () => {
  const layers = check(withOverrides({ overrides: { 'responses.wabaApps': { error: { code: 190, message: 'expired' } } } }));
  assert.equal(firstBlocking(layers).id, 2);
  assert.ok(layers.slice(2, 4).every(item => item.message === 'Not checked because an earlier layer needs attention.'));
});

test('a real layer 3 failure still stops layer 4', () => {
  const layers = check(withOverrides({ overrides: { 'responses.appSubscriptions': { data: [] } } }));
  assert.equal(layers[2].status, 'fail');
  assert.equal(layers[3].message, 'Not checked because an earlier layer needs attention.');
});

test('app callback on this workflow\'s test URL is named as the test URL', () => {
  const layers = check(withOverrides({ overrides: { 'responses.appSubscriptions.data': [{ object: 'whatsapp_business_account', callback_url: 'https://n8n.example.com/webhook-test/abc', fields: [{ name: 'messages' }], active: true }] } }));
  assert.equal(layers[2].status, 'fail');
  assert.match(layers[2].message, /this workflow's test URL/);
  assert.match(layers[2].fix, /stop test listening/);
});

test('another callback on the app names the conflict error and warns against the WABA DELETE', () => {
  const layers = check(withOverrides({ overrides: { 'responses.appSubscriptions.data': [{ object: 'whatsapp_business_account', callback_url: 'https://old.example.net/webhook/zzz', fields: [{ name: 'messages' }], active: true }] } }));
  assert.match(layers[2].message, /already has a webhook subscription/);
  assert.match(layers[2].fix, /Do not DELETE \/\{WABA_ID\}\/subscribed_apps/);
});

test('a custom N8N_ENDPOINT_WEBHOOK path warns and the check continues', () => {
  const custom = 'https://n8n.example.com/hooks/abc';
  const layers = check(withOverrides({ overrides: {
    callbackUrl: custom,
    'responses.appSubscriptions.data': [{ object: 'whatsapp_business_account', callback_url: custom, fields: [{ name: 'messages' }], active: true }],
  } }));
  assert.equal(layers[0].status, 'warn');
  assert.match(layers[0].message, /N8N_ENDPOINT_WEBHOOK/);
  assert.deepEqual(layers.slice(1, 4).map(item => item.status), ['pass', 'pass', 'pass']);
  assert.equal(firstProblem(layers), null);
});

test('a custom path does not excuse /webhook-test/, HTTP, or a query string', () => {
  for (const [url, message] of [
    ['https://n8n.example.com/webhook-test/abc', /webhook-test/],
    ['http://n8n.example.com/hooks/abc', /public HTTPS/],
    ['https://n8n.example.com/hooks/abc?x=1', /query/],
  ]) {
    const layers = check(withOverrides({ overrides: { callbackUrl: url } }));
    assert.equal(layers[0].status, 'fail', url);
    assert.match(layers[0].message, message);
  }
});

test('private and non-public callback hosts fail layer 1', () => {
  for (const host of ['[::1]', '[::]', '[fd12:3456::1]', '[fc00::1]', '[fe80::1]', '[fec0::1]', '[ff02::1]', '[2001:db8::1]',
    '[::ffff:127.0.0.1]', '[::ffff:192.168.1.10]', '[::ffff:10.0.0.1]', '100.64.0.1', '100.127.255.254', '10.0.0.5', '172.20.0.1',
    'localhost', 'n8n', 'n8n.local', 'box.internal', 'router.lan', 'nas.home.arpa']) {
    const layers = check(withOverrides({ overrides: { callbackUrl: `https://${host}/webhook/abc` } }));
    assert.equal(layers[0].status, 'fail', host);
    assert.match(layers[0].message, /public HTTPS/, host);
  }
});

test('public IPv4 and IPv6 callback hosts pass layer 1', () => {
  for (const host of ['[2606:4700:4700::1111]', '[2a00:1450:4001:82b::200e]', '[::ffff:8.8.8.8]', '100.128.0.1', '8.8.8.8']) {
    const layers = check(withOverrides({ overrides: { callbackUrl: `https://${host}/webhook/abc` } }));
    assert.equal(layers[0].status, 'pass', host);
  }
});

const PRODUCTION = base.callbackUrl;
const ELSEWHERE = 'https://override.example.org/webhook';
const wabaWithOverride = uri => ({ data: [{ whatsapp_business_api_data: { id: '2002', name: 'Example App' }, override_callback_uri: uri }] });

test('a WABA override to another URL breaks layer 2 and names that URL', () => {
  const layers = check(withOverrides({ overrides: { 'responses.wabaApps': wabaWithOverride(ELSEWHERE) } }));
  assert.equal(layers[1].status, 'fail');
  assert.ok(layers[1].message.includes(ELSEWHERE));
  assert.equal(firstBlocking(layers).id, 2);
  assert.match(layers[1].fix, /moves messages away from whatever set it/);
  assert.match(layers[1].fix, /POST \/1001\/subscribed_apps with no body/);
  assert.match(layers[1].fix, /curl -X POST 'https:\/\/graph\.facebook\.com\/v25\.0\/1001\/subscribed_apps' -H 'Authorization: Bearer <USER_ACCESS_TOKEN>'$/, 'the removal POST carries no body');
});

test('an override on another app in the WABA does not break layer 2', () => {
  const layers = check(withOverrides({ overrides: { 'responses.wabaApps': { data: [
    { whatsapp_business_api_data: { id: '2002', name: 'Example App' } },
    { whatsapp_business_api_data: { id: '9999', name: 'Other App' }, override_callback_uri: ELSEWHERE },
  ] } } }));
  assert.equal(layers[1].status, 'pass');
});

test('a WABA override equal to the Production URL passes layer 2', () => {
  const layers = check(withOverrides({ overrides: { 'responses.wabaApps': wabaWithOverride(PRODUCTION) } }));
  assert.equal(layers[1].status, 'pass');
  assert.match(layers[1].message, /override URL is your n8n Production URL/);
  assert.equal(firstProblem(layers), null);
});

test('a phone override to another URL breaks layer 4 with the user-run removal', () => {
  const layers = check(withOverrides({ overrides: { 'responses.phone.webhook_configuration': { phone_number: ELSEWHERE, application: PRODUCTION } } }));
  assert.deepEqual(layers.slice(0, 3).map(item => item.status), ['pass', 'pass', 'pass']);
  assert.equal(layers[3].status, 'fail');
  assert.ok(layers[3].message.includes(ELSEWHERE));
  assert.match(layers[3].fix, /moves messages away from whatever set it/);
  assert.ok(layers[3].fix.includes(`-d '{"webhook_configuration":{"override_callback_uri":""}}'`));
  assert.ok(layers[3].fix.includes("curl -X POST 'https://graph.facebook.com/v25.0/3003'"));
});

test('a phone override is found even when optional layer 3 cannot be checked', () => {
  const layers = check(withOverrides({ overrides: {
    'responses.appSubscriptions': { error: { code: 190, message: 'Invalid OAuth access token.' } },
    'responses.phone.webhook_configuration': { phone_number: ELSEWHERE, application: PRODUCTION },
  } }));
  assert.equal(layers[2].status, 'not checked');
  assert.equal(firstBlocking(layers).id, 4);
});

test('a phone override equal to the Production URL passes layer 4', () => {
  const layers = check(withOverrides({ overrides: { 'responses.phone.webhook_configuration': { phone_number: PRODUCTION, application: PRODUCTION } } }));
  assert.equal(layers[3].status, 'pass');
  assert.match(layers[3].message, /override URL is your n8n Production URL/);
});

test('with no override fields, layers 2 and 4 behave as before and claim nothing about overrides', () => {
  const layers = check(withOverrides({}));
  assert.deepEqual(layers.map(item => item.status), ['pass', 'pass', 'pass', 'pass', 'not checked']);
  assert.equal(firstProblem(layers), null);
  assert.match(layers[3].message, /no webhook_configuration, so the phone override was not read/);
  assert.doesNotMatch(layers[3].message, /no override URL/);
});
