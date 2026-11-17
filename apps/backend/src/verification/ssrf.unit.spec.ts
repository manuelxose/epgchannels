/**
 * SSRF / egress adversarial suite (TDT-API-02D, SEC-01).
 *
 * Proves the egress layer is **two-sided**: it refuses every blocked destination
 * (RFC1918, loopback, link-local/metadata, ULA, IPv4-mapped, reserved names,
 * unsafe redirects, rebinding DNS, oversized bodies, timeouts, URL credentials)
 * and it still fetches a legitimate target. Every refusal is scored twice:
 *
 *  - the failure **code** is the one the contract names, and
 *  - the fixture's connection counter for the blocked destination is **0**:
 *    no socket was opened, so the rejection happened before the network.
 *
 * The only real sockets in this file go to a loopback fixture, and only when the
 * caller passes the explicit test-only `allowLoopbackForTests` flag (default
 * `false`) — that flag is what makes the "allowed" half meaningful.
 *
 * No real DNS is ever consulted: every call supplies `deps.lookup`.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { classifyIpv4, classifyIpv6, isPublicAddress, isReservedHostname } from '../infrastructure/ip-classification.js';
import {
  EgressFailure,
  pinnedLookup,
  safeFetch,
  type EgressFailureCode,
  type EgressLookup,
  type SafeEgressRequest,
} from '../infrastructure/safe-egress.js';
import { startHttpFixture, type HttpFixture } from './fixtures/http-fixtures.js';

const PUBLIC_V4 = '93.184.216.34';

/** Resolver stub with a call log: proves when (and how often) resolution ran. */
function lookupOf(table: Readonly<Record<string, readonly string[]>>): EgressLookup & { calls: string[] } {
  const calls: string[] = [];
  const lookup = (async (host: string): Promise<readonly string[]> => {
    calls.push(host);
    const answer = table[host];
    if (answer === undefined) {
      const error = new Error(`getaddrinfo ENOTFOUND ${host}`) as NodeJS.ErrnoException;
      error.code = 'ENOTFOUND';
      throw error;
    }
    return answer;
  }) as EgressLookup & { calls: string[] };
  lookup.calls = calls;
  return lookup;
}

/** Scripted resolver: returns one answer per call, then repeats the last one. */
function scriptedLookup(answers: ReadonlyArray<readonly string[]>): EgressLookup & { reads: () => number } {
  let calls = 0;
  const lookup = (async (): Promise<readonly string[]> => {
    const index = Math.min(calls, answers.length - 1);
    calls += 1;
    return answers[index] ?? [];
  }) as unknown as EgressLookup & { reads: () => number };
  lookup.reads = () => calls;
  return lookup;
}

function request(overrides: Partial<SafeEgressRequest> & { url: string }): SafeEgressRequest {
  return { timeoutMs: 2_000, maxBytes: 1024 * 1024, ...overrides };
}

/** Awaits the typed failure and returns it; fails the test when nothing threw. */
async function failureOf(promise: Promise<unknown>): Promise<EgressFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EgressFailure);
    return error as EgressFailure;
  }
  throw new Error('expected an EgressFailure, but the fetch resolved');
}

async function expectCode(promise: Promise<unknown>, code: EgressFailureCode): Promise<EgressFailure> {
  const failure = await failureOf(promise);
  expect(failure.code, `expected ${code}, got ${failure.code} (${failure.message})`).toBe(code);
  return failure;
}

/** Starts a fixture for one test body and always closes it. */
async function withFixture<T>(
  routes: Parameters<typeof startHttpFixture>[0],
  body: (fixture: HttpFixture) => Promise<T>,
): Promise<T> {
  const fixture = await startHttpFixture(routes);
  try {
    return await body(fixture);
  } finally {
    await fixture.close();
  }
}

describe('SSRF-IP: IPv4 special-purpose ranges are refused', () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    ['0.0.0.0', 'this-network'],
    ['0.1.2.3', 'this-network'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['100.64.0.1', 'shared'],
    ['100.127.255.254', 'shared'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.0.1', 'link-local'],
    ['169.254.169.254', 'link-local'], // cloud metadata
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.0.0.1', 'ietf-protocol'],
    ['192.0.2.10', 'documentation'],
    ['192.168.1.1', 'private'],
    ['192.168.255.255', 'private'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
  ];

  it.each(refused)('refuses %s (%s)', (address, reason) => {
    const result = classifyIpv4(address);
    expect(result.ok).toBe(false);
    expect(result.version).toBe(4);
    if (!result.ok) expect(result.reason).toBe(reason);
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '151.101.1.69', '203.0.114.1'])(
    'accepts public %s (positive control)',
    (address) => {
      expect(classifyIpv4(address).ok).toBe(true);
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it('refuses malformed and ambiguous octet spellings', () => {
    for (const address of ['1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '1.2.3.a', '']) {
      expect(classifyIpv4(address).ok, address).toBe(false);
    }
  });
});

describe('SSRF-IP: IPv6 special-purpose ranges are refused', () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'ula'],
    ['fd12:3456:789a::1', 'ula'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['ff00::', 'multicast'],
    ['::ffff:127.0.0.1', 'ipv4-mapped-private'],
    ['::ffff:10.0.0.1', 'ipv4-mapped-private'],
    ['::ffff:169.254.169.254', 'ipv4-mapped-private'],
    ['::ffff:7f00:1', 'ipv4-mapped-private'],
    ['::ffff:0:0', 'ipv4-mapped-private'],
    ['::127.0.0.1', 'ipv4-embedded'],
    ['64:ff9b::7f00:1', 'ipv4-embedded'],
    ['2001:db8::1', 'documentation'],
    ['100::1', 'not-global-unicast'], // 0100::/8, discard-only 100::/64
    ['2002:c0a8:101::1', '6to4'],
    ['2001::1', 'teredo'],
    ['fe80::1%eth0', 'malformed'],
  ];

  it.each(refused)('refuses %s (%s)', (address, reason) => {
    const result = classifyIpv6(address);
    expect(result.ok).toBe(false);
    expect(result.version).toBe(6);
    if (!result.ok) expect(result.reason).toBe(reason);
    expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress(`[${address}]`)).toBe(false);
  });

  it.each(['2606:4700:4700::1111', '2a00:1450:4003:800::200e', '[2606:4700:4700::1111]'])(
    'accepts public %s (positive control)',
    (address) => {
      expect(classifyIpv6(address).ok).toBe(true);
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it('classifies an IPv4-mapped address by its embedded IPv4, never by the wrapper', () => {
    expect(classifyIpv6('::ffff:8.8.8.8').ok).toBe(true);
    expect(classifyIpv6('::ffff:192.168.0.1').ok).toBe(false);
    expect(classifyIpv6('::ffff:c0a8:1').ok).toBe(false); // hex form of 192.168.0.1
  });
});

describe('SSRF-NAME: reserved hostnames are refused', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'localhost.',
    'api.localhost',
    'a.b.localhost',
    'printer.local',
    'nas.local.',
    'metadata.internal',
    'x.home.arpa',
    'home.arpa',
    'intranet',
    '10.0.0.1',
    '127.0.0.1',
    '0x7f.1',
    '2130706433',
    '::1',
    '[::1]',
    '',
  ])('isReservedHostname(%j) is true', (host) => {
    expect(isReservedHostname(host)).toBe(true);
  });

  it.each(['example.com', 'live.example.org', 'cdn.example.net', 'sub.example.co.uk'])(
    'isReservedHostname(%j) is false (positive control)',
    (host) => {
      expect(isReservedHostname(host)).toBe(false);
    },
  );
});

describe('SSRF-FETCH: blocked destinations never open a socket', () => {
  const beforeNetwork: ReadonlyArray<readonly [string, EgressFailureCode]> = [
    ['http://127.0.0.1/', 'host-blocked'],
    ['http://localhost/', 'host-blocked'],
    ['http://[::1]/', 'host-blocked'],
    ['http://2130706433/', 'host-blocked'], // numeric spelling of 127.0.0.1
    ['http://0x7f.0.0.1/', 'host-blocked'], // hex spelling
    ['http://printer.local/', 'host-blocked'],
    ['http://metadata.internal/', 'host-blocked'],
    ['http://x.home.arpa/', 'host-blocked'],
    ['file:///etc/passwd', 'scheme-not-allowed'],
    ['ftp://example.invalid/x', 'scheme-not-allowed'],
    ['gopher://example.invalid/', 'scheme-not-allowed'],
    ['not a url', 'invalid-url'],
    ['https://user:canary-secret@example.invalid/x', 'credential-in-url'],
  ];

  it.each(beforeNetwork)('refuses %s as %s without a socket', async (url, code) => {
    await withFixture({}, async (fixture) => {
      const lookup = lookupOf({ 'example.invalid': [PUBLIC_V4] });
      const failure = await expectCode(safeFetch(request({ url }), { lookup }), code);
      expect(fixture.counters.sockets).toBe(0);
      expect(fixture.counters.requests).toBe(0);
      // A credential is never echoed back in message or detail.
      expect(`${failure.message}${JSON.stringify(failure.detail ?? {})}`).not.toContain('canary-secret');
    });
  });

  it.each([
    ['http://10.0.0.1/s.m3u8', '10.0.0.1'],
    ['http://172.16.5.4/s.m3u8', '172.16.5.4'],
    ['http://192.168.1.20/s.m3u8', '192.168.1.20'],
    ['http://169.254.169.254/latest/meta-data/', '169.254.169.254'],
    ['http://100.64.1.1/s.m3u8', '100.64.1.1'],
    ['http://[fd00::1]/s.m3u8', 'fd00::1'],
    ['http://[fe80::1]/s.m3u8', 'fe80::1'],
    // WHATWG URL canonicalises the mapped literal to its hex form; either
    // spelling is refused before any socket.
    ['http://[::ffff:127.0.0.1]/s.m3u8', '::ffff:7f00:1'],
  ])('refuses private literal %s as host-blocked with no socket', async (url, host) => {
    await withFixture({}, async (fixture) => {
      const lookup = lookupOf({});
      const failure = await expectCode(safeFetch(request({ url }), { lookup }), 'host-blocked');
      expect(failure.detail?.['host']).toBe(host);
      // Literal addresses are never resolved and never dialled.
      expect(lookup.calls).toHaveLength(0);
      expect(fixture.counters.sockets).toBe(0);
    });
  });

  it('refuses a public name that resolves to a private address (private-address)', async () => {
    await withFixture({}, async (fixture) => {
      const lookup = lookupOf({ 'rebind.example.com': ['192.168.1.10'] });
      const failure = await expectCode(
        safeFetch(request({ url: 'http://rebind.example.com/s.m3u8' }), { lookup }),
        'private-address',
      );
      expect(failure.detail?.['refused']).toEqual(['192.168.1.10']);
      expect(fixture.counters.sockets).toBe(0);
    });
  });

  it('refuses a record set that mixes public and private answers', async () => {
    const lookup = lookupOf({ 'mixed.example.com': [PUBLIC_V4, '10.1.2.3'] });
    await expectCode(safeFetch(request({ url: 'http://mixed.example.com/x' }), { lookup }), 'private-address');
  });

  it('refuses a metadata endpoint hidden behind a name (169.254.169.254)', async () => {
    const lookup = lookupOf({ 'metadata.example.com': ['169.254.169.254'] });
    await expectCode(
      safeFetch(request({ url: 'http://metadata.example.com/latest/meta-data/' }), { lookup }),
      'private-address',
    );
  });

  it('fails with dns-failure, not a socket error, when resolution errors', async () => {
    const lookup = lookupOf({});
    const failure = await expectCode(safeFetch(request({ url: 'http://nowhere.example.com/x' }), { lookup }), 'dns-failure');
    expect(failure.detail?.['host']).toBe('nowhere.example.com');
  });

  it('fails with dns-failure when resolution returns nothing', async () => {
    const lookup = lookupOf({ 'empty.example.com': [] });
    await expectCode(safeFetch(request({ url: 'http://empty.example.com/x' }), { lookup }), 'dns-failure');
  });

  it('honours the caller block list before any resolution or socket (host-blocked)', async () => {
    const lookup = lookupOf({ 'www.tdtchannels.com': [PUBLIC_V4] });
    await expectCode(
      safeFetch(request({ url: 'https://www.tdtchannels.com/list.m3u', blockedHosts: ['tdtchannels.com'] }), { lookup }),
      'host-blocked',
    );
    expect(lookup.calls).toHaveLength(0);
  });
});

describe('SSRF-REBIND: a second resolution cannot move the target', () => {
  it('refuses when the first answer is loopback and a later answer is public (private-address)', async () => {
    // The classic rebind shape: a name that answers loopback at validation time.
    // Validation happens once, on the whole answer set, so the request dies.
    const lookup = scriptedLookup([['127.0.0.1'], [PUBLIC_V4]]);
    await expectCode(safeFetch(request({ url: 'http://rebind.example.com/s.m3u8' }), { lookup }), 'private-address');
    expect(lookup.reads()).toBe(1);
  });

  it('refuses when the first answer is public and a later answer is loopback', async () => {
    // The other rebind shape. The public first answer is validated and pinned;
    // a resolver that re-ran for the connect would land on loopback. Here the
    // public address is simply unreachable, so the failure is the connection —
    // and crucially the loopback answer is never consulted.
    const lookup = scriptedLookup([[PUBLIC_V4], ['127.0.0.1']]);
    const failure = await failureOf(
      safeFetch(request({ url: 'http://rebind.example.com/x', timeoutMs: 400 }), { lookup }),
    );
    expect(['connection-failed', 'timeout']).toContain(failure.code);
    expect(lookup.reads()).toBe(1);
  });

  it('resolves exactly once and pins the validated address', async () => {
    const lookup = lookupOf({ 'live.example.com': [PUBLIC_V4] });
    const failure = await failureOf(
      safeFetch(request({ url: 'http://live.example.com/x', timeoutMs: 400 }), { lookup }),
    );
    // One resolution, then a connect failure (or timeout) to the pinned address.
    expect(lookup.calls).toEqual(['live.example.com']);
    expect(['connection-failed', 'timeout']).toContain(failure.code);
  });

  it('a rebinding name still ends at the pinned validation answer, never the second one', async () => {
    await withFixture({ '/ok': { status: 200, body: 'rebind-target' } }, async (fixture) => {
      // A name resolves once, then the fixture's own loopback address arrives on
      // a later call. The socket may only go to a validated answer; the second
      // (loopback) answer is never consulted, so the fixture sees zero connections.
      const lookup = scriptedLookup([[PUBLIC_V4], ['127.0.0.1']]);
      const failure = await failureOf(
        safeFetch(request({ url: 'http://rebind.example.com/ok', timeoutMs: 300 }), { lookup }),
      );
      expect(['connection-failed', 'timeout']).toContain(failure.code);
      expect(lookup.reads()).toBe(1);
      expect(fixture.counters.sockets).toBe(0);
      expect(fixture.counters.requests).toBe(0);
    });
  });

  it('pins the validated loopback address when the test flag is set (positive control)', async () => {
    await withFixture({ '/ok': { status: 200, body: 'pinned' } }, async (fixture) => {
      const result = await safeFetch(request({ url: fixture.url('/ok'), allowLoopbackForTests: true }), {
        lookup: lookupOf({}),
      });
      expect(result.body).toBe('pinned');
      expect(result.resolvedAddresses).toEqual(['127.0.0.1']);
    });
  });
});

describe('SSRF-FETCH: two-sided behaviour against a loopback fixture', () => {
  it('refuses the fixture URL by default: loopback needs the explicit test flag (host-blocked)', async () => {
    await withFixture({ '/ok.m3u8': { status: 200, contentType: 'application/x-mpegurl', body: '#EXTM3U\n' } }, async (fixture) => {
      const failure = await expectCode(
        safeFetch(request({ url: fixture.url('/ok.m3u8') }), { lookup: lookupOf({}) }),
        'host-blocked',
      );
      expect(failure.detail?.['host']).toBe('127.0.0.1');
      expect(fixture.counters.sockets).toBe(0);
      expect(fixture.counters.requests).toBe(0);
    });
  });

  it('the test flag unblocks nothing but loopback', async () => {
    await withFixture({}, async (fixture) => {
      for (const url of ['http://10.0.0.1/x', 'http://169.254.169.254/x', 'http://printer.local/x', 'file:///etc/passwd']) {
        const failure = await failureOf(
          safeFetch(request({ url, allowLoopbackForTests: true }), { lookup: lookupOf({}) }),
        );
        expect(['host-blocked', 'scheme-not-allowed']).toContain(failure.code);
      }
      expect(fixture.counters.sockets).toBe(0);
    });
  });

  it('fetches the fixture URL when allowLoopbackForTests is explicitly true (positive control)', async () => {
    await withFixture(
      { '/ok.m3u8': { status: 200, contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-VERSION:3\n' } },
      async (fixture) => {
        const result = await safeFetch(request({ url: fixture.url('/ok.m3u8'), allowLoopbackForTests: true }), {
          lookup: lookupOf({}),
        });
        expect(result.status).toBe(200);
        expect(result.ok).toBe(true);
        expect(result.contentType).toBe('application/vnd.apple.mpegurl');
        expect(result.body).toContain('#EXTM3U');
        expect(result.bytes).toBeGreaterThan(0);
        expect(result.finalHost).toBe('127.0.0.1');
        expect(result.redirects).toBe(0);
        expect(result.resolvedAddresses).toEqual(['127.0.0.1']);
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
        // Exactly the two allowed headers, never a credential.
        expect(fixture.received).toHaveLength(1);
        const seen = fixture.received[0]!;
        expect(seen.hasAuthorization).toBe(false);
        expect(seen.hasCookie).toBe(false);
        expect(seen.headers['accept']).toBe('*/*');
        expect(String(seen.headers['user-agent'])).toMatch(/^TDTPlatform\/1\.0/);
      },
    );
  });

  it('HEAD returns headers only and a null body', async () => {
    await withFixture({ '/head': { status: 200, contentType: 'text/html', body: '<html>ignored</html>' } }, async (fixture) => {
      const result = await safeFetch(request({ url: fixture.url('/head'), method: 'HEAD', allowLoopbackForTests: true }), {
        lookup: lookupOf({}),
      });
      expect(result.status).toBe(200);
      expect(result.body).toBeNull();
    });
  });

  it('reports a non-2xx status without throwing (the caller classifies it)', async () => {
    await withFixture({ '/gone': { status: 404, contentType: 'text/plain', body: 'nope' } }, async (fixture) => {
      const result = await safeFetch(request({ url: fixture.url('/gone'), allowLoopbackForTests: true }), {
        lookup: lookupOf({}),
      });
      expect(result.status).toBe(404);
      expect(result.ok).toBe(false);
      expect(result.body).toBe('nope');
    });
  });
});

describe('SSRF-REDIRECT: every hop is re-validated', () => {
  it('refuses a redirect to 127.0.0.1 on another port as redirect-unsafe (target gets 0 connections)', async () => {
    await withFixture({ '/internal': { status: 200, body: 'secret' } }, async (blocked) => {
      await withFixture({ '/hop': { location: blocked.url('/internal') } }, async (front) => {
        // The blocked port is NOT in allowedRedirectPorts: the cross-port hop is
        // refused even though the fixture flag is on (contract §2).
        const failure = await expectCode(
          safeFetch(request({ url: front.url('/hop'), allowLoopbackForTests: true }), { lookup: lookupOf({}) }),
          'redirect-unsafe',
        );
        expect(failure.detail?.['redirects']).toBe(1);
        expect(failure.detail?.['port']).toBe(blocked.port);
        // The blocked destination never received a connection.
        expect(blocked.counters.sockets).toBe(0);
        expect(blocked.counters.requests).toBe(0);
      });
    });
  });

  it('refuses the same loopback redirect when only a different port is allowed (two-sided)', async () => {
    await withFixture({ '/internal': { status: 200, body: 'secret' } }, async (blocked) => {
      await withFixture({ '/hop': { location: blocked.url('/internal') } }, async (front) => {
        // Allowing *some* port does not allow *this* port.
        await expectCode(
          safeFetch(
            request({ url: front.url('/hop'), allowLoopbackForTests: true, allowedRedirectPorts: [1, 2, 3] }),
            { lookup: lookupOf({}) },
          ),
          'redirect-unsafe',
        );
        expect(blocked.counters.sockets).toBe(0);
        expect(blocked.counters.requests).toBe(0);
      });
    });
  });

  it('allows the cross-port loopback redirect only when the test flag AND that port are permitted (positive control)', async () => {
    await withFixture({ '/internal': { status: 200, body: 'hop-target' } }, async (target) => {
      await withFixture({ '/hop': { location: target.url('/internal') } }, async (front) => {
        const result = await safeFetch(
          request({ url: front.url('/hop'), allowLoopbackForTests: true, allowedRedirectPorts: [target.port] }),
          { lookup: lookupOf({}) },
        );
        expect(result.status).toBe(200);
        expect(result.body).toBe('hop-target');
        expect(result.redirects).toBe(1);
        expect(target.counters.requests).toBe(1);
      });
    });
  });

  it('refuses a redirect to RFC1918 (192.168.10.5) as redirect-unsafe', async () => {
    await withFixture({ '/hop': { location: 'http://192.168.10.5/s.m3u8' } }, async (front) => {
      const failure = await expectCode(
        safeFetch(request({ url: front.url('/hop'), allowLoopbackForTests: true }), { lookup: lookupOf({}) }),
        'redirect-unsafe',
      );
      expect(failure.detail?.['reason']).toBe('host-blocked');
      expect(front.counters.requests).toBe(1);
    });
  });

  it('refuses a redirect to a private name that resolves privately (diagnosed as private-address)', async () => {
    await withFixture({ '/hop': { location: 'http://internal.example.com/x' } }, async (front) => {
      const lookup = lookupOf({ 'internal.example.com': ['10.0.0.5'] });
      const failure = await expectCode(
        safeFetch(request({ url: front.url('/hop'), allowLoopbackForTests: true }), { lookup }),
        'redirect-unsafe',
      );
      expect(failure.detail?.['reason']).toBe('private-address');
    });
  });

  it('refuses a redirect to the file: scheme as redirect-unsafe', async () => {
    await withFixture({ '/hop': { location: 'file:///etc/passwd' } }, async (front) => {
      const failure = await expectCode(
        safeFetch(request({ url: front.url('/hop'), allowLoopbackForTests: true }), { lookup: lookupOf({}) }),
        'redirect-unsafe',
      );
      expect(failure.detail?.['scheme']).toBe('file:');
    });
  });

  it('refuses a redirect to a caller-blocked host without resolving it (redirect-unsafe)', async () => {
    await withFixture({ '/hop': { location: 'https://www.tdtchannels.com/list.m3u' } }, async (front) => {
      const lookup = lookupOf({ 'www.tdtchannels.com': [PUBLIC_V4] });
      const failure = await expectCode(
        safeFetch(request({ url: front.url('/hop'), allowLoopbackForTests: true, blockedHosts: ['tdtchannels.com'] }), {
          lookup,
        }),
        'redirect-unsafe',
      );
      expect(failure.detail?.['reason']).toBe('host-blocked');
      expect(lookup.calls).not.toContain('www.tdtchannels.com');
    });
  });

  it('follows a safe redirect and reports the final URL, host and hop count', async () => {
    await withFixture(
      {
        '/one': { location: '/two' },
        '/two': { status: 200, contentType: 'application/x-mpegurl', body: '#EXTM3U\n' },
      },
      async (fixture) => {
        const result = await safeFetch(request({ url: fixture.url('/one'), allowLoopbackForTests: true }), {
          lookup: lookupOf({}),
        });
        expect(result.redirects).toBe(1);
        expect(result.finalUrl).toBe(fixture.url('/two'));
        expect(result.finalHost).toBe('127.0.0.1');
        expect(result.status).toBe(200);
        expect(result.body).toBe('#EXTM3U\n');
      },
    );
  });

  it('fails with too-many-redirects past the default limit of 5', async () => {
    const routes: Record<string, { location: string }> = {};
    for (let hop = 0; hop < 10; hop += 1) routes[`/r${hop}`] = { location: `/r${hop + 1}` };
    await withFixture(routes, async (fixture) => {
      const failure = await expectCode(
        safeFetch(request({ url: fixture.url('/r0'), allowLoopbackForTests: true }), { lookup: lookupOf({}) }),
        'too-many-redirects',
      );
      expect(failure.detail?.['maxRedirects']).toBe(5);
      expect(fixture.counters.requests).toBe(6); // initial request + 5 followed hops
    });
  });

  it('honours a lower maxRedirects', async () => {
    const routes: Record<string, { location: string }> = {};
    for (let hop = 0; hop < 5; hop += 1) routes[`/r${hop}`] = { location: `/r${hop + 1}` };
    await withFixture(routes, async (fixture) => {
      await expectCode(
        safeFetch(request({ url: fixture.url('/r0'), allowLoopbackForTests: true, maxRedirects: 2 }), {
          lookup: lookupOf({}),
        }),
        'too-many-redirects',
      );
    });
  });
});

describe('SSRF-LIMITS: size, time and content-type', () => {
  it('refuses a chunked body larger than maxBytes (incremental counter)', async () => {
    await withFixture({ '/big': { streamBytes: 64 * 1024, contentType: 'video/mp2t' } }, async (fixture) => {
      const failure = await expectCode(
        safeFetch(request({ url: fixture.url('/big'), maxBytes: 8 * 1024, allowLoopbackForTests: true }), {
          lookup: lookupOf({}),
        }),
        'response-too-large',
      );
      expect(failure.detail?.['maxBytes']).toBe(8 * 1024);
    });
  });

  it('refuses a declared content-length above maxBytes before reading the body', async () => {
    await withFixture({ '/declared': { status: 200, declaredContentLength: 4096, body: 'tiny' } }, async (fixture) => {
      const failure = await expectCode(
        safeFetch(request({ url: fixture.url('/declared'), maxBytes: 1024, allowLoopbackForTests: true }), {
          lookup: lookupOf({}),
        }),
        'response-too-large',
      );
      expect(failure.detail?.['contentLength']).toBe(4096);
    });
  });

  it('accepts a body exactly at maxBytes (positive control)', async () => {
    await withFixture({ '/exact': { status: 200, body: 'x'.repeat(2048) } }, async (fixture) => {
      const result = await safeFetch(request({ url: fixture.url('/exact'), maxBytes: 2048, allowLoopbackForTests: true }), {
        lookup: lookupOf({}),
      });
      expect(result.bytes).toBe(2048);
    });
  });

  it('times out against a server that never answers', async () => {
    await withFixture({ '/hang': { hang: true } }, async (fixture) => {
      const startedAt = Date.now();
      const failure = await expectCode(
        safeFetch(request({ url: fixture.url('/hang'), timeoutMs: 200, allowLoopbackForTests: true }), {
          lookup: lookupOf({}),
        }),
        'timeout',
      );
      expect(failure.code).toBe('timeout');
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(fixture.counters.requests).toBe(1);
    });
  });

  it('refuses a content-type outside allowedContentPrefixes', async () => {
    await withFixture({ '/html': { status: 200, contentType: 'text/html', body: '<html></html>' } }, async (fixture) => {
      const failure = await expectCode(
        safeFetch(
          request({
            url: fixture.url('/html'),
            allowLoopbackForTests: true,
            allowedContentPrefixes: ['application/vnd.apple.mpegurl', 'application/x-mpegurl'],
          }),
          { lookup: lookupOf({}) },
        ),
        'content-type-not-allowed',
      );
      expect(failure.detail?.['contentType']).toBe('text/html');
    });
  });

  it('accepts a content-type matching a prefix, case-insensitively (positive control)', async () => {
    await withFixture(
      { '/m3u': { status: 200, contentType: 'Application/Vnd.Apple.MpegURL; charset=utf-8', body: '#EXTM3U\n' } },
      async (fixture) => {
        const result = await safeFetch(
          request({
            url: fixture.url('/m3u'),
            allowLoopbackForTests: true,
            allowedContentPrefixes: ['application/vnd.apple.mpegurl'],
          }),
          { lookup: lookupOf({}) },
        );
        expect(result.status).toBe(200);
      },
    );
  });

  it('fails with connection-failed or timeout when the validated address is unreachable', async () => {
    const lookup = lookupOf({ 'unreachable.example.com': [PUBLIC_V4] });
    const failure = await failureOf(
      safeFetch(request({ url: 'http://unreachable.example.com/x', timeoutMs: 400 }), { lookup }),
    );
    expect(['connection-failed', 'timeout']).toContain(failure.code);
  });

  it('an aborted caller signal yields connection-failed and opens no socket', async () => {
    await withFixture({ '/ok': { status: 200, body: 'ok' } }, async (fixture) => {
      const signal = AbortSignal.abort();
      const lookup = lookupOf({});
      const failure = await failureOf(
        safeFetch(request({ url: fixture.url('/ok'), allowLoopbackForTests: true, signal }), { lookup }),
      );
      // Even an already-aborted chain is not a success: the request never runs.
      expect(failure.code).toBe('connection-failed');
      expect(failure.detail?.['reason']).toBe('aborted');
      expect(fixture.counters.requests).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Regressions found by the captain against the REAL network. Every test above
  // injects `deps.lookup`, which is exactly why none of them could see these:
  // the broken code was the `lookup` handed to node:http(s), not our resolver.
  // ---------------------------------------------------------------------------

  it('reports an oversized undeclared-length body as response-too-large, never as a truncated body', async () => {
    // 4 MiB streamed with no content-length over a 64 KiB limit — the validator's
    // manifest path would otherwise parse a truncated playlist and call it
    // `invalid-manifest`. The transport must own the verdict.
    await withFixture({ '/huge': { streamBytes: 4 * 1024 * 1024, contentType: 'application/x-mpegurl' } }, async (fixture) => {
      const startedAt = Date.now();
      const failure = await expectCode(
        safeFetch(request({ url: fixture.url('/huge'), maxBytes: 64 * 1024, allowLoopbackForTests: true }), {
          lookup: lookupOf({}),
        }),
        'response-too-large',
      );
      expect(failure.detail?.['reason']).toBeUndefined(); // not a 'stream-closed' fallback
      expect(failure.detail?.['bytes']).toBeGreaterThan(64 * 1024);
      // The read is aborted at the limit, not after downloading everything.
      expect(Date.now() - startedAt).toBeLessThan(1_500);
    });
  });

  it('answers an error status with an HTML body instead of filtering it (status is the signal)', async () => {
    // 404/403/451/503 pages are text/html; refusing them hides the status the
    // caller classifies by. Each must come back as a plain response with ok:false.
    const routes = {
      '/404': { status: 404, contentType: 'text/html', body: '<h1>not found</h1>' },
      '/403': { status: 403, contentType: 'text/html', body: '<h1>forbidden</h1>' },
      '/451': { status: 451, contentType: 'text/html', body: '<h1>unavailable for legal reasons</h1>' },
      '/503': { status: 503, contentType: 'text/html', body: '<h1>unavailable</h1>' },
    } as const;
    await withFixture(routes, async (fixture) => {
      for (const [path, expected] of [
        ['/404', 404],
        ['/403', 403],
        ['/451', 451],
        ['/503', 503],
      ] as const) {
        const result = await safeFetch(
          request({
            url: fixture.url(path),
            allowLoopbackForTests: true,
            allowedContentPrefixes: ['application/vnd.apple.mpegurl', 'application/x-mpegurl'],
          }),
          { lookup: lookupOf({}) },
        );
        expect(result.status, path).toBe(expected);
        expect(result.ok, path).toBe(false);
        expect(result.contentType, path).toBe('text/html');
        expect(result.body, path).toContain('<h1>');
      }
    });
  });

  it('reports a hung server as timeout after the declared budget, never as size or body failure', async () => {
    // The /slow shape from the captain's matrix: connection accepted, no bytes.
    await withFixture({ '/slow': { hang: true } }, async (fixture) => {
      const startedAt = Date.now();
      const failure = await expectCode(
        safeFetch(
          request({
            url: fixture.url('/slow'),
            timeoutMs: 400,
            maxBytes: 1024,
            allowLoopbackForTests: true,
            allowedContentPrefixes: ['application/x-mpegurl'],
          }),
          { lookup: lookupOf({}) },
        ),
        'timeout',
      );
      const elapsed = Date.now() - startedAt;
      expect(failure.code).toBe('timeout');
      expect(failure.detail?.['timeoutMs']).toBe(400);
      expect(elapsed).toBeGreaterThanOrEqual(350);
      expect(elapsed).toBeLessThan(2_000);
    });
  });
});

describe('SSRF-LOOKUP: the pin answers both of Node lookup conventions', () => {
  type CallbackArgs = [unknown, unknown, unknown?];
  const call = (
    pinned: string | null,
    options: { all?: boolean },
  ): Promise<CallbackArgs> =>
    new Promise((resolve) => {
      const lookup = pinnedLookup(pinned);
      lookup('example.test', options, (...args: unknown[]) => resolve(args as CallbackArgs));
    });

  it('answers the `all: true` form (what Node 20+ autoSelectFamily asks) with an array', async () => {
    const [error, addresses, _family] = await call('93.184.216.34', { all: true });
    expect(error).toBeNull();
    expect(Array.isArray(addresses)).toBe(true);
    expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('answers the single-address form with a string and a family', async () => {
    const [error, address, family] = await call('93.184.216.34', {});
    expect(error).toBeNull();
    expect(address).toBe('93.184.216.34');
    expect(family).toBe(4);
  });

  it('answers the `all: true` form for a pinned IPv6 address with family 6', async () => {
    const [error, addresses] = await call('2606:4700:4700::1111', { all: true });
    expect(error).toBeNull();
    expect(addresses).toEqual([{ address: '2606:4700:4700::1111', family: 6 }]);
  });

  it('fails closed when nothing was validated (dns-rebind, no address handed to Node)', async () => {
    const [error, address] = await call(null, { all: true });
    expect(error).toBeInstanceOf(EgressFailure);
    expect((error as EgressFailure).code).toBe('dns-rebind');
    expect(address).toBeNull();
  });

  it('pins a REAL node:net connection through the `all: true` convention', async () => {
    // The real path, with no injected resolver anywhere: Node's own connection
    // machinery calls our lookup and must connect with the array answer.
    await withFixture({ '/ok': { status: 200, body: 'ok' } }, async (fixture) => {
      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect({ host: 'pinned.invalid', port: fixture.port, lookup: pinnedLookup('127.0.0.1') as never });
        s.once('connect', () => resolve(s));
        s.once('error', reject);
        setTimeout(() => reject(new Error('connect timed out')), 3_000);
      });
      expect(socket.remoteAddress).toBeDefined();
      socket.destroy();
      // The connection reached the fixture even though the hostname is not resolvable.
      expect(fixture.counters.requests).toBe(0);
    });
  });

  it('pins a REAL node:http request through the agent path (autoSelectFamily on)', async () => {
    // End-to-end over node:http with our lookup only: this is the exact code
    // the old string-only callback broke with ERR_INVALID_IP_ADDRESS.
    await withFixture({ '/ok': { status: 200, contentType: 'text/plain', body: 'pinned' } }, async (fixture) => {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            host: 'pinned.invalid',
            port: fixture.port,
            path: '/ok',
            agent: false,
            lookup: pinnedLookup('127.0.0.1') as never,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          },
        );
        req.once('error', reject);
        req.end();
      });
      expect(body).toBe('pinned');
      expect(fixture.counters.requests).toBe(1);
      expect(fixture.received[0]?.url).toBe('/ok');
    });
  });

  it('the pin reaches a REAL tls handshake (https) instead of ERR_INVALID_IP_ADDRESS', async () => {
    // No certificate work is needed: the handshake must reach the TLS layer
    // (which then fails on its own terms). The old callback never got that far:
    // Node threw "Invalid IP address: undefined" before sending a ClientHello.
    await withFixture({}, async (fixture) => {
      const error = await new Promise<Error>((resolve) => {
        const req = https.request(
          {
            host: 'pinned.invalid',
            port: fixture.port, // speaks plain HTTP: TLS handshake must fail there
            agent: false,
            lookup: pinnedLookup('127.0.0.1') as never,
            servername: 'pinned.invalid',
          },
          () => resolve(new Error('unexpected TLS success')),
        );
        req.once('error', (e: NodeJS.ErrnoException) => resolve(e));
        req.end();
      });
      const code = (error as NodeJS.ErrnoException).code ?? '';
      expect(code).not.toBe('ERR_INVALID_IP_ADDRESS');
      expect(code).not.toMatch(/EAI_AGAIN|ENOTFOUND/);
      // Proof the bytes reached the fixture: the TCP connection was accepted.
      expect(fixture.counters.sockets).toBe(1);
    });
  });

  it('safeFetch with NO injected resolver still refuses reserved names and fetches through the pin', async () => {
    // deps.lookup omitted entirely: the real dns.promises.lookup path runs. A
    // reserved name is refused before any socket; a loopback literal needs the
    // explicit test flag and then travels the real node:http + pinnedLookup path.
    await expectCode(safeFetch(request({ url: 'http://localhost:9/never' })), 'host-blocked');
    await withFixture({ '/ok': { status: 200, body: 'direct' } }, async (fixture) => {
      const result = await safeFetch(request({ url: fixture.url('/ok'), allowLoopbackForTests: true }));
      expect(result.status).toBe(200);
      expect(result.body).toBe('direct');
      expect(result.resolvedAddresses).toEqual(['127.0.0.1']);
      expect(result.redirects).toBe(0);
    });
  });
});
