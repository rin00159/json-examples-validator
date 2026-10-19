import { describe, expect, it } from 'vitest';
import { loadCases } from './cases.js';
import { resolveOptions } from './config.js';
import type { ValidatorOptions } from './types.js';

/**
 * Register one vitest test per (example, profile). Call it with top-level `await` in a test file:
 *
 *   import { defineExamplesTests } from 'json-examples-validator/vitest';
 *   await defineExamplesTests({ root: new URL('..', import.meta.url).pathname });
 */
export async function defineExamplesTests(options: ValidatorOptions): Promise<void> {
  const { cases, problems, warnings } = await loadCases(await resolveOptions(options));
  for (const w of warnings) console.warn(`[json-examples-validator] ${w}`);

  describe('json-examples: setup', () => {
    it('every examples file maps to a schema and is well-formed', () => {
      expect(problems).toEqual([]);
    });
  });

  const byFile = new Map<string, typeof cases>();
  for (const c of cases) byFile.set(c.examplesFile, [...(byFile.get(c.examplesFile) ?? []), c]);
  for (const [file, fileCases] of byFile) {
    describe(file, () => {
      for (const c of fileCases) {
        const name = `${c.profile} | [${c.index}] ${c.label}`;
        if (c.skipReason) {
          it.skip(`${name} (${c.skipReason})`, () => {});
          continue;
        }
        it(name, async () => {
          const outcome = await c.run();
          expect(outcome.failures, `${c.schemaFile}\n${outcome.failures.join('\n')}`).toEqual([]);
        });
      }
    });
  }
}
