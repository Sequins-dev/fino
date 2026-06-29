/**
 * Benchmarks for fino:security/cors
 */

import { buildCorsHeaders } from 'fino:security/cors';
import { bench } from 'fino:bench';

bench('security/cors', (b) => {
  b.measure('buildCorsHeaders()', () => buildCorsHeaders({
    origin: 'https://app.example',
    allowOrigins: ['https://app.example'],
    methods: ['GET', 'POST'],
  }));
});
