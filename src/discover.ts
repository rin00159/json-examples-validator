import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { findSchemaFiles, toPosix as posixPath, VERSION_DIR } from 'jsonschema-lib-layout';
import type { IncludeDotDirs } from 'jsonschema-lib-layout';

export const EXAMPLES_FILE = /^(?<subex>[^._]+)(?:_defs-(?<defs>[^.]+))?\.json-examples\.json$/;
export { findSchemaFiles, isIgnoredDir } from 'jsonschema-lib-layout';

export interface ExampleSource {
  /** Path relative to the library root. */
  examplesFile: string;
  absPath: string;
  versionDir: string;
  version: string;
  /** Schema file relative to the version directory. */
  schemaFile: string;
  /** `$defs` name when the file is `<SubexT>_defs-<DeF>.json-examples.json`. */
  defs?: string;
}

const dirs = async (p: string) =>
  (await readdir(p, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);

const cmpVersion = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  return (x[2] ?? 0) - (y[2] ?? 0);
};

/** examples/<major>/<minor>/<SubexT>[_defs-<DeF>].json-examples.json -> the schema file it targets. */
export async function discoverExamples(root: string, opts: { version?: string; allPatches?: boolean; includeDotDirs?: IncludeDotDirs } = {}): Promise<{ sources: ExampleSource[]; problems: string[] }> {
  const sources: ExampleSource[] = [];
  const problems: string[] = [];
  const schemaRoot = join(root, 'schema');
  const versions = (await dirs(schemaRoot)).filter((v) => VERSION_DIR.test(v));
  const filesOf = new Map<string, string[]>();

  for (const major of (await dirs(join(root, 'examples'))).filter((d) => /^\d+$/.test(d))) {
    for (const minor of (await dirs(join(root, 'examples', major))).filter((d) => /^\d+$/.test(d))) {
      const exDir = join(root, 'examples', major, minor);
      const candidates = versions.filter((v) => v.startsWith(`${major}.${minor}.`)).sort(cmpVersion);
      const chosen = opts.version ? candidates.filter((v) => v === opts.version) : opts.allPatches ? candidates : candidates.slice(-1);
      if (opts.version) {
        const [vMajor, vMinor] = opts.version.split('.');
        if (vMajor !== major || vMinor !== minor) continue;
      }

      for (const name of (await readdir(exDir)).sort()) {
        const m = EXAMPLES_FILE.exec(name);
        if (!m?.groups) {
          if (name.endsWith('.json') && (await stat(join(exDir, name))).isFile()) problems.push(`examples/${major}/${minor}/${name}: file name does not match <SubexT>[_defs-<DeF>].json-examples.json`);
          continue;
        }
        const examplesFile = posixPath(relative(root, join(exDir, name)));
        if (chosen.length === 0) {
          problems.push(`${examplesFile}: no schema/${major}.${minor}.* directory${opts.version ? ` equal to ${opts.version}` : ''}`);
          continue;
        }
        for (const version of chosen) {
          const versionDir = join(schemaRoot, version);
          if (!filesOf.has(version)) filesOf.set(version, await findSchemaFiles(versionDir, opts.includeDotDirs));
          const wanted = `${m.groups.subex}.schema.json`;
          const hits = filesOf.get(version)!.filter((f) => f === wanted || f.endsWith('/' + wanted));
          if (hits.length !== 1) {
            problems.push(`${examplesFile}: ${hits.length === 0 ? 'no' : 'more than one'} ${wanted} in schema/${version}${hits.length ? ` (${hits.join(', ')})` : ''}`);
            continue;
          }
          sources.push({ examplesFile, absPath: join(exDir, name), versionDir, version, schemaFile: hits[0]!, ...(m.groups.defs && { defs: m.groups.defs }) });
        }
      }
    }
  }
  return { sources, problems };
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}
