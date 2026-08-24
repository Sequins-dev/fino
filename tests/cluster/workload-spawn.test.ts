/**
 * A workload spawning its own realms (FIN-164).
 *
 * The capability is mediated by the hosting node rather than handed to the
 * workload, because a workload is untrusted code and three things must not be
 * its choice: which parent its child hangs from in the ownership tree, which
 * code the child runs, and how many children it may create.
 */
import { describe, it } from 'fino:test/test';
import { caskRelativeEntry } from 'internal:cluster/client';
import { RealmRegistry } from 'internal:cluster/registry';

describe('workload spawn — entry containment', () => {
  it('resolves an entry inside the cask', (t) => {
    t.equal(
      caskRelativeEntry('/cache/sha256-abc', 'workers/child.ts'),
      '/cache/sha256-abc/workers/child.ts',
      'a relative entry lands under the cask root',
    );
  });

  it('refuses an absolute path', (t) => {
    // The requester is untrusted code; an absolute path would let it name any
    // file the node can read.
    t.throws(
      () => caskRelativeEntry('/cache/sha256-abc', '/etc/passwd'),
      /must be relative to the cask/,
      'absolute entries are refused by shape, not normalised',
    );
  });

  it('refuses traversal out of the cask', (t) => {
    t.throws(
      () => caskRelativeEntry('/cache/sha256-abc', '../sha256-other/main.ts'),
      /must not escape the cask/,
      'a leading .. cannot reach a sibling cask',
    );
    t.throws(
      () => caskRelativeEntry('/cache/sha256-abc', 'workers/../../escape.ts'),
      /must not escape the cask/,
      'a buried .. is refused too',
    );
  });
});

describe('workload spawn — ownership', () => {
  it('a workload’s children hang from the workload, not the node', (t) => {
    // What the mediated spawn buys: the child is registered with the
    // workload's own port as its parent, so cancelling the workload reaches
    // it. Registering against the deployment root instead would leave the
    // child running after its parent died.
    const reg = new RealmRegistry();
    reg.register('deployer/p-root', null, 'deployer');
    reg.register('worker-a/w1', 'deployer/p-root', 'worker-a');
    // Two generations of self-spawned children.
    reg.register('worker-b/c1', 'worker-a/w1', 'worker-b');
    reg.register('worker-c/g1', 'worker-b/c1', 'worker-c');

    const removed = reg.exit('worker-a/w1').sort();
    t.deepEqual(
      removed,
      ['worker-a/w1', 'worker-b/c1', 'worker-c/g1'],
      'cancelling the workload cancels its whole subtree across nodes',
    );
    t.equal(reg.getNodeId('deployer/p-root'), 'deployer', 'the deployment root is untouched');
  });
});
