/**
* A trivial single-tenant app entry. `runApp` evaluates this module as an
* embedded child realm and its `run()` resolves when the module finishes — used
* to prove the single-tenant fast path still executes an entry to completion.
*/
export const ran = true;
