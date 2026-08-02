/**
 * Never yields for ten seconds: the workload the watchdog exists for. Finite
 * so the reactor it wedges can eventually be joined — a genuinely infinite
 * one could not be torn down, which is itself the point of the watchdog.
 */
const end = Date.now() + 10_000;
while (Date.now() < end) {
  /* deliberately blocking */
}
