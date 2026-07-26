export interface JsonSchemaExample {
  description: string;
  data: unknown;
  valid: boolean;
}
export interface JsonSchemaCase {
  description: string;
  schema: Record<string, unknown> | boolean;
  tests: JsonSchemaExample[];
}
export interface JsonSchemaKeywordFile {
  draft: string;
  keyword: string;
  file: string;
  supported: boolean;
  reason?: string;
  cases: JsonSchemaCase[];
}
export const JSON_SCHEMA_TEST_SUITE_SUBSET: JsonSchemaKeywordFile[] = [
  {
    draft: 'draft2020-12',
    keyword: 'type',
    file: 'type.json',
    supported: true,
    cases: [
      {
        description: 'primitive JSON types',
        schema: { type: ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'] },
        tests: [
          {
            description: 'string is valid',
            data: 'x',
            valid: true,
          },
          {
            description: 'integer is valid',
            data: 1,
            valid: true,
          },
          {
            description: 'non-integer number is valid',
            data: 1.5,
            valid: true,
          },
          {
            description: 'object is valid',
            data: {},
            valid: true,
          },
        ],
      },
      {
        description: 'integer excludes fractional numbers',
        schema: { type: 'integer' },
        tests: [
          {
            description: 'integer matches',
            data: 2,
            valid: true,
          },
          {
            description: 'fractional number fails',
            data: 2.5,
            valid: false,
          },
        ],
      },
    ],
  },
  {
    draft: 'draft2020-12',
    keyword: 'const',
    file: 'const.json',
    supported: true,
    cases: [
      {
        description: 'const validates deep JSON equality',
        schema: { const: { a: [1, true, null] } },
        tests: [
          {
            description: 'same object is valid',
            data: { a: [1, true, null] },
            valid: true,
          },
          {
            description: 'different array value is invalid',
            data: { a: [1, false, null] },
            valid: false,
          },
        ],
      },
    ],
  },
  {
    draft: 'draft2020-12',
    keyword: 'enum',
    file: 'enum.json',
    supported: true,
    cases: [
      {
        description: 'enum validates deep JSON equality',
        schema: { enum: ['red', { tagged: true }, null] },
        tests: [
          {
            description: 'string member is valid',
            data: 'red',
            valid: true,
          },
          {
            description: 'object member is valid',
            data: { tagged: true },
            valid: true,
          },
          {
            description: 'missing member is invalid',
            data: 'blue',
            valid: false,
          },
        ],
      },
    ],
  },
  {
    draft: 'draft2020-12',
    keyword: 'properties',
    file: 'properties.json',
    supported: true,
    cases: [
      {
        description: 'properties and required',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            count: { type: 'integer' },
          },
          required: ['name'],
        },
        tests: [
          {
            description: 'required property present',
            data: {
              name: 'ok',
              count: 1,
            },
            valid: true,
          },
          {
            description: 'required property missing',
            data: { count: 1 },
            valid: false,
          },
          {
            description: 'property schema failure',
            data: {
              name: 'ok',
              count: '1',
            },
            valid: false,
          },
        ],
      },
    ],
  },
  {
    draft: 'draft2020-12',
    keyword: 'additionalProperties',
    file: 'additionalProperties.json',
    supported: true,
    cases: [
      {
        description: 'additionalProperties false rejects extras',
        schema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          additionalProperties: false,
        },
        tests: [
          {
            description: 'known property only is valid',
            data: { name: 'ok' },
            valid: true,
          },
          {
            description: 'unknown property is invalid',
            data: {
              name: 'ok',
              extra: true,
            },
            valid: false,
          },
        ],
      },
      {
        description: 'additionalProperties schema validates extras',
        schema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          additionalProperties: {
            type: 'integer',
            minimum: 1,
          },
        },
        tests: [
          {
            description: 'valid extra value',
            data: {
              name: 'ok',
              retries: 2,
            },
            valid: true,
          },
          {
            description: 'invalid extra value',
            data: {
              name: 'ok',
              retries: 0,
            },
            valid: false,
          },
        ],
      },
    ],
  },
  {
    draft: 'draft2020-12',
    keyword: 'items',
    file: 'items.json',
    supported: true,
    cases: [
      {
        description: 'homogeneous array items',
        schema: {
          type: 'array',
          items: { type: 'string' },
        },
        tests: [
          {
            description: 'all items match',
            data: ['a', 'b'],
            valid: true,
          },
          {
            description: 'one item fails',
            data: ['a', 1],
            valid: false,
          },
        ],
      },
    ],
  },
  {
    draft: 'draft2020-12',
    keyword: 'prefixItems',
    file: 'prefixItems.json',
    supported: true,
    cases: [
      {
        description: 'tuple validation',
        schema: {
          type: 'array',
          prefixItems: [{ type: 'string' }, { type: 'integer' }],
        },
        tests: [
          {
            description: 'tuple items match',
            data: ['a', 1],
            valid: true,
          },
          {
            description: 'tuple item fails',
            data: ['a', '1'],
            valid: false,
          },
        ],
      },
    ],
  },
  {
    draft: 'draft2020-12',
    keyword: 'anyOf',
    file: 'anyOf.json',
    supported: true,
    cases: [
      {
        description: 'anyOf validates at least one branch',
        schema: {
          anyOf: [
            {
              type: 'string',
              minLength: 2,
            },
            {
              type: 'integer',
              minimum: 10,
            },
          ],
        },
        tests: [
          {
            description: 'first branch matches',
            data: 'ok',
            valid: true,
          },
          {
            description: 'second branch matches',
            data: 12,
            valid: true,
          },
          {
            description: 'no branch matches',
            data: 3,
            valid: false,
          },
        ],
      },
    ],
  },
  {
    draft: 'draft2020-12',
    keyword: 'string',
    file: 'minLength-maxLength-pattern-format.json',
    supported: true,
    cases: [
      {
        description: 'string size pattern and supported formats',
        schema: {
          type: 'string',
          minLength: 3,
          maxLength: 8,
          pattern: '^[a-z]+@[a-z]+\\.[a-z]+$',
          format: 'email',
        },
        tests: [
          {
            description: 'valid email-like string',
            data: 'a@b.co',
            valid: true,
          },
          {
            description: 'too short',
            data: 'a@',
            valid: false,
          },
          {
            description: 'pattern mismatch',
            data: 'A@b.co',
            valid: false,
          },
          {
            description: 'format mismatch',
            data: 'abcde',
            valid: false,
          },
        ],
      },
    ],
  },
  {
    draft: 'draft2020-12',
    keyword: 'number',
    file: 'minimum-maximum.json',
    supported: true,
    cases: [
      {
        description: 'numeric minimum and maximum',
        schema: {
          type: 'number',
          minimum: 1,
          maximum: 5,
        },
        tests: [
          {
            description: 'inside inclusive bounds',
            data: 3,
            valid: true,
          },
          {
            description: 'below minimum',
            data: 0,
            valid: false,
          },
          {
            description: 'above maximum',
            data: 6,
            valid: false,
          },
        ],
      },
    ],
  },
  {
    draft: 'draft2020-12',
    keyword: 'array',
    file: 'minItems-maxItems.json',
    supported: true,
    cases: [
      {
        description: 'array length',
        schema: {
          type: 'array',
          minItems: 1,
          maxItems: 2,
        },
        tests: [
          {
            description: 'length in range',
            data: [1],
            valid: true,
          },
          {
            description: 'too few items',
            data: [],
            valid: false,
          },
          {
            description: 'too many items',
            data: [1, 2, 3],
            valid: false,
          },
        ],
      },
    ],
  },
  {
    draft: 'draft2020-12',
    keyword: '$ref',
    file: 'ref.json',
    supported: false,
    reason: '$ref and $defs are outside the documented fino:validate subset',
    cases: [
      {
        description: 'unsupported $ref is intentionally skipped',
        schema: {
          $ref: '#/$defs/name',
          $defs: { name: { type: 'string' } },
        },
        tests: [
          {
            description: 'would fail with full JSON Schema resolution',
            data: 42,
            valid: false,
          },
        ],
      },
    ],
  },
  {
    draft: 'draft2020-12',
    keyword: 'oneOf',
    file: 'oneOf.json',
    supported: false,
    reason: 'oneOf is outside the documented fino:validate subset',
    cases: [
      {
        description: 'unsupported oneOf is intentionally skipped',
        schema: { oneOf: [{ type: 'string' }] },
        tests: [
          {
            description: 'would fail when no branch matches',
            data: 42,
            valid: false,
          },
        ],
      },
    ],
  },
  {
    draft: 'draft2020-12',
    keyword: 'allOf',
    file: 'allOf.json',
    supported: false,
    reason: 'allOf is outside the documented fino:validate subset',
    cases: [
      {
        description: 'unsupported allOf is intentionally skipped',
        schema: { allOf: [{ type: 'string' }] },
        tests: [
          {
            description: 'would fail when branch fails',
            data: 42,
            valid: false,
          },
        ],
      },
    ],
  },
  {
    draft: 'draft2020-12',
    keyword: 'not',
    file: 'not.json',
    supported: false,
    reason: 'not is outside the documented fino:validate subset',
    cases: [
      {
        description: 'unsupported not is intentionally skipped',
        schema: { not: { type: 'number' } },
        tests: [
          {
            description: 'would fail for negated schema match',
            data: 42,
            valid: false,
          },
        ],
      },
    ],
  },
  {
    draft: 'draft2020-12',
    keyword: 'patternProperties',
    file: 'patternProperties.json',
    supported: false,
    reason: 'patternProperties is outside the documented fino:validate subset',
    cases: [
      {
        description: 'unsupported patternProperties is intentionally skipped',
        schema: {
          type: 'object',
          patternProperties: { '^s_': { type: 'string' } },
        },
        tests: [
          {
            description: 'would fail matching property schema',
            data: { s_key: 1 },
            valid: false,
          },
        ],
      },
    ],
  },
  {
    draft: 'draft2020-12',
    keyword: 'format',
    file: 'unsupported-format.json',
    supported: false,
    reason:
      'formats other than email, url, and uri are outside the documented fino:validate subset',
    cases: [
      {
        description: 'unsupported uuid format is intentionally skipped',
        schema: {
          type: 'string',
          format: 'uuid',
        },
        tests: [
          {
            description: 'would fail with a uuid format assertion vocabulary',
            data: 'not-a-uuid',
            valid: false,
          },
        ],
      },
    ],
  },
];
