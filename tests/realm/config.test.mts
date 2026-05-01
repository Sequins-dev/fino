/**
 * Tests for fino:realm — provider config serialisation.
 */

import { describe, it } from 'fino:test/test';
import { DiskFsConfig, SystemNetConfig, SystemDnsConfig } from 'fino:realm';

describe('Provider config serialisation', () => {
  it('DiskFsConfig round-trips through JSON', (t) => {
    const cfg = new DiskFsConfig({ root: '/sandbox' });
    const json = cfg.toJSON();
    const back = DiskFsConfig.fromJSON(json);
    t.equal(back.options.root, '/sandbox', 'root preserved');
    t.equal(back.type, 'disk', 'type preserved');
  });

  it('DiskFsConfig defaults to empty options', (t) => {
    const cfg = new DiskFsConfig();
    t.equal(cfg.options.root, undefined, 'no root by default');
  });

  it('SystemNetConfig round-trips through JSON', (t) => {
    const cfg = new SystemNetConfig();
    const json = cfg.toJSON();
    const back = SystemNetConfig.fromJSON(json);
    t.equal(back.type, 'system-net', 'type preserved');
  });

  it('SystemDnsConfig round-trips through JSON', (t) => {
    const cfg = new SystemDnsConfig();
    const json = cfg.toJSON();
    const back = SystemDnsConfig.fromJSON(json);
    t.equal(back.type, 'system-dns', 'type preserved');
  });
});
