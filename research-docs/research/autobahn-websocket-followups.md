# Autobahn WebSocket Follow-ups

This tracks Autobahn cases that were not kept in the first passing
`tests/integration/autobahn-websocket.test.ts` lane. These are not considered
resolved. Re-enable and address them one at a time, either by fixing Fino or by
recording a precise out-of-scope reason when the case exercises an intentionally
unsupported WebSocket feature.

## Harness Policy

- Harness setup failures are hard failures.
- Only intentionally unimplemented features may be excluded.
- Do not omit a case just because it currently fails or is not emitted by the
  current Autobahn config.

## Cases To Revisit

No open cases are currently tracked.

## Already Addressed From The Same Harness Pass

| Case | Resolution |
| --- | --- |
| `7.5.1` | Fixed CLOSE handling to reject invalid UTF-8 close reasons with close code `1007`. |
| `7.9.1` | Fixed CLOSE handling to reject invalid received close codes with close code `1002`. |
