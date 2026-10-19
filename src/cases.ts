import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { discoverExamples, readJson } from './discover.js';
import { createEngine, type Engine } from './engine.js';
import { matchErrors } from './match.js';
import {
  ALL_PROFILES,
  expectedErrorsFor,
  expectedValid,
  type CaseOutcome,
  type ExampleCase,
  type ExampleEntry,
  type LoadedCases,
  type Profile,
  type ValidatorOptions,
} from './types.js';

export const absRefMap = (o: ValidatorOptions) => Object.fromEntries(Object.entries(o.refMap ?? {}).map(([url, p]) => [url, resolve(o.root, p)]));
const profileDir = (versionDir: string, p: Profile) => (p === 'annotation' || p === 'assertion' ? versionDir : join(versionDir, p));

function checkEntry(e: unknown, i: number): string | undefined {
  if (typeof e !== 'object' || e === null) return `jsons[${i}] is not an object`;
  const x = e as Record<string, unknown>;
  if (typeof x.valid !== 'boolean') return `jsons[${i}].valid must be a boolean`;
  if (!('instance' in x)) return `jsons[${i}].instance is missing`;
  if (typeof x.group !== 'string') return `jsons[${i}].group must be a string`;
  for (const k of ['valid@when_formatAssertion', 'valid@when_formatAssertionFull']) {
    if (x[k] !== undefined && typeof x[k] !== 'boolean') return `jsons[${i}].${k} must be a boolean`;
  }
  for (const k of ['expectedErrors', 'expectedErrors@when_formatAssertion', 'expectedErrors@when_formatAssertionFull']) {
    if (x[k] !== undefined && !Array.isArray(x[k])) return `jsons[${i}].${k} must be an array`;
  }
  if (x.errorMatch !== undefined && x.errorMatch !== 'contains' && x.errorMatch !== 'exact') return `jsons[${i}].errorMatch must be "contains" or "exact"`;
  return undefined;
}

const SCENARIOS: Array<{ name: string; profile: Profile; mode: 'fast' | 'full' }> = [
  { name: 'annotation', profile: 'annotation', mode: 'full' },
  { name: 'format assertion (fast)', profile: 'assertion', mode: 'fast' },
  { name: 'format assertion (full)', profile: 'assertion', mode: 'full' },
];

/** Turn every example of the library into a runnable case (one per example and profile). */
export async function loadCases(options: ValidatorOptions): Promise<LoadedCases> {
  const { root, profiles = ALL_PROFILES, formatsMode = 'full', ajvOptions = {}, skip = [], exactErrors = false, requireExpectedErrors = 'warn' } = options;
  const { sources, problems } = await discoverExamples(root, { version: options.version, includeDotDirs: options.includeDotDirs });
  const warnings: string[] = [];
  const cases: ExampleCase[] = [];
  const engines = new Map<string, Promise<Engine>>();
  const engineFor = (dir: string, profile: Profile) => {
    const key = `${profile}|${dir}`;
    if (!engines.has(key)) engines.set(key, createEngine({ dir, profile, formatsMode, ajvOptions, includeDotDirs: options.includeDotDirs, refMap: absRefMap(options), offline: options.offline }));
    return engines.get(key)!;
  };

  for (const src of sources) {
    let doc: { jsons?: unknown; engine?: { name?: string } };
    try {
      doc = (await readJson(src.absPath)) as typeof doc;
    } catch (e) {
      problems.push(`${src.examplesFile}: ${(e as Error).message}`);
      continue;
    }
    if (!Array.isArray(doc.jsons)) {
      problems.push(`${src.examplesFile}: "jsons" must be an array`);
      continue;
    }
    const bad = doc.jsons.map(checkEntry).filter((m): m is string => m !== undefined);
    if (bad.length) {
      problems.push(...bad.map((m) => `${src.examplesFile}: ${m}`));
      continue;
    }
    // Wording of error messages belongs to one engine; only compare it when the file was written for this one.
    const compareMessages = doc.engine?.name === undefined || doc.engine.name === 'ajv';

    (doc.jsons as ExampleEntry[]).forEach((ex, index) => {
      const label = ex.label ?? ex.name ?? `#${index}`;

      if (requireExpectedErrors !== 'off') {
        const missing = SCENARIOS.filter((s) => !expectedValid(ex, s.profile, s.mode) && expectedErrorsFor(ex, s.profile, s.mode) === undefined).map((s) => s.name);
        if (missing.length) {
          const msg = `${src.examplesFile} [${index}] ${label}: invalid without expectedErrors (${missing.join(', ')})`;
          (requireExpectedErrors === 'error' ? problems : warnings).push(msg);
        }
      }

      for (const profile of profiles) {
        const dir = profileDir(src.versionDir, profile);
        const rule = skip.find(
          (r) =>
            (!r.profile || r.profile === profile) &&
            (!r.file || src.examplesFile.includes(r.file)) &&
            (r.index === undefined || r.index === index) &&
            (r.label === undefined || r.label === (ex.label ?? ex.name)),
        );
        const skipReason = rule ? `skipped: ${rule.reason}` : existsSync(dir) ? undefined : `skipped: ${profile} directory does not exist (run format-assert-generator)`;
        const expected = expectedValid(ex, profile, formatsMode);
        const expectedErrors = expectedErrorsFor(ex, profile, formatsMode);
        const exact = (ex.errorMatch ?? (exactErrors ? 'exact' : 'contains')) === 'exact';
        // The target is decided by the file name only (root, or `_defs-<DeF>`). `groupPointer` classifies the example and never changes the result.
        const pointer = src.defs ? `/$defs/${src.defs}` : '';

        cases.push({
          id: `${profile} | ${src.examplesFile} | [${index}] ${label}`,
          examplesFile: src.examplesFile,
          schemaFile: src.schemaFile,
          index,
          label,
          profile,
          ...(skipReason && { skipReason }),
          run: async (): Promise<CaseOutcome> => {
            const validate = await (await engineFor(dir, profile)).validatorFor(src.schemaFile, pointer);
            const actualValid = validate(ex.instance) as boolean;
            const errors = [...(validate.errors ?? [])];
            const failures: string[] = [];
            if (actualValid !== expected) {
              failures.push(
                `expected ${expected ? 'valid' : 'invalid'}, got ${actualValid ? 'valid' : 'invalid'}` +
                  (errors.length ? `: ${errors.map((e) => `${e.instancePath || '/'} ${e.keyword} (${e.message})`).join('; ')}` : '') +
                  (ex.pointer ? ` [pointer: ${[ex.pointer].flat().join(', ')}]` : ''),
              );
            } else if (!expected && expectedErrors) {
              failures.push(...matchErrors(expectedErrors, errors, profile, exact, { compareMessages }));
            }
            return { ok: failures.length === 0, failures, expectedValid: expected, actualValid, errors };
          },
        });
      }
    });
  }
  return { cases, problems, warnings };
}
