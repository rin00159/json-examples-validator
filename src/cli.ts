#!/usr/bin/env node
import { helpText, parseCliArgs } from './options.js';
import { buildReport, formatReport } from './report.js';
import { runExamples } from './run.js';
import { checkWrappers } from './wrapper.js';

async function main(): Promise<number> {
  const cmd = parseCliArgs(process.argv.slice(2));
  if (cmd.kind === 'help') {
    process.stdout.write(helpText());
    return 0;
  }
  if (cmd.kind === 'usage') {
    process.stderr.write(helpText());
    return 2;
  }
  const { options, verbose } = cmd;

  if (cmd.mode === 'report') {
    const { items, problems } = await buildReport({ ...options, all: cmd.reportAll });
    for (const p of problems) console.error(`problem: ${p}`);
    process.stdout.write(formatReport(items));
    return problems.length || items.some((i) => i.mismatch || i.notes.length) ? 1 : 0;
  }

  const res = await runExamples(options, (c, o) => {
    if (verbose) console.log(`${o === 'skipped' ? 'SKIP' : o.ok ? 'ok  ' : 'FAIL'} ${c.id}${o === 'skipped' && c.skipReason ? `  (${c.skipReason})` : ''}`);
  });
  if (options.checkWrappers) res.problems.push(...(await checkWrappers(options)).map((p) => `wrapper: ${p}`));
  res.ok = res.ok && res.problems.length === 0;
  for (const w of res.warnings) console.error(`warning: ${w}`);
  for (const p of res.problems) console.error(`problem: ${p}`);
  for (const f of res.failed) {
    console.error(`FAIL ${f.case.id}`);
    for (const m of f.outcome.failures) console.error(`     ${m}`);
  }
  console.log(`${res.passed} passed, ${res.failed.length} failed, ${res.skipped} skipped, ${res.problems.length} problem(s), ${res.warnings.length} warning(s)`);
  return res.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
