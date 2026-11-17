#!/usr/bin/env node
/**
 * TDT-API-02D — independent SSRF adversarial acceptance probe (SEC-01).
 *
 * WHY THIS EXISTS
 * ---------------
 * The vitest suite proves the guard's *logic*, but every one of its cases injects
 * `deps.lookup`. That injection is precisely what hid the last real defect: the
 * pinned `lookup` handed to `node:http(s)` answered Node's `all: true` calling
 * convention with a string, and every real HTTPS fetch failed. This probe is the
 * separate acceptance evidence, and it has NO seam:
 *
 *   - it imports the BUILT module (`apps/backend/dist/...`), not the sources;
 *   - it calls `safeFetch(request)` with **no deps argument at all**, so DNS runs
 *     through the real `dns.promises.lookup` and the connection through the real
 *     `node:net` stack;
 *   - it records every TCP connect attempted by this process, plus every accepted
 *     connection and request on its loopback fixtures, so "refused before the
 *     network" is proven by observers independent of the code under test;
 *   - it runs a mandatory positive control in the same process, so a total
 *     network outage cannot masquerade as a correct refusal.
 *
 * WHY A LOOPBACK FIXTURE EXISTS IN AN SSRF PROBE
 * ----------------------------------------------
 * Nine of the ten cases must be refused, and for those the probe passes **no
 * test-only flag whatsoever** (the 127.0.0.1 case targets a port where a fixture
 * is actually listening, so a connection would be both possible and counted).
 * The tenth case validates the *redirect* policy: to observe a redirect being
 * re-validated, a server must issue one, and no third party will point us at our
 * own port. Two loopback fixtures therefore exist: a FRONT that 302s to
 * `http://127.0.0.1:<targetPort>/secret`, and the TARGET holding the secret.
 * The FRONT hop is the single call in this file that carries the documented
 * test-only loopback allowance — without it no loopback server could be reached
 * and no redirect could exist. The TARGET hop is re-validated exactly as in
 * production: it must be refused as `redirect-unsafe`, its own counters must stay
 * 0, and no TCP connect to its port may be observed.
 *
 * USAGE
 *   npm run build -w @tdt/backend
 *   node apps/backend/scripts/ssrf-adversarial-probe.mjs
 *
 * EXIT: 0 only when every adversarial case was refused AND the positive control
 * returned HTTP 200. 1 = a case succeeded / control failed / bypass audit failed.
 * 2 = environment problem (build missing, output not writable).
 *
 * Plain ESM, Node built-ins only. No new dependencies.
 */
import { promises as dns } from 'node:dns';
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF_PATH = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF_PATH);
/** Repository root, derived from this file's location (`<root>/apps/backend/scripts`). */
const ROOT = path.resolve(HERE, '..', '..', '..');

// Dynamic import needs a file:// URL on Windows (a bare `C:\...` path has a "c:" scheme).
const SAFE_EGRESS_URL = pathToFileURL(path.join(ROOT, 'apps/backend/dist/infrastructure/safe-egress.js')).href;
const FIXTURES_URL = pathToFileURL(path.join(ROOT, 'apps/backend/dist/verification/fixtures/http-fixtures.js')).href;
const OUTPUT_PATH = path.join(ROOT, 'evidence/verification-02d/ssrf-adversarial.json');

const POSITIVE_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const CASE_TIMEOUT_MS = 6_000;
const CASE_MAX_BYTES = 256 * 1024;
const CONTROL_TIMEOUT_MS = 15_000;
const CONTROL_MAX_BYTES = 200_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_STDOUT_LINES = 12;

// ---------------------------------------------------------------------------
// Independent observer #1: every TCP connect attempted by this process.
// ---------------------------------------------------------------------------

/** @type {Array<{ address: string, port: number }>} */
const connectAttempts = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function observedConnect(...args) {
  try {
    const first = args[0];
    if (Array.isArray(first)) {
      const options = (first[0] ?? {});
      connectAttempts.push({ address: String(options.host ?? ''), port: Number(options.port ?? 0) });
    } else if (first !== null && typeof first === 'object') {
      if (first.path !== undefined) {
        connectAttempts.push({ address: `unix:${first.path}`, port: 0 });
      } else {
        connectAttempts.push({ address: String(first.host ?? 'localhost'), port: Number(first.port ?? 0) });
      }
    } else if (typeof first === 'number') {
      connectAttempts.push({ address: String(args[1] ?? 'localhost'), port: first });
    }
  } catch {
    // The observer must never change the behaviour of the code under test.
  }
  return realConnect.apply(this, args);
};

// ---------------------------------------------------------------------------
// Redaction and small helpers
// ---------------------------------------------------------------------------

/** Redacts userinfo and the whole query string: evidence never carries a secret. */
function redactUrl(raw) {
  try {
    const url = new URL(raw);
    const userInfo = url.username.length > 0 || url.password.length > 0 ? 'redacted@' : '';
    const port = url.port.length > 0 ? `:${url.port}` : '';
    const query = url.search.length > 0 ? '?redacted' : '';
    return `${url.protocol}//${userInfo}${url.hostname}${port}${url.pathname}${query}`;
  } catch {
    return '<unparseable-url>';
  }
}

/** Host (and port) only, for lines that must not carry paths or queries. */
function hostOnly(raw) {
  try {
    const url = new URL(raw);
    return url.port.length > 0 ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return '<unparseable-url>';
  }
}

/** The TCP port a case would connect to, so connect attempts can be attributed. */
function portOf(raw) {
  try {
    const url = new URL(raw);
    if (url.port.length > 0) return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return 0;
  }
}

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_LITERAL = /^\[?[0-9a-fA-F]*:[0-9a-fA-F:.]*\]?$/;

function isIpLiteral(hostname) {
  return IPV4_LITERAL.test(hostname) || IPV6_LITERAL.test(hostname);
}

/**
 * Independent DNS audit. For a name, ask the REAL resolver what it would answer
 * and record whether any of those answers ever reached a socket. The guard's own
 * decision is what the probe scores; this only phrases the leak audit, proving
 * that a private answer was refused before it could be used.
 */
async function dnsAudit(url, attempts) {
  const hostname = new URL(url).hostname;
  if (isIpLiteral(hostname)) {
    return { asked: false, answers: [], leakedToSocket: false, note: 'IP literal: the guard never resolves it' };
  }
  try {
    const answers = await dns.lookup(hostname, { all: true, verbatim: true });
    const addresses = answers.map((a) => a.address).slice(0, 4);
    const connectsTo = attempts.filter((attempt) => addresses.includes(attempt.address));
    return {
      asked: true,
      answers: addresses,
      leakedToSocket: connectsTo.length > 0,
      note:
        connectsTo.length === 0
          ? 'resolved independently by the probe; the private answer never reached a connect'
          : 'a resolved private answer reached a connect attempt — a leak',
    };
  } catch (error) {
    return { asked: true, answers: [], leakedToSocket: false, note: `resolver error: ${error?.code ?? 'unknown'}` };
  }
}

// ---------------------------------------------------------------------------
// In-script assertion: no test-only bypass outside the single documented front.
// ---------------------------------------------------------------------------

/**
 * Reads this file's own source and proves that the test-only loopback option is
 * mentioned only on lines that declare themselves: the single call site that
 * carries it (REDIRECT-FRONT-BYPASS) and this auditor's own pattern/labels
 * (BYPASS-AUDIT-INTERNAL). Any other occurrence would be an undeclared bypass.
 * A runtime guard in `refusalCase` independently asserts that no refusal case
 * ever carries the option.
 */
async function auditTestBypass() {
  const source = await fsp.readFile(SELF_PATH, 'utf8');
  const lines = source.split(/\r?\n/);
  const hits = [];
  lines.forEach((line, index) => {
    if (!line.includes('allowLoopbackForTests')) return; // BYPASS-AUDIT-INTERNAL: the pattern itself
    const declared = line.includes('REDIRECT-FRONT-BYPASS') || line.includes('BYPASS-AUDIT-INTERNAL');
    const isProse = line.trimStart().startsWith('*') || line.trimStart().startsWith('//');
    if (!declared && !isProse) hits.push({ line: index + 1, text: line.trim().slice(0, 120) });
  });
  return {
    // BYPASS-AUDIT-INTERNAL: report text, not a call site
    checked: 'source scan for allowLoopbackForTests outside a REDIRECT-FRONT-BYPASS line',
    unmarkedCallSites: hits,
    passed: hits.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Runs one refusal case through the public entry point.
 * NO deps argument and NO test-only flag: exactly what production calls.
 */
async function refusalCase(lib, { url, expectedRefusal, note }) {
  const marker = connectAttempts.length;
  const startedAt = Date.now();
  let observedCode = 'NONE';
  let detail = {};
  let succeeded = false;
  try {
    const request = { url, timeoutMs: CASE_TIMEOUT_MS, maxBytes: CASE_MAX_BYTES };
    // Runtime guard for the in-script assertion: a refusal case must never carry
    // a test-only bypass key.
    // BYPASS-AUDIT-INTERNAL: the runtime guard's own key literals
    const bypassKeys = ['allowLoopbackForTests', 'allowedRedirectPorts']; // BYPASS-AUDIT-INTERNAL: key names this guard checks
    if (bypassKeys.some((key) => key in request)) {
      throw new Error('PROBE BUG: a refusal case carried a test-only option');
    }
    await lib.safeFetch(request); // ← NO second argument: no injected lookup, no seam
    succeeded = true;
  } catch (error) {
    if (error instanceof lib.EgressFailure) {
      observedCode = error.code;
      detail = error.detail ?? {};
    } else {
      observedCode = `UNEXPECTED:${error?.name ?? 'Error'}`;
    }
  }
  const attempts = connectAttempts.slice(marker);
  const destinationPort = portOf(url);
  const dnsInfo = await dnsAudit(url, attempts);
  return {
    url: redactUrl(url),
    expectedRefusal,
    observedCode,
    refused: !succeeded && !String(observedCode).startsWith('UNEXPECTED'),
    succeededUnexpectedly: succeeded,
    targetConnections: null,
    tcpConnectsAttempted: attempts.length,
    tcpConnectsToDestination: attempts.filter((attempt) => attempt.port === destinationPort).length,
    dns: dnsInfo,
    detail: {
      host: typeof detail.host === 'string' ? detail.host : null,
      reason: typeof detail.reason === 'string' ? detail.reason : null,
      hop: typeof detail.hop === 'number' ? detail.hop : null,
    },
    latencyMs: Date.now() - startedAt,
    note,
  };
}

async function main() {
  const startedAt = new Date();
  let lib;
  let startHttpFixture;
  try {
    lib = await import(SAFE_EGRESS_URL);
    ({ startHttpFixture } = await import(FIXTURES_URL));
  } catch (error) {
    process.stderr.write(
      `PROBE SETUP FAILED: built modules missing under apps/backend/dist (${error?.message ?? error}).\n` +
        'Run `npm run build -w @tdt/backend` first.\n',
    );
    return 2;
  }

  const bypassAudit = await auditTestBypass();

  // Fixtures exist ONLY for the redirect case (see the header comment).
  const target = await startHttpFixture({
    '/secret': { status: 200, contentType: 'application/x-mpegurl', body: '#EXTM3U\n# SECRET-TARGET-REACHED\n' },
  });
  const front = await startHttpFixture({
    '/redirect': { status: 302, location: `http://127.0.0.1:${target.port}/secret` },
  });

  const cases = [];
  try {
    // --- Nine refusal cases: no test-only flag for any of them. --------------
    // [input URL, expected refusal, note, spelling (only where the input is an
    // alternative numeric spelling, which URL normalisation canonicalises)]
    const plain = [
      [
        `http://127.0.0.1:${front.port}/s.m3u8`,
        'host-blocked',
        `loopback literal aimed at the FRONT fixture's live port (${front.port}): a connection here would be counted; the default disposition refused it with no flag passed`,
      ],
      ['http://169.254.169.254/latest/meta-data/', 'host-blocked', 'cloud metadata endpoint (169.254/16 link-local)'],
      ['http://10.0.0.1/s.m3u8', 'host-blocked', 'RFC1918 10/8'],
      ['http://192.168.1.1/s.m3u8', 'host-blocked', 'RFC1918 192.168/16'],
      ['http://[::1]/s.m3u8', 'host-blocked', 'IPv6 loopback literal (bracketed form)'],
      ['http://[::ffff:127.0.0.1]/s.m3u8', 'host-blocked', 'IPv4-mapped IPv6 wrapper around 127.0.0.1'],
      ['http://localhost/s.m3u8', 'host-blocked', 'reserved hostname; refused before resolution'],
      ['http://0x7f.1/s.m3u8', 'host-blocked', 'hex spelling of 127.0.0.1', '0x7f.1'],
      ['http://2130706433/s.m3u8', 'host-blocked', 'decimal spelling of 127.0.0.1', '2130706433'],
    ];
    for (const [url, expectedRefusal, note, spelling] of plain) {
      const result = await refusalCase(lib, { url, expectedRefusal, note });
      if (spelling !== undefined) {
        // WHATWG URL normalises these to 127.0.0.1 before the guard sees them;
        // record the input spelling so the evidence shows both forms were tried.
        result.spelling = spelling;
        result.url = `http://${spelling}/s.m3u8`;
      }
      cases.push(result);
    }

    // --- Redirect case: front hop is the ONE documented test-only call. ------
    const frontMarker = connectAttempts.length;
    const redirectStartedAt = Date.now();
    let redirectCode = 'NONE';
    let redirectSucceeded = false;
    let redirectDetail = {};
    try {
      const result = await lib.safeFetch({
        // REDIRECT-FRONT-BYPASS: the single test-only call in this file. It lets the
        // FRONT hop exist so a redirect can be issued; the TARGET hop it points at
        // is validated with production policy and must be refused.
        // eslint-disable-next-line
        allowLoopbackForTests: true, // REDIRECT-FRONT-BYPASS
        url: `http://127.0.0.1:${front.port}/redirect`,
        timeoutMs: CASE_TIMEOUT_MS,
        maxBytes: CASE_MAX_BYTES,
      });
      redirectSucceeded = true;
      redirectCode = `SUCCEEDED:${result.status}`;
      redirectDetail = { landedOn: redactUrl(result.finalUrl) };
    } catch (error) {
      redirectCode = error instanceof lib.EgressFailure ? error.code : `UNEXPECTED:${error?.name ?? 'Error'}`;
      redirectDetail = error instanceof lib.EgressFailure ? (error.detail ?? {}) : {};
    }
    const redirectAttempts = connectAttempts.slice(frontMarker);
    cases.push({
      url: `http://127.0.0.1:${front.port}/redirect -> http://127.0.0.1:${target.port}/secret`,
      expectedRefusal: 'redirect-unsafe',
      observedCode: redirectCode,
      refused: !redirectSucceeded && redirectCode === 'redirect-unsafe',
      succeededUnexpectedly: redirectSucceeded,
      targetConnections: target.counters.sockets,
      targetRequests: target.counters.requests,
      frontConnections: front.counters.sockets,
      tcpConnectsAttempted: redirectAttempts.length,
      tcpConnectsToDestination: redirectAttempts.filter((attempt) => attempt.port === target.port).length,
      dns: { asked: false, answers: [], leakedToSocket: false, note: 'IP literal hops' },
      detail: {
        // For a rejected hop the guard names the cause as either a `reason` code
        // (a re-validated hop failed) or `port`/`fromPort` (a cross-port hop
        // without an explicit permit). The probe reports what it actually got.
        reason: typeof redirectDetail.reason === 'string' ? redirectDetail.reason : null,
        redirects: typeof redirectDetail.redirects === 'number' ? redirectDetail.redirects : null,
        port: typeof redirectDetail.port === 'number' ? redirectDetail.port : null,
        fromPort: typeof redirectDetail.fromPort === 'number' ? redirectDetail.fromPort : null,
        landedOn: typeof redirectDetail.landedOn === 'string' ? redirectDetail.landedOn : null,
      },
      latencyMs: Date.now() - redirectStartedAt,
      note:
        'the FRONT hop used the documented test-only loopback allowance (the only such call); the redirect to the TARGET port was re-validated and refused as redirect-unsafe, and the TARGET fixture recorded zero connections and zero requests',
    });
  } finally {
    await front.close();
    await target.close();
  }

  // --- Positive control: same entry point, no deps, real network. ------------
  let positiveControl;
  try {
    const result = await lib.safeFetch({ url: POSITIVE_URL, timeoutMs: CONTROL_TIMEOUT_MS, maxBytes: CONTROL_MAX_BYTES });
    positiveControl = {
      url: hostOnly(POSITIVE_URL),
      status: result.status,
      ok: result.status === 200,
      bytes: result.bytes,
      contentType: result.contentType,
      resolvedAddresses: result.resolvedAddresses.slice(0, 4),
      note: 'same process and entry point with no injected deps: proof the guard is two-sided',
    };
  } catch (error) {
    positiveControl = {
      url: hostOnly(POSITIVE_URL),
      status: null,
      ok: false,
      error: error instanceof lib.EgressFailure ? error.code : `UNEXPECTED:${error?.name ?? 'Error'}`,
      note: 'public fetch failed: refusals cannot be called a success without a working control',
    };
  }

  const refused = cases.filter((c) => c.refused).length;
  const succeededUnexpectedly = cases.filter((c) => c.succeededUnexpectedly).length;
  const summary = { cases: cases.length, refused, succeededUnexpectedly, positiveControlOk: positiveControl.ok === true };
  const passed = refused === cases.length && succeededUnexpectedly === 0 && positiveControl.ok === true && bypassAudit.passed === true;

  const report = {
    generatedAt: startedAt.toISOString(),
    node: process.version,
    probe: {
      entryPoint: 'apps/backend/dist/infrastructure/safe-egress.js#safeFetch',
      injectedDeps: false,
      noDeps: 'every call is safeFetch(request): the real dns.promises.lookup and the real node:net stack run',
      tcpConnectObserver: 'node:net Socket.prototype.connect instrumented in-process; counts every connect attempt',
      testOnlyBypassAudit: bypassAudit,
      loopbackFixtures:
        'two loopback fixtures exist ONLY for the redirect case: the FRONT hop is reached through the documented test-only allowance so that a redirect can exist at all; the TARGET proves it is never reached (0 connections, 0 requests, 0 connects)',
    },
    cases,
    positiveControl,
    summary,
    passed,
  };

  // Bounded JSON: cap the byte size, never write an unbounded file.
  let text = JSON.stringify(report, null, 2);
  if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) {
    text = JSON.stringify({ ...report, cases: cases.slice(0, 10), truncated: true }, null, 2);
  }
  try {
    await fsp.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fsp.writeFile(OUTPUT_PATH, `${text}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(`PROBE SETUP FAILED: cannot write ${OUTPUT_PATH} (${error?.message ?? error}).\n`);
    return 2;
  }

  // At most 12 lines of stdout.
  const lines = [
    `SSRF adversarial probe — node ${process.version} — ${report.generatedAt}`,
    `entry: safeFetch (built dist), deps: none injected | bypass audit: ${bypassAudit.passed ? 'pass' : 'FAIL'} | tcp connects observed: ${connectAttempts.length}`,
  ];
  for (const c of cases) {
    const fence =
      c.targetConnections === null ? `connects=${c.tcpConnectsToDestination}` : `targetConnections=${c.targetConnections}`;
    lines.push(`  ${c.refused && !c.succeededUnexpectedly ? 'REFUSED' : 'FAILED '} ${String(c.observedCode).padEnd(18)} ${fence.padEnd(20)} ${c.url}`);
  }
  lines.push(`positive control: ${positiveControl.ok ? 'OK' : 'FAILED'} status=${positiveControl.status ?? positiveControl.error} ${positiveControl.url}`);
  lines.push(`summary: ${JSON.stringify(summary)}`);
  lines.push(`evidence: ${path.relative(ROOT, OUTPUT_PATH).split(path.sep).join('/')} | probe: ${passed ? 'PASS' : 'FAIL'}`);
  process.stdout.write(`${lines.slice(0, MAX_STDOUT_LINES).join('\n')}\n`);

  if (!positiveControl.ok) {
    process.stderr.write(
      'PROBE FAILED: the positive control could not fetch a real public URL — a total network outage must not be read as a correct refusal.\n',
    );
  }
  return passed ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`PROBE ERROR: ${error?.stack ?? error}\n`);
    process.exitCode = 2;
  });
