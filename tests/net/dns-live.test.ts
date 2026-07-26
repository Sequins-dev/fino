/**
 * Gated live DNSSEC smoke tests for release verification.
 *
 * These tests intentionally require network access and are skipped unless
 * `FINO_DNS_LIVE=1` is set. Override domains with `FINO_DNS_SIGNED_DOMAIN`
 * and `FINO_DNS_BOGUS_DOMAIN`.
 */
import { describe, it } from 'fino:test/test';
import { env } from 'fino:process';
import { Resolver } from 'fino:net/dns';
const skipLive =
  env.FINO_DNS_LIVE !== '1' && 'set FINO_DNS_LIVE=1 to run live DNSSEC release checks';
const dnsServer = env.FINO_DNS_SERVER ?? '1.1.1.1';
const signedDomain = env.FINO_DNS_SIGNED_DOMAIN ?? 'cloudflare.com';
const bogusDomain = env.FINO_DNS_BOGUS_DOMAIN ?? 'dnssec-failed.org';
describe('Live DNSSEC release smoke', { skip: skipLive }, () => {
  it('validates a real signed domain', async (t) => {
    const resolver = new Resolver({
      timeout: 5e3,
      retries: 1,
      dnssec: true,
    });
    resolver.setServers([dnsServer]);
    const addresses = await resolver.resolve4(signedDomain);
    t.ok(addresses.length > 0, `${signedDomain} has validated A records`);
  });
  it('rejects a real bogus signed domain', async (t) => {
    const resolver = new Resolver({
      timeout: 5e3,
      retries: 1,
      dnssec: true,
    });
    resolver.setServers([dnsServer]);
    await t.rejects(
      () => resolver.resolve4(bogusDomain),
      (err) =>
        (
          err as {
            code?: string;
          }
        ).code === 'EDNSSEC',
      `${bogusDomain} rejects with EDNSSEC`,
    );
  });
});
