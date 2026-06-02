# password

## HashPasswordOptions

```ts
interface HashPasswordOptions {
```

PBKDF2 password hashing options.

### iterations

```ts
iterations?: number
```

### saltLength

```ts
saltLength?: number
```

### keyLength

```ts
keyLength?: number
```

### hash

```ts
hash?: 'sha-256' | 'sha-384' | 'sha-512'
```

## hashPassword

```ts
function hashPassword(password: string, options: HashPasswordOptions = {}): string
```

Hash a password as `pbkdf2$hash$iterations$salt$hash`.

## verifyPassword

```ts
function verifyPassword(password: string, record: string): boolean
```

Verify a PBKDF2 password record, returning `false` for malformed records.
