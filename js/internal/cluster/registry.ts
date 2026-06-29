/**
* internal:cluster/registry - realm ownership tree.
*
* The seed maintains the authoritative ownership tree. Every realm records
* its parent's port ID at spawn time. Death propagates top-down: when a realm
* or its host node disappears, all descendants are terminated.
*
* Port IDs (not realmIds) are used as keys here because the parent communicates
* with a child through a port, and a PORT_MSG routes by portId. The registry
* answers: "which node hosts this port, and what ports does it own?"
*
* ## Example
*
* ```ts no_run
* import { RealmRegistry } from 'internal:cluster/registry';
*
* const registry = new RealmRegistry();
* registry.register('worker-a/p-parent', null, 'worker-a');
* registry.register('worker-b/p-child', 'worker-a/p-parent', 'worker-b');
*
* const host = registry.getNodeId('worker-b/p-child');
* const removed = registry.nodeDown('worker-b');
* ```
*
* @internal
*/
interface PortEntry {
  portId: string;
  parentPortId: string | null;
  nodeId: string;
  children: Set<string>;
}
/**
* In-memory ownership tree for clustered realm ports.
*
* The registry maps port IDs to hosting node IDs and parent/child edges. It is
* deliberately synchronous and has no transport side effects; callers perform
* notification and termination routing from the returned snapshots.
*
* ```ts
* import { RealmRegistry } from 'internal:cluster/registry';
* const registry = new RealmRegistry();
* registry.register('node-a/p-1', null, 'node-a');
* ```
*
* @internal
*/
export class RealmRegistry {
  /**
  * Private property `#ports` used by `RealmRegistry`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #ports = undefined;
  *
  *   readInternalState() {
  *     return this.#ports;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #ports = new Map<string, PortEntry>();
  // nodeId -> set of portIds hosted on that node
  /**
  * Private property `#byNode` used by `RealmRegistry`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #byNode = undefined;
  *
  *   readInternalState() {
  *     return this.#byNode;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #byNode = new Map<string, Set<string>>();
  /**
  * Register a new port. `parentPortId` is null for root-realm ports.
  *
  * The method overwrites an existing port entry with the same ID. It records
  * the child edge only when the parent is already present, so callers should
  * register parents before children.
  *
  * ```ts
  * import { RealmRegistry } from 'internal:cluster/registry';
  * const registry = new RealmRegistry();
  * registry.register('node-a/p-parent', null, 'node-a');
  * registry.register('node-b/p-child', 'node-a/p-parent', 'node-b');
  * ```
  */
  register(portId: string, parentPortId: string | null, nodeId: string): void {
    const entry: PortEntry = {
      portId,
      parentPortId,
      nodeId,
      children: new Set()
    };
    this.#ports.set(portId, entry);
    if (parentPortId) {
      this.#ports.get(parentPortId)?.children.add(portId);
    }
    let set = this.#byNode.get(nodeId);
    if (!set) {
      set = new Set();
      this.#byNode.set(nodeId, set);
    }
    set.add(portId);
  }
  /**
  * Remove a port and all its descendants.
  * Returns the flat list of portIds removed (including the root of the removal).
  *
  * Unknown ports are ignored and return an empty array. Children are removed
  * before the root, which lets callers terminate descendants before forgetting
  * the parent.
  *
  * ```ts
  * import { RealmRegistry } from 'internal:cluster/registry';
  * const registry = new RealmRegistry();
  * registry.register('node-a/p-1', null, 'node-a');
  * registry.exit('node-a/p-1');
  * ```
  */
  exit(portId: string): string[] {
    const removed: string[] = [];
    this.#removeRecursive(portId, removed);
    return removed;
  }
  /**
  * Remove all ports hosted on a node and all their descendants.
  * Returns the flat list of { portId, parentPortId } pairs removed,
  * so callers can notify the parent's host of orphaned children.
  *
  * If the node has no registered ports, this returns an empty array. The
  * returned `parentPortId` may be `null` for root ports, so callers must check
  * before routing parent notifications.
  *
  * ```ts
  * import { RealmRegistry } from 'internal:cluster/registry';
  * const registry = new RealmRegistry();
  * registry.register('node-b/p-2', null, 'node-b');
  * registry.nodeDown('node-b');
  * ```
  */
  nodeDown(nodeId: string): {
    portId: string;
    parentPortId: string | null;
  }[] {
    const hosted = this.#byNode.get(nodeId);
    if (!hosted) return [];
    const removed: {
      portId: string;
      parentPortId: string | null;
    }[] = [];
    for (const portId of [...hosted]) {
      this.#removeRecursiveWithParent(portId, removed);
    }
    return removed;
  }
  /**
  * Return the node currently registered as host for a port.
  *
  * The method returns `undefined` when the port is unknown or has already been
  * removed. It performs no ID parsing and assumes callers already use cluster
  * port IDs.
  *
  * ```ts
  * import { RealmRegistry } from 'internal:cluster/registry';
  * const registry = new RealmRegistry();
  * registry.register('node-a/p-1', null, 'node-a');
  * registry.getNodeId('node-a/p-1');
  * ```
  */
  getNodeId(portId: string): string | undefined {
    return this.#ports.get(portId)?.nodeId;
  }
  /**
  * Return the parent port ID for a registered port.
  *
  * Root ports return `null`, and unknown ports return `undefined`. Seed
  * routing uses this before removing an exited child so the parent host can be
  * notified after the registry entry is gone.
  *
  * ```ts
  * import { RealmRegistry } from 'internal:cluster/registry';
  * const registry = new RealmRegistry();
  * registry.register('node-a/p-parent', null, 'node-a');
  * registry.register('node-b/p-child', 'node-a/p-parent', 'node-b');
  * registry.getParentPortId('node-b/p-child');
  * ```
  */
  getParentPortId(portId: string): string | null | undefined {
    return this.#ports.get(portId)?.parentPortId;
  }
  /**
  * Return direct child port IDs for a parent port.
  *
  * The returned array is a snapshot and can be mutated by the caller without
  * changing registry state. Unknown parents return an empty array.
  *
  * ```ts
  * import { RealmRegistry } from 'internal:cluster/registry';
  * const registry = new RealmRegistry();
  * registry.register('node-a/p-1', null, 'node-a');
  * registry.getChildren('node-a/p-1');
  * ```
  */
  getChildren(portId: string): string[] {
    const entry = this.#ports.get(portId);
    return entry ? [...entry.children] : [];
  }
  /**
  * Private method `#removeRecursive` used by `RealmRegistry`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #removeRecursive() {
  *     return 'removeRecursive';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#removeRecursive();
  *   }
  * }
  * ```
  *
  * @internal
  */
  #removeRecursive(portId: string, acc: string[]): void {
    const entry = this.#ports.get(portId);
    if (!entry) return;
    for (const childId of [...entry.children]) {
      this.#removeRecursive(childId, acc);
    }
    if (entry.parentPortId) {
      this.#ports.get(entry.parentPortId)?.children.delete(portId);
    }
    this.#byNode.get(entry.nodeId)?.delete(portId);
    this.#ports.delete(portId);
    acc.push(portId);
  }
  /**
  * Private method `#removeRecursiveWithParent` used by `RealmRegistry`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #removeRecursiveWithParent() {
  *     return 'removeRecursiveWithParent';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#removeRecursiveWithParent();
  *   }
  * }
  * ```
  *
  * @internal
  */
  #removeRecursiveWithParent(portId: string, acc: {
    portId: string;
    parentPortId: string | null;
  }[]): void {
    const entry = this.#ports.get(portId);
    if (!entry) return;
    for (const childId of [...entry.children]) {
      this.#removeRecursiveWithParent(childId, acc);
    }
    if (entry.parentPortId) {
      this.#ports.get(entry.parentPortId)?.children.delete(portId);
    }
    this.#byNode.get(entry.nodeId)?.delete(portId);
    this.#ports.delete(portId);
    acc.push({
      portId,
      parentPortId: entry.parentPortId
    });
  }
}
