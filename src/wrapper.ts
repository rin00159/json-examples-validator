import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { absRefMap } from './cases.js';
import { resolveOptions } from './config.js';
import { discoverExamples, findSchemaFiles, readJson } from './discover.js';
import { Ajv2020, localPathFor } from './engine.js';
import type { ValidatorOptions } from './types.js';

type Json = Record<string, unknown>;
const WRAPPER_SUFFIX = '.json-examples.schema.json';

/** Rewrite relative `$ref`s of a wrapper schema to the `$id` of the library schema file they point to. */
function rewriteRefs(node: unknown, wrapperDir: string, idOfPath: Map<string, string>): unknown {
  if (Array.isArray(node)) return node.map((n) => rewriteRefs(n, wrapperDir, idOfPath));
  if (typeof node !== 'object' || node === null) return node;
  return Object.fromEntries(
    Object.entries(node).map(([k, v]) => {
      if (k === '$ref' && typeof v === 'string' && !v.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(v)) {
        const [path = '', frag] = v.split('#');
        const id = idOfPath.get(resolve(wrapperDir, path));
        return [k, id ? `${id}${frag !== undefined ? '#' + frag : ''}` : v];
      }
      return [k, rewriteRefs(v, wrapperDir, idOfPath)];
    }),
  );
}

/**
 * Validate each examples file against its editor-facing wrapper schema
 * (`examples/<M>/<m>/schema/<name>.json-examples.schema.json`, the ones with the `_hook_valid` convention), when it exists.
 * Both the wrapper and this tool answer "do the examples agree with the schema?", so they must not disagree.
 * Returns problems. Remote `$ref`s are fetched unless `refMap` maps them to local files.
 *
 * `format` is NOT asserted here: a wrapper only knows `valid`, not the `valid@when_formatAssertion*` overrides, so it speaks for the
 * annotation view of the schema (which is also what `valid` means).
 */
export async function checkWrappers(options: ValidatorOptions): Promise<string[]> {
  const opts = await resolveOptions(options);
  const { sources, problems } = await discoverExamples(opts.root, { version: opts.version, allPatches: opts.allPatches, includeDotDirs: opts.includeDotDirs });
  const found: string[] = [];
  const refMap = absRefMap(opts);

  for (const src of sources) {
    const wrapperPath = join(dirname(src.absPath), 'schema', basename(src.absPath).replace(/\.json-examples\.json$/, WRAPPER_SUFFIX));
    if (!existsSync(wrapperPath)) continue;
    const name = `${src.examplesFile} <-> ${wrapperPath.slice(opts.root.length + 1)}`;
    try {
      const ajv = new Ajv2020({ allErrors: true, strict: false, ...opts.ajvOptions, validateFormats: false, loadSchema: async (uri: string) => {
        const local = localPathFor(uri.split('#')[0]!, refMap);
        if (local) return JSON.parse(await readFile(local, 'utf8'));
        if (opts.offline) throw new Error(`${uri} is not in refMap and offline mode is on`);
        const res = await fetch(uri);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      } } as never);

      const idOfPath = new Map<string, string>();
      for (const f of await findSchemaFiles(src.versionDir, opts.includeDotDirs)) {
        const abs = resolve(src.versionDir, f);
        const schema = (await readJson(abs)) as Json;
        if (typeof schema.$id === 'string') {
          idOfPath.set(abs, schema.$id);
          ajv.addSchema(schema);
        }
      }
      const wrapper = (await readJson(wrapperPath)) as Json;
      const rewritten = rewriteRefs(wrapper, dirname(wrapperPath), idOfPath) as Json;
      if (typeof rewritten.$id !== 'string') rewritten.$id = pathToFileURL(wrapperPath).href;
      const validate = await ajv.compileAsync(rewritten);
      const doc = await readJson(src.absPath);
      if (!validate(doc)) {
        for (const e of validate.errors ?? []) found.push(`${name}: ${e.instancePath || '/'} ${e.keyword} (${e.message})`);
      }
    } catch (e) {
      found.push(`${name}: cannot check (${(e as Error).message})`);
    }
  }
  return [...problems, ...found];
}
