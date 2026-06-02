import type { HeaderMap } from './headers.mts';

/** Inputs for building CORS response headers for a request origin. */
export interface CorsOptions {
  origin?: string | null;
  allowOrigins: string[] | '*' | ((origin: string) => boolean);
  methods?: string[];
  allowHeaders?: string[];
  exposeHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

function originAllowed(origin: string, allow: CorsOptions['allowOrigins']): boolean {
  if (allow === '*') return true;
  if (typeof allow === 'function') return allow(origin);
  return allow.includes(origin);
}

/** Build CORS response headers for an explicit request origin. */
export function buildCorsHeaders(options: CorsOptions): HeaderMap {
  const origin = options.origin ?? '';
  const headers: HeaderMap = {
    vary: 'Origin',
  };

  if (origin.length > 0 && originAllowed(origin, options.allowOrigins)) {
    headers['access-control-allow-origin'] = options.allowOrigins === '*' && !options.credentials ? '*' : origin;
  }

  if (options.methods && options.methods.length > 0) {
    headers['access-control-allow-methods'] = options.methods.join(', ');
  }
  if (options.allowHeaders && options.allowHeaders.length > 0) {
    headers['access-control-allow-headers'] = options.allowHeaders.join(', ');
  }
  if (options.exposeHeaders && options.exposeHeaders.length > 0) {
    headers['access-control-expose-headers'] = options.exposeHeaders.join(', ');
  }
  if (options.credentials) headers['access-control-allow-credentials'] = 'true';
  if (options.maxAge !== undefined) headers['access-control-max-age'] = String(options.maxAge);

  return headers;
}
