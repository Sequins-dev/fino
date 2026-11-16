/**
 * internal:scheduler/readiness — native reactor capacity for command concurrency.
 *
 * The native host owns pool sizing and lifecycle. Commands read its actual
 * capacity rather than recomputing a second potentially different pool size.
 * @internal
 */
import { reactorPoolStats } from 'internal:scheduler-native';

/** Return the number of reactors configured by the process host. @internal */
export function configuredReactorThreadCount(): number {
  return reactorPoolStats()?.workers ?? 1;
}
