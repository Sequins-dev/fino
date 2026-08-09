/**
 * Realm fixture — never returns to its event loop.
 *
 * Cooperative termination is delivered as a message, so a realm spinning in
 * synchronous JavaScript never observes it. Only a forced interrupt can stop
 * this one.
 */
export default function runaway(): number {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    /* spin */
  }
}
