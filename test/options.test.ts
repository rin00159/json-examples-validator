import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_FILE, resolveOptions } from '../src/config.js';
import { OPTION_DEFS, helpText, parseCliArgs } from '../src/options.js';

const run = (...a: string[]) => {
  const c = parseCliArgs(a);
  if (c.kind !== 'run') throw new Error(c.kind);
  return c;
};

describe('parseCliArgs', () => {
  it('help / usage', () => {
    expect(parseCliArgs(['-h']).kind).toBe('help');
    expect(parseCliArgs([]).kind).toBe('usage');
    expect(parseCliArgs(['a', 'b']).kind).toBe('usage');
  });
  it('maps flags to options', () => {
    const c = run('lib', '--version', '1.0.0,^2', '--version', ' 3 ', '--profile', 'annotation, assertion', '--formats-mode', 'fast', '--exact-errors', '--check-wrappers', '--offline', '--ref-map', 'http://x/a.json=a.json', '--ref-map', 'http://y/=y/');
    expect(c.mode).toBe('run');
    expect(c.options).toMatchObject({
      root: 'lib',
      version: ['1.0.0', '^2', '3'],
      profiles: ['annotation', 'assertion'],
      formatsMode: 'fast',
      exactErrors: true,
      checkWrappers: true,
      offline: true,
      refMap: { 'http://x/a.json': 'a.json', 'http://y/': 'y/' },
    });
  });
  it('dot dirs and report modes', () => {
    expect(run('l', '--include-dot-dirs', '--include-dot-dir', '.a').options.includeDotDirs).toBe(true);
    expect(run('l', '--include-dot-dir', '.a', '--include-dot-dir', '.b').options.includeDotDirs).toEqual(['.a', '.b']);
    expect(run('l', '--report').mode).toBe('report');
    const all = run('l', '--report-all');
    expect([all.mode, all.reportAll]).toEqual(['report', true]);
  });
  it('rejects invalid values', () => {
    expect(() => parseCliArgs(['l', '--profile', 'nope'])).toThrow('unknown profile "nope"');
    expect(() => parseCliArgs(['l', '--formats-mode', 'x'])).toThrow('--formats-mode must be fast or full');
    expect(() => parseCliArgs(['l', '--require-expected-errors', 'x'])).toThrow('off, warn or error');
    expect(() => parseCliArgs(['l', '--ref-map', 'novalue'])).toThrow('<url=path>');
  });
  it('help lists every option', () => {
    const h = helpText();
    for (const d of OPTION_DEFS) expect(h).toContain(`--${d.flag}`);
  });
});

describe('config file validation', () => {
  const withConfig = async (cfg: unknown) => {
    const root = await mkdtemp(join(tmpdir(), 'jev-'));
    await writeFile(join(root, CONFIG_FILE), JSON.stringify(cfg));
    return root;
  };
  it('accepts a valid config and lets options override it', async () => {
    const root = await withConfig({ formatsMode: 'fast', skip: [{ profile: 'annotation', index: 1, reason: 'r' }], offline: true });
    const o = await resolveOptions({ root, offline: false });
    expect(o).toMatchObject({ formatsMode: 'fast', offline: false });
  });
  it('rejects unknown keys and wrong types', async () => {
    await expect(resolveOptions({ root: await withConfig({ formatMode: 'fast' }) })).rejects.toThrow(/formatMode/);
    await expect(resolveOptions({ root: await withConfig({ skip: [{ index: 1 }] }) })).rejects.toThrow(/reason/);
    await expect(resolveOptions({ root: await withConfig({ profiles: ['x'] }) })).rejects.toThrow(CONFIG_FILE);
  });
});
