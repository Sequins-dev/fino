import { describe, it } from 'fino:test/test';
import { PortRpc } from 'internal:realm/port-rpc';

describe('PortRpc', () => {
  it('consumes a matched response even when its request is no longer pending', (t) => {
    const rpc = new PortRpc({ send() {} });
    t.equal(rpc.dispatch({ __rpc_res: true, reqId: 42 }), true);
  });
});
