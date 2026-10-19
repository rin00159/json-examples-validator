import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertValidConfig } from './options.js';
import type { ValidatorOptions } from './types.js';

export const CONFIG_FILE = 'json-examples-validator.config.json';

/** Options from `<root>/json-examples-validator.config.json` (if present), overridden by `options`. */
export async function resolveOptions(options: ValidatorOptions): Promise<ValidatorOptions> {
  let fromFile: Partial<ValidatorOptions> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(join(options.root, CONFIG_FILE), 'utf8'));
    assertValidConfig(parsed);
    fromFile = parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${CONFIG_FILE}: ${(e as Error).message}`);
  }
  const defined = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  return { ...fromFile, ...defined } as ValidatorOptions;
}
