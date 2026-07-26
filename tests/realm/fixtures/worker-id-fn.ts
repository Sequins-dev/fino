/**
 * Fixture: returns an ID that is unique per worker isolate (stable across calls
 * to the same worker, different between workers). Used to verify RealmPool
 * dispatches calls across multiple workers.
 */
const _id = Math.random().toString(36).slice(2, 9);
export default function (): string {
  return _id;
}
