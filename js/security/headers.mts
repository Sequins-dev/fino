/** Case-insensitive HTTP header map represented with lower-case names. */
export type HeaderMap = Record<string, string>;

/** Options controlling the default backend security headers. */
export interface SecurityHeadersOptions {
  contentSecurityPolicy?: string | false;
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false;
  referrerPolicy?: string | false;
  strictTransportSecurity?: string | false;
  permissionsPolicy?: string | false;
  crossOriginOpenerPolicy?: string | false;
  extra?: HeaderMap;
}

/** Build conservative security headers for backend HTTP responses. */
export function createSecurityHeaders(options: SecurityHeadersOptions = {}): HeaderMap {
  const headers: HeaderMap = {
    'x-content-type-options': 'nosniff',
  };

  const frameOptions = options.frameOptions ?? 'DENY';
  if (frameOptions !== false) headers['x-frame-options'] = frameOptions;

  const referrerPolicy = options.referrerPolicy ?? 'no-referrer';
  if (referrerPolicy !== false) headers['referrer-policy'] = referrerPolicy;

  const hsts = options.strictTransportSecurity ?? 'max-age=31536000; includeSubDomains';
  if (hsts !== false) headers['strict-transport-security'] = hsts;

  const coop = options.crossOriginOpenerPolicy ?? 'same-origin';
  if (coop !== false) headers['cross-origin-opener-policy'] = coop;

  const csp = options.contentSecurityPolicy;
  if (typeof csp === 'string') headers['content-security-policy'] = csp;

  const permissionsPolicy = options.permissionsPolicy;
  if (typeof permissionsPolicy === 'string') headers['permissions-policy'] = permissionsPolicy;

  return mergeHeaders(headers, options.extra ?? {});
}

/** Merge header maps using lowercase names and later values taking precedence. */
export function mergeHeaders(...sets: Array<HeaderMap | undefined>): HeaderMap {
  const out: HeaderMap = {};
  for (const set of sets) {
    if (!set) continue;
    for (const key of Object.keys(set)) out[key.toLowerCase()] = String(set[key]);
  }
  return out;
}
