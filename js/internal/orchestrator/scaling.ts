/**
* internal:orchestrator/scaling — deployment scaling-policy validation.
*
* This module contains only policy normalization. Replica ownership and timers
* live in the deployment controller; cluster placement is intentionally not
* modeled until the cluster orchestrator consumes it.
*
* @internal
*/

export interface DeploymentScalingPolicy {
  min?: number;
  max?: number;
  scaleUpWindowMs?: number;
  scaleDownWindowMs?: number;
}

export interface NormalizedDeploymentScalingPolicy {
  min: number;
  max: number;
  scaleUpWindowMs: number;
  scaleDownWindowMs: number;
}

/** Apply deployment defaults and validate replica bounds. */
export function normalizeDeploymentScalingPolicy(
  policy: DeploymentScalingPolicy | undefined,
  reactorCapacity: number
): NormalizedDeploymentScalingPolicy {
  if (!Number.isInteger(reactorCapacity) || reactorCapacity < 1) {
    throw new TypeError('reactor capacity must be a positive integer');
  }
  const min = policy?.min ?? 1;
  const max = policy?.max ?? reactorCapacity;
  if (!Number.isInteger(min) || min < 1) throw new TypeError('scaling minimum must be a positive integer');
  if (!Number.isInteger(max) || max < 1) throw new TypeError('scaling maximum must be a positive integer');
  if (min > max) throw new RangeError('scaling minimum cannot exceed maximum');
  if (max > reactorCapacity) throw new RangeError('scaling maximum exceeds reactor capacity');
  const scaleUpWindowMs = nonNegative(policy?.scaleUpWindowMs ?? 1_000, 'scale-up window');
  const scaleDownWindowMs = nonNegative(policy?.scaleDownWindowMs ?? 30_000, 'scale-down window');
  return { min, max, scaleUpWindowMs, scaleDownWindowMs };
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative finite number`);
  return value;
}
