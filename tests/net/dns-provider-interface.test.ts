import { describe, it } from 'fino:test/test';
import { DnsProvider, type DnsRecordData, type LookupResult, type RRType } from '../../js/internal/net/dns-provider.ts';
type RecordMap = Record<string, Partial<Record<RRType, DnsRecordData[]>>>;
class MemoryDnsProvider extends DnsProvider {
  #records: RecordMap;
  #reverse: Record<string, string[]>;
  #servers: string[];
  constructor(records: RecordMap, reverse: Record<string, string[]> = {}, servers = ['127.0.0.1']) {
    super();
    this.#records = records;
    this.#reverse = reverse;
    this.#servers = servers.slice();
  }
  async lookup(hostname: string, opts: {
    family?: 4 | 6;
  } = {}): Promise<LookupResult> {
    const types: RRType[] = opts.family === 6 ? ['AAAA'] : opts.family === 4 ? ['A'] : ['A', 'AAAA'];
    for (const type of types) {
      const values = this.#records[hostname]?.[type] ?? [];
      const address = values.find((value): value is string => typeof value === 'string');
      if (address) return {
        address,
        family: type === 'AAAA' ? 6 : 4
      };
    }
    throw new Error(`DNS lookup failed for ${hostname}`);
  }
  async resolve(hostname: string, rrtype: RRType = 'A'): Promise<DnsRecordData[]> {
    const record = this.#records[hostname];
    if (!record) throw new Error(`DNS name not found: ${hostname}`);
    return (record[rrtype] ?? []).slice();
  }
  async reverse(ip: string): Promise<string[]> {
    return (this.#reverse[ip] ?? []).slice();
  }
  getServers(): string[] {
    return this.#servers.slice();
  }
  setServers(servers: string[]): void {
    for (const server of servers) {
      if (!/^(?:\d{1,3}\.){3}\d{1,3}$|^[:0-9a-fA-F]+$/.test(server)) {
        throw new Error(`invalid DNS server: ${server}`);
      }
    }
    this.#servers = servers.slice();
  }
}
describe('internal:net/dns-provider contract', () => {
  const records: RecordMap = {
    'service.test': {
      A: ['192.0.2.10'],
      AAAA: ['2001:db8::10'],
      MX: [{
        priority: 10,
        exchange: 'mail.service.test'
      }],
      TXT: [['v=spf1 -all']],
      SRV: [{
        priority: 1,
        weight: 5,
        port: 443,
        name: 'api.service.test'
      }],
      SOA: [{
        nsname: 'ns.service.test',
        hostmaster: 'hostmaster.service.test',
        serial: 1,
        refresh: 3600,
        retry: 600,
        expire: 86400,
        minttl: 60
      }],
      PTR: ['ptr.service.test']
    },
    'empty.test': { A: [] }
  };
  it('lookup honors requested address family', async (t) => {
    const provider = new MemoryDnsProvider(records);
    t.deepEqual(await provider.lookup('service.test', { family: 4 }), {
      address: '192.0.2.10',
      family: 4
    });
    t.deepEqual(await provider.lookup('service.test', { family: 6 }), {
      address: '2001:db8::10',
      family: 6
    });
    await t.rejects(() => provider.lookup('empty.test', { family: 4 }), /lookup failed/, 'empty address sets reject lookup');
  });
  it('resolve returns record shapes and snapshots', async (t) => {
    const provider = new MemoryDnsProvider(records);
    t.deepEqual(await provider.resolve('service.test', 'A'), ['192.0.2.10']);
    t.deepEqual(await provider.resolve('service.test', 'AAAA'), ['2001:db8::10']);
    t.deepEqual(await provider.resolve('service.test', 'MX'), [{
      priority: 10,
      exchange: 'mail.service.test'
    }]);
    t.deepEqual(await provider.resolve('service.test', 'TXT'), [['v=spf1 -all']]);
    t.deepEqual(await provider.resolve('service.test', 'SRV'), [{
      priority: 1,
      weight: 5,
      port: 443,
      name: 'api.service.test'
    }]);
    t.deepEqual(await provider.resolve('service.test', 'SOA'), [{
      nsname: 'ns.service.test',
      hostmaster: 'hostmaster.service.test',
      serial: 1,
      refresh: 3600,
      retry: 600,
      expire: 86400,
      minttl: 60
    }]);
    t.deepEqual(await provider.resolve('empty.test', 'AAAA'), [], 'existing names may return no matching records');
    const resolved = await provider.resolve('service.test', 'A');
    resolved.push('192.0.2.99');
    t.deepEqual(await provider.resolve('service.test', 'A'), ['192.0.2.10'], 'mutating returned records does not mutate provider state');
  });
  it('reverse returns PTR name snapshots', async (t) => {
    const provider = new MemoryDnsProvider(records, { '192.0.2.10': ['service.test'] });
    const names = await provider.reverse('192.0.2.10');
    names.push('mutated.test');
    t.deepEqual(await provider.reverse('192.0.2.10'), ['service.test']);
    t.deepEqual(await provider.reverse('192.0.2.99'), [], 'missing reverse mappings return an empty list');
  });
  it('server accessors copy and validate input', (t) => {
    const provider = new MemoryDnsProvider(records);
    const servers = provider.getServers();
    servers.push('8.8.8.8');
    t.deepEqual(provider.getServers(), ['127.0.0.1'], 'getServers returns a snapshot');
    const next = ['1.1.1.1', '2001:4860:4860::8888'];
    provider.setServers(next);
    next.push('8.8.4.4');
    t.deepEqual(provider.getServers(), ['1.1.1.1', '2001:4860:4860::8888'], 'setServers copies input');
    t.throws(() => provider.setServers(['not a server']), /invalid DNS server/);
  });
});
