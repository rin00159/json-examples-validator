#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { buildReport, formatReport } from './report.js';
import { runExamples } from './run.js';
import { checkWrappers } from './wrapper.js';
import { ALL_PROFILES, type Profile } from './types.js';

const HELP = `Usage: json-examples-validator <library root> [options]

Validates examples/<major>/<minor>/<SubexT>[_defs-<DeF>].json-examples.json against schema/<major>.<minor>.<patch>/.

      --version <semver>     schema version or semver range (repeatable, comma-separated; default: highest patch)
      --profile <list>       comma separated: ${ALL_PROFILES.join(', ')} (default: all)
      --formats-mode <fast|full>   ajv-formats mode for "assertion" (default: full)
      --exact-errors         the number of errors must equal expectedErrors.length
      --include-dot-dirs     also read dot-directories below schema/<version>
      --include-dot-dir <n>  ... only this one (repeatable)
      --report               instead of running: show examples whose result depends on format handling or whose
                             valid* keys are wrong, with the keys to write (exit 1 on a mismatch); --report-all lists every example
      --check-wrappers       also validate every examples file against its examples/<M>/<m>/schema/*.json-examples.schema.json
      --ref-map <url=path>   resolve a wrapper's remote $ref from a local file (repeatable)
      --require-expected-errors <off|warn|error>   invalid examples without expectedErrors (default: warn)
      --offline              never fetch remote $refs (they must be given with --ref-map)
      --verbose              print every example
  -h, --help

Optional <root>/json-examples-validator.config.json holds the same options plus "skip" rules.
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: 'string', multiple: true },
      profile: { type: 'string' },
      'formats-mode': { type: 'string' },
      'exact-errors': { type: 'boolean' },
      'include-dot-dirs': { type: 'boolean' },
      'include-dot-dir': { type: 'string', multiple: true },
      report: { type: 'boolean' },
      'report-all': { type: 'boolean' },
      'check-wrappers': { type: 'boolean' },
      'ref-map': { type: 'string', multiple: true },
      'require-expected-errors': { type: 'string' },
      offline: { type: 'boolean' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const [root, ...rest] = positionals;
  if (!root || rest.length) {
    process.stderr.write(HELP);
    return 2;
  }
  const profiles = values.profile?.split(',').map((s) => s.trim()) as Profile[] | undefined;
  for (const p of profiles ?? []) if (!ALL_PROFILES.includes(p)) throw new Error(`unknown profile "${p}"`);
  if (values['formats-mode'] && !['fast', 'full'].includes(values['formats-mode'])) throw new Error('--formats-mode must be fast or full');

  const requireExpectedErrors = values['require-expected-errors'] as 'off' | 'warn' | 'error' | undefined;
  if (requireExpectedErrors && !['off', 'warn', 'error'].includes(requireExpectedErrors)) throw new Error('--require-expected-errors must be off, warn or error');
  const refMap = values['ref-map'] ? Object.fromEntries(values['ref-map'].map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])) : undefined;
  const rawVersion = values.version;
  const version = rawVersion ? rawVersion.flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean) : undefined;
  const common = {
    root,
    version,
    profiles,
    formatsMode: values['formats-mode'] as 'fast' | 'full' | undefined,
    includeDotDirs: values['include-dot-dirs'] ? true : values['include-dot-dir'],
    requireExpectedErrors,
    refMap,
    offline: values.offline,
  };

  if (values.report || values['report-all']) {
    const { items, problems } = await buildReport({ ...common, all: values['report-all'] });
    for (const p of problems) console.error(`problem: ${p}`);
    process.stdout.write(formatReport(items));
    return problems.length || items.some((i) => i.mismatch || i.notes.length) ? 1 : 0;
  }

  const res = await runExamples(
    { ...common, exactErrors: values['exact-errors'] },
    (c, o) => {
      if (values.verbose) console.log(`${o === 'skipped' ? 'SKIP' : o.ok ? 'ok  ' : 'FAIL'} ${c.id}${o === 'skipped' && c.skipReason ? `  (${c.skipReason})` : ''}`);
    },
  );
  if (values['check-wrappers']) res.problems.push(...(await checkWrappers(common)).map((p) => `wrapper: ${p}`));
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
