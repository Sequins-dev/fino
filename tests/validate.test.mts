import { describe, it } from 'fino:test/test';
import { ValidationError, compile, parse, safeParse, v } from 'fino:validate';

describe('fino:validate', () => {
  it('builders are directly JSON serializable as JSON Schema', (t) => {
    const schema = v.object({
      name: v.string().min(2),
      port: v.integer().min(1).max(65535).default(3000),
      debug: v.boolean().optional(),
    }).additionalProperties(false);

    const json = JSON.parse(JSON.stringify(schema));

    t.equal(json.type, 'object', 'object schema type emitted');
    t.deepEqual(json.required, ['name', 'port'], 'optional properties are excluded from required');
    t.equal(json.properties.name.minLength, 2, 'string constraints are JSON Schema');
    t.equal(json.properties.port.default, 3000, 'defaults are JSON Schema');
    t.equal(json.additionalProperties, false, 'additionalProperties is preserved');
  });

  it('accepts raw JSON Schema objects in all validation APIs', (t) => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[a-z]+$' },
        count: { type: 'integer', minimum: 1 },
      },
      required: ['id', 'count'],
      additionalProperties: false,
    };
    const validator = compile(schema);

    t.deepEqual(parse(schema, { id: 'abc', count: 2 }), { id: 'abc', count: 2 }, 'parse accepts raw schema');
    t.equal(validator.safeParse({ id: 'abc', count: 2 }).success, true, 'compiled validator accepts valid input');
    t.equal(safeParse(schema, { id: 'ABC', count: 0 }).success, false, 'safeParse reports invalid input');
  });

  it('applies defaults and reports nested validation errors', (t) => {
    const schema = v.object({
      service: v.object({
        name: v.string().min(1),
        port: v.integer().default(8080),
      }),
      tags: v.array(v.string()).min(1),
    });

    const value = parse(schema, {
      service: { name: 'api' },
      tags: ['backend'],
    });

    t.deepEqual(value, { service: { name: 'api', port: 8080 }, tags: ['backend'] }, 'defaults are applied');
    t.throws(
      () => parse(schema, { service: { name: '' }, tags: [] }),
      (err) => err instanceof ValidationError && err.issues.length === 2,
      'throws ValidationError with nested issues',
    );
  });

  it('supports unions, enums, tuples, and refinements', (t) => {
    const schema = v.object({
      mode: v.enum(['dev', 'prod']),
      endpoint: v.union([v.string().format('url'), v.literal(null)]),
      pair: v.tuple([v.string(), v.integer()]),
      even: v.number().refine((value) => Number(value) % 2 === 0, 'must be even'),
    });

    t.equal(parse(schema, {
      mode: 'prod',
      endpoint: 'https://example.com',
      pair: ['a', 1],
      even: 4,
    }).even, 4, 'valid composite schema parses');

    t.equal(safeParse(schema, {
      mode: 'test',
      endpoint: 'not-url',
      pair: ['a'],
      even: 3,
    }).success, false, 'invalid composite schema fails');
  });
});
