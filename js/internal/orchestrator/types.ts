/**
* Shared node-orchestration records.
*
* @internal
*/

export type RealmId = string;
export type ReactorId = string;
export type PriorityClass = 'interactive' | 'service' | 'background';

/** Coarse load reported by one reactor for placement decisions. */
export interface ReactorLoadSummary {
  reactorId: ReactorId;
  heldRealms: number;
  runnableRealms: number;
  debtMicros: number;
}
