/**
 * internal:cluster/join-string — mint and parse cluster join strings.
 *
 * A join string is the single secret an operator moves between machines to
 * enroll a node, kubeadm-style:
 *
 * ```text
 * fino://10.0.0.5:4433/__fino_cluster#cid:c-x7f2,tok:9hj3k2m4n5p6,sha256:ab12…
 * ```
 *
 * The authority and path locate the seed's WebTransport endpoint. The
 * fragment carries comma-separated `key:value` pairs: `cid` is the cluster
 * identity a joiner verifies against WELCOME, `tok` is the join token the
 * seed enforces, and each `sha256` is a hex-encoded certificate hash the
 * joiner pins instead of trusting a CA. Everything in the fragment is
 * bootstrap material — the token is a secret and join strings must never be
 * published through discovery records.
 *
 * @internal
 */

/** Parsed contents of a join string. */
export interface JoinInfo {
  /** `https://host:port/path` seed endpoint for the WebTransport dial. */
  seed: string;
  /** Cluster identity the joiner should verify against WELCOME. */
  clusterId: string;
  /** Join token presented in HELLO; absent when the seed does not enforce one. */
  token?: string;
  /** Hex-encoded sha-256 certificate hashes to pin. */
  certHashes: string[];
}

const HEX_RE = /^[0-9a-f]+$/;

/** Render a join string from its parts. */
export function mintJoinString(info: JoinInfo): string {
  const url = new URL(info.seed);
  if (url.protocol !== 'https:') {
    throw new TypeError('join string seed must use https:');
  }
  const parts = [`cid:${info.clusterId}`];
  if (info.token !== undefined) parts.push(`tok:${info.token}`);
  for (const hash of info.certHashes) {
    if (!HEX_RE.test(hash)) throw new TypeError('certificate hashes must be lowercase hex');
    parts.push(`sha256:${hash}`);
  }
  return `fino://${url.host}${url.pathname}#${parts.join(',')}`;
}

/** Parse a join string; throws a `TypeError` on any malformed part. */
export function parseJoinString(value: string): JoinInfo {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('invalid join string: not a URL');
  }
  if (url.protocol !== 'fino:') {
    throw new TypeError('invalid join string: expected fino:// scheme');
  }
  if (url.host === '') {
    throw new TypeError('invalid join string: missing seed host');
  }
  const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  let clusterId = '';
  let token = '';
  const certHashes: string[] = [];
  for (const part of fragment.split(',')) {
    if (part === '') continue;
    const split = part.indexOf(':');
    if (split === -1) throw new TypeError(`invalid join string: malformed fragment "${part}"`);
    const key = part.slice(0, split);
    const val = part.slice(split + 1);
    if (val === '') throw new TypeError(`invalid join string: empty ${key}`);
    switch (key) {
      case 'cid':
        clusterId = val;
        break;
      case 'tok':
        token = val;
        break;
      case 'sha256': {
        const hash = val.toLowerCase();
        if (!HEX_RE.test(hash) || hash.length !== 64) {
          throw new TypeError('invalid join string: sha256 must be 64 hex characters');
        }
        certHashes.push(hash);
        break;
      }
      default:
        // Unknown keys are ignored so older nodes can parse newer strings.
        break;
    }
  }
  if (clusterId === '') throw new TypeError('invalid join string: missing cid');
  return {
    seed: `https://${url.host}${url.pathname === '' ? '/' : url.pathname}`,
    clusterId,
    ...(token !== '' ? { token } : {}),
    certHashes,
  };
}
