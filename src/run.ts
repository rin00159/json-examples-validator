import { loadCases } from './cases.js';
import { resolveOptions } from './config.js';
import type { CaseOutcome, ExampleCase, ValidatorOptions } from './types.js';

export interface RunResult {
  total: number;
  passed: number;
  skipped: number;
  failed: Array<{ case: ExampleCase; outcome: CaseOutcome | { failures: string[] } }>;
  problems: string[];
  warnings: string[];
  ok: boolean;
}

/** Run everything without a test framework. */
export async function runExamples(options: ValidatorOptions, onCase?: (c: ExampleCase, outcome: CaseOutcome | 'skipped') => void): Promise<RunResult> {
  const { cases, problems, warnings } = await loadCases(await resolveOptions(options));
  const result: RunResult = { total: cases.length, passed: 0, skipped: 0, failed: [], problems, warnings, ok: false };
  for (const c of cases) {
    if (c.skipReason) {
      result.skipped++;
      onCase?.(c, 'skipped');
      continue;
    }
    try {
      const outcome = await c.run();
      onCase?.(c, outcome);
      if (outcome.ok) result.passed++;
      else result.failed.push({ case: c, outcome });
    } catch (e) {
      result.failed.push({ case: c, outcome: { failures: [(e as Error).message] } });
    }
  }
  result.ok = result.failed.length === 0 && problems.length === 0;
  return result;
}
