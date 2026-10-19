import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const BASE = 'https://example.test/lib/main/schema/0.1.0';

export async function put(root: string, rel: string, content: unknown): Promise<void> {
  const p = join(root, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, typeof content === 'string' ? content : JSON.stringify(content, null, '\t') + '\n');
}

/** A tiny library: schema/0.1.0 (+ older 0.1.0 patches) with a format-using schema and a $ref'd sub-schema; examples/0/1. */
export async function makeLibrary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-'));
  await put(root, 'schema/0.1.0/main.schema.json', {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${BASE}/main.schema.json`,
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' }, child: { $ref: 'ide/child.schema.json' } },
    $defs: { when: { type: 'string', format: 'date' } },
  });
  await put(root, 'schema/0.1.0/ide/child.schema.json', {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${BASE}/ide/child.schema.json`,
    type: 'object',
    properties: { n: { type: 'integer', minimum: 1 } },
  });
  return root;
}
