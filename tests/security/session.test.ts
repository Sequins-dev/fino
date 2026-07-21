/** Tests for fino:security/session stores and HTTP lifecycle behavior. */
import { describe, it } from 'fino:test/test';
import { memoryCache } from 'fino:cache';
import { DiskFileSystem } from 'fino:file';
import { App, cookies } from 'fino:net/http/app';
import { cacheSessionStore, memorySessionStore, sessions, sqliteSessionStore, SessionConflictError, type Session, type SessionKey, type SessionRecord, type SessionStore } from 'fino:security/session';
function fakeClock(now = 1e3) {
  return {
    clock: { now: () => now },
    advance(ms: number) {
      now += ms;
    }
  };
}
function record(id = 'session-1'): SessionRecord<{
  user: string;
}> {
  return {
    id,
    data: { user: 'ada' },
    createdAt: 1e3,
    updatedAt: 1e3,
    expiresAt: Number.MAX_SAFE_INTEGER
  };
}
async function assertStoreContract(t: any, store: SessionStore<{
  user: string;
}>): Promise<void> {
  const initial = record();
  t.equal(await store.load(initial.id), null, 'missing session returns null');
  const created = await store.save(initial, { ifRevision: null });
  t.ok(created !== null, 'create-only save creates a missing session');
  t.deepEqual(created!.record, initial);
  t.equal(await store.save(initial, { ifRevision: null }), null, 'create-only save rejects an existing session');
  const changed = {
    ...initial,
    data: { user: 'grace' },
    updatedAt: 1100
  };
  const updated = await store.save(changed, { ifRevision: created!.revision });
  t.ok(updated !== null, 'matching revision updates the session');
  t.notEqual(updated!.revision, created!.revision, 'session revision advances');
  t.equal(await store.save(initial, { ifRevision: created!.revision }), null, 'stale revision rejects');
  t.deepEqual((await store.load(initial.id))!.record.data, { user: 'grace' });
  await store.delete(initial.id);
  t.equal(await store.load(initial.id), null, 'delete removes the session');
  t.equal(await store.save(initial, { ifRevision: updated!.revision }), null, 'stale save cannot resurrect a deleted session');
}
const primaryKey: SessionKey = {
  id: 'primary',
  secret: 'primary-test-secret'
};
const oldKey: SessionKey = {
  id: 'old',
  secret: 'old-test-secret'
};
function cookiePair(response: Response, name = 'fino.sid'): string {
  const header = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  if (header === undefined) throw new Error(`missing ${name} Set-Cookie header`);
  return header.split(';')[0]!;
}
function makeApp(store: SessionStore<Record<string, unknown>>, options: {
  keys?: readonly [SessionKey, ...SessionKey[]];
  clock?: {
    now(): number;
  };
  rolling?: boolean;
} = {}): App {
  const app = new App();
  const stateful = app.value('cookies', cookies()).value('session', sessions({
    store,
    keys: options.keys ?? [primaryKey],
    ttlMs: 1e3,
    clock: options.clock,
    rolling: options.rolling
  }));
  stateful.post('/login').handle((ctx) => {
    const session = ctx.session as Session;
    session.regenerate();
    session.data.user = 'ada';
    return Response.json({
      id: session.id,
      expiresAt: session.expiresAt
    });
  });
  stateful.get('/me').handle((ctx) => {
    const session = ctx.session as Session;
    return Response.json({
      id: session.id,
      user: session.data.user ?? null,
      expiresAt: session.expiresAt
    });
  });
  stateful.post('/logout').handle((ctx) => {
    (ctx.session as Session).invalidate();
    return new Response(null, { status: 204 });
  });
  return app;
}
describe('fino:security/session stores', () => {
  it('memory store satisfies the revisioned contract', async (t) => {
    await assertStoreContract(t, memorySessionStore());
  });
  it('cache adapter satisfies the revisioned contract', async (t) => {
    await assertStoreContract(t, cacheSessionStore(memoryCache()));
  });
  it('sqlite store satisfies the revisioned contract and survives reopen', async (t) => {
    const path = `/tmp/fino-session-test-${Math.floor(Math.random() * 1e9)}.db`;
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await sqliteSessionStore({
      path,
      fs
    });
    try {
      await assertStoreContract(t, store);
      const saved = await store.save(record('persistent'), { ifRevision: null });
      t.ok(saved !== null);
    } finally {
      await store.close();
    }
    const reopened = await sqliteSessionStore({
      path,
      fs
    });
    try {
      t.deepEqual((await reopened.load('persistent'))!.record.data, { user: 'ada' });
    } finally {
      await reopened.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('stores discard expired records using an injected clock', async (t) => {
    const time = fakeClock();
    const store = memorySessionStore({ clock: time.clock });
    const created = await store.save({
      ...record(),
      expiresAt: 2e3
    }, { ifRevision: null });
    t.ok(created !== null);
    time.advance(1001);
    t.equal(await store.load('session-1'), null);
  });
});
describe('fino:security/session HTTP middleware', () => {
  it('seals the session id and persists login data with secure cookie defaults', async (t) => {
    const store = memorySessionStore<Record<string, unknown>>();
    const app = makeApp(store);
    const login = await app.handle(new Request('https://example.test/login', { method: 'POST' }));
    const body = await login.json() as {
      id: string;
    };
    const setCookie = login.headers.getSetCookie().find((value) => value.startsWith('fino.sid='))!;
    t.ok(setCookie.includes('HttpOnly'));
    t.ok(setCookie.includes('Secure'));
    t.ok(setCookie.includes('SameSite=Lax'));
    t.ok(setCookie.includes('Path=/'));
    t.equal(setCookie.includes(body.id), false, 'plaintext session id is not exposed');
    const me = await app.handle(new Request('https://example.test/me', { headers: { cookie: cookiePair(login) } }));
    const loaded = await me.json() as {
      id: string;
      user: string;
    };
    t.equal(loaded.id, body.id);
    t.equal(loaded.user, 'ada');
    t.equal(me.headers.getSetCookie().length, 0, 'fixed unmodified session does not rewrite storage or cookie');
  });
  it('rejects tampered cookies and replaces them with a fresh session', async (t) => {
    const app = makeApp(memorySessionStore());
    const login = await app.handle(new Request('https://example.test/login', { method: 'POST' }));
    const original = await login.clone().json() as {
      id: string;
    };
    const pair = cookiePair(login);
    const tampered = `${pair.slice(0, -1)}${pair.endsWith('a') ? 'b' : 'a'}`;
    const me = await app.handle(new Request('https://example.test/me', { headers: { cookie: tampered } }));
    const fresh = await me.json() as {
      id: string;
      user: null;
    };
    t.notEqual(fresh.id, original.id);
    t.equal(fresh.user, null);
    t.ok(me.headers.getSetCookie().some((value) => value.startsWith('fino.sid=')));
  });
  it('accepts an old sealing key and reissues with the primary key', async (t) => {
    const store = memorySessionStore<Record<string, unknown>>();
    const oldApp = makeApp(store, { keys: [oldKey] });
    const login = await oldApp.handle(new Request('https://example.test/login', { method: 'POST' }));
    const original = await login.clone().json() as {
      id: string;
    };
    const rotatedApp = makeApp(store, { keys: [primaryKey, oldKey] });
    const me = await rotatedApp.handle(new Request('https://example.test/me', { headers: { cookie: cookiePair(login) } }));
    const loaded = await me.json() as {
      id: string;
      user: string;
    };
    t.equal(loaded.id, original.id);
    t.equal(loaded.user, 'ada');
    t.ok(cookiePair(me).startsWith('fino.sid=primary.'), 'cookie is resealed with the primary key');
  });
  it('supports fixed and rolling expiry', async (t) => {
    const time = fakeClock();
    const fixedStore = memorySessionStore<Record<string, unknown>>({ clock: time.clock });
    const fixedApp = makeApp(fixedStore, { clock: time.clock });
    const fixedLogin = await fixedApp.handle(new Request('https://example.test/login', { method: 'POST' }));
    const fixedBody = await fixedLogin.clone().json() as {
      expiresAt: number;
    };
    time.advance(400);
    const fixedMe = await fixedApp.handle(new Request('https://example.test/me', { headers: { cookie: cookiePair(fixedLogin) } }));
    t.equal((await fixedMe.json() as {
      expiresAt: number;
    }).expiresAt, fixedBody.expiresAt);
    const rollingStore = memorySessionStore<Record<string, unknown>>({ clock: time.clock });
    const rollingApp = makeApp(rollingStore, {
      clock: time.clock,
      rolling: true
    });
    const rollingLogin = await rollingApp.handle(new Request('https://example.test/login', { method: 'POST' }));
    const rollingBody = await rollingLogin.clone().json() as {
      expiresAt: number;
    };
    time.advance(400);
    const rollingMe = await rollingApp.handle(new Request('https://example.test/me', { headers: { cookie: cookiePair(rollingLogin) } }));
    t.ok((await rollingMe.json() as {
      expiresAt: number;
    }).expiresAt > rollingBody.expiresAt);
    t.ok(rollingMe.headers.getSetCookie().length > 0, 'rolling session refreshes its cookie');
  });
  it('invalidates the stored session and expires the browser cookie', async (t) => {
    const app = makeApp(memorySessionStore());
    const login = await app.handle(new Request('https://example.test/login', { method: 'POST' }));
    const original = await login.clone().json() as {
      id: string;
    };
    const pair = cookiePair(login);
    const logout = await app.handle(new Request('https://example.test/logout', {
      method: 'POST',
      headers: { cookie: pair }
    }));
    const cleared = logout.headers.getSetCookie().find((value) => value.startsWith('fino.sid='))!;
    t.ok(cleared.includes('Max-Age=0'));
    const me = await app.handle(new Request('https://example.test/me', { headers: { cookie: pair } }));
    const fresh = await me.json() as {
      id: string;
      user: null;
    };
    t.notEqual(fresh.id, original.id);
    t.equal(fresh.user, null);
  });
  it('regenerates a loaded id after login and makes the old cookie unusable', async (t) => {
    const app = makeApp(memorySessionStore());
    const anonymous = await app.handle(new Request('https://example.test/me'));
    const anonymousBody = await anonymous.clone().json() as {
      id: string;
    };
    const anonymousCookie = cookiePair(anonymous);
    const login = await app.handle(new Request('https://example.test/login', {
      method: 'POST',
      headers: { cookie: anonymousCookie }
    }));
    const authenticated = await login.clone().json() as {
      id: string;
    };
    t.notEqual(authenticated.id, anonymousBody.id);
    const stale = await app.handle(new Request('https://example.test/me', { headers: { cookie: anonymousCookie } }));
    const staleBody = await stale.json() as {
      id: string;
      user: null;
    };
    t.notEqual(staleBody.id, anonymousBody.id);
    t.notEqual(staleBody.id, authenticated.id);
    t.equal(staleBody.user, null);
  });
  it('raises SessionConflictError instead of overwriting a concurrent mutation', async (t) => {
    const store = memorySessionStore<Record<string, unknown>>();
    const setup = makeApp(store);
    const login = await setup.handle(new Request('https://example.test/login', { method: 'POST' }));
    const pair = cookiePair(login);
    const app = new App();
    const releases: Array<() => void> = [];
    let entered = 0;
    let bothEntered!: () => void;
    const ready = new Promise<void>((resolve) => {
      bothEntered = resolve;
    });
    app.value('cookies', cookies()).value('session', sessions({
      store,
      keys: [primaryKey],
      ttlMs: 1e3
    })).post('/change').handle(async (ctx) => {
      const session = ctx.session as Session;
      session.data.count = Number(session.data.count ?? 0) + 1;
      entered++;
      if (entered === 2) bothEntered();
      await new Promise<void>((resolve) => releases.push(resolve));
      return new Response('ok');
    });
    const request = () => app.handle(new Request('https://example.test/change', {
      method: 'POST',
      headers: { cookie: pair }
    }));
    const first = request();
    const second = request();
    await ready;
    releases.shift()!();
    await first;
    releases.shift()!();
    await t.rejects(() => second, SessionConflictError);
  });
});
