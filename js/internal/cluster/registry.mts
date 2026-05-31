/**
 * internal:cluster/registry — realm ownership tree.
 *
 * The seed maintains the authoritative ownership tree. Every realm records
 * its parent's port ID at spawn time. Death propagates top-down: when a realm
 * or its host node disappears, all descendants are terminated.
 *
 * Port IDs (not realmIds) are used as keys here because the parent communicates
 * with a child through a port, and a PORT_MSG routes by portId. The registry
 * answers: "which node hosts this port, and what ports does it own?"
 *
 * @internal
 */

interface PortEntry {
  portId: string;
  parentPortId: string | null;
  nodeId: string;
  children: Set<string>;
}

export class RealmRegistry {
  #ports = new Map<string, PortEntry>();
  // nodeId → set of portIds hosted on that node
  #byNode = new Map<string, Set<string>>();

  /**
   * Register a new port. `parentPortId` is null for root-realm ports.
   */
  register(portId: string, parentPortId: string | null, nodeId: string): void {
    const entry: PortEntry = { portId, parentPortId, nodeId, children: new Set() };
    this.#ports.set(portId, entry);
    if (parentPortId) {
      this.#ports.get(parentPortId)?.children.add(portId);
    }
    let set = this.#byNode.get(nodeId);
    if (!set) { set = new Set(); this.#byNode.set(nodeId, set); }
    set.add(portId);
  }

  /**
   * Remove a port and all its descendants.
   * Returns the flat list of portIds removed (including the root of the removal).
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
   */
  nodeDown(nodeId: string): { portId: string; parentPortId: string | null }[] {
    const hosted = this.#byNode.get(nodeId);
    if (!hosted) return [];
    const removed: { portId: string; parentPortId: string | null }[] = [];
    for (const portId of [...hosted]) {
      this.#removeRecursiveWithParent(portId, removed);
    }
    return removed;
  }

  getNodeId(portId: string): string | undefined {
    return this.#ports.get(portId)?.nodeId;
  }

  getChildren(portId: string): string[] {
    const entry = this.#ports.get(portId);
    return entry ? [...entry.children] : [];
  }

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

  #removeRecursiveWithParent(portId: string, acc: { portId: string; parentPortId: string | null }[]): void {
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
    acc.push({ portId, parentPortId: entry.parentPortId });
  }
}
