import { describe, it } from 'fino:test/test';
import { ValidationError, compile, parse, safeParse, v } from 'fino:validate';
describe('fino:validate', () => {
  it('builders are directly JSON serializable as JSON Schema', (t) => {
    const schema = v
      .object({
        name: v.string().min(2),
        port: v.integer().min(1).max(65535).default(3e3),
        debug: v.boolean().optional(),
      })
      .additionalProperties(false);
    const json = JSON.parse(JSON.stringify(schema));
    t.equal(json.type, 'object', 'object schema type emitted');
    t.deepEqual(json.required, ['name', 'port'], 'optional properties are excluded from required');
    t.equal(json.properties.name.minLength, 2, 'string constraints are JSON Schema');
    t.equal(json.properties.port.default, 3e3, 'defaults are JSON Schema');
    t.equal(json.additionalProperties, false, 'additionalProperties is preserved');
  });
  it('describe() adds description to JSON Schema output', (t) => {
    const schema = v.object({
      query: v.string().describe('The search query string'),
      limit: v.integer().min(1).max(100).default(10).describe('Max results to return'),
    });
    const json = JSON.parse(JSON.stringify(schema));
    t.equal(
      json.properties.query.description,
      'The search query string',
      'field description emitted',
    );
    t.equal(
      json.properties.limit.description,
      'Max results to return',
      'field description alongside other constraints',
    );
    t.equal(json.properties.limit.default, 10, 'default preserved alongside description');
  });
  it('accepts raw JSON Schema objects in all validation APIs', (t) => {
    const schema = {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          pattern: '^[a-z]+$',
        },
        count: {
          type: 'integer',
          minimum: 1,
        },
      },
      required: ['id', 'count'],
      additionalProperties: false,
    };
    const validator = compile(schema);
    t.deepEqual(
      parse(schema, {
        id: 'abc',
        count: 2,
      }),
      {
        id: 'abc',
        count: 2,
      },
      'parse accepts raw schema',
    );
    t.equal(
      validator.safeParse({
        id: 'abc',
        count: 2,
      }).success,
      true,
      'compiled validator accepts valid input',
    );
    t.equal(
      safeParse(schema, {
        id: 'ABC',
        count: 0,
      }).success,
      false,
      'safeParse reports invalid input',
    );
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
    t.deepEqual(
      value,
      {
        service: {
          name: 'api',
          port: 8080,
        },
        tags: ['backend'],
      },
      'defaults are applied',
    );
    t.throws(
      () =>
        parse(schema, {
          service: { name: '' },
          tags: [],
        }),
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
    t.equal(
      parse(schema, {
        mode: 'prod',
        endpoint: 'https://example.com',
        pair: ['a', 1],
        even: 4,
      }).even,
      4,
      'valid composite schema parses',
    );
    t.equal(
      safeParse(schema, {
        mode: 'test',
        endpoint: 'not-url',
        pair: ['a'],
        even: 3,
      }).success,
      false,
      'invalid composite schema fails',
    );
  });
  it('supports nullable, const, and string formats', (t) => {
    const schema = v.object({
      maybe: v.string().nullable(),
      fixed: v.literal('ready'),
      email: v.string().format('email'),
      uri: v.string().format('uri'),
    });
    t.deepEqual(
      parse(schema, {
        maybe: null,
        fixed: 'ready',
        email: 'ops@example.com',
        uri: 'https://example.com/path',
      }),
      {
        maybe: null,
        fixed: 'ready',
        email: 'ops@example.com',
        uri: 'https://example.com/path',
      },
      'nullable and formatted values parse',
    );
    const result = safeParse(schema, {
      maybe: 1,
      fixed: 'pending',
      email: 'not-email',
      uri: 'not uri',
    });
    t.equal(result.success, false, 'invalid nullable, const, and formats fail');
    if (!result.success) {
      const keywords = result.issues.map((issue) => issue.keyword);
      t.ok(keywords.includes('anyOf'), 'nullable anyOf failure is reported');
      t.ok(keywords.includes('const'), 'const failure is reported');
      t.equal(
        keywords.filter((keyword) => keyword === 'format').length,
        2,
        'both format failures are reported',
      );
    }
  });
  it('supports raw JSON Schema type arrays', (t) => {
    const schema = { type: ['string', 'null'] };
    t.equal(safeParse(schema, 'ok').success, true, 'string is accepted');
    t.equal(safeParse(schema, null).success, true, 'null is accepted');
    t.equal(safeParse(schema, 42).success, false, 'other types are rejected');
  });
  it('clones object and array defaults before returning parsed values', (t) => {
    const schema = v.object({
      settings: v.any().default({
        tags: ['api'],
        nested: { enabled: true },
      }),
    });
    const first = parse<Record<string, any>>(schema, {});
    const second = parse<Record<string, any>>(schema, {});
    first.settings.tags.push('mutated');
    first.settings.nested.enabled = false;
    t.deepEqual(
      second,
      {
        settings: {
          tags: ['api'],
          nested: { enabled: true },
        },
      },
      'later defaults are not mutated by earlier parse output',
    );
  });
  it('validates arrays, tuples, and object edge cases with paths', (t) => {
    const schema = v
      .object({
        list: v.array(v.integer()).min(2).max(3),
        tuple: v.tuple([v.string(), v.integer()]),
      })
      .additionalProperties(false);
    const result = safeParse(schema, {
      list: [1, 'two', 3, 4],
      tuple: ['ok', 'bad', 'extra'],
      extra: true,
    });
    t.equal(result.success, false, 'invalid arrays, tuples, and extra keys fail');
    if (!result.success) {
      t.ok(
        result.issues.some((issue) => issue.path === 'list' && issue.keyword === 'maxItems'),
        'array length issue is reported',
      );
      t.ok(
        result.issues.some((issue) => issue.path === 'list[1]' && issue.keyword === 'type'),
        'array item issue uses indexed path',
      );
      t.ok(
        result.issues.some((issue) => issue.path === 'tuple[1]' && issue.keyword === 'type'),
        'tuple item issue uses indexed path',
      );
      t.ok(
        result.issues.some((issue) => issue.path === 'tuple' && issue.keyword === 'maxItems'),
        'tuple extra item issue is reported',
      );
      t.ok(
        result.issues.some(
          (issue) => issue.path === 'extra' && issue.keyword === 'additionalProperties',
        ),
        'extra object key issue is reported',
      );
    }
  });
  it('validates schema-valued additionalProperties', (t) => {
    const schema = v.object({ known: v.string() }).additionalProperties(v.integer().min(1).schema);
    t.deepEqual(
      parse(schema, {
        known: 'ok',
        retries: 3,
      }),
      {
        known: 'ok',
        retries: 3,
      },
      'valid extra property parses',
    );
    const result = safeParse(schema, {
      known: 'ok',
      retries: 0,
      mode: 'fast',
    });
    t.equal(result.success, false, 'invalid extra properties fail against schema');
    if (!result.success) {
      t.ok(
        result.issues.some((issue) => issue.path === 'retries' && issue.keyword === 'minimum'),
        'numeric extra property constraint is reported',
      );
      t.ok(
        result.issues.some((issue) => issue.path === 'mode' && issue.keyword === 'type'),
        'typed extra property constraint is reported',
      );
    }
  });
  it('reports invalid schemas and applies refinements after defaults', (t) => {
    t.throws(() => compile(null), /Expected JSON Schema object/, 'null schema is rejected');
    t.throws(
      () => v.array(null as any),
      /Expected JSON Schema object/,
      'invalid item schema is rejected',
    );
    const schema = v
      .string()
      .default('generated')
      .refine((value) => value.startsWith('gen'), 'must be generated');
    t.equal(parse(schema, undefined), 'generated', 'refinement sees defaulted value');
    t.equal(
      safeParse(schema, 'manual').success,
      false,
      'refinement rejects explicit invalid value',
    );
  });
  it('documents ignored keywords outside the supported JSON Schema subset', (t) => {
    t.equal(
      safeParse(
        {
          type: 'string',
          minLength: 2,
          unknownKeyword: true,
        },
        'a',
      ).success,
      false,
      'supported keywords still apply',
    );
    t.equal(
      safeParse(
        {
          type: 'string',
          unknownKeyword: true,
        },
        'a',
      ).success,
      true,
      'unknown keywords are ignored',
    );
    t.equal(
      safeParse(
        {
          $ref: '#/$defs/name',
          $defs: { name: { type: 'string' } },
        },
        42,
      ).success,
      true,
      '$ref and $defs are not resolved',
    );
    t.equal(
      safeParse({ oneOf: [{ type: 'string' }] }, 42).success,
      true,
      'oneOf is not implemented',
    );
    t.equal(
      safeParse({ allOf: [{ type: 'string' }] }, 42).success,
      true,
      'allOf is not implemented',
    );
    t.equal(safeParse({ not: { type: 'number' } }, 42).success, true, 'not is not implemented');
    t.equal(
      safeParse(
        {
          type: 'string',
          format: 'uuid',
        },
        'not-a-uuid',
      ).success,
      true,
      'unsupported formats are ignored',
    );
  });
});
