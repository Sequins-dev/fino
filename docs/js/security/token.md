# token

fino:security/token - HMAC-signed opaque JSON tokens.

This module issues compact `payload.signature` tokens for workflows that
need tamper-evident JSON payloads without the full JWT/JWK stack. Tokens may
include a purpose marker and expiration timestamp, and verification returns
`null` for malformed, expired, mismatched, or tampered input.

Tokens are authenticated but not encrypted. Anyone holding a token can decode
the JSON payload, so keep secrets out of it. Use separate purposes for
session, email verification, and password-reset flows to prevent accidental
token reuse across workflows.

```ts
import { issueToken, verifyToken } from 'fino:security/token';

const token = issueToken({ sub: 'user-123' }, tokenSecret, {
  purpose: 'email-verify',
  expiresIn: 900,
});
const payload = verifyToken(token, tokenSecret, { purpose: 'email-verify' });
```

## IssueTokenOptions

```ts
interface IssueTokenOptions {
```

Options for issuing an HMAC-signed opaque JSON token.

Tokens are authenticated but not encrypted: anyone holding the token can
base64url-decode and read the JSON payload. Use `purpose` to bind tokens to a
workflow, and `expiresIn` to add an expiration claim.

```ts
import type { IssueTokenOptions } from 'fino:security/token';

const options: IssueTokenOptions = { purpose: 'email-verify', expiresIn: 900 };
```

### expiresIn

```ts
expiresIn?: number
```

Lifetime in seconds from issuance time.

When omitted, no `exp` claim is added and verification will not expire the
token. Negative values create already-expired tokens.

```ts
import type { IssueTokenOptions } from 'fino:security/token';

const options: IssueTokenOptions = { expiresIn: 60 };
```

### purpose

```ts
purpose?: string
```

Optional purpose marker embedded in the payload.

Verification can require the same purpose to prevent a token issued for one
flow from being reused in another.

```ts
import type { IssueTokenOptions } from 'fino:security/token';

const options: IssueTokenOptions = { purpose: 'password-reset' };
```

## VerifyTokenOptions

```ts
interface VerifyTokenOptions {
```

Options for verifying an HMAC-signed opaque JSON token.

Verification checks the HMAC signature, optional expiration, and optional
purpose. Invalid, expired, or mismatched tokens return `null` rather than
throwing.

```ts
import type { VerifyTokenOptions } from 'fino:security/token';

const options: VerifyTokenOptions = { purpose: 'email-verify', clockTolerance: 30 };
```

### purpose

```ts
purpose?: string
```

Required purpose value.

When provided, the token payload must contain the same `purpose` string or
verification returns `null`.

```ts
import type { VerifyTokenOptions } from 'fino:security/token';

const options: VerifyTokenOptions = { purpose: 'password-reset' };
```

### now

```ts
now?: number
```

Current Unix time in seconds.

Defaults to `Date.now() / 1000`. Supplying it is useful for tests or
replaying verification at a known time.

```ts
import type { VerifyTokenOptions } from 'fino:security/token';

const options: VerifyTokenOptions = { now: 1_700_000_000 };
```

### clockTolerance

```ts
clockTolerance?: number
```

Expiration grace period in seconds.

Defaults to `0`. The value is added to `exp` during verification to allow
small clock skews.

```ts
import type { VerifyTokenOptions } from 'fino:security/token';

const options: VerifyTokenOptions = { clockTolerance: 30 };
```

## issueToken

```ts
function issueToken(payload: Record<string, unknown>, secret: BufferLike, options: IssueTokenOptions = {}): string
```

Issue a signed opaque JSON token as `payload.signature`.

The payload is JSON-serialized and base64url-encoded, then signed with
HMAC-SHA-256. The returned token is tamper-evident but not encrypted, so do
not include secrets in the payload.

```ts
import { issueToken } from 'fino:security/token';

const token = issueToken({ sub: 'user-123' }, 'secret', {
  purpose: 'session',
  expiresIn: 3600,
});
```

## verifyToken

```ts
function verifyToken(token: string, secret: BufferLike, options: VerifyTokenOptions = {}): Record<string, unknown> | null
```

Verify a signed opaque JSON token and return its JSON payload.

Returns `null` for malformed tokens, signature mismatches, expired tokens,
JSON decode failures, or purpose mismatches. Signature comparison is
timing-safe. The returned payload includes any `purpose` or `exp` fields that
were embedded during issuance.

```ts
import { issueToken, verifyToken } from 'fino:security/token';

const token = issueToken({ sub: 'user-123' }, 'secret', { purpose: 'session' });
const payload = verifyToken(token, 'secret', { purpose: 'session' });
```
