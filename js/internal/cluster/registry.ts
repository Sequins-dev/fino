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
   * The authoritative record of every registered port, keyed by port ID.
   *
   * Each entry carries the hosting node, the parent edge, and the set of direct
   * child ports, so a single lookup answers ownership, parentage, and children
   * for a port. Mutating this map is the source of truth; the by-node index is
   * kept in sync alongside it.
   *
   * @internal
   */
  #ports = new Map<string, PortEntry>();
  // nodeId -> set of portIds hosted on that node
  /**
   * Reverse index mapping each node ID to the set of port IDs it hosts.
   *
   * This is what makes `nodeDown` cheap: when a node disappears the registry
   * reads its hosted-port set directly instead of scanning every entry. It is
   * maintained in lockstep with `#ports` on every register and removal.
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
    // Registering a port that already exists must not rebuild it. The seed
    // registers a spawn's parent on every SPAWN, so a port that spawns twice
    // arrives here twice — and rebuilding reset its children and erased its
    // own parent edge, dropping earlier children out of the tree entirely.
    // They then survived a cancellation that should have reached them, which
    // is the opposite of what an ownership tree is for.
    //
    // An existing entry keeps its children. It also keeps its parent edge
    // unless this call supplies one, so the `register(port, null, node)` the
    // seed makes before a spawn cannot orphan a port that already has a
    // parent, while a genuine re-parent is still expressible.
    const existing = this.#ports.get(portId);
    const entry: PortEntry = existing ?? {
      portId,
      parentPortId,
      nodeId,
      children: new Set(),
    };
    if (existing !== undefined) {
      if (existing.nodeId !== nodeId) {
        // A port that moved hosts — a shed — must leave the old node's index,
        // or that node going down would take down a port it no longer hosts.
        this.#byNode.get(existing.nodeId)?.delete(portId);
        existing.nodeId = nodeId;
      }
      if (parentPortId !== null && parentPortId !== existing.parentPortId) {
        this.#ports.get(existing.parentPortId ?? '')?.children.delete(portId);
        existing.parentPortId = parentPortId;
      }
    }
    this.#ports.set(portId, entry);
    if (entry.parentPortId !== null) {
      this.#ports.get(entry.parentPortId)?.children.add(portId);
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
   * Depth-first removal of a port and its subtree, backing `exit`.
   *
   * Descendants are visited and appended to `acc` before the port itself, so the
   * accumulated list is ordered children-first. Each visit detaches the port
   * from its parent's child set and from the by-node index before deleting the
   * entry. Unknown ports are a no-op.
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
   * Depth-first removal variant used by `nodeDown` that records parent edges.
   *
   * Behaves like `#removeRecursive` — children-first ordering, parent and
   * by-node detachment, no-op on unknown ports — but accumulates
   * `{ portId, parentPortId }` pairs instead of bare IDs. The parent edge is
   * captured before deletion so callers can still notify a removed child's
   * parent host once the entry is gone.
   *
   * @internal
   */
  #removeRecursiveWithParent(
    portId: string,
    acc: {
      portId: string;
      parentPortId: string | null;
    }[],
  ): void {
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
      parentPortId: entry.parentPortId,
    });
  }
}
