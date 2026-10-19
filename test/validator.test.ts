import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runExamples } from '../src/index.js';
import { BASE, makeLibrary, put } from './fixture.js';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
let root: string;

beforeEach(async () => {
  root = await makeLibrary();
});

const examples = (jsons: unknown[]) => put(root, 'examples/0/1/main.json-examples.json', { jsons });

describe('runExamples: basics', () => {
  it('passes valid/invalid examples and checks expectedErrors', async () => {
    await examples([
      { group: 'basic', valid: true, instance: { id: UUID, child: { n: 2 } } },
      { group: 'basic', valid: false, instance: { id: UUID, child: { n: 0 } }, expectedErrors: [{ instanceLocation: '/child/n', keyword: 'minimum', message: 'must be >= 1' }] },
      { group: 'basic', valid: false, instance: {}, expectedErrors: [{ instanceLocation: '', keyword: 'required', message: { regex: 'required', keyword: 'id' } }] },
    ]);
    const res = await runExamples({ root, profiles: ['annotation'] });
    expect(res.problems).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(res.passed).toBe(3);
  });

  it('reports a wrong valid flag and missing expected errors', async () => {
    await examples([
      { group: 'basic', valid: true, instance: {} },
      { group: 'basic', valid: false, instance: { id: UUID, child: { n: 0 } }, expectedErrors: [{ instanceLocation: '/child/n', keyword: 'maximum' }] },
    ]);
    const res = await runExamples({ root, profiles: ['annotation'] });
    expect(res.failed.map((f) => f.case.index)).toEqual([0, 1]);
    expect(res.failed[0]!.outcome.failures[0]).toMatch(/expected valid, got invalid.*required/);
    expect(res.failed[1]!.outcome.failures[0]).toMatch(/expected error not produced.*keyword minimum/);
    expect(res.ok).toBe(false);
  });

  it('exactErrors requires the same number of errors', async () => {
    await examples([{ group: 'basic', valid: false, instance: { child: { n: 0 } }, expectedErrors: [{ instanceLocation: '/child/n', keyword: 'minimum' }] }]);
    expect((await runExamples({ root, profiles: ['annotation'] })).ok).toBe(true);
    expect((await runExamples({ root, profiles: ['annotation'], exactErrors: true })).ok).toBe(false);
  });

  it('_defs-<DeF> in the file name selects the target; groupPointer never changes the result', async () => {
    await examples([
      { group: 'property', groupPointer: '/properties/child', valid: true, instance: { id: UUID } },
      { group: 'property', groupPointer: '/properties/id', valid: false, instance: { id: 5 } }, // validated against the ROOT, not against /properties/id
    ]);
    await put(root, 'examples/0/1/main_defs-when.json-examples.json', {
      jsons: [{ group: 'property:defs', groupPointer: '/properties/child', valid: true, instance: '2020-01-01' }, { group: 'property:defs', valid: false, instance: 5 }],
    });
    const res = await runExamples({ root, profiles: ['annotation'] });
    expect(res.problems).toEqual([]);
    expect([res.passed, res.failed.length]).toEqual([4, 0]);
  });
});

describe('runExamples: format profiles', () => {
  const formatExamples = () =>
    examples([
      { group: 'basic', valid: true, 'valid@when_formatAssertion': false, instance: { id: 'not-a-uuid' }, 'expectedErrors@when_formatAssertion': [{ instanceLocation: '/id', keyword: ['format', 'pattern'] }] },
      { group: 'basic', valid: true, instance: { id: UUID } },
    ]);

  it('annotation ignores format, assertion enforces it', async () => {
    await formatExamples();
    const res = await runExamples({ root, profiles: ['annotation', 'assertion'] });
    expect(res.failed).toEqual([]);
    expect(res.passed).toBe(4);
  });

  it('format-assert-* profiles are skipped when the directory does not exist', async () => {
    await formatExamples();
    const res = await runExamples({ root });
    expect(res.skipped).toBe(4);
    expect(res.ok).toBe(true);
  });

  it('uses the generated directories when present and treats format as pattern', async () => {
    await formatExamples();
    // what format-assert-generator would produce (fast): format -> pattern, $id/$ref relocated
    const pat = '^(?:[uU][rR][nN]:[uU][uU][iI][dD]:)?[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$';
    for (const m of ['fast', 'full']) {
      await put(root, `schema/0.1.0/format-assert-${m}/main.schema.json`, {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: `${BASE}/format-assert-${m}/main.schema.json`,
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', pattern: pat }, child: { $ref: 'ide/child.schema.json' } },
      });
      await put(root, `schema/0.1.0/format-assert-${m}/ide/child.schema.json`, { $id: `${BASE}/format-assert-${m}/ide/child.schema.json`, type: 'object' });
    }
    const res = await runExamples({ root, profiles: ['format-assert-fast', 'format-assert-full'] });
    expect(res.problems).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(res.passed).toBe(4);
  });

  it('skip rules need a reason and silence known differences', async () => {
    await formatExamples();
    await put(root, 'schema/0.1.0/format-assert-fast/main.schema.json', { $id: `${BASE}/format-assert-fast/main.schema.json`, type: 'object' }); // accepts everything
    const failing = await runExamples({ root, profiles: ['format-assert-fast'] });
    expect(failing.failed).toHaveLength(1);
    const skipped = await runExamples({ root, profiles: ['format-assert-fast'], skip: [{ profile: 'format-assert-fast', index: 0, reason: 'fast mode is shape-only' }] });
    expect(skipped.ok).toBe(true);
    expect(skipped.skipped).toBe(1);
  });
});

describe('runExamples: discovery problems', () => {
  it('reports unmatched schemas, bad names, broken entries and picks the highest patch', async () => {
    await put(root, 'examples/0/1/missing.json-examples.json', { jsons: [] });
    await put(root, 'examples/0/1/Bad_name.json', {});
    await put(root, 'examples/0/1/main.json-examples.json', { jsons: [{ group: 'basic', valid: 'yes', instance: 1 }] });
    await put(root, 'examples/9/9/main.json-examples.json', { jsons: [] });
    const { problems } = await runExamples({ root });
    expect(problems.join('\n')).toMatch(/missing\.schema\.json/);
    expect(problems.join('\n')).toMatch(/Bad_name\.json/);
    expect(problems.join('\n')).toMatch(/valid must be a boolean/);
    expect(problems.join('\n')).toMatch(/examples\/9\/9\/main.*no schema\/9\.9\./);

    // a newer patch wins by default, version: ['*'] runs both
    await mkdir(join(root, 'schema/0.1.1'), { recursive: true });
    await writeFile(join(root, 'schema/0.1.1/main.schema.json'), JSON.stringify({ $id: 'https://example.test/other/0.1.1/main.schema.json', type: 'string' }));
    await examples([{ group: 'basic', valid: true, instance: 'text' }]);
    const latest = await runExamples({ root, profiles: ['annotation'] });
    expect(latest.failed).toEqual([]);
    expect(latest.passed).toBe(1);
    const all = await runExamples({ root, profiles: ['annotation'], version: ['*'] });
    expect(all.failed).toHaveLength(1); // 0.1.0 expects an object
    const pinned = await runExamples({ root, profiles: ['annotation'], version: ['0.1.0'] });
    expect(pinned.failed).toHaveLength(1);
    const pinnedRange = await runExamples({ root, profiles: ['annotation'], version: ['^0.1.1'] });
    expect(pinnedRange.failed).toEqual([]);
    expect(pinnedRange.passed).toBe(1);

    // invalid semver or source specifier is reported as problem
    const badSemver = await runExamples({ root, version: ['not-a-version'] });
    expect(badSemver.problems.join('\n')).toMatch(/not a valid node-semver/);

    const badSource = await runExamples({ root, version: ['git+https://github.com/foo/bar', 'npm:foo@1.0.0'] });
    expect(badSource.problems.join('\n')).toMatch(/must not include source specifiers/);
  });

  it('reads json-examples-validator.config.json and lets options override it', async () => {
    await examples([{ group: 'basic', valid: false, instance: { id: UUID } }]); // wrong on purpose
    await put(root, 'json-examples-validator.config.json', { profiles: ['annotation'], skip: [{ index: 0, reason: 'known' }] });
    expect((await runExamples({ root })).skipped).toBe(1);
    expect((await runExamples({ root, skip: [] })).ok).toBe(false);
  });
});

describe('runExamples: valid@when_formatAssertionFull', () => {
  it('has priority over valid@when_formatAssertion, and only applies to full', async () => {
    // fast mode of ajv-formats accepts 2021-02-29 (shape only); full rejects it
    await put(root, 'examples/0/1/main_defs-when.json-examples.json', {
      jsons: [{ group: 'property:defs', valid: true, 'valid@when_formatAssertionFull': false, instance: '2021-02-29' }],
    });
    const full = await runExamples({ root, profiles: ['annotation', 'assertion'], formatsMode: 'full' });
    expect(full.failed).toEqual([]); // annotation: true, assertion(full): false - both as declared
    const fast = await runExamples({ root, profiles: ['assertion'], formatsMode: 'fast' });
    expect(fast.failed).toEqual([]); // fast ignores ...Full -> expects `valid: true`, and fast accepts the date
    await put(root, 'examples/0/1/main_defs-when.json-examples.json', {
      jsons: [{ group: 'property:defs', valid: false, 'valid@when_formatAssertion': true, 'valid@when_formatAssertionFull': false, instance: '2021-02-29' }],
    });
    expect((await runExamples({ root, profiles: ['assertion'], formatsMode: 'full' })).failed).toEqual([]); // Full (false) beats formatAssertion (true)
    const fastAgain = await runExamples({ root, profiles: ['assertion'], formatsMode: 'fast' });
    expect(fastAgain.failed).toEqual([]); // formatAssertion (true) beats valid (false); fast accepts the date
  });

  it('rejects a non-boolean value', async () => {
    await examples([{ group: 'basic', valid: true, 'valid@when_formatAssertionFull': 'no', instance: {} }]);
    expect((await runExamples({ root })).problems.join()).toMatch(/formatAssertionFull must be a boolean/);
  });
});

describe('runExamples: dot-directories', () => {
  it('are read only when included', async () => {
    await put(root, 'schema/0.1.0/.private/extra.schema.json', { $id: `${BASE}/.private/extra.schema.json`, type: 'string' });
    await put(root, 'examples/0/1/extra.json-examples.json', { jsons: [{ group: 'basic', valid: true, instance: 'x' }] });
    expect((await runExamples({ root, profiles: ['annotation'] })).problems.join()).toMatch(/no extra\.schema\.json/);
    const res = await runExamples({ root, profiles: ['annotation'], includeDotDirs: ['.private'] });
    expect(res.problems.filter((p) => /extra/.test(p))).toEqual([]);
    expect(res.failed).toEqual([]);
  });
});

describe('runExamples: expectedErrors details', () => {
  const run = (jsons: unknown[], extra = {}) => examples(jsons).then(() => runExamples({ root, profiles: ['annotation', 'assertion'], ...extra }));

  it('scenario specific errors follow the priority Full > formatAssertion > base', async () => {
    // fast ajv-formats accepts 2021-02-29, full rejects it: only valid@when_formatAssertionFull
    await put(root, 'examples/0/1/main_defs-when.json-examples.json', {
      jsons: [
        {
          group: 'property:defs',
          valid: true,
          'valid@when_formatAssertionFull': false,
          'expectedErrors@when_formatAssertionFull': [{ instanceLocation: '', keyword: 'format', params: { format: 'date' } }],
          instance: '2021-02-29',
        },
      ],
    });
    expect((await runExamples({ root, profiles: ['annotation', 'assertion'], formatsMode: 'full' })).failed).toEqual([]);
    expect((await runExamples({ root, profiles: ['annotation', 'assertion'], formatsMode: 'fast' })).failed).toEqual([]);
    // wrong params are caught
    await put(root, 'examples/0/1/main_defs-when.json-examples.json', {
      jsons: [{ group: 'property:defs', valid: true, 'valid@when_formatAssertionFull': false, 'expectedErrors@when_formatAssertionFull': [{ instanceLocation: '', keyword: 'format', params: { format: 'time' } }], instance: '2021-02-29' }],
    });
    const bad = await runExamples({ root, profiles: ['assertion'], formatsMode: 'full' });
    expect(bad.failed[0]!.outcome.failures[0]).toMatch(/params/);
  });

  it('params identify WHICH property, keyword may be a list, schemaLocation is a keyword pointer', async () => {
    const res = await run([
      {
        group: 'basic',
        valid: false,
        instance: { child: {} },
        expectedErrors: [
          { instanceLocation: '', keyword: 'required', params: { missingProperty: 'id' }, schemaLocation: '/required' },
          { instanceLocation: '/child', keyword: ['required', 'type'], params: { missingProperty: 'n' } },
        ],
      },
    ]);
    // `child` has no required list, so the second expectation is not produced
    expect(res.failed).toHaveLength(2);
    expect(res.failed[0]!.outcome.failures.join()).toMatch(/\/child/);
    const ok = await run([{ group: 'basic', valid: false, instance: {}, expectedErrors: [{ instanceLocation: '', keyword: ['type', 'required'], params: { missingProperty: 'id' }, schemaLocation: '/required' }] }]);
    expect(ok.failed).toEqual([]);
    const wrongProp = await run([{ group: 'basic', valid: false, instance: {}, expectedErrors: [{ instanceLocation: '', keyword: 'required', params: { missingProperty: 'other' } }] }]);
    expect(wrongProp.failed).toHaveLength(2);
  });

  it('errorMatch: exact is per example and beats the global default', async () => {
    const jsons = [{ group: 'basic', valid: false, instance: { child: { n: 0 } }, expectedErrors: [{ instanceLocation: '/child/n', keyword: 'minimum' }], errorMatch: 'exact' }];
    expect((await run(jsons)).failed.length).toBeGreaterThan(0); // `id` is missing too -> 2 errors
    const contains = [{ ...jsons[0]!, errorMatch: 'contains' }];
    expect((await run(contains, { exactErrors: true })).failed).toEqual([]);
  });

  it('messages are compared only for ajv (or no declared engine)', async () => {
    const mk = (engine?: unknown) => ({ ...(engine ? { engine } : {}), jsons: [{ group: 'basic', valid: false, instance: {}, expectedErrors: [{ instanceLocation: '', keyword: 'required', message: 'wording of another engine' }] }] });
    await put(root, 'examples/0/1/main.json-examples.json', mk());
    expect((await runExamples({ root, profiles: ['annotation'] })).failed).toHaveLength(1);
    await put(root, 'examples/0/1/main.json-examples.json', mk({ name: 'hyperjump', version: '1.0.0' }));
    expect((await runExamples({ root, profiles: ['annotation'] })).failed).toEqual([]);
    await put(root, 'examples/0/1/main.json-examples.json', mk({ name: 'ajv', version: '8.17.1', formats: { name: 'ajv-formats', version: '3.0.1' } }));
    expect((await runExamples({ root, profiles: ['annotation'] })).failed).toHaveLength(1);
  });

  it('warns (or fails) about invalid examples without expectedErrors', async () => {
    const jsons = [
      { group: 'basic', valid: false, instance: {} },
      { group: 'basic', valid: true, 'valid@when_formatAssertion': false, instance: { id: 'x' } },
      { group: 'basic', valid: false, instance: {}, expectedErrors: [{ instanceLocation: '', keyword: 'required' }] },
    ];
    await examples(jsons);
    const warn = await runExamples({ root, profiles: ['annotation'] });
    expect(warn.warnings).toHaveLength(2);
    expect(warn.warnings[0]).toMatch(/\[0\].*annotation/);
    expect(warn.warnings[1]).toMatch(/\[1\].*format assertion \(fast\), format assertion \(full\)/);
    expect(warn.ok).toBe(true);
    expect((await runExamples({ root, profiles: ['annotation'], requireExpectedErrors: 'off' })).warnings).toEqual([]);
    const strict = await runExamples({ root, profiles: ['annotation'], requireExpectedErrors: 'error' });
    expect(strict.ok).toBe(false);
    expect(strict.problems).toHaveLength(2);
  });
});

describe('runExamples: remote $ref', () => {
  const REMOTE = 'https://example.test/other/ext.schema.json';
  beforeEach(async () => {
    await put(root, 'schema/0.1.0/uses-ext.schema.json', { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `${BASE}/uses-ext.schema.json`, $ref: REMOTE });
    await put(root, 'vendor/ext.schema.json', { $id: REMOTE, type: 'integer' });
    await put(root, 'examples/0/1/uses-ext.json-examples.json', { jsons: [{ group: 'basic', valid: true, instance: 3 }, { group: 'basic', valid: false, instance: 'x', expectedErrors: [{ instanceLocation: '', keyword: 'type' }] }] });
  });

  it('is resolved through refMap (no network)', async () => {
    const res = await runExamples({ root, profiles: ['annotation'], refMap: { [REMOTE]: 'vendor/ext.schema.json' }, offline: true });
    expect(res.failed).toEqual([]);
    expect(res.passed).toBe(2);
  });

  it('offline without a mapping fails with a clear message', async () => {
    const res = await runExamples({ root, profiles: ['annotation'], offline: true });
    expect(res.failed[0]!.outcome.failures.join()).toMatch(/not in refMap and offline/);
  });
});
