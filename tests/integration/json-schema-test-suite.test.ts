/**
 * JSON Schema Test Suite subset for `fino:validate`.
 *
 * The fixture mirrors the upstream JSON Schema Test Suite shape, but only runs
 * the documented `fino:validate` subset. Unsupported keywords are registered
 * as skipped subtests with explicit out-of-scope reasons so TAP output remains
 * granular without implying full JSON Schema support.
 */

import { describe, it } from 'fino:test/test';
import { safeParse } from 'fino:validate';
import {
  JSON_SCHEMA_TEST_SUITE_SUBSET,
  type JsonSchemaCase,
  type JsonSchemaExample,
  type JsonSchemaKeywordFile,
} from './fixtures/json-schema-test-suite-subset.ts';

interface TestContext {
  equal(actual: unknown, expected: unknown, message?: string): void;
}

function exampleName(testCase: JsonSchemaCase, example: JsonSchemaExample): string {
  return `${testCase.description} — ${example.description}`;
}

function assertExample(t: TestContext, keywordFile: JsonSchemaKeywordFile, testCase: JsonSchemaCase, example: JsonSchemaExample): void {
  const result = safeParse(testCase.schema as any, example.data);
  t.equal(
    result.success,
    example.valid,
    `${keywordFile.draft}/${keywordFile.file}: expected ${example.valid ? 'valid' : 'invalid'} for ${JSON.stringify(example.data)}`,
  );
}

describe('JSON Schema Test Suite subset — fino:validate', () => {
  it('documents every unsupported fixture with an explicit reason', (t) => {
    for (const keywordFile of JSON_SCHEMA_TEST_SUITE_SUBSET) {
      if (!keywordFile.supported) {
        t.ok(keywordFile.reason && keywordFile.reason.length > 0, `${keywordFile.keyword} has an out-of-scope reason`);
      }
    }
  });

  for (const keywordFile of JSON_SCHEMA_TEST_SUITE_SUBSET) {
    describe(`${keywordFile.draft}/${keywordFile.file}`, () => {
      for (const testCase of keywordFile.cases) {
        for (const example of testCase.tests) {
          it(exampleName(testCase, example), { skip: keywordFile.supported ? false : keywordFile.reason }, (t) => {
            assertExample(t, keywordFile, testCase, example);
          });
        }
      }
    });
  }
});
