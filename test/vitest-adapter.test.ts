// Dogfooding: the vitest adapter registers one test per (example, profile) of a throw-away library.
import { defineExamplesTests } from '../src/vitest.js';
import { makeLibrary, put } from './fixture.js';

const root = await makeLibrary();
await put(root, 'examples/0/1/main.json-examples.json', {
  jsons: [
    { group: 'basic', label: 'valid doc', valid: true, instance: { id: '123e4567-e89b-12d3-a456-426614174000' } },
    { group: 'basic', label: 'missing id', valid: false, instance: {}, expectedErrors: [{ instanceLocation: '', keyword: 'required' }] },
    { group: 'basic', label: 'bad uuid only fails under assertion', valid: true, 'valid@when_formatAssertion': false, 'expectedErrors@when_formatAssertion': [{ instanceLocation: '/id', keyword: ['format', 'pattern'] }], instance: { id: 'x' } },
  ],
});

await defineExamplesTests({ root, profiles: ['annotation', 'assertion'] });
