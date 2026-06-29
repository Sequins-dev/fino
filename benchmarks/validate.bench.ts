/**
 * Benchmarks for fino:validate
 *
 * Run with: cargo run -- bench benchmarks/validate.bench.ts
 */

import { compile as compileValidator, safeParse, v } from 'fino:validate';
import { bench } from 'fino:bench';

const userSchema = v.object({
  name: v.string(),
  port: v.integer().min(1).max(65535),
  enabled: v.boolean().default(true),
});
const compiledUser = compileValidator(userSchema);

bench('validate', (b) => {
  b.measure('compile object schema', () => compileValidator(userSchema));
  b.measure('compiled parse', () => compiledUser.parse({ name: 'fino', port: 3030 }));
  b.measure('safeParse invalid', () => safeParse(userSchema, { name: 'fino', port: 0 }));
});
