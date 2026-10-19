import { parseArgs } from 'node:util';
import { Ajv } from 'ajv';
import { ALL_PROFILES, type Profile, type ValidatorOptions } from './types.js';

/**
 * Single source of truth for the options: drives the `parseArgs` config and the help text of the CLI,
 * and (through `CONFIG_SCHEMA`) the validation of `json-examples-validator.config.json`.
 */
interface OptionDef {
  flag: string;
  type: 'boolean' | 'string';
  multiple?: boolean;
  short?: string;
  /** Placeholder shown in the help (string options). */
  arg?: string;
  /** Allowed values (checked, and shown in the help when no `arg` is given). */
  choices?: readonly string[];
  help: string;
}

export const OPTION_DEFS: readonly OptionDef[] = [
  { flag: 'version', type: 'string', multiple: true, arg: '<semver>', help: 'schema version or semver range (repeatable, comma-separated; default: highest patch)' },
  { flag: 'profile', type: 'string', arg: '<list>', help: `comma separated: ${ALL_PROFILES.join(', ')} (default: all)` },
  { flag: 'formats-mode', type: 'string', choices: ['fast', 'full'], help: 'ajv-formats mode for "assertion" (default: full)' },
  { flag: 'exact-errors', type: 'boolean', help: 'the number of errors must equal expectedErrors.length' },
  { flag: 'include-dot-dirs', type: 'boolean', help: 'also read dot-directories below schema/<version>' },
  { flag: 'include-dot-dir', type: 'string', multiple: true, arg: '<n>', help: '... only this one (repeatable)' },
  {
    flag: 'report',
    type: 'boolean',
    help: 'instead of running: show examples whose result depends on format handling or whose valid* keys are wrong, with the keys to write (exit 1 on a mismatch)',
  },
  { flag: 'report-all', type: 'boolean', help: 'like --report, but list every example' },
  { flag: 'check-wrappers', type: 'boolean', help: 'also validate every examples file against its examples/<M>/<m>/schema/*.json-examples.schema.json' },
  { flag: 'ref-map', type: 'string', multiple: true, arg: '<url=path>', help: "resolve a wrapper's remote $ref from a local file (repeatable)" },
  { flag: 'require-expected-errors', type: 'string', choices: ['off', 'warn', 'error'], help: 'invalid examples without expectedErrors (default: warn)' },
  { flag: 'offline', type: 'boolean', help: 'never fetch remote $refs (they must be given with --ref-map)' },
  { flag: 'verbose', type: 'boolean', help: 'print every example' },
  { flag: 'help', type: 'boolean', short: 'h', help: 'show this help' },
];

const label = (d: OptionDef) => {
  const arg = d.arg ?? (d.choices ? `<${d.choices.join('|')}>` : '');
  return `${d.short ? `-${d.short}, ` : '    '}--${d.flag}${arg ? ` ${arg}` : ''}`;
};

export function helpText(): string {
  const width = Math.max(...OPTION_DEFS.map((d) => label(d).length));
  const lines = OPTION_DEFS.map((d) => `  ${label(d).padEnd(width)}  ${d.help}`);
  return `Usage: json-examples-validator <library root> [options]

Validates examples/<major>/<minor>/<SubexT>[_defs-<DeF>].json-examples.json against schema/<major>.<minor>.<patch>/.

${lines.join('\n')}

Optional <root>/json-examples-validator.config.json holds the same options (camelCase) plus "skip" rules and "ajvOptions".
`;
}

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'usage' }
  | { kind: 'run'; mode: 'run' | 'report'; reportAll: boolean; verbose: boolean; options: ValidatorOptions };

const splitList = (values: string[]) => values.flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);

function parseRefMap(entries: string[]): Record<string, string> {
  return Object.fromEntries(
    entries.map((kv) => {
      const i = kv.indexOf('=');
      if (i < 0) throw new Error(`--ref-map expects <url=path>, got "${kv}"`);
      return [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
}

/** Parse CLI arguments (without `node` and the script). Throws on invalid values. */
export function parseCliArgs(argv: string[]): CliCommand {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: Object.fromEntries(OPTION_DEFS.map((d) => [d.flag, { type: d.type, ...(d.multiple && { multiple: true }), ...(d.short && { short: d.short }) }])),
  });
  if (values.help) return { kind: 'help' };
  const [root, ...rest] = positionals;
  if (!root || rest.length) return { kind: 'usage' };

  for (const d of OPTION_DEFS) {
    const v = values[d.flag];
    if (d.choices && typeof v === 'string' && !d.choices.includes(v)) throw new Error(`--${d.flag} must be ${d.choices.join(', ').replace(/, ([^,]*)$/, ' or $1')}`);
  }
  const profiles = typeof values.profile === 'string' ? (values.profile.split(',').map((s) => s.trim()) as Profile[]) : undefined;
  for (const p of profiles ?? []) if (!ALL_PROFILES.includes(p)) throw new Error(`unknown profile "${p}"`);

  const strings = (flag: string) => values[flag] as string[] | undefined;
  const options: ValidatorOptions = {
    root,
    version: strings('version') && splitList(strings('version')!),
    profiles,
    formatsMode: values['formats-mode'] as ValidatorOptions['formatsMode'],
    exactErrors: values['exact-errors'] as boolean | undefined,
    includeDotDirs: values['include-dot-dirs'] ? true : strings('include-dot-dir'),
    requireExpectedErrors: values['require-expected-errors'] as ValidatorOptions['requireExpectedErrors'],
    checkWrappers: values['check-wrappers'] as boolean | undefined,
    refMap: strings('ref-map') && parseRefMap(strings('ref-map')!),
    offline: values.offline as boolean | undefined,
  };
  const reportAll = Boolean(values['report-all']);
  return { kind: 'run', mode: values.report || reportAll ? 'report' : 'run', reportAll, verbose: Boolean(values.verbose), options };
}

const PROFILE_SCHEMA = { enum: [...ALL_PROFILES] };
const STRING_ARRAY = { type: 'array', items: { type: 'string' } };

/** JSON Schema of `json-examples-validator.config.json` (everything in `ValidatorOptions` except `root`). */
export const CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: STRING_ARRAY,
    profiles: { type: 'array', items: PROFILE_SCHEMA },
    exactErrors: { type: 'boolean' },
    formatsMode: { enum: ['fast', 'full'] },
    ajvOptions: { type: 'object' },
    skip: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['reason'],
        properties: {
          profile: PROFILE_SCHEMA,
          file: { type: 'string' },
          label: { type: 'string' },
          index: { type: 'integer', minimum: 0 },
          reason: { type: 'string' },
        },
      },
    },
    requireExpectedErrors: { enum: ['off', 'warn', 'error'] },
    checkWrappers: { type: 'boolean' },
    refMap: { type: 'object', additionalProperties: { type: 'string' } },
    offline: { type: 'boolean' },
    includeDotDirs: { oneOf: [{ type: 'boolean' }, STRING_ARRAY] },
  },
} as const;

const validateConfig = new Ajv({ allErrors: true, strict: false }).compile(CONFIG_SCHEMA);

/** Throws a readable error when the parsed config file does not fit `CONFIG_SCHEMA`. */
export function assertValidConfig(config: unknown): asserts config is Partial<ValidatorOptions> {
  if (validateConfig(config)) return;
  const msgs = (validateConfig.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}${e.params && 'additionalProperty' in e.params ? ` (${String(e.params.additionalProperty)})` : ''}`);
  throw new Error(msgs.join('; '));
}
