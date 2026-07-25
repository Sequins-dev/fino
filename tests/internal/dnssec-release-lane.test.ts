import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { ROOT_TRUST_ANCHORS, dnskeyKeyTag } from 'internal:net/dnssec';
const fs = new DiskFileSystem();
const decoder = new TextDecoder();
async function readText(path: string): Promise<string> {
  return decoder.decode(await fs.readFile(path));
}
describe('DNSSEC release lane', () => {
  it('embeds the active and successor IANA root trust anchors', (t) => {
    const tags = ROOT_TRUST_ANCHORS.map((anchor) => dnskeyKeyTag(anchor.rawData)).sort((a, b) => a - b);
    t.deepEqual(tags, [20326, 38696], 'KSK-2017 and KSK-2024 are both trusted during rollover');
  });
  it('has a scheduled and manually configurable live verification workflow', async (t) => {
    const workflow = await readText('.github/workflows/dnssec-release.yml');
    const required = [
      'schedule:',
      'workflow_dispatch:',
      'dns_server:',
      'FINO_DNS_LIVE: "1"',
      'FINO_DNS_SERVER:',
      './target/release/fino test tests/net/dns-live.test.ts'
    ];
    const missing = required.filter((marker) => !workflow.includes(marker));
    t.deepEqual(missing, [], 'workflow runs the gated live suite on schedule or demand');
  });
  it('records the current IANA rollover checkpoint', async (t) => {
    const release = await readText('RELEASE.md');
    const required = [
      'KSK-2017',
      '20326',
      'KSK-2024',
      '38696',
      '11 October 2026'
    ];
    const missing = required.filter((marker) => !release.includes(marker));
    t.deepEqual(missing, [], 'release guidance identifies the current rollover keys and date');
  });
});
