/** Tests for fino:net/http/app session caches and HTTP lifecycle behavior. */
import { describe, it } from 'fino:test/test';
import { memoryCache, sqliteCache, type RevisionedCache } from 'fino:cache';
import { DiskFileSystem } from 'fino:file';
import {
  App,
  cookies,
  sessions,
  SessionConflictError,
  type Session,
  type SessionKey,
} from 'fino:net/http/app';
function fakeClock(now = 1e3) {
  return {
    clock: { now: () => now },
    advance(ms: number) {
      now += ms;
    },
  };
}
const primaryKey: SessionKey = {
  id: 'primary',
  secret: 'primary-test-secret',
};
const oldKey: SessionKey = {
  id: 'old',
  secret: 'old-test-secret',
};
function cookiePair(response: Response, name = 'fino.sid'): string {
  const header = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  if (header === undefined) throw new Error(`missing ${name} Set-Cookie header`);
  return header.split(';')[0]!;
}
function makeApp(
  store: RevisionedCache,
  options: {
    keys?: readonly [SessionKey, ...SessionKey[]];
    clock?: {
      now(): number;
    };
    rolling?: boolean;
  } = {},
): App {
  const app = new App();
  const stateful = app.value('cookies', cookies()).value(
    'session',
    sessions({
      store,
      keys: options.keys ?? [primaryKey],
      ttlMs: 1e3,
      clock: options.clock,
      rolling: options.rolling,
    }),
  );
  stateful.post('/login').handle((ctx) => {
    const session = ctx.session as Session;
    session.regenerate();
    session.data.user = 'ada';
    return Response.json({
      id: session.id,
      expiresAt: session.expiresAt,
    });
  });
  stateful.get('/me').handle((ctx) => {
    const session = ctx.session as Session;
    return Response.json({
      id: session.id,
      user: session.data.user ?? null,
      expiresAt: session.expiresAt,
    });
  });
  stateful.post('/logout').handle((ctx) => {
    (ctx.session as Session).invalidate();
    return new Response(null, { status: 204 });
  });
  return app;
}
describe('fino:net/http/app session cache integration', () => {
  it('accepts a caller-owned SQLite cache and survives reopen', async (t) => {
    const path = `/tmp/fino-session-test-${Math.floor(Math.random() * 1e9)}.db`;
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await sqliteCache({
      path,
      namespace: 'sessions',
      fs,
    });
    try {
      const app = makeApp(store);
      const login = await app.handle(new Request('https://example.test/login', { method: 'POST' }));
      const pair = cookiePair(login);
      await store.close();
      const reopened = await sqliteCache({
        path,
        namespace: 'sessions',
        fs,
      });
      try {
        const restored = await makeApp(reopened).handle(
          new Request('https://example.test/me', { headers: { cookie: pair } }),
        );
        t.equal(
          (
            (await restored.json()) as {
              user: string;
            }
          ).user,
          'ada',
        );
      } finally {
        await reopened.close();
      }
    } finally {
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
});
describe('fino:net/http/app session middleware', () => {
  it('seals the session id and persists login data with secure cookie defaults', async (t) => {
    const store = memoryCache({ namespace: 'sessions' });
    const app = makeApp(store);
    const login = await app.handle(new Request('https://example.test/login', { method: 'POST' }));
    const body = (await login.json()) as {
      id: string;
    };
    const setCookie = login.headers.getSetCookie().find((value) => value.startsWith('fino.sid='))!;
    t.ok(setCookie.includes('HttpOnly'));
    t.ok(setCookie.includes('Secure'));
    t.ok(setCookie.includes('SameSite=Lax'));
    t.ok(setCookie.includes('Path=/'));
    t.equal(setCookie.includes(body.id), false, 'plaintext session id is not exposed');
    const me = await app.handle(
      new Request('https://example.test/me', { headers: { cookie: cookiePair(login) } }),
    );
    const loaded = (await me.json()) as {
      id: string;
      user: string;
    };
    t.equal(loaded.id, body.id);
    t.equal(loaded.user, 'ada');
    t.equal(
      me.headers.getSetCookie().length,
      0,
      'fixed unmodified session does not rewrite storage or cookie',
    );
  });
  it('rejects tampered cookies and replaces them with a fresh session', async (t) => {
    const app = makeApp(memoryCache({ namespace: 'sessions' }));
    const login = await app.handle(new Request('https://example.test/login', { method: 'POST' }));
    const original = (await login.clone().json()) as {
      id: string;
    };
    const pair = cookiePair(login);
    const tampered = `${pair.slice(0, -1)}${pair.endsWith('a') ? 'b' : 'a'}`;
    const me = await app.handle(
      new Request('https://example.test/me', { headers: { cookie: tampered } }),
    );
    const fresh = (await me.json()) as {
      id: string;
      user: null;
    };
    t.notEqual(fresh.id, original.id);
    t.equal(fresh.user, null);
    t.ok(me.headers.getSetCookie().some((value) => value.startsWith('fino.sid=')));
  });
  it('accepts an old sealing key and reissues with the primary key', async (t) => {
    const store = memoryCache({ namespace: 'sessions' });
    const oldApp = makeApp(store, { keys: [oldKey] });
    const login = await oldApp.handle(
      new Request('https://example.test/login', { method: 'POST' }),
    );
    const original = (await login.clone().json()) as {
      id: string;
    };
    const rotatedApp = makeApp(store, { keys: [primaryKey, oldKey] });
    const me = await rotatedApp.handle(
      new Request('https://example.test/me', { headers: { cookie: cookiePair(login) } }),
    );
    const loaded = (await me.json()) as {
      id: string;
      user: string;
    };
    t.equal(loaded.id, original.id);
    t.equal(loaded.user, 'ada');
    t.ok(cookiePair(me).startsWith('fino.sid=primary.'), 'cookie is resealed with the primary key');
  });
  it('supports fixed and rolling expiry', async (t) => {
    const time = fakeClock();
    const fixedStore = memoryCache({
      namespace: 'fixed-sessions',
      clock: time.clock,
    });
    const fixedApp = makeApp(fixedStore, { clock: time.clock });
    const fixedLogin = await fixedApp.handle(
      new Request('https://example.test/login', { method: 'POST' }),
    );
    const fixedBody = (await fixedLogin.clone().json()) as {
      expiresAt: number;
    };
    time.advance(400);
    const fixedMe = await fixedApp.handle(
      new Request('https://example.test/me', { headers: { cookie: cookiePair(fixedLogin) } }),
    );
    t.equal(
      (
        (await fixedMe.json()) as {
          expiresAt: number;
        }
      ).expiresAt,
      fixedBody.expiresAt,
    );
    const rollingStore = memoryCache({
      namespace: 'rolling-sessions',
      clock: time.clock,
    });
    const rollingApp = makeApp(rollingStore, {
      clock: time.clock,
      rolling: true,
    });
    const rollingLogin = await rollingApp.handle(
      new Request('https://example.test/login', { method: 'POST' }),
    );
    const rollingBody = (await rollingLogin.clone().json()) as {
      expiresAt: number;
    };
    time.advance(400);
    const rollingMe = await rollingApp.handle(
      new Request('https://example.test/me', { headers: { cookie: cookiePair(rollingLogin) } }),
    );
    t.ok(
      (
        (await rollingMe.json()) as {
          expiresAt: number;
        }
      ).expiresAt > rollingBody.expiresAt,
    );
    t.ok(rollingMe.headers.getSetCookie().length > 0, 'rolling session refreshes its cookie');
  });
  it('replaces an expired session with a fresh anonymous session', async (t) => {
    const time = fakeClock();
    const store = memoryCache({
      namespace: 'sessions',
      clock: time.clock,
    });
    const app = makeApp(store, { clock: time.clock });
    const login = await app.handle(new Request('https://example.test/login', { method: 'POST' }));
    const authenticated = (await login.clone().json()) as {
      id: string;
    };
    const pair = cookiePair(login);
    time.advance(1001);
    const me = await app.handle(
      new Request('https://example.test/me', { headers: { cookie: pair } }),
    );
    const fresh = (await me.json()) as {
      id: string;
      user: null;
    };
    t.notEqual(fresh.id, authenticated.id);
    t.equal(fresh.user, null);
    t.ok(me.headers.getSetCookie().some((value) => value.startsWith('fino.sid=')));
  });
  it('invalidates the stored session and expires the browser cookie', async (t) => {
    const app = makeApp(memoryCache({ namespace: 'sessions' }));
    const login = await app.handle(new Request('https://example.test/login', { method: 'POST' }));
    const original = (await login.clone().json()) as {
      id: string;
    };
    const pair = cookiePair(login);
    const logout = await app.handle(
      new Request('https://example.test/logout', {
        method: 'POST',
        headers: { cookie: pair },
      }),
    );
    const cleared = logout.headers.getSetCookie().find((value) => value.startsWith('fino.sid='))!;
    t.ok(cleared.includes('Max-Age=0'));
    const me = await app.handle(
      new Request('https://example.test/me', { headers: { cookie: pair } }),
    );
    const fresh = (await me.json()) as {
      id: string;
      user: null;
    };
    t.notEqual(fresh.id, original.id);
    t.equal(fresh.user, null);
  });
  it('regenerates a loaded id after login and makes the old cookie unusable', async (t) => {
    const app = makeApp(memoryCache({ namespace: 'sessions' }));
    const anonymous = await app.handle(new Request('https://example.test/me'));
    const anonymousBody = (await anonymous.clone().json()) as {
      id: string;
    };
    const anonymousCookie = cookiePair(anonymous);
    const login = await app.handle(
      new Request('https://example.test/login', {
        method: 'POST',
        headers: { cookie: anonymousCookie },
      }),
    );
    const authenticated = (await login.clone().json()) as {
      id: string;
    };
    t.notEqual(authenticated.id, anonymousBody.id);
    const stale = await app.handle(
      new Request('https://example.test/me', { headers: { cookie: anonymousCookie } }),
    );
    const staleBody = (await stale.json()) as {
      id: string;
      user: null;
    };
    t.notEqual(staleBody.id, anonymousBody.id);
    t.notEqual(staleBody.id, authenticated.id);
    t.equal(staleBody.user, null);
  });
  it('raises SessionConflictError instead of overwriting a concurrent mutation', async (t) => {
    const store = memoryCache({ namespace: 'sessions' });
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
    app
      .value('cookies', cookies())
      .value(
        'session',
        sessions({
          store,
          keys: [primaryKey],
          ttlMs: 1e3,
        }),
      )
      .post('/change')
      .handle(async (ctx) => {
        const session = ctx.session as Session;
        session.data.count = Number(session.data.count ?? 0) + 1;
        entered++;
        if (entered === 2) bothEntered();
        await new Promise<void>((resolve) => releases.push(resolve));
        return new Response('ok');
      });
    const request = () =>
      app.handle(
        new Request('https://example.test/change', {
          method: 'POST',
          headers: { cookie: pair },
        }),
      );
    const first = request();
    const second = request();
    await ready;
    releases.shift()!();
    await first;
    releases.shift()!();
    await t.rejects(() => second, SessionConflictError);
  });
});
