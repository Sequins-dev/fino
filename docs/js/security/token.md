# token

## IssueTokenOptions

```ts
interface IssueTokenOptions {
```

Options for issuing an HMAC-signed opaque JSON token.

### expiresIn

```ts
expiresIn?: number
```

### purpose

```ts
purpose?: string
```

## VerifyTokenOptions

```ts
interface VerifyTokenOptions {
```

Options for verifying an HMAC-signed opaque JSON token.

### purpose

```ts
purpose?: string
```

### now

```ts
now?: number
```

### clockTolerance

```ts
clockTolerance?: number
```

## issueToken

```ts
function issueToken(payload: Record<string, unknown>, secret: BufferLike, options: IssueTokenOptions = {}): string
```

Issue a signed opaque JSON token as `payload.signature`.

## verifyToken

```ts
function verifyToken(token: string, secret: BufferLike, options: VerifyTokenOptions = {}): Record<string, unknown> | null
```

Verify a signed opaque JSON token, returning `null` when invalid, expired, or mismatched.
