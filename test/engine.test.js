import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { check } from '../engine.js';

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
    assert.ok(layers.every(item => ['pass', 'fail', 'not checked'].includes(item.status)));
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
