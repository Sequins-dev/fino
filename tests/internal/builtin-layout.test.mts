import { describe, it } from 'fino:test/test';

describe('builtin module layout', () => {
  it('exposes the pre-release public module grouping', async (t) => {
    await import('fino:format/markdown');
    await import('fino:format/csv');
    await import('fino:format/toml');
    await import('fino:format/xml');
    await import('fino:format/yaml');
    await import('fino:format/typescript');
    await import('fino:parsing/scanner');
    await import('fino:database/sqlite');
    await import('fino:context');
    await import('fino:context/topic');
    await import('fino:realm');
    await import('fino:realm/pool');
    await import('fino:realm/self');
    await import('fino:net/http');
    await import('fino:net/http/h1');
    await import('fino:net/http/h2');
    await import('fino:net/http/driver');
    await import('fino:net/http/server');
    await import('fino:net/http/eventsource');
    await import('fino:net/http/websocket');

    t.ok(true, 'new public builtin grouping resolves');
  });
});
