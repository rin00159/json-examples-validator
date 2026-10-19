import type { ErrorObject, Options as AjvOptions } from 'ajv';

/**
 * How a schema is evaluated:
 * - `annotation`: original schema, `format` is only an annotation (JSON Schema's default). Expectation: `valid`.
 * - `assertion`: original schema, `format` asserted with ajv-formats (mode `formatsMode`).
 * - `format-assert-fast` / `format-assert-full`: the generated copies (`format` replaced by `pattern`), `format` not asserted.
 *
 * Expected result, first defined wins (see `expectedValid`):
 *   full  (assertion with formatsMode=full, format-assert-full): `valid@when_formatAssertionFull` > `valid@when_formatAssertion` > `valid`
 *   fast  (assertion with formatsMode=fast, format-assert-fast): `valid@when_formatAssertion` > `valid`
 */
export type Profile = 'annotation' | 'assertion' | 'format-assert-fast' | 'format-assert-full';
export const ALL_PROFILES: readonly Profile[] = ['annotation', 'assertion', 'format-assert-full', 'format-assert-fast'];

export interface ExpectedError {
  /** JSON Pointer to where the error occurred in the instance. */
  instanceLocation: string;
  /** JSON Pointer to the failing keyword in the schema (compared by suffix). */
  schemaLocation?: string;
  /** One keyword, or a list of acceptable alternatives (e.g. `["format", "pattern"]`). */
  keyword: string | string[];
  /** Partial match against the engine's error params (`{ missingProperty: 'id' }`). */
  params?: Record<string, unknown>;
  /** Engine specific wording; ignored when the file declares another `engine`. */
  message?: string | { regex?: string | string[]; keyword?: string | string[] };
}

export interface ExampleEntry {
  group: string;
  groupPointer?: string;
  name?: string;
  pointer?: string | string[];
  label?: string;
  valid: boolean;
  /** Overrides `valid` when `format` is asserted (fast and full). */
  'valid@when_formatAssertion'?: boolean;
  /** Overrides both of the above when `format` is asserted in ajv-formats' *full* mode (or the format-assert-full copy). */
  'valid@when_formatAssertionFull'?: boolean;
  instance: unknown;
  expectedErrors?: ExpectedError[];
  'expectedErrors@when_formatAssertion'?: ExpectedError[];
  'expectedErrors@when_formatAssertionFull'?: ExpectedError[];
  errorMatch?: 'contains' | 'exact';
}

export interface SkipRule {
  profile?: Profile;
  /** Substring of the examples file path. */
  file?: string;
  /** Exact `label` (or `name`) of the example. */
  label?: string;
  /** Index in `jsons`. */
  index?: number;
  reason: string;
}

export interface ValidatorOptions {
  /** The JSON Schema library root (contains `schema/` and `examples/`). */
  root: string;
  /** Only this schema version, e.g. `0.0.0` (examples/0/0 against schema/0.0.0). */
  version?: string;
  /** Default: all four. A profile whose directory does not exist is reported as skipped. */
  profiles?: readonly Profile[];
  /** Run against every patch version of a major.minor instead of the highest one. */
  allPatches?: boolean;
  /** Require the actual error count to equal `expectedErrors.length` (default: expected errors must be a subset). */
  exactErrors?: boolean;
  /** ajv-formats mode for the `assertion` profile. Default `full`. */
  formatsMode?: 'fast' | 'full';
  /** Extra ajv options. Default `{ allErrors: true, strict: false }`. */
  ajvOptions?: AjvOptions;
  skip?: readonly SkipRule[];
  /** `valid: false` (in some scenario) without a matching expectedErrors: `warn` (default), `error` (a setup problem) or `off`. */
  requireExpectedErrors?: 'off' | 'warn' | 'error';
  /** Also validate every examples file against its `examples/<M>/<m>/schema/<name>.json-examples.schema.json` wrapper, when there is one. */
  checkWrappers?: boolean;
  /** `$ref` / `$schema` URL (without fragment) -> local file; a key ending in `/` maps a whole remote directory to a local directory, so neither example runs nor wrapper checks need the network. Relative to `root`. */
  refMap?: Record<string, string>;
  /** Never use the network for remote `$ref`s (they must then be in `refMap`). */
  offline?: boolean;
  /** Read dot-directories below `schema/<version>` too: `true` for all, or a list of names. `.git`, `node_modules`, `format-assert-*` are never read. */
  includeDotDirs?: boolean | readonly string[];
}

export interface CaseOutcome {
  ok: boolean;
  failures: string[];
  expectedValid: boolean;
  actualValid: boolean;
  errors: ErrorObject[];
}

export interface ExampleCase {
  /** `profile | examples file | #index label` */
  id: string;
  examplesFile: string;
  schemaFile: string;
  index: number;
  label: string;
  profile: Profile;
  skipReason?: string;
  run(): Promise<CaseOutcome>;
}

export interface LoadedCases {
  cases: ExampleCase[];
  /** Setup problems (no matching schema, broken example file, ...). Each one should fail the run. */
  problems: string[];
  /** Non-fatal findings (see `requireExpectedErrors`). */
  warnings: string[];
}

const isFullScenario = (profile: Profile, formatsMode: 'fast' | 'full') => profile === 'format-assert-full' || (profile === 'assertion' && formatsMode === 'full');

/** Expected `valid` of an example under a profile. */
export function expectedValid(ex: ExampleEntry, profile: Profile, formatsMode: 'fast' | 'full'): boolean {
  if (profile === 'annotation') return ex.valid;
  return (isFullScenario(profile, formatsMode) ? ex['valid@when_formatAssertionFull'] : undefined) ?? ex['valid@when_formatAssertion'] ?? ex.valid;
}

/** Expected errors under a profile, with the same priority as `expectedValid`. `undefined` = not specified. */
export function expectedErrorsFor(ex: ExampleEntry, profile: Profile, formatsMode: 'fast' | 'full'): ExpectedError[] | undefined {
  if (profile === 'annotation') return ex.expectedErrors;
  return (isFullScenario(profile, formatsMode) ? ex['expectedErrors@when_formatAssertionFull'] : undefined) ?? ex['expectedErrors@when_formatAssertion'] ?? ex.expectedErrors;
}
