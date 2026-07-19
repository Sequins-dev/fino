/**
* internal:orchestrator — cluster and node-level realm ownership.
*
* Reactors schedule assigned realms. Cluster orchestration owns deployment
* admission and node choice; each node orchestrator owns reactor lifecycle and
* local placement. This module also provides the root application entry helper
* used by `fino run`.
*
* @internal
*/
import { Realm, type ImportRule, type RealmOptions } from '../../realm/index.ts';
import { createJobsControlFacade } from '../jobs/control.ts';

/** Options for running a user entry script as the root application realm. */
export interface AppOptions {
  /** Module specifier loaded as the application entry. */
  entry: string;
  /** Optional JSON-serializable bootstrap value. */
  data?: unknown;
  /** Optional inherited or overridden OTLP endpoint. */
  otlpEndpoint?: RealmOptions['otlpEndpoint'];
  /** Import rules applied after the root defaults. */
  overrides?: RealmOptions['overrides'];
}

/**
* Run an application in one reactor-hosted realm.
*
* The application receives the jobs control facade and is terminated when the
* root process begins unloading. The temporary unload listener is always
* removed when the application settles.
*/
export async function runApp(options: AppOptions): Promise<unknown> {
  const rules: ImportRule[] = [
    ...options.overrides === undefined
      ? []
      : Array.isArray(options.overrides)
        ? options.overrides
        : options.overrides.toRules(),
    {
      pattern: 'fino:jobs/control',
      directive: createJobsControlFacade()
    }
  ];
  const realm = new Realm({
    entry: options.entry,
    ...options.data !== undefined ? { data: options.data } : {},
    ...options.otlpEndpoint !== undefined ? { otlpEndpoint: options.otlpEndpoint } : {},
    overrides: rules
  });
  const root = globalThis as Record<string, unknown>;
  const terminate = () => realm.terminate();
  const add = root.addEventListener as ((type: string, listener: () => void) => void) | undefined;
  const remove = root.removeEventListener as ((type: string, listener: () => void) => void) | undefined;
  add?.('beforeunload', terminate);
  try {
    return await realm.run();
  } finally {
    remove?.('beforeunload', terminate);
  }
}
