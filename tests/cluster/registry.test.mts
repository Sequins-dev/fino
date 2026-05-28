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
    const removedIds = removed.map(r => r.portId);
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

  it('exit of parent removes portId from parent-of-parent children set', (t) => {
    const reg = new RealmRegistry();
    reg.register('root', null, 'n1');
    reg.register('child', 'root', 'n2');
    reg.exit('child');
    const children = reg.getChildren('root');
    t.equal(children.length, 0, 'child removed from root children');
  });
});
