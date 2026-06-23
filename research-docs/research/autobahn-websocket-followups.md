# Autobahn WebSocket Follow-ups

This tracks Autobahn cases that were not kept in the first passing
`tests/integration/autobahn-websocket.test.mts` lane. These are not considered
resolved. Re-enable and address them one at a time, either by fixing Fino or by
recording a precise out-of-scope reason when the case exercises an intentionally
unsupported WebSocket feature.

## Harness Policy

- Harness setup failures are hard failures.
- Only intentionally unimplemented features may be excluded.
- Do not omit a case just because it currently fails or is not emitted by the
  current Autobahn config.

## Cases To Revisit

| Case | Current state | Next step |
| --- | --- | --- |
| `1.3.1` | Removed from nested assertions after Autobahn did not emit it for the initial lane. | Determine why Autobahn omits this case, re-enable if applicable, and fix any Fino behavior it exposes. |
| `1.3.2` | Removed from nested assertions after Autobahn did not emit it for the initial lane. | Determine why Autobahn omits this case, re-enable if applicable, and fix any Fino behavior it exposes. |
| `10.2.1` | Removed with Autobahn group `10.*` from the initial lane. | Identify the group 10 requirement and either implement/fix support or document a precise unsupported-feature reason. |

## Already Addressed From The Same Harness Pass

| Case | Resolution |
| --- | --- |
| `7.5.1` | Fixed CLOSE handling to reject invalid UTF-8 close reasons with close code `1007`. |
| `7.9.1` | Fixed CLOSE handling to reject invalid received close codes with close code `1002`. |
