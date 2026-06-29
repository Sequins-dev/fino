/**
* Fixture: child realm that stays alive until externally terminated.
*
* Top-level await on a never-resolving Promise keeps the entry module pending,
* which prevents isDone() from becoming true until the parent calls terminate().
* The child's nonBlocking driveLoop polls with tick(0), so it never blocks the
* parent thread.
*/
await new Promise<never>(() => {});
