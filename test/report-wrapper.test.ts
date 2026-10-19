import { beforeEach, describe, expect, it } from 'vitest';
import { buildReport, checkWrappers, formatReport, suggestDeclaration } from '../src/index.js';
import { BASE, makeLibrary, put } from './fixture.js';

let root: string;
beforeEach(async () => {
  root = await makeLibrary();
});

describe('suggestDeclaration', () => {
  it('writes only the keys that are needed', () => {
    const s = (annotation: boolean, assertionFast: boolean, assertionFull: boolean) => suggestDeclaration({ annotation, assertionFast, assertionFull });
    expect(s(true, true, true)).toEqual({ valid: true });
    expect(s(true, false, false)).toEqual({ valid: true, 'valid@when_formatAssertion': false });
    expect(s(true, true, false)).toEqual({ valid: true, 'valid@when_formatAssertionFull': false });
    expect(s(true, false, true)).toEqual({ valid: true, 'valid@when_formatAssertion': false, 'valid@when_formatAssertionFull': true });
    expect(s(false, true, true)).toEqual({ valid: false, 'valid@when_formatAssertion': true });
  });
});

describe('buildReport', () => {
  it('lists format-dependent and mismatching examples with the keys to write', async () => {
    await put(root, 'examples/0/1/main_defs-when.json-examples.json', {
      jsons: [
        { group: 'property:defs', label: 'plain', valid: true, instance: '2020-01-01' },
        { group: 'property:defs', label: 'calendar-invalid date: fast accepts, full rejects', valid: true, instance: '2021-02-29' }, // undeclared
        { group: 'property:defs', label: 'declared', valid: true, 'valid@when_formatAssertionFull': false, instance: '2021-02-29' },
      ],
    });
    const { items, problems } = await buildReport({ root });
    expect(problems).toEqual([]);
    expect(items.map((i) => i.label)).toEqual(['calendar-invalid date: fast accepts, full rejects', 'declared']);
    expect(items[0]).toMatchObject({ mismatch: true, formatSensitive: true, suggested: { valid: true, 'valid@when_formatAssertionFull': false } });
    expect(items[1]).toMatchObject({ mismatch: false, formatSensitive: true });
    expect(formatReport(items)).toMatch(/MISMATCH[\s\S]*suggested: "valid": true, "valid@when_formatAssertionFull": false/);
    expect((await buildReport({ root, all: true })).items).toHaveLength(3);
  });

  it('notes when a format-assert copy disagrees with the assertion it replaces', async () => {
    await put(root, 'examples/0/1/main_defs-when.json-examples.json', { jsons: [{ group: 'property:defs', valid: true, 'valid@when_formatAssertionFull': false, instance: '2021-02-29' }] });
    // an (intentionally wrong) full copy that accepts everything
    await put(root, 'schema/0.1.0/format-assert-full/main.schema.json', { $id: `${BASE}/format-assert-full/main.schema.json`, $defs: { when: { type: 'string' } } });
    const { items } = await buildReport({ root });
    expect(items[0]!.notes.join()).toMatch(/format-assert-full \(valid\) differs from assertion\/full \(invalid\)/);
  });
});

describe('checkWrappers', () => {
  const wrapper = (hookRef: string) => ({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    allOf: [{ $ref: 'https://example.test/json-examples.schema.json' }],
    $defs: { _hook_valid: { $ref: hookRef } },
    type: 'object',
    properties: {
      jsons: {
        type: 'array',
        items: {
          type: 'object',
          if: { properties: { valid: { const: true } } },
          then: { properties: { instance: { $ref: '#/$defs/_hook_valid' } } },
          else: { properties: { instance: { not: { $ref: '#/$defs/_hook_valid' } } } },
        },
      },
    },
  });

  it('accepts consistent files and reports contradictions, resolving remote refs through refMap', async () => {
    await put(root, 'meta/json-examples.schema.json', { $id: 'https://example.test/json-examples.schema.json', type: 'object', required: ['jsons'] });
    await put(root, 'examples/0/1/schema/main.json-examples.schema.json', wrapper('../../../../schema/0.1.0/main.schema.json'));
    const id = '123e4567-e89b-12d3-a456-426614174000';
    await put(root, 'examples/0/1/main.json-examples.json', { jsons: [{ group: 'basic', valid: true, instance: { id } }, { group: 'basic', valid: false, instance: {} }] });
    const refMap = { 'https://example.test/json-examples.schema.json': 'meta/json-examples.schema.json' };
    expect(await checkWrappers({ root, refMap })).toEqual([]);

    await put(root, 'examples/0/1/main.json-examples.json', { jsons: [{ group: 'basic', valid: true, instance: {} }] }); // says valid, schema disagrees
    const found = await checkWrappers({ root, refMap });
    expect(found.join('\n')).toMatch(/main\.json-examples\.json.*wrapper|<->/);
    expect(found.length).toBeGreaterThan(0);
  });

  it('reports a wrapper whose remote $ref cannot be loaded instead of crashing', async () => {
    await put(root, 'examples/0/1/schema/main.json-examples.schema.json', wrapper('../../../../schema/0.1.0/main.schema.json'));
    await put(root, 'examples/0/1/main.json-examples.json', { jsons: [] });
    const found = await checkWrappers({ root, refMap: { 'https://example.test/json-examples.schema.json': 'does/not/exist.json' } });
    expect(found.join()).toMatch(/cannot check/);
  });
});
