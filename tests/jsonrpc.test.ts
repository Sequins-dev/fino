import { describe, it } from 'fino:test/test';
import { JsonRpcPeer, JsonRpcService, JsonRpcServer, JsonRpcError, METHOD_NOT_FOUND, INTERNAL_ERROR, PARSE_ERROR, INVALID_PARAMS } from 'fino:jsonrpc';
import type { Transport } from 'fino:jsonrpc';
// ---------------------------------------------------------------------------
// In-memory loopback pair
// ---------------------------------------------------------------------------
class MessageQueue {
  #buf: string[] = [];
  #waiters: Array<(s: string) => void> = [];
  #closed = false;
  push(msg: string): void {
    const w = this.#waiters.shift();
    if (w) {
      w(msg);
    } else {
      this.#buf.push(msg);
    }
  }
  close(): void {
    this.#closed = true;
    for (const w of this.#waiters) w('');
    this.#waiters = [];
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      if (this.#buf.length > 0) {
        yield this.#buf.shift()!;
      } else if (this.#closed) {
        return;
      } else {
        const msg = await new Promise<string>((resolve) => {
          this.#waiters.push(resolve);
        });
        if (msg === '' && this.#closed) return;
        if (msg) yield msg;
      }
    }
  }
}
function loopbackPair(): [Transport, Transport] {
  const aToB = new MessageQueue();
  const bToA = new MessageQueue();
  const a: Transport = {
    send: (msg) => {
      aToB.push(msg);
    },
    receive: () => bToA,
    close: () => {
      aToB.close();
      bToA.close();
    }
  };
  const b: Transport = {
    send: (msg) => {
      bToA.push(msg);
    },
    receive: () => aToB,
    close: () => {
      aToB.close();
      bToA.close();
    }
  };
  return [a, b];
}
describe('fino:jsonrpc — JsonRpcService', () => {
  it('handle() dispatches a request and returns the JSON response', async (t) => {
    const svc = new JsonRpcService();
    svc.method('multiply').description('Multiply two numbers').handle((params) => {
      const p = params as {
        a: number;
        b: number;
      };
      return p.a * p.b;
    });
    const response = await svc.handle(JSON.stringify({
      jsonrpc: '2.0',
      method: 'multiply',
      params: {
        a: 6,
        b: 7
      },
      id: 1
    }));
    t.ok(response, 'response is not null');
    const parsed = JSON.parse(response!);
    t.equal(parsed.result, 42, 'result is 42');
    t.equal(parsed.id, 1, 'id echoed back');
  });
  it('handle() returns null for notifications (no id)', async (t) => {
    const svc = new JsonRpcService();
    let called = false;
    svc.method('ping').handle(() => {
      called = true;
    });
    const response = await svc.handle(JSON.stringify({
      jsonrpc: '2.0',
      method: 'ping',
      params: {}
    }));
    await new Promise<void>((r) => setTimeout(r, 10));
    t.equal(response, null, 'notification returns null');
    t.ok(called, 'notification handler was called');
  });
  it('handle() returns METHOD_NOT_FOUND for unknown methods', async (t) => {
    const svc = new JsonRpcService();
    const response = await svc.handle(JSON.stringify({
      jsonrpc: '2.0',
      method: 'unknown',
      id: 5
    }));
    t.ok(response, 'response is not null');
    const parsed = JSON.parse(response!);
    t.ok(parsed.error, 'response has error field');
    t.equal(parsed.error.code, METHOD_NOT_FOUND, 'code is METHOD_NOT_FOUND');
    t.equal(parsed.id, 5, 'id echoed back');
  });
  it('handle() returns PARSE_ERROR for invalid JSON', async (t) => {
    const svc = new JsonRpcService();
    const response = await svc.handle('{not valid json');
    t.ok(response, 'response is not null');
    const parsed = JSON.parse(response!);
    t.equal(parsed.error.code, PARSE_ERROR, 'code is PARSE_ERROR');
  });
  it('handle() propagates JsonRpcError code from handler', async (t) => {
    const svc = new JsonRpcService();
    svc.method('strict').handle(() => {
      throw new JsonRpcError('bad param', INVALID_PARAMS);
    });
    const response = await svc.handle(JSON.stringify({
      jsonrpc: '2.0',
      method: 'strict',
      id: 9
    }));
    const parsed = JSON.parse(response!);
    t.equal(parsed.error.code, INVALID_PARAMS, 'custom error code preserved');
  });
  it('list() returns registered method descriptors', (t) => {
    const svc = new JsonRpcService();
    svc.method('add').description('Add two numbers').params({
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' }
      }
    }).handle(() => null);
    svc.method('ping').handle(() => 'pong');
    const methods = svc.list();
    t.equal(methods.length, 2, 'two methods listed');
    t.equal(methods[0]?.name, 'add', 'first method is add');
    t.equal(methods[0]?.description, 'Add two numbers', 'description preserved');
    t.ok(methods[0]?.params, 'params schema preserved');
    t.equal(methods[1]?.name, 'ping', 'second method is ping');
  });
  it('params schema validates incoming params automatically', async (t) => {
    const { v } = await import('fino:validate');
    const svc = new JsonRpcService();
    svc.method('add').params(v.object({
      a: v.number(),
      b: v.number()
    })).handle((p) => (p as {
      a: number;
      b: number;
    }).a + (p as {
      a: number;
      b: number;
    }).b);
    // valid params
    const ok = JSON.parse((await svc.handle(JSON.stringify({
      jsonrpc: '2.0',
      method: 'add',
      params: {
        a: 3,
        b: 4
      },
      id: 1
    })))!);
    t.equal(ok.result, 7, 'valid params return result');
    // invalid params (string instead of number)
    const bad = JSON.parse((await svc.handle(JSON.stringify({
      jsonrpc: '2.0',
      method: 'add',
      params: {
        a: 'x',
        b: 4
      },
      id: 2
    })))!);
    t.equal(bad.error.code, INVALID_PARAMS, 'invalid params return INVALID_PARAMS');
    t.ok(Array.isArray(bad.error.data), 'issues array included in data');
  });
  it('params schema accepts raw JSON Schema objects', async (t) => {
    const svc = new JsonRpcService();
    svc.method('greet').params({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    }).handle((p) => `hello ${(p as {
      name: string;
    }).name}`);
    const ok = JSON.parse((await svc.handle(JSON.stringify({
      jsonrpc: '2.0',
      method: 'greet',
      params: { name: 'world' },
      id: 1
    })))!);
    t.equal(ok.result, 'hello world', 'valid raw schema passes');
    const bad = JSON.parse((await svc.handle(JSON.stringify({
      jsonrpc: '2.0',
      method: 'greet',
      params: { name: 42 },
      id: 2
    })))!);
    t.equal(bad.error.code, INVALID_PARAMS, 'raw schema validation rejects wrong type');
  });
  it('methods can be chained fluently', async (t) => {
    const svc = new JsonRpcService();
    svc.method('double').handle((p) => (p as {
      n: number;
    }).n * 2).method('triple').handle((p) => (p as {
      n: number;
    }).n * 3);
    const r1 = JSON.parse((await svc.handle(JSON.stringify({
      jsonrpc: '2.0',
      method: 'double',
      params: { n: 5 },
      id: 1
    })))!);
    const r2 = JSON.parse((await svc.handle(JSON.stringify({
      jsonrpc: '2.0',
      method: 'triple',
      params: { n: 5 },
      id: 2
    })))!);
    t.equal(r1.result, 10, 'double works');
    t.equal(r2.result, 15, 'triple works');
  });
});
describe('fino:jsonrpc — JsonRpcPeer', () => {
  it('call() resolves with result from a service-backed peer', async (t) => {
    const [ta, tb] = loopbackPair();
    const client = new JsonRpcPeer(ta);
    const svc = new JsonRpcService();
    svc.method('add').handle((params) => {
      const p = params as {
        a: number;
        b: number;
      };
      return p.a + p.b;
    });
    new JsonRpcPeer(tb, svc);
    const result = await client.call('add', {
      a: 3,
      b: 4
    });
    t.equal(result, 7, 'result is 7');
    await client.close();
  });
  it('call() rejects with JsonRpcError when the handler throws', async (t) => {
    const [ta, tb] = loopbackPair();
    const client = new JsonRpcPeer(ta);
    const svc = new JsonRpcService();
    svc.method('fail').handle(() => {
      throw new Error('intentional failure');
    });
    new JsonRpcPeer(tb, svc);
    let caught: unknown;
    try {
      await client.call('fail');
    } catch (err) {
      caught = err;
    }
    t.ok(caught instanceof JsonRpcError, 'throws JsonRpcError');
    t.equal((caught as JsonRpcError).code, INTERNAL_ERROR, 'code is INTERNAL_ERROR');
    await client.close();
  });
  it('call() rejects with JsonRpcError when the method is unknown', async (t) => {
    const [ta, tb] = loopbackPair();
    const client = new JsonRpcPeer(ta);
    new JsonRpcPeer(tb, new JsonRpcService());
    let caught: unknown;
    try {
      await client.call('nonexistent');
    } catch (err) {
      caught = err;
    }
    t.ok(caught instanceof JsonRpcError, 'throws JsonRpcError');
    t.equal((caught as JsonRpcError).code, METHOD_NOT_FOUND, 'code is METHOD_NOT_FOUND');
    await client.close();
  });
  it('notify() sends a notification with no response', async (t) => {
    const [ta, tb] = loopbackPair();
    const client = new JsonRpcPeer(ta);
    let received = false;
    let receivedId: unknown = 'not-set';
    const svc = new JsonRpcService();
    svc.method('ping').handle((_params, ctx) => {
      received = true;
      receivedId = ctx.id;
    });
    new JsonRpcPeer(tb, svc);
    await client.notify('ping', { ts: 123 });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    t.ok(received, 'notification handler was called');
    t.equal(receivedId, undefined, 'id is undefined for notifications');
    await client.close();
  });
  it('multiple concurrent calls are correlated by id', async (t) => {
    const [ta, tb] = loopbackPair();
    const client = new JsonRpcPeer(ta);
    const svc = new JsonRpcService();
    svc.method('echo').handle((params) => params);
    new JsonRpcPeer(tb, svc);
    const results = await Promise.all([
      client.call('echo', 'first'),
      client.call('echo', 'second'),
      client.call('echo', 'third')
    ]);
    t.deepEqual(results, [
      'first',
      'second',
      'third'
    ], 'all results in correct order');
    await client.close();
  });
  it('handlers can be async', async (t) => {
    const [ta, tb] = loopbackPair();
    const client = new JsonRpcPeer(ta);
    const svc = new JsonRpcService();
    svc.method('slow').handle(async (params) => {
      await new Promise<void>((r) => setTimeout(r, 5));
      return (params as {
        value: number;
      }).value * 2;
    });
    new JsonRpcPeer(tb, svc);
    const result = await client.call('slow', { value: 21 });
    t.equal(result, 42, 'async handler returns correct result');
    await client.close();
  });
  it('peer can act as both client and server simultaneously', async (t) => {
    const [ta, tb] = loopbackPair();
    const svcA = new JsonRpcService();
    svcA.method('greet').handle((params) => `hello from A: ${(params as {
      name: string;
    }).name}`);
    const peerA = new JsonRpcPeer(ta, svcA);
    const svcB = new JsonRpcService();
    svcB.method('greet').handle((params) => `hello from B: ${(params as {
      name: string;
    }).name}`);
    const peerB = new JsonRpcPeer(tb, svcB);
    const [fromB, fromA] = await Promise.all([peerA.call('greet', { name: 'world' }), peerB.call('greet', { name: 'world' })]);
    t.equal(fromB, 'hello from B: world', 'A got response from B');
    t.equal(fromA, 'hello from A: world', 'B got response from A');
    await peerA.close();
  });
});
describe('fino:jsonrpc — JsonRpcError', () => {
  it('carries code and optional data', (t) => {
    const err = new JsonRpcError('bad input', -32602, { field: 'name' });
    t.equal(err.message, 'bad input');
    t.equal(err.code, -32602);
    t.deepEqual(err.data, { field: 'name' });
    t.equal(err.name, 'JsonRpcError');
    t.ok(err instanceof JsonRpcError);
    t.ok(err instanceof Error);
  });
});
describe('fino:jsonrpc — JsonRpcServer', () => {
  it('serve() handles requests over a persistent transport', async (t) => {
    const [clientTransport, serverTransport] = loopbackPair();
    const svc = new JsonRpcService();
    svc.method('double').handle((params) => (params as {
      n: number;
    }).n * 2);
    const server = new JsonRpcServer(svc);
    void server.serve(serverTransport);
    const client = new JsonRpcPeer(clientTransport);
    const result = await client.call('double', { n: 21 });
    t.equal(result, 42, 'server responded correctly over transport');
    await client.close();
  });
  it('listen() serves JSON-RPC over HTTP and responds to requests', async (t) => {
    const svc = new JsonRpcService();
    svc.method('greet').description('Return a greeting').handle((params) => `Hello, ${(params as {
      name: string;
    }).name}!`);
    const server = new JsonRpcServer(svc);
    const handle = server.listen({ port: 0 });
    await handle.ready;
    const { port } = handle;
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'greet',
        params: { name: 'World' },
        id: 1
      })
    });
    t.equal(res.status, 200, 'status is 200');
    const json = await res.json() as {
      result: string;
    };
    t.equal(json.result, 'Hello, World!', 'server returned expected greeting');
    await handle.close();
  });
  it('listen() returns 204 for notifications sent over HTTP', async (t) => {
    const svc = new JsonRpcService();
    let notified = false;
    svc.method('event').handle(() => {
      notified = true;
    });
    const server = new JsonRpcServer(svc);
    const handle = server.listen({ port: 0 });
    await handle.ready;
    const { port } = handle;
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: {}
      })
    });
    t.equal(res.status, 204, 'notification returns 204');
    await new Promise<void>((r) => setTimeout(r, 10));
    t.ok(notified, 'notification handler was called');
    await handle.close();
  });
  it('httpHandler() works with fino:net/http/app App.rpc()', async (t) => {
    const { App } = await import('fino:net/http/app');
    const svc = new JsonRpcService();
    svc.method('greet').handle((p) => `hi ${(p as {
      name: string;
    }).name}`);
    const app = new App({ name: 'Test' });
    app.rpc('/rpc', svc);
    const server = app.listen({ port: 0 });
    await server.ready;
    const res = await fetch(`http://127.0.0.1:${server.port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'greet',
        params: { name: 'fino' },
        id: 1
      })
    });
    t.equal(res.status, 200, 'status 200');
    const json = await res.json() as {
      result: string;
    };
    t.equal(json.result, 'hi fino', 'App.rpc dispatches JSON-RPC');
    await server.close();
  });
  it('listen() returns 404 for requests to the wrong path', async (t) => {
    const svc = new JsonRpcService();
    const server = new JsonRpcServer(svc);
    const handle = server.listen({
      port: 0,
      path: '/rpc'
    });
    await handle.ready;
    const { port } = handle;
    const res = await fetch(`http://127.0.0.1:${port}/wrong`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    t.equal(res.status, 404, 'wrong path returns 404');
    await handle.close();
  });
});
