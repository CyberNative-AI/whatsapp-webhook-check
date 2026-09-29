// Deliberately disables layer 2 in a disposable in-memory copy; this test must fail.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./engine.js', import.meta.url), 'utf8');
const original = '() => wabaCheck(responses.wabaApps, appId, wabaId),';
assert.ok(source.includes(original), 'negative control mutation target exists');
const mutant = source.replace(original, "() => layer(1, 'pass', 'Disabled', null, 'No change needed.'),");
const { check } = await import(`data:text/javascript;base64,${Buffer.from(mutant).toString('base64')}`);
const fixtures = JSON.parse(await readFile(new URL('./fixtures/cases.json', import.meta.url)));
const input = structuredClone(fixtures[0].input);
input.responses.wabaApps = { data: [] };

test('negative control: empty subscribed_apps must fail at layer 2', () => {
  const first = check(input).find(item => item.status === 'fail' || item.message.startsWith('Cannot check:'));
  assert.equal(first?.id, 2, 'empty subscribed_apps must fail at layer 2');
});
