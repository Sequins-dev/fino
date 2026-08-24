/**
 * Tests for internal:cluster/registry — realm ownership tree.
 */
import { describe, it } from 'fino:test/test';
import { RealmRegistry } from 'internal:cluster/registry';
describe('RealmRegistry', () => {
  it('register and getNodeId', (t) => {
    const reg = new RealmRegistry();
    reg.register('portA', null, 'node1');
    t.equal(reg.getNodeId('portA'), 'node1', 'returns registered nodeId');
    t.equal(reg.getNodeId('missing'), undefined, 'returns undefined for unknown portId');
  });
  it('exit removes the port and returns it in the list', (t) => {
    const reg = new RealmRegistry();
    reg.register('portA', null, 'node1');
    const removed = reg.exit('portA');
    t.ok(removed.includes('portA'), 'removed list includes portA');
    t.equal(reg.getNodeId('portA'), undefined, 'portA gone after exit');
  });
  it('exit recursively removes descendants', (t) => {
    const reg = new RealmRegistry();
    reg.register('root', null, 'node1');
    reg.register('child', 'root', 'node2');
    reg.register('grandchild', 'child', 'node3');
    const removed = reg.exit('root');
    t.ok(removed.includes('root'), 'root removed');
    t.ok(removed.includes('child'), 'child removed');
    t.ok(removed.includes('grandchild'), 'grandchild removed');
    t.equal(reg.getNodeId('grandchild'), undefined, 'grandchild gone');
  });
  it('exit only removes the subtree, not unrelated ports', (t) => {
    const reg = new RealmRegistry();
    reg.register('portA', null, 'node1');
    reg.register('portB', null, 'node1');
    reg.register('childA', 'portA', 'node2');
    const removed = reg.exit('portA');
    t.ok(removed.includes('portA'), 'portA removed');
    t.ok(removed.includes('childA'), 'childA removed');
    t.ok(!removed.includes('portB'), 'portB untouched');
    t.equal(reg.getNodeId('portB'), 'node1', 'portB still registered');
  });
  it('nodeDown removes all ports on that node and their descendants', (t) => {
    const reg = new RealmRegistry();
    reg.register('parentPort', null, 'nodeA');
    reg.register('childPort', 'parentPort', 'nodeB');
    reg.register('grandchildPort', 'childPort', 'nodeC');
    // nodeB goes down
    const removed = reg.nodeDown('nodeB');
    const removedIds = removed.map((r) => r.portId);
    t.ok(removedIds.includes('childPort'), 'childPort on dead node removed');
    t.ok(removedIds.includes('grandchildPort'), 'grandchild removed too');
    t.ok(!removedIds.includes('parentPort'), 'parentPort on nodeA is unaffected');
    t.equal(reg.getNodeId('parentPort'), 'nodeA', 'parentPort still registered');
  });
  it('getChildren returns child portIds', (t) => {
    const reg = new RealmRegistry();
    reg.register('parent', null, 'node1');
    reg.register('childA', 'parent', 'node2');
    reg.register('childB', 'parent', 'node3');
    const children = reg.getChildren('parent');
    t.ok(children.includes('childA'), 'childA listed');
    t.ok(children.includes('childB'), 'childB listed');
    t.equal(children.length, 2, 'exactly 2 children');
  });
  it('getParentPortId returns the parent edge', (t) => {
    const reg = new RealmRegistry();
    reg.register('parent', null, 'node1');
    reg.register('child', 'parent', 'node2');
    t.equal(reg.getParentPortId('parent'), null, 'root port has null parent');
    t.equal(reg.getParentPortId('child'), 'parent', 'child returns parent port');
    t.equal(reg.getParentPortId('missing'), undefined, 'unknown port returns undefined');
  });
  it('exit of parent removes portId from parent-of-parent children set', (t) => {
    const reg = new RealmRegistry();
    reg.register('root', null, 'n1');
    reg.register('child', 'root', 'n2');
    reg.exit('child');
    const children = reg.getChildren('root');
    t.equal(children.length, 0, 'child removed from root children');
  });

  it('re-registering a known port keeps its edges', (t) => {
    // The seed registers a spawn's parent port on every SPAWN, so a port that
    // spawns twice is registered twice. Rebuilding the entry each time reset
    // its children and detached its own parent edge, so the first child fell
    // out of the tree and survived a cancellation that should have reached it.
    const reg = new RealmRegistry();
    reg.register('root', null, 'n1');
    reg.register('mid', 'root', 'n1');
    reg.register('first', 'mid', 'n2');
    // Second spawn from the same parent, exactly as the seed does it.
    reg.register('mid', null, 'n1');
    reg.register('second', 'mid', 'n2');

    t.deepEqual(reg.getChildren('mid').sort(), ['first', 'second'], 'both children retained');
    t.equal(reg.getParentPortId('mid'), 'root', 'the parent edge is not erased');
    const removed = reg.exit('mid').sort();
    t.deepEqual(removed, ['first', 'mid', 'second'], 'cancelling the parent reaches both children');
  });

  it('a port that changes host leaves the old node index', (t) => {
    // Shedding moves a workload between nodes. If the old node keeps the port
    // in its index, that node going down cancels a port it no longer hosts.
    const reg = new RealmRegistry();
    reg.register('moved', null, 'node-a');
    reg.register('moved', null, 'node-b');
    t.equal(reg.getNodeId('moved'), 'node-b', 'host updated');
    t.deepEqual(reg.nodeDown('node-a'), [], 'the old host no longer claims it');
    t.equal(reg.getNodeId('moved'), 'node-b', 'and it survives the old host going down');
    t.equal(reg.nodeDown('node-b').length, 1, 'the new host does claim it');
  });

  it('cancels a whole subtree to arbitrary depth', (t) => {
    // Structured concurrency: a workload spawning a workload spawning a
    // workload must all die together.
    const reg = new RealmRegistry();
    reg.register('root', null, 'n1');
    reg.register('child', 'root', 'n2');
    reg.register('grandchild', 'child', 'n3');
    reg.register('greatgrandchild', 'grandchild', 'n1');
    const removed = reg.exit('root');
    t.equal(removed.length, 4, 'every descendant removed');
    t.ok(removed.indexOf('greatgrandchild') < removed.indexOf('root'), 'depth-first: leaves first');
    t.equal(reg.getNodeId('grandchild'), undefined, 'descendants are forgotten');
  });
});
