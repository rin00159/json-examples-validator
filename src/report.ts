import { join } from 'node:path';
import { discoverExamples, readJson } from './discover.js';
import { createEngine } from './engine.js';
import { expectedValid, type ExampleEntry, type ValidatorOptions } from './types.js';
import { existsSync } from 'node:fs';
import { absRefMap } from './cases.js';
import { resolveOptions } from './config.js';

export interface ScenarioResults {
  annotation: boolean;
  assertionFast: boolean;
  assertionFull: boolean;
  /** undefined when the format-assert-* directory does not exist. */
  formatAssertFast?: boolean;
  formatAssertFull?: boolean;
}

export interface ReportItem {
  examplesFile: string;
  index: number;
  label: string;
  actual: ScenarioResults;
  /** What the example currently declares for annotation / assertion (fast) / assertion (full). */
  declared: { annotation: boolean; assertionFast: boolean; assertionFull: boolean };
  /** The `valid*` keys that would make the declaration match reality (only the keys that are needed). */
  suggested: { valid: boolean; 'valid@when_formatAssertion'?: boolean; 'valid@when_formatAssertionFull'?: boolean };
  /** The declaration does not match the actual results. */
  mismatch: boolean;
  /** fast and full (or annotation) disagree: the example depends on format handling. */
  formatSensitive: boolean;
  notes: string[];
}

/** Which `valid*` keys describe the actual results? (`valid` = annotation; extra keys only where they differ from what the lower ones give.) */
export function suggestDeclaration(r: Pick<ScenarioResults, 'annotation' | 'assertionFast' | 'assertionFull'>): ReportItem['suggested'] {
  const out: ReportItem['suggested'] = { valid: r.annotation };
  if (r.assertionFast !== r.annotation) out['valid@when_formatAssertion'] = r.assertionFast;
  if (r.assertionFull !== (out['valid@when_formatAssertion'] ?? r.annotation)) out['valid@when_formatAssertionFull'] = r.assertionFull;
  return out;
}

/**
 * Run every example in every scenario and show where they differ (and what to write to declare it).
 * By default only examples whose declaration is wrong, or whose result depends on format handling, are listed.
 */
export async function buildReport(options: ValidatorOptions & { all?: boolean }): Promise<{ items: ReportItem[]; problems: string[] }> {
  const opts = { ...(await resolveOptions(options)), all: options.all };
  const { sources, problems } = await discoverExamples(opts.root, { version: opts.version, includeDotDirs: opts.includeDotDirs });
  const items: ReportItem[] = [];
  const base = { ajvOptions: opts.ajvOptions ?? {}, includeDotDirs: opts.includeDotDirs, refMap: absRefMap(opts), offline: opts.offline };

  for (const src of sources) {
    const doc = (await readJson(src.absPath)) as { jsons?: ExampleEntry[] };
    if (!Array.isArray(doc.jsons)) {
      problems.push(`${src.examplesFile}: "jsons" must be an array`);
      continue;
    }
    const faDir = (m: 'fast' | 'full') => join(src.versionDir, `format-assert-${m}`);
    const [annotation, aFast, aFull, fFast, fFull] = await Promise.all([
      createEngine({ ...base, dir: src.versionDir, profile: 'annotation', formatsMode: 'full' }),
      createEngine({ ...base, dir: src.versionDir, profile: 'assertion', formatsMode: 'fast' }),
      createEngine({ ...base, dir: src.versionDir, profile: 'assertion', formatsMode: 'full' }),
      existsSync(faDir('fast')) ? createEngine({ ...base, dir: faDir('fast'), profile: 'format-assert-fast', formatsMode: 'full' }) : undefined,
      existsSync(faDir('full')) ? createEngine({ ...base, dir: faDir('full'), profile: 'format-assert-full', formatsMode: 'full' }) : undefined,
    ]);
    const pointer = src.defs ? `/$defs/${src.defs}` : '';
    const run = async (e: typeof annotation | undefined, instance: unknown) => (e ? (((await e.validatorFor(src.schemaFile, pointer))(instance)) as boolean) : undefined);

    for (const [index, ex] of doc.jsons.entries()) {
      const actual: ScenarioResults = {
        annotation: (await run(annotation, ex.instance))!,
        assertionFast: (await run(aFast, ex.instance))!,
        assertionFull: (await run(aFull, ex.instance))!,
        formatAssertFast: await run(fFast, ex.instance),
        formatAssertFull: await run(fFull, ex.instance),
      };
      const declared = { annotation: expectedValid(ex, 'annotation', 'full'), assertionFast: expectedValid(ex, 'assertion', 'fast'), assertionFull: expectedValid(ex, 'assertion', 'full') };
      const mismatch = declared.annotation !== actual.annotation || declared.assertionFast !== actual.assertionFast || declared.assertionFull !== actual.assertionFull;
      const formatSensitive = !(actual.annotation === actual.assertionFast && actual.assertionFast === actual.assertionFull);
      const notes: string[] = [];
      if (actual.formatAssertFast !== undefined && actual.formatAssertFast !== actual.assertionFast) notes.push(`format-assert-fast (${word(actual.formatAssertFast)}) differs from assertion/fast (${word(actual.assertionFast)})`);
      if (actual.formatAssertFull !== undefined && actual.formatAssertFull !== actual.assertionFull) notes.push(`format-assert-full (${word(actual.formatAssertFull)}) differs from assertion/full (${word(actual.assertionFull)})`);
      if (opts.all || mismatch || formatSensitive || notes.length) {
        items.push({ examplesFile: src.examplesFile, index, label: ex.label ?? ex.name ?? `#${index}`, actual, declared, suggested: suggestDeclaration(actual), mismatch, formatSensitive, notes });
      }
    }
  }
  return { items, problems };
}

const word = (b: boolean) => (b ? 'valid' : 'invalid');

export function formatReport(items: readonly ReportItem[]): string {
  if (items.length === 0) return 'no format-dependent or mismatching examples\n';
  return items
    .map((i) => {
      const a = i.actual;
      const lines = [
        `${i.examplesFile} [${i.index}] ${i.label}`,
        `  actual:    annotation=${word(a.annotation)}  assertion(fast)=${word(a.assertionFast)}  assertion(full)=${word(a.assertionFull)}` +
          (a.formatAssertFast !== undefined ? `  format-assert-fast=${word(a.formatAssertFast)}` : '') +
          (a.formatAssertFull !== undefined ? `  format-assert-full=${word(a.formatAssertFull)}` : ''),
        `  declared:  ${i.mismatch ? 'MISMATCH ' : 'ok '} annotation=${word(i.declared.annotation)}  assertion(fast)=${word(i.declared.assertionFast)}  assertion(full)=${word(i.declared.assertionFull)}`,
      ];
      if (i.mismatch || i.formatSensitive) lines.push(`  suggested: ${Object.entries(i.suggested).map(([k, v]) => `"${k}": ${v}`).join(', ')}`);
      for (const n of i.notes) lines.push(`  note:      ${n}`);
      return lines.join('\n');
    })
    .join('\n\n') + '\n';
}
