import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Options as AjvOptions, ValidateFunction } from 'ajv';
import { findSchemaFiles } from 'jsonschema-lib-layout';
import { readJson } from './discover.js';
import type { Profile } from './types.js';

// ajv / ajv-formats are CommonJS with a default export; createRequire gives the real constructors under NodeNext.
const require = createRequire(import.meta.url);
interface Ajv {
  addSchema(schema: object, key?: string): unknown;
  compile(schema: object): ValidateFunction;
  compileAsync(schema: object): Promise<ValidateFunction>;
  getSchema(key: string): unknown;
}
type AjvCtor = new (opts: AjvOptions) => Ajv;
const AjvDraft07 = require('ajv').default as AjvCtor;
const Ajv2019 = require('ajv/dist/2019').default as AjvCtor;
const Ajv2020 = require('ajv/dist/2020').default as AjvCtor;
export { Ajv2020, AjvDraft07, Ajv2019 };
export type { AjvCtor, Ajv as AjvLike };
export const addFormats = require('ajv-formats').default as (ajv: Ajv, opts?: { mode?: 'fast' | 'full' }) => Ajv;

type Json = Record<string, unknown>;

export interface Engine {
  /** Validator for `<schema file>#<pointer>`. Remote `$ref`s are resolved here (refMap first, then the network unless offline). */
  validatorFor(schemaFile: string, pointer: string): Promise<ValidateFunction>;
}

function dialectOf(schema: Json): AjvCtor {
  const s = typeof schema.$schema === 'string' ? schema.$schema : '';
  if (s.includes('2019-09')) return Ajv2019;
  if (s.includes('draft-07') || s.includes('draft-06')) return AjvDraft07;
  return Ajv2020;
}

const encodePointer = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/**
 * refMap lookup: an exact URL, or a prefix ending in `/` (maps a whole remote directory to a local one, e.g. a vendored repository).
 */
export function localPathFor(url: string, refMap: Record<string, string> | undefined): string | undefined {
  if (!refMap) return undefined;
  if (refMap[url]) return refMap[url];
  const prefix = Object.keys(refMap)
    .filter((k) => k.endsWith('/') && url.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? join(refMap[prefix]!, url.slice(prefix.length)) : undefined;
}

export interface EngineConfig {
  dir: string;
  profile: Profile;
  formatsMode: 'fast' | 'full';
  ajvOptions: AjvOptions;
  includeDotDirs?: boolean | readonly string[];
  /** `$ref` URL (without fragment) -> absolute local file path. */
  refMap?: Record<string, string>;
  /** Never use the network for `$ref`s. */
  offline?: boolean;
}

/** All `*.schema.json` of `dir` loaded into one ajv instance, so `$ref`s between files resolve through `$id`. */
export async function createEngine(config: EngineConfig): Promise<Engine> {
  const files = await findSchemaFiles(config.dir, config.includeDotDirs);
  const schemas = new Map<string, Json>();
  for (const f of files) schemas.set(f, (await readJson(join(config.dir, f))) as Json);

  const remote = new Map<string, Promise<object>>();
  const loadSchema = (uri: string): Promise<object> => {
    const url = uri.split('#')[0]!;
    if (!remote.has(url)) {
      remote.set(
        url,
        (async () => {
          const local = localPathFor(url, config.refMap);
          if (local) return JSON.parse(await readFile(local, 'utf8')) as object;
          if (config.offline) throw new Error(`$ref ${url} is not in refMap and offline mode is on`);
          const res = await fetch(url);
          if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
          return (await res.json()) as object;
        })(),
      );
    }
    return remote.get(url)!;
  };

  const BUILTIN_META = /json-schema\.org\/(draft\/2020-12|draft\/2019-09|draft-0[4-7])\/schema#?$/;
  const instances = new Map<AjvCtor, Promise<Ajv>>();
  const instanceFor = (Ctor: AjvCtor): Promise<Ajv> => {
    let p = instances.get(Ctor);
    if (!p) {
      p = (async () => {
        // A library may declare its own meta-schema in `$schema` (e.g. an "extends" dialect). This tool checks examples, not
        // schemas, so such schemas are used as they are, without validating them against that meta-schema.
        const customMeta = [...schemas.values()].some((sc) => dialectOf(sc) === Ctor && typeof sc.$schema === 'string' && !BUILTIN_META.test(sc.$schema));
        const ajv = new Ctor({
          allErrors: true,
          strict: false,
          ...(customMeta && { validateSchema: false }),
          ...config.ajvOptions,
          loadSchema,
          validateFormats: config.profile === 'assertion' ? undefined : false,
        } as AjvOptions);
        if (config.profile === 'assertion') addFormats(ajv, { mode: config.formatsMode });
        for (const [file, schema] of schemas) {
          if (dialectOf(schema) !== Ctor) continue;
          ajv.addSchema(schema, typeof schema.$id === 'string' ? undefined : `file:///${file}`);
        }
        await addRemoteSchemas(ajv, [...schemas.values()].filter((sc) => dialectOf(sc) === Ctor), loadSchema);
        return ajv;
      })();
      instances.set(Ctor, p);
    }
    return p;
  };

  const cache = new Map<string, Promise<ValidateFunction>>();
  return {
    validatorFor(schemaFile, pointer) {
      const key = `${schemaFile}#${pointer}`;
      let v = cache.get(key);
      if (!v) {
        const schema = schemas.get(schemaFile);
        if (!schema) return Promise.reject(new Error(`${schemaFile} not found in ${config.dir}`));
        const base = typeof schema.$id === 'string' ? schema.$id.split('#')[0]! : `file:///${schemaFile}`;
        // every remote schema is already registered (addRemoteSchemas), so a plain synchronous compile is enough
        v = instanceFor(dialectOf(schema)).then((ajv) => ajv.compile({ $ref: pointer ? `${base}#${encodePointer(pointer)}` : base }));
        cache.set(key, v);
      }
      return v;
    },
  };
}

const isHttp = (u: string) => /^https?:\/\//i.test(u);
/** Absolute http(s) URLs (fragment stripped) referenced by `$ref` / `$dynamicRef` anywhere in `node`, resolved against `base`. */
function referencedUrls(node: unknown, base: string, out: Set<string>): void {
  if (Array.isArray(node)) return node.forEach((n) => referencedUrls(n, base, out));
  if (typeof node !== 'object' || node === null) return;
  for (const [k, v] of Object.entries(node)) {
    if ((k === '$ref' || k === '$dynamicRef') && typeof v === 'string' && !v.startsWith('#')) {
      try {
        const u = new URL(v, base);
        u.hash = '';
        if (isHttp(u.href)) out.add(u.href);
      } catch {
        /* not a URL: ignore */
      }
    } else referencedUrls(v, base, out);
  }
}

/** Fetch (refMap first) every remote schema the given schemas reference, transitively, and register it with ajv. */
async function addRemoteSchemas(ajv: Ajv, roots: Json[], loadSchema: (uri: string) => Promise<object>): Promise<void> {
  const known = new Set<string>();
  const todo: Array<{ schema: unknown; base: string }> = [];
  for (const sc of roots) {
    const id = typeof sc.$id === 'string' ? sc.$id.split('#')[0]! : '';
    if (id) known.add(id);
    todo.push({ schema: sc, base: id || 'file:///' });
  }
  while (todo.length) {
    const { schema, base } = todo.pop()!;
    const urls = new Set<string>();
    referencedUrls(schema, base, urls);
    for (const url of urls) {
      if (known.has(url) || url.startsWith('https://json-schema.org/')) continue; // meta-schemas are built into ajv
      known.add(url);
      const loaded = (await loadSchema(url)) as Json;
      const id = typeof loaded.$id === 'string' ? loaded.$id.split('#')[0]! : undefined;
      if (id) known.add(id);
      ajv.addSchema(loaded, id ? undefined : url);
      // renamed repositories / redirects: the document declares another $id than the URL it was referenced by -> register it under the URL too
      if (id && id !== url) ajv.addSchema({ ...loaded, $id: url });
      todo.push({ schema: loaded, base: id ?? url });
    }
  }
}
