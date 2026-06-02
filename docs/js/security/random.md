# random

## randomBytes

```ts
function randomBytes(length: number): Uint8Array
```

Return cryptographically secure random bytes.

## randomBase64Url

```ts
function randomBase64Url(length = 32): string
```

Return cryptographically secure random bytes encoded as unpadded base64url.

## randomToken

```ts
function randomToken(bytes = 32): string
```

Return an opaque random token with 32 bytes of entropy by default.

## randomInt

```ts
function randomInt(min: number, max: number): number
```

Return an unbiased random integer in [min, max).
