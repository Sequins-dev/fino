---
weight: 26
---
# Security Guide

`fino:security` collects compact helpers for backend security tasks: random
bytes and tokens, CORS and security headers, cookies, passwords, JWK/JWKS,
JWT/JWE, OAuth helpers, and signed opaque JSON tokens.

## Choose The Narrow Module

Import the specific module when possible:

```ts no_run
import { randomToken } from 'fino:security/random';
import { signJwt } from 'fino:security/jwt';
import { sealCookie } from 'fino:security/cookie';
```

The root `fino:security` module is a convenience facade. Narrow imports make it
clear which security primitive an application depends on.

## Boundaries

Security helpers reduce repetitive protocol work, but they do not make policy
decisions for the application. Callers still own key storage, token lifetimes,
cookie scope, password reset flows, OAuth redirect allowlists, CSRF posture,
rate limits, and audit logging.

Prefer generated random bytes or tokens from `fino:security/random` over ad hoc
IDs. Keep signing and encryption keys out of source code, rotate them
deliberately, and test failure paths such as expired tokens, wrong audiences,
missing headers, and invalid cookies.
