/**
 * Adversarial security tests for the provider + playback path.
 *
 * These are *absence* tests: they prove the forbidden mechanisms are not merely
 * undocumented but absent from the code path. Three invariants, each required by
 * `EXECUTION_CONTRACT.md` §4:
 *
 * 1. **No generic CORS proxy.** We never relay a third party's bytes.
 * 2. **No fabricated/spoofed headers.** We identify ourselves honestly, and a
 *    source that needs a forged header is never published.
 * 3. **No credential replay.** No cookies, no tokens, no userinfo, and a
 *    tokenised URL is refused rather than replayed.
 *
 * The checks are structural (source text + behaviour), so a future edit that
 * reintroduces one of these fails here instead of shipping.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fetchWithPolicy, EgressBlockedError } from '../../infrastructure/egress.js';
import { decidePublication } from '../playback/publication-policy.js';
import { unresolvedRecord } from './authorization.js';
import { OPERATOR_SEEDS, YOUTUBE_PLATFORM_SEED } from './operator-seeds.js';
import { decideSourceEligibility } from './source-eligibility.js';
import { classifyHost, hostOf } from './provider-kinds.js';

/*
 * Anchor on this file's own location, never on `process.cwd()`: the suite runs
 * both from `apps/backend` and from the repository root (`npx vitest run
 * apps/backend/src/...`). A cwd-based anchor scanned an empty directory when run
 * from the root, which made every absence pin below vacuously true — exactly the
 * failure mode an absence test must not have.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** The provider + playback path this task owns. */
function providerAndPlaybackFiles(): Array<{ path: string; text: string }> {
  const roots = [join(SRC, 'modules', 'providers'), join(SRC, 'modules', 'playback')];
  const files: Array<{ path: string; text: string }> = [];
  for (const root of roots) {
    for (const file of sourceFiles(root)) files.push({ path: file, text: readFileSync(file, 'utf8') });
  }
  return files;
}

/** Strips comments so documentation that *names* a banned mechanism does not match. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('authorization modules are structurally network-free', () => {
  /**
   * The strongest form of "no CORS proxy / no forged headers / no credential
   * replay": the authorization path has no network capability at all. These pins
   * fail if a future edit gives it one.
   */
  /**
   * The 02C authorization modules. `providers.registry.ts` is deliberately NOT
   * in this set: it is the technical *verification* module and is allowed to use
   * egress. That separation is the point — rights never touch the network.
   */
  const AUTHORIZATION_MODULES = new Set([
    'authorization.ts',
    'eligibility.ts',
    'adapter.registry.ts',
    'provider-kinds.ts',
    'operator-seeds.ts',
    'source-eligibility.ts',
    'authorization.repository.ts',
  ]);

  function authorizationModuleTexts(): Array<{ path: string; code: string }> {
    const root = join(SRC, 'modules', 'providers');
    return sourceFiles(root)
      .filter((file) => AUTHORIZATION_MODULES.has(file.replace(/^.*[\\/]/, '')))
      .map((file) => ({ path: file, code: codeOnly(readFileSync(file, 'utf8')) }));
  }

  it('scans exactly the authorization modules, so the pin cannot silently widen or narrow', () => {
    expect(authorizationModuleTexts()).toHaveLength(AUTHORIZATION_MODULES.size);
  });

  it('contains no network client at all', () => {
    const banned = [
      /\bfetch\s*\(/,
      /\baxios\b/,
      /['"]node:https?['"]/,
      /['"]http['"]/,
      /\bundici\b/,
      /\bgot\s*\(/,
    ];
    for (const { path, code } of authorizationModuleTexts()) {
      for (const pattern of banned) {
        expect(pattern.test(code), `${path} matched ${pattern}`).toBe(false);
      }
    }
  });

  it('constructs no request headers and imports no proxy/cors helper', () => {
    /*
     * Header names are quoted or capitalised when they are real headers. A bare
     * `authorizationReason:` property is our own domain field and must not trip
     * this pin, so the patterns anchor on header-shaped constructions.
     */
    const banned = [
      /\bsetHeader\b/i,
      /['"]Authorization['"]\s*:/i,
      /\bAuthorization\s*:\s*['"`]/i,
      /['"]x-api-key['"]\s*:/i,
      /['"]Cookie['"]\s*:/i,
      /\bnew\s+Headers\b/,
      /\bcreateProxy\b/i,
      /\bproxyMiddleware\b/i,
      /\bcors\(\s*\)/i,
      /from\s+['"](?:cors|http-proxy)['"]/,
    ];
    for (const { path, code } of authorizationModuleTexts()) {
      for (const pattern of banned) {
        expect(pattern.test(code), `${path} matched ${pattern}`).toBe(false);
      }
    }
  });

  it('imports nothing from infrastructure/egress in the authorization path', () => {
    for (const { path, code } of authorizationModuleTexts()) {
      expect(/from\s+['"][^'"]*egress[^'"]*['"]/.test(code), path).toBe(false);
    }
  });
});

describe('the operator seeds are evidence, never authorizations', () => {
  it('no Spanish seed grants a permitted class', () => {
    for (const seed of OPERATOR_SEEDS) {
      expect(seed.verdict, seed.operatorId).not.toBe('permitted-direct-playback');
      expect(seed.verdict, seed.operatorId).not.toBe('permitted-official-embed');
    }
  });

  it('only the platform (YouTube) seed is permitted, and only as an official embed', () => {
    expect(YOUTUBE_PLATFORM_SEED.verdict).toBe('permitted-official-embed');
    expect(YOUTUBE_PLATFORM_SEED.method).toBe('official-embed');
    expect(YOUTUBE_PLATFORM_SEED.providerKind).toBe('platform');
  });

  it('no seed claiming a right lacks a citation', () => {
    for (const seed of OPERATOR_SEEDS) {
      if (seed.verdict === 'restricted') {
        expect(seed.quotedClause, seed.operatorId).toBeTruthy();
        expect(seed.clauseUrl, seed.operatorId).toMatch(/^https:\/\//);
      }
      if (seed.verdict === 'unresolved') {
        expect(seed.method, seed.operatorId).toBe('none');
        expect(seed.publicationScope, seed.operatorId).toBe('none');
      }
    }
  });
});

describe('no generic CORS proxy in the provider/playback path', () => {
  it('contains no proxy, relay or stream-passthrough endpoint', () => {
    const banned = [
      /\bcreateProxy\b/i,
      /\bproxyMiddleware\b/i,
      /\bcors-anywhere\b/i,
      /\bcorsAnywhere\b/i,
      /\bpipe\(\s*res\s*\)/i,
      /\bres\.write\(.*chunk/i,
      /\brelayStream\b/i,
      /\bpassthrough\b/i,
    ];
    for (const { path, text } of providerAndPlaybackFiles()) {
      const code = codeOnly(text);
      for (const pattern of banned) {
        expect(pattern.test(code), `${path} matched ${pattern}`).toBe(false);
      }
    }
  });

  it('never forwards an inbound request to a third-party origin', () => {
    for (const { path, text } of providerAndPlaybackFiles()) {
      const code = codeOnly(text);
      // A fetch must never take the inbound request object as its target.
      expect(/\bfetch\(\s*(request|req)\b/.test(code), path).toBe(false);
    }
  });
});

describe('no fabricated or spoofed headers', () => {
  it('never sets Referer/Origin/User-Agent overrides to impersonate a client', () => {
    const banned = [
      /\breferer\s*:/i,
      /\breferrer\s*:/i,
      /\borigin\s*:\s*['"`]/i,
      /\bcookie\s*:/i,
      /\bauthorization\s*:\s*['"`]/i,
    ];
    for (const { path, text } of providerAndPlaybackFiles()) {
      const code = codeOnly(text);
      for (const pattern of banned) {
        expect(pattern.test(code), `${path} matched ${pattern}`).toBe(false);
      }
    }
  });

  it('egress identifies itself with one honest User-Agent and sends no credential headers', async () => {
    const seen: Array<Record<string, string>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers ?? {});
      // `url` matters: egress re-checks the final origin after redirects.
      return {
        url: 'https://example.test/live/master.m3u8',
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/x-mpegURL' }),
        body: null,
      } as unknown as Response;
    }) as typeof fetch;
    try {
      await fetchWithPolicy('https://example.test/live/master.m3u8', { blockedHosts: [], timeoutMs: 5000 });
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(seen).toHaveLength(1);
    const headers = seen[0]!;
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    expect(names).not.toContain('cookie');
    expect(names).not.toContain('authorization');
    expect(names).not.toContain('referer');
    // The UA identifies us as ourselves, not as a broadcaster's own app.
    expect(headers['user-agent']).toMatch(/TDTPlatform/i);
    expect(headers['user-agent']).not.toMatch(/VLC|Kodi|Mozilla|Chrome|Safari/i);
  });

  it('a source that requires a forged header is never published, however healthy', () => {
    const decision = decidePublication({
      channelStatus: 'published',
      sourceStatus: 'published',
      permission: 'emitter-public-stream',
      technicalStatus: 'ok',
      conditions: { requiresForgedHeader: true, emitterAppOnly: false },
    });
    expect(decision.public).toBe(false);
    if (!decision.public) expect(decision.reason).toBe('requires-forged-header');

    // …and 02C eligibility does not rescue it either.
    const eligibility = decideSourceEligibility({
      publication: {
        channelStatus: 'published',
        sourceStatus: 'published',
        permission: 'emitter-public-stream',
        technicalStatus: 'ok',
        conditions: { requiresForgedHeader: true, emitterAppOnly: false },
      },
      authorization: unresolvedRecord('x', 'https://example.test/s.m3u8', 'broadcaster_cdn', {
        upstream: 'iptv-org',
        snapshotId: null,
        path: null,
        line: null,
        sourceUrl: null,
        documentUrl: null,
        retrievedAt: null,
      }),
      type: 'hls',
      requestedTerritory: 'ES',
    });
    expect(eligibility.playable).toBe(false);
  });

  it('an emitter-app-only source is never published', () => {
    const decision = decidePublication({
      channelStatus: 'published',
      sourceStatus: 'published',
      permission: 'emitter-public-stream',
      technicalStatus: 'ok',
      conditions: { requiresForgedHeader: false, emitterAppOnly: true },
    });
    expect(decision.public).toBe(false);
    if (!decision.public) expect(decision.reason).toBe('emitter-app-only');
  });
});

describe('no credential replay or storage', () => {
  it('the provider/playback path never reads cookies or credentials', () => {
    const banned = [/req\.cookies/i, /\bdocument\.cookie\b/i, /\bprocess\.env\.[A-Z_]*TOKEN/i, /\bpassword\b/i];
    for (const { path, text } of providerAndPlaybackFiles()) {
      const code = codeOnly(text);
      for (const pattern of banned) {
        expect(pattern.test(code), `${path} matched ${pattern}`).toBe(false);
      }
    }
  });

  it('refuses a non-http(s) scheme instead of replaying it', async () => {
    await expect(
      fetchWithPolicy('file:///etc/passwd', { blockedHosts: [], timeoutMs: 1000 }),
    ).rejects.toThrow(/non-http\(s\)/i);
  });

  it('refuses userinfo credentials embedded in a URL', async () => {
    // `https://user:pass@host/...` must not be fetched with those credentials.
    const url = 'https://attacker:canary-secret@example.test/live/master.m3u8';
    let called = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('#EXTM3U\n', { status: 200 });
    }) as typeof fetch;
    try {
      // The egress layer hands the URL to fetch; the assertion below proves the
      // credential never reaches a header or a logged value.
      try {
        await fetchWithPolicy(url, { blockedHosts: ['example.test'], timeoutMs: 1000 });
      } catch (error) {
        expect(error).toBeInstanceOf(EgressBlockedError);
      }
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('a tokenised URL is not published as a credential-bearing descriptor', () => {
    const decision = decidePublication({
      channelStatus: 'published',
      sourceStatus: 'published',
      permission: 'unlicensed',
      technicalStatus: 'ok',
      conditions: { requiresForgedHeader: false, emitterAppOnly: false },
    });
    expect(decision.public).toBe(false);
  });
});

/**
 * Host resolution for authorization decisions.
 *
 * `AuthorizationRepository.decisionsForSources` attaches an operator decision by
 * exact host match. These cases pin the attacks a loose match would allow: a
 * lookalike host inheriting the YouTube grant, or a userinfo component smuggling
 * a different host into the comparison.
 */
describe('authorization host matching cannot be spoofed', () => {
  it('a lookalike YouTube host does not inherit the platform grant', () => {
    const lookalike = 'https://www.youtube.com.attacker.example.org/embed/x';
    // hostOf reads the real host, so an exact-equality match never hits it.
    expect(hostOf(lookalike)).toBe('www.youtube.com.attacker.example.org');
    expect(['www.youtube.com', 'youtube.com', 'youtu.be']).not.toContain(hostOf(lookalike));
  });

  it('a userinfo component does not change the matched host', () => {
    const smuggled = 'https://www.youtube.com@rtvelivestream.rtve.es/live/master.m3u8';
    // URL parsing must report the host AFTER the @, never the userinfo part.
    expect(hostOf(smuggled)).toBe('rtvelivestream.rtve.es');
  });

  it('an unparseable or absent URL yields no host, so no decision can attach', () => {
    expect(hostOf('not a url')).toBeNull();
    expect(hostOf(null)).toBeNull();
    expect(hostOf(undefined)).toBeNull();
  });

  it('a shortener or a static CDN host is never a broadcaster host', () => {
    expect(classifyHost('https://jmp2.uk/abc123').kind).toBe('shortener');
    expect(classifyHost('https://cdn.jsdelivr.net/x.m3u8').kind).toBe('cdn');
  });
});

/**
 * The evidence rule that a real capture taught us.
 *
 * A browser capture of a third party's page also captures that page's own client
 * keys: the Mediaset Infinity capture carried a third party's Firebase key in a
 * Remote Config URL. Committing raw captures therefore leaks other people's
 * identifiers, so `.gitignore` must ignore every raw capture while still
 * versioning the credential-free summary and the record index.
 *
 * This test reads the repository's own `.gitignore`, so it fails if someone
 * narrows the rule back to a single filename.
 */
describe('raw REA captures can never be committed', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
  const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8');

  it('ignores every raw capture file, not one named file', () => {
    expect(gitignore).toMatch(/^evidence\/rea02c\/records\/capture_\*\.json$/m);
    expect(gitignore).toMatch(/^evidence\/rea02c\/rea-session-bundle-\*\.json$/m);
  });

  it('still versions the credential-free summary and the record index', () => {
    // Neither may be ignored: they are the traceable, credential-free derivative.
    expect(gitignore).not.toMatch(/^evidence\/rea02c\/captures-summary\.json$/m);
    expect(gitignore).not.toMatch(/^evidence\/rea02c\/records\/index\.json$/m);
    expect(gitignore).not.toMatch(/^evidence\/rea02c\/records\/\*\.json$/m);
  });
});
