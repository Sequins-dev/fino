import { describe, it } from 'fino:test/test';
import 'fino:format/markdown';
import 'fino:format/csv';
import 'fino:format/toml';
import 'fino:format/xml';
import 'fino:format/yaml';
import 'fino:format/typescript';
import 'fino:parsing/scanner';
import 'fino:compress';
import 'fino:database/sqlite';
import 'fino:context';
import 'fino:context/topic';
import 'fino:process';
import 'fino:process/argv';
import 'fino:tty';
import 'fino:tty/prompt';
import 'fino:realm';
import 'fino:realm/pool';
import 'fino:realm/self';
import 'fino:realm/messaging';
import 'fino:module';
import 'fino:cluster';
import 'fino:net/http';
import 'fino:net/http/h1';
import 'fino:net/http/h2';
import 'fino:net/http/driver';
import 'fino:net/http/server';
import 'fino:net/http/eventsource';
import 'fino:net/http/websocket';

describe('builtin module layout', () => {
  it('exposes the pre-release public module grouping', async (t) => {
    t.ok(true, 'new public builtin grouping resolves');
  });
});
