import type { ErrorObject } from 'ajv';
import type { ExpectedError, Profile } from './types.js';

const asArray = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const fragment = (s: string) => (s.includes('#') ? s.slice(s.indexOf('#') + 1) : s);

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Every key of `expected` is present in `actual` with a deep-equal value (objects recurse as partial matches). */
export function partialMatch(expected: unknown, actual: unknown): boolean {
  if (isPlainObject(expected)) return isPlainObject(actual) && Object.entries(expected).every(([k, v]) => k in actual && partialMatch(v, actual[k]));
  return JSON.stringify(expected) === JSON.stringify(actual);
}

export interface MatchOptions {
  /** Compare `message` (false when the file declares an engine other than ajv). */
  compareMessages: boolean;
}

/** Does `actual` (an ajv error) satisfy `expected`? Returns the reasons it does not (empty = match). */
export function mismatch(expected: ExpectedError, actual: ErrorObject, profile: Profile, opts: MatchOptions = { compareMessages: true }): string[] {
  const why: string[] = [];
  // The format-assert-* copies have `pattern` where the original has `format`: only location + keyword are comparable there.
  const converted = profile === 'format-assert-fast' || profile === 'format-assert-full';
  if (expected.instanceLocation !== actual.instancePath) why.push(`instanceLocation ${JSON.stringify(actual.instancePath)}`);
  if (!asArray(expected.keyword).includes(actual.keyword)) why.push(`keyword ${actual.keyword}`);
  if (converted) return why;

  if (expected.schemaLocation !== undefined) {
    const e = fragment(expected.schemaLocation);
    const a = fragment(actual.schemaPath);
    // ajv reports the path relative to the referenced subschema, the example may give the full one: accept either as a suffix of the other
    if (!(e === a || e.endsWith(a) || a.endsWith(e))) why.push(`schemaLocation ${actual.schemaPath}`);
  }
  if (expected.params !== undefined && !partialMatch(expected.params, actual.params)) why.push(`params ${JSON.stringify(actual.params)}`);
  if (opts.compareMessages && expected.message !== undefined) {
    const msg = actual.message ?? '';
    if (typeof expected.message === 'string') {
      if (!msg.includes(expected.message)) why.push(`message ${JSON.stringify(msg)}`);
    } else {
      for (const r of asArray(expected.message.regex)) if (!new RegExp(r).test(msg)) why.push(`message ${JSON.stringify(msg)} !~ /${r}/`);
      for (const k of asArray(expected.message.keyword)) if (!msg.includes(k)) why.push(`message ${JSON.stringify(msg)} lacks "${k}"`);
    }
  }
  return why;
}

/** Every expected error must be matched by a distinct actual error. */
export function matchErrors(
  expected: readonly ExpectedError[],
  actual: readonly ErrorObject[],
  profile: Profile,
  exact: boolean,
  opts: MatchOptions = { compareMessages: true },
): string[] {
  const failures: string[] = [];
  const used = new Set<number>();
  for (const exp of expected) {
    let best: string[] | undefined;
    let found = -1;
    actual.forEach((a, i) => {
      if (found >= 0 || used.has(i)) return;
      const why = mismatch(exp, a, profile, opts);
      if (why.length === 0) found = i;
      else if (!best || why.length < best.length) best = why;
    });
    if (found >= 0) used.add(found);
    else failures.push(`expected error not produced: ${JSON.stringify(exp)}${best ? ` (closest differs in: ${best.join('; ')})` : ' (no errors at all)'}`);
  }
  if (exact && actual.length !== expected.length) {
    failures.push(`expected exactly ${expected.length} error(s), got ${actual.length}: ${actual.map((e) => `${e.instancePath || '/'} ${e.keyword}`).join(', ')}`);
  }
  return failures;
}
