/**
 * Browser playback verification: does the stream actually PLAY?
 *
 * This tool exists because the milestone's central claim is that **HTTP 200 is
 * not proof of playable video**. So it measures two axes independently and never
 * derives one from the other:
 *
 *   AXIS A — reachability: a plain `fetch` of the manifest. Status, content-type,
 *            byte count, elapsed time, and whether the body starts with `#EXTM3U`.
 *            It does not follow into segments and it does not infer playback.
 *
 *   AXIS B — real playback: a real Chromium loads a page whose `<video>` element
 *            is pointed at the manifest, calls `play()` without a user gesture,
 *            and we watch what the element ACTUALLY does: `readyState`,
 *            `currentTime` advancing, `videoWidth`/`videoHeight`, `MediaError`,
 *            `paused`. The verdict comes from those observations only.
 *
 * Nothing here bypasses a protection. There is no proxy, no forged `Origin`, no
 * permissive CORS header injected to make a stream look better, no credential
 * replay. A stream that a browser refuses is reported as refused.
 *
 * Usage:
 *   node apps/backend/scripts/browser-playback-check.mjs [--url <manifest>]... [--out <path>] [--timeout-ms 25000]
 *
 * Playwright resolution: the worktree does not ship `playwright`, so the module
 * is resolved in this order — the worktree's own `node_modules`, then a small set
 * of known sibling checkouts that have `@playwright/test` installed, then the npx
 * cache. If none resolves, or no Chromium binary launches, every source is
 * reported `not-observable` with the reason and the process still exits 0: an
 * unmeasured axis is a declared unknown, never a pass and never a failure.
 */
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
/** apps/backend/scripts → repo root is three levels up. */
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DEFAULT_OUT = join(REPO_ROOT, 'evidence', 'verification-02d', 'browser-playback.json');

/**
 * Ordinary public HLS test streams that really exist. They are deliberately
 * different from one another: a VOD ladder on a CDN that allows any origin, a
 * multi-variant Apple sample on a CDN that sends NO CORS header, and a live
 * loopback test channel. The three exercise different failure paths.
 */
const DEFAULT_SOURCES = [
  'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8',
  'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8',
];

/** Exact verdict vocabulary. Nothing outside this list is ever reported. */
export const VERDICTS = [
  'played',
  'playback-failed-cors',
  'playback-failed-codec',
  'playback-failed-format',
  'autoplay-blocked',
  'timeout-no-progress',
  'http-unreachable',
  'not-observable',
];

/** A verdict counts as "failed" for the summary unless it is a pass or an unknown. */
const VERDICT_MEANING = {
  played: 'The element produced media: the playhead advanced and a frame size was reported.',
  'playback-failed-cors': 'The browser could not load the manifest/media because the origin did not grant CORS.',
  'playback-failed-codec': 'The media was reached but the browser could not decode it (MediaError 4 / no supported source).',
  'playback-failed-format': 'The resource was reachable but is not a media resource the element accepts.',
  'autoplay-blocked': 'The source is fine; play() was refused for lack of a user gesture (NotAllowedError).',
  'timeout-no-progress': 'No media progress was observed within the timeout and no error was raised.',
  'http-unreachable': 'The plain fetch of the manifest did not yield a usable manifest (status, CORS or body).',
  'not-observable': 'Playback could not be measured at all (no browser or no module). Declared unknown, not a pass.',
};

const AXIS_A_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_CONSOLE_LINES = 25;
const MAX_DETAIL_LINES = 10;
const CONSOLE_LINE_MAX = 300;

// ── arguments ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { urls: [], out: DEFAULT_OUT, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url') {
      const value = argv[index + 1];
      if (!value) throw new Error('--url requires a value');
      options.urls.push(value);
      index += 1;
    } else if (arg === '--out') {
      const value = argv[index + 1];
      if (!value) throw new Error('--out requires a value');
      options.out = resolve(value);
      index += 1;
    } else if (arg === '--timeout-ms') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--timeout-ms requires a positive number');
      options.timeoutMs = Math.trunc(value);
      index += 1;
    } else if (arg === '--no-browser') {
      /*
       * Declares the browser axis unavailable on purpose. It exists so the
       * `not-observable` path can be demonstrated and audited on a machine that
       * happens to have Chromium: an unmeasured axis must be provably declared,
       * not merely assumed.
       */
      options.noBrowser = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

// ── URL hygiene: never persist a token ─────────────────────────────────────

/**
 * Strips userinfo and token-like query parameters before a URL is written to
 * evidence (D-015). The manifest URL is still probed in full; only the recorded
 * copy is redacted, so a report never becomes a place where a credential lives.
 */
const TOKEN_PARAMS = new Set([
  'token',
  'access_token',
  'auth',
  'apikey',
  'api_key',
  'key',
  'sig',
  'signature',
  'hmac',
  'expires',
  'exp',
  'session',
  'sessionid',
  'password',
  'secret',
  'jwt',
]);

export function redactUrl(raw) {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    for (const name of [...url.searchParams.keys()]) {
      if (TOKEN_PARAMS.has(name.toLowerCase())) url.searchParams.set(name, 'REDACTED');
    }
    return url.toString();
  } catch {
    // Not parseable: keep only the scheme-ish prefix so evidence stays readable.
    return String(raw).replace(/\/\/[^/@\s]*@/, '//REDACTED@').slice(0, 200);
  }
}

// ── AXIS A: plain reachability ─────────────────────────────────────────────

/**
 * Fetches the manifest exactly like a plain HTTP client would: no credentials,
 * no forged headers, `redirect: 'manual'` so a redirect is *recorded* rather than
 * silently followed. Bounded body read; the body is inspected for `#EXTM3U` and
 * then discarded — it is never stored.
 */
export async function measureReachability(rawUrl) {
  const started = Date.now();
  const result = {
    status: null,
    contentType: null,
    bytes: 0,
    elapsedMs: 0,
    startsWithExtM3u: false,
    /** Master-playlist facts, parsed here rather than in the browser. */
    manifest: null,
    redirect: null,
    corsAllowOrigin: null,
    error: null,
  };
  let response;
  try {
    response = await fetch(rawUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(AXIS_A_TIMEOUT_MS),
      headers: { accept: '*/*' },
    });
  } catch (error) {
    result.elapsedMs = Date.now() - started;
    result.error = classifyFetchError(error);
    return result;
  }

  result.status = response.status;
  result.contentType = response.headers.get('content-type');
  result.corsAllowOrigin = response.headers.get('access-control-allow-origin');
  const location = response.headers.get('location');
  if (result.status >= 300 && result.status < 400 && location !== null) {
    // Recorded, not followed: axis A is about the URL that was asked for.
    result.redirect = redactUrl(new URL(location, rawUrl).toString());
    result.elapsedMs = Date.now() - started;
    return result;
  }

  let text = '';
  try {
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        result.bytes += value.byteLength;
        if (text.length < MAX_BODY_BYTES) text += Buffer.from(value).toString('utf8');
        if (result.bytes > MAX_BODY_BYTES) {
          await reader.cancel();
          break;
        }
      }
    }
  } catch (error) {
    result.error = classifyFetchError(error);
    result.elapsedMs = Date.now() - started;
    return result;
  }
  result.elapsedMs = Date.now() - started;
  result.startsWithExtM3u = text.trimStart().startsWith('#EXTM3U');
  if (result.startsWithExtM3u) result.manifest = parseManifestFacts(text);
  return result;
}

function classifyFetchError(error) {
  const message = String(error?.message ?? error).slice(0, 200);
  const name = error?.name ?? '';
  if (name === 'TimeoutError' || /abort|timeout/i.test(message)) return `timeout: ${message}`;
  const cause = error?.cause?.code ?? error?.cause?.message ?? '';
  if (cause) return `${message} (${String(cause).slice(0, 120)})`;
  return message;
}

/**
 * The first integer after a tag's colon, or null when there is none.
 *
 * `parseManifestFacts` below has always called this for `#EXT-X-MEDIA-SEQUENCE`
 * and `#EXT-X-TARGETDURATION`, but the function was never defined: any media
 * playlist that actually declares either tag threw `ReferenceError:
 * leadingInt is not defined` and aborted the whole run. The 02D test streams
 * happened not to declare them, so it went unnoticed until a real catalogue
 * playlist was measured.
 */
function leadingInt(line) {
  const match = /:(\d+)/.exec(line);
  return match === null ? null : Number(match[1]);
}

/**
 * Structured facts of an HLS playlist: counts and whether it is a master. The
 * playlist text itself is never returned or persisted.
 */
export function parseManifestFacts(body) {
  const lines = body.split(/\r?\n/);
  let variants = 0;
  let segments = 0;
  let mediaSequence = null;
  let targetDuration = null;
  let endList = false;
  let pendingExtinf = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF')) variants += 1;
      else if (line.startsWith('#EXTINF')) pendingExtinf = true;
      else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) mediaSequence = leadingInt(line);
      else if (line.startsWith('#EXT-X-TARGETDURATION')) targetDuration = leadingInt(line);
      else if (line === '#EXT-X-ENDLIST') endList = true;
      continue;
    }
    if (pendingExtinf) {
      segments += 1;
      pendingExtinf = false;
    }
  }
  return {
    kind: variants > 0 ? 'master' : 'media',
    variantCount: variants,
    segmentCount: segments,
    mediaSequence,
    targetDuration,
    endList,
    extensions: new Set(lines.filter((l) => l.startsWith('#EXT')).map((l) => l.trim().split(':')[0])).size,
  };
}

// ── Playwright resolution ──────────────────────────────────────────────────

/**
 * Resolves a Playwright package without adding a dependency.
 *
 * The worktree does not ship Playwright (it is a frontend dev dependency and the
 * backend has no browser code), so a measurement tool that refused to look one
 * directory further would always report `not-observable`. The search is explicit
 * and ordered; every candidate is a *read-only* import of an already-installed
 * package, never an install, never a download.
 */
async function resolvePlaywright() {
  const candidates = [];

  // 1. The worktree's own resolution chain (works when the dependency exists).
  const requireFromHere = createRequire(import.meta.url);
  for (const specifier of ['playwright', '@playwright/test']) {
    try {
      candidates.push(requireFromHere.resolve(specifier));
      return { ok: true, specifier, via: 'worktree' };
    } catch {
      // keep looking
    }
  }

  // 2. Sibling checkouts in the same workspace that already have it installed.
  const siblings = [
    'apps/frontend/node_modules/playwright/index.mjs',
    '../tdt-api01/apps/frontend/node_modules/playwright/index.mjs',
    '../../tdt-api01/apps/frontend/node_modules/playwright/index.mjs',
    '../../tdt-player-rebuild/node_modules/playwright/index.mjs',
  ];
  for (const relative of siblings) {
    const absolute = resolve(REPO_ROOT, relative);
    try {
      await access(absolute, fsConstants.R_OK);
      return { ok: true, specifier: pathToFileURL(absolute).href, via: `sibling:${relative}` };
    } catch {
      // keep looking
    }
  }

  // 3. The npx cache, most recent version first.
  const npxRoot = process.env['LOCALAPPDATA']
    ? join(process.env['LOCALAPPDATA'], 'npm-cache', '_npx')
    : process.env['APPDATA']
      ? join(process.env['APPDATA'], 'npm-cache', '_npx')
      : null;
  if (npxRoot !== null) {
    try {
      const dirs = await readdir(npxRoot);
      for (const dir of dirs) {
        const candidate = join(npxRoot, dir, 'node_modules', 'playwright', 'index.mjs');
        try {
          await access(candidate, fsConstants.R_OK);
          return { ok: true, specifier: pathToFileURL(candidate).href, via: `npx-cache:${dir}` };
        } catch {
          // keep looking
        }
      }
    } catch {
      // no npx cache
    }
  }

  return { ok: false, reason: 'playwright-module-unavailable' };
}

// ── AXIS B: real playback ──────────────────────────────────────────────────

/** The page we drive. Inline, tiny, and it exposes nothing but the element. */
const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>browser-playback-check</title></head>
<body style="margin:0;background:#000">
<video id="v" muted playsinline preload="auto" style="width:320px;height:180px"></video>
<script>
  window.__probe = { startedAt: Date.now(), playResult: null, playError: null, samples: [] };
  var v = document.getElementById('v');
  window.__video = v;
  ['loadedmetadata','loadeddata','canplay','playing','waiting','stalled','suspend','error','emptied','abort'].forEach(function (name) {
    v.addEventListener(name, function () {
      window.__probe.samples.push({ event: name, at: Date.now() - window.__probe.startedAt, readyState: v.readyState });
    });
  });
  window.__start = function (src) {
    window.__probe.startedAt = Date.now();
    window.__probe.samples = [];
    v.src = src;
    var promise;
    try { promise = v.play(); } catch (error) {
      window.__probe.playError = String(error && error.name || error);
      return;
    }
    if (promise && typeof promise.then === 'function') {
      promise.then(function () { window.__probe.playResult = 'resolved'; },
                   function (error) { window.__probe.playResult = 'rejected'; window.__probe.playError = String(error && error.name || error) + ': ' + String(error && error.message || ''); });
    } else {
      window.__probe.playResult = 'undefined';
    }
  };
</script></body></html>`;

/**
 * Observes real playback of one URL in a real Chromium.
 *
 * Returns the observed element state plus everything needed to classify it. It
 * never classifies by itself on heuristics: `classifyPlayback` uses only what was
 * observed (media error, network failure kind, play() rejection, playhead).
 */
async function measurePlayback(browser, rawUrl, timeoutMs, probeCors = false) {
  const context = await browser.newContext({
    // A null origin is what a page served from a data:/sandboxed context has.
    // Nothing is added to make a stream look better: no extra headers, no proxy.
    viewport: { width: 480, height: 320 },
    ignoreHTTPSErrors: false,
  });
  const page = await context.newPage();
  const consoleBounded = [];
  const failedRequests = [];
  const statusResponses = [];
  let corsProbe = null;
  /**
   * `requestfailed` text alone cannot separate CORS (the browser refused to hand
   * the response over) from a plain network error, and the console message for a
   * CORS block ("blocked by CORS policy") also arrives as a `console.error` with
   * no request attached. Both signals are collected; neither is a verdict.
   */
  const diagnostics = { corsConsoleSeen: false, failedRequestTexts: [] };

  page.on('console', (message) => {
    const text = message.text();
    if (/cors|access-control-allow-origin|blocked by cors/i.test(text)) diagnostics.corsConsoleSeen = true;
    if (consoleBounded.length >= MAX_CONSOLE_LINES) return;
    consoleBounded.push(`console.${message.type()}: ${text.slice(0, CONSOLE_LINE_MAX)}`);
  });
  page.on('pageerror', (error) => {
    if (consoleBounded.length >= MAX_CONSOLE_LINES) return;
    consoleBounded.push(`pageerror: ${String(error?.message ?? error).slice(0, CONSOLE_LINE_MAX)}`);
  });
  page.on('response', (response) => {
    // Statuses of media/playlist requests: this is what makes a body-vs-manifest
    // failure legible without reading any playlist text.
    if (response.status() < 400) return;
    if (statusResponses.length >= 5) return;
    const type = response.request().resourceType();
    statusResponses.push({ resourceType: type, status: response.status(), url: shortUrl(redactUrl(response.url())) });
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    const errorText = failure?.errorText ?? 'unknown';
    diagnostics.failedRequestTexts.push(errorText);
    if (failedRequests.length < MAX_CONSOLE_LINES) {
      failedRequests.push({ kind: classifyFailedRequest(request.resourceType(), errorText), resourceType: request.resourceType() });
    }
  });

  try {
    await page.setContent(PAGE_HTML, { waitUntil: 'domcontentloaded' });
    if (probeCors) {
      /*
       * A CORS observation made by the PAGE itself (origin `null`), independent of
       * the <video> element. A media element reports CORS blocks only through ORB
       * or a generic MediaError, so without this a "not a media resource" and a
       * "cross-origin refusal" would be indistinguishable. This probe reads no
       * body and changes no request: it asks the origin, from the page's origin,
       * whether it grants access at all.
       */
      const cors = await page.evaluate(async (url) => {
        try {
          const response = await fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit' });
          return { ok: true, status: response.status, type: response.type };
        } catch (error) {
          return { ok: false, status: null, error: String(error && error.message || error).slice(0, 160) };
        }
      }, rawUrl);
      corsProbe = cors;
      // A `type: 'opaque'`/`'no-cors'` result would mean the request escaped CORS
      // rules; `basic`/`cors` here means the origin granted access.
      if (cors.ok === true && (cors.type === 'cors' || cors.type === 'basic')) diagnostics.corsGranted = true;
      if (cors.ok === false && /cors|access-control/i.test(cors.error ?? '')) diagnostics.corsConsoleSeen = true;
    }
    await page.evaluate((src) => window.__start(src), rawUrl);

    const deadline = Date.now() + timeoutMs;
    let lastCurrentTime = 0;
    let advanced = false;
    let peakReadyState = 0;
    let mediaError = null;
    let playedEvent = false;
    let pauseObserved = false;
    let stalledSince = null;
    let playState = null;

    while (Date.now() < deadline) {
      const snapshot = await page.evaluate(() => {
        const v = window.__video;
        const probe = window.__probe ?? {};
        return {
          readyState: v.readyState,
          networkState: v.networkState,
          currentTime: v.currentTime,
          paused: v.paused,
          ended: v.ended,
          videoWidth: v.videoWidth,
          videoHeight: v.videoHeight,
          duration: Number.isFinite(v.duration) ? v.duration : null,
          src: v.currentSrc,
          mediaError: v.error ? { code: v.error.code, message: String(v.error.message ?? '') } : null,
          playResult: probe.playResult ?? null,
          playError: probe.playError ?? null,
          events: (probe.samples ?? []).map((s) => s.event),
        };
      });
      playState = snapshot;
      peakReadyState = Math.max(peakReadyState, snapshot.readyState);
      if (snapshot.events.includes('playing')) playedEvent = true;
      if (snapshot.paused === true && playedEvent) pauseObserved = true;
      if (snapshot.currentTime > lastCurrentTime + 0.05) {
        advanced = true;
        lastCurrentTime = snapshot.currentTime;
      }
      if (snapshot.mediaError !== null) {
        mediaError = snapshot.mediaError;
        break;
      }
      // Playback proved: a frame size plus forward motion is real media, not a
      // cached container probe.
      if (advanced && snapshot.videoWidth > 0 && snapshot.videoHeight > 0) break;
      if (snapshot.playResult === 'rejected' && snapshot.playError) break;
      if (snapshot.networkState === 3 /* NETWORK_NO_SOURCE */ && snapshot.readyState === 0) break;
      if (snapshot.readyState < 3) {
        stalledSince = stalledSince ?? Date.now();
      } else {
        stalledSince = null;
      }
      await new Promise((wait) => setTimeout(wait, 250));
    }

    /*
     * Settle window: after the observation loop, keep listening briefly so the
     * request/console events that explain a failure (a 404, a CORS block) are
     * captured instead of racing the last poll.
     */
    await new Promise((wait) => setTimeout(wait, 400));

    const media = playState ?? {
      readyState: 0,
      networkState: 0,
      currentTime: 0,
      paused: true,
      ended: false,
      videoWidth: 0,
      videoHeight: 0,
      duration: null,
      src: '',
      mediaError: null,
      playResult: null,
      playError: null,
      events: [],
    };

    return {
      observed: {
        readyState: media.readyState,
        peakReadyState,
        networkState: media.networkState,
        currentTime: media.currentTime,
        playheadAdvanced: advanced,
        paused: media.paused,
        ended: media.ended,
        playingEvent: playedEvent,
        pausedAfterPlaying: pauseObserved,
        videoWidth: media.videoWidth,
        videoHeight: media.videoHeight,
        duration: media.duration,
        mediaError,
        playResult: media.playResult,
        playError: media.playError,
        events: [...new Set(media.events ?? [])].slice(0, 20),
        timedOut: Date.now() >= deadline && !advanced,
      },
      network: {
        blockedByCors: diagnostics.corsConsoleSeen || failedRequests.some((f) => f.kind === 'cors-blocked'),
        corsProbe,
        failedRequests: dedupeFailedRequests(failedRequests),
        failedRequestCount: failedRequests.length,
        /** Non-2xx responses the page received, e.g. a 404 variant playlist. */
        errorResponses: statusResponses,
        /** Raw `requestfailed` texts, bounded, for an operator to read. */
        failureTexts: [...new Set(diagnostics.failedRequestTexts)].slice(0, 5).map((t) => t.slice(0, 80)),
      },
      console: consoleBounded,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

function dedupeFailedRequests(list) {
  const seen = new Map();
  for (const item of list) {
    const key = `${item.resourceType}:${item.kind}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].map(([key, count]) => {
    const [resourceType, kind] = key.split(':');
    return { resourceType, kind, count };
  });
}

function classifyFailedRequest(resourceType, errorText) {
  if (/blockedbyclient|cors|origin|access-control/i.test(errorText)) return 'cors-blocked';
  if (/aborted/i.test(errorText)) return 'aborted';
  if (/timeout|timedout/i.test(errorText)) return 'timeout';
  return `network:${errorText.slice(0, 60)}`;
}

/**
 * The verdict. Every branch below is backed by something *observed*; there is no
 * branch that guesses from the URL or from a capability claim.
 *
 * The order is the whole point of the taxonomy, so it is stated explicitly:
 *
 *  1. media progress observed → `played` (the only positive outcome).
 *  2. a rejected `play()` with `NotAllowedError` → `autoplay-blocked`. The source
 *     is not at fault: our own autoplay policy must never be reported as a CDN,
 *     rights or codec failure.
 *  3. a CORS block observed (console policy text or a CORS-classified failed
 *     request) → `playback-failed-cors`. Checked *before* MediaError, because a
 *     browser that refuses the response cannot know whether the codec is
 *     supported — Chromium reports MediaError 4 for both, and reporting "codec"
 *     there would blame the wrong party.
 *  4. a 404/410 for a playlist or media request → `playback-failed-format`: the
 *     container was fine, a resource inside it is missing. Axis A cannot see
 *     this, because axis A never follows into segments.
 *  5. a MediaError → codec (4 / 3) vs format (2 network, 1 aborted).
 *  6. `NETWORK_NO_SOURCE` with readyState 0 and no error → not a media resource.
 *  7. nothing observed within the timeout → `timeout-no-progress`, an admitted
 *     unknown rather than an invented failure.
 */
export function classifyPlayback(observation) {
  const { observed, network } = observation;
  if (observed.playheadAdvanced && observed.videoWidth > 0 && observed.videoHeight > 0) {
    return {
      verdict: 'played',
      reason: `playhead advanced to ${observed.currentTime.toFixed(2)}s at ${observed.videoWidth}x${observed.videoHeight} (readyState ${observed.peakReadyState})`,
    };
  }
  if (observed.playResult === 'rejected' && /NotAllowedError/i.test(observed.playError ?? '')) {
    return { verdict: 'autoplay-blocked', reason: `play() rejected: ${observed.playError}` };
  }
  const missing = (network.errorResponses ?? []).find((entry) => entry.status === 404 || entry.status === 410);
  const orbBlocked = (network.failureTexts ?? []).some((text) => /BLOCKED_BY_ORB/i.test(text));
  const corsRefused = network.blockedByCors === true && network.corsProbe?.ok === false;
  if (corsRefused) {
    return {
      verdict: 'playback-failed-cors',
      reason: `the origin refused the page's cross-origin request: ${network.corsProbe?.error ?? 'CORS policy'}`,
    };
  }
  /*
   * A missing manifest/media resource explains a MediaError as well as it
   * explains an empty element, so it is decided BEFORE the MediaError branch.
   * Chromium reports MediaError 4 for a 404'd variant playlist too; calling that
   * "codec" would blame the wrong party for a publisher-side breakage.
   */
  if (missing !== undefined) {
    return {
      verdict: 'playback-failed-format',
      reason: `a ${missing.resourceType} request returned HTTP ${missing.status} (${missing.url}): a resource inside the manifest is missing`,
    };
  }
  /*
   * Opaque Response Blocking is the browser's own verdict that the bytes are not a
   * media resource it will consume (an HTML page, an error document). It is a
   * format refusal, not a codec one, even though Chromium also raises MediaError 4.
   */
  if (orbBlocked) {
    return {
      verdict: 'playback-failed-format',
      reason: 'the browser blocked the response as a non-media resource (net::ERR_BLOCKED_BY_ORB): the body is not playable media',
    };
  }
  if (observed.mediaError) {
    const code = observed.mediaError.code;
    if (code === 4 || code === 3) {
      return {
        verdict: 'playback-failed-codec',
        reason: `MediaError ${code} (${code === 4 ? 'MEDIA_ERR_SRC_NOT_SUPPORTED' : 'MEDIA_ERR_DECODE'}): ${observed.mediaError.message || 'no supported source'}`,
      };
    }
    return {
      verdict: 'playback-failed-format',
      reason: `MediaError ${code}: ${observed.mediaError.message || 'the element could not use this resource'}`,
    };
  }
  /*
   * NETWORK_NO_SOURCE with readyState 0: the element exhausted every source it was
   * given and none of them became media. That is a format refusal, and it is
   * distinct from "still loading" (NETWORK_LOADING) or "nothing happened yet".
   */
  if (observed.peakReadyState === 0 && observed.networkState === 3) {
    return {
      verdict: 'playback-failed-format',
      reason: 'the element reached NETWORK_NO_SOURCE with readyState 0: it rejected every source (unsupported container/type)',
    };
  }
  /*
   * A rejected `play()` with no concrete cause above is NOT a format verdict: a
   * `NotSupportedError` can mean "the resource is not media" *or* "nothing loaded
   * in the window we watched", and the browser does not say which. Reporting a
   * failure here would be a guess, so the honest outcome is the admitted unknown.
   */
  return {
    verdict: 'timeout-no-progress',
    reason: `play() rejected (${observed.playError ?? 'unknown'}) with no media error, no missing resource and no CORS block observed; readyState ${observed.peakReadyState}, networkState ${observed.networkState} — cause not established`,
  };
}

// ── one source ─────────────────────────────────────────────────────────────

async function checkSource(browserState, rawUrl, timeoutMs) {
  const axisA = await measureReachability(rawUrl);
  const record = {
    url: redactUrl(rawUrl),
    axisA: {
      status: axisA.status,
      contentType: axisA.contentType,
      bytes: axisA.bytes,
      elapsedMs: axisA.elapsedMs,
      startsWithExtM3u: axisA.startsWithExtM3u,
      manifest: axisA.manifest,
      redirect: axisA.redirect,
      // Recorded because it *explains* the browser axis. It is never used to
      // decide the browser verdict: that is observed in Chromium, not read here.
      corsAllowOrigin: axisA.corsAllowOrigin,
      error: axisA.error,
    },
    axisB: null,
  };
  const reachableManifest = axisA.status === 200 && axisA.startsWithExtM3u;

  if (!browserState.ok) {
    record.axisB = {
      verdict: 'not-observable',
      reason: `browser unavailable: ${browserState.reason}`,
      media: null,
      network: null,
      consoleBounded: [],
    };
    return { record, reachableManifest };
  }

  let observed;
  try {
    observed = await measurePlayback(browserState.browser, rawUrl, timeoutMs, !reachableManifest);
  } catch (error) {
    // The browser itself failed to drive this page. That is not a stream verdict.
    record.axisB = {
      verdict: 'not-observable',
      reason: `playback probe could not run: ${String(error?.message ?? error).slice(0, 200)}`,
      media: null,
      network: null,
      consoleBounded: [],
    };
    return { record, reachableManifest };
  }

  const classified = classifyPlayback(observed);
  record.axisB = {
    verdict: classified.verdict,
    reason: classified.reason,
    media: observed.observed,
    network: observed.network,
    consoleBounded: observed.console,
  };
  /*
   * The two axes are reported side by side and are NOT reconciled: axis A says
   * what a plain HTTP client saw, axis B says what the browser did. When axis A
   * never obtained a manifest there is nothing for the browser to play, so the
   * verdict is `http-unreachable` and the browser's own finding is kept as
   * `browserFinding` — the evidence is not discarded, it is attributed.
   *
   * EXCEPT when the browser actually played. An automatic fetch client does not
   * follow every redirect and does not always report the body a media element
   * receives, so "axis A saw no manifest" is NOT evidence that playback failed.
   * Relabelling a `played` observation as `http-unreachable` produced a verdict
   * that contradicted its own recorded evidence (`readyState` 4, `playing`,
   * real frame dimensions, `mediaError: null`) and it was reported as "the
   * browser could not start playback" — which was simply untrue. Playback that
   * the browser demonstrably performed wins; the axis-A disagreement is kept as
   * `axisAConcern` so the redirect behaviour is still on the record.
   */
  if (!reachableManifest) {
    if (classified.verdict === 'played') {
      record.axisB.axisANeverSawManifest = true;
      record.axisB.axisAConcern = `axis A saw no manifest (HTTP ${axisA.status ?? 'error'}); the browser played anyway`;
      record.axisB.reason = `${classified.reason} (axis A saw no manifest: HTTP ${axisA.status ?? 'error'} — the element followed what the fetch client did not)`;
    } else {
      record.axisB.explainedBy = 'axisA-not-a-manifest';
      record.axisB.browserFinding = classified.verdict;
      record.axisB.verdict = 'http-unreachable';
      record.axisB.reason = `axis A did not obtain a manifest (HTTP ${axisA.status ?? 'error'}, ${axisA.startsWithExtM3u ? 'HLS body' : 'not an HLS body'}); the browser could not start playback (observed: ${classified.reason})`;
    }
  }
  return { record, reachableManifest };
}

// ── entry point ────────────────────────────────────────────────────────────

async function launchBrowser() {
  const resolved = await resolvePlaywright();
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  let module;
  try {
    module = await import(resolved.specifier);
  } catch (error) {
    return { ok: false, reason: `playwright-import-failed: ${String(error?.message ?? error).slice(0, 160)}` };
  }
  const chromium = module.chromium ?? module.default?.chromium;
  if (!chromium) return { ok: false, reason: 'playwright-import-lacked-chromium' };
  try {
    /*
     * Full Chromium, not headless-shell: the shell build lacks the proprietary
     * H.264/AAC decoders the public test streams use, so it would report a codec
     * failure the real browser would not have.
     */
    const browser = await chromium.launch({
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    return { ok: true, browser, via: resolved.via };
  } catch (error) {
    return { ok: false, reason: `chromium-unavailable: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}` };
  }
}

function summarize(results) {
  const counts = { played: 0, failed: 0, notObservable: 0, httpOkButNotPlayable: 0 };
  for (const { record, reachableManifest } of results) {
    const verdict = record.axisB?.verdict;
    if (verdict === 'played') counts.played += 1;
    else if (verdict === 'not-observable') counts.notObservable += 1;
    else counts.failed += 1;
    /*
     * The milestone's evidence line: the manifest answered 200 with `#EXTM3U`,
     * and the browser still did not play it. Counted only when the browser axis
     * was actually measured — an unobserved axis proves nothing.
     */
    if (reachableManifest && verdict !== 'played' && verdict !== 'not-observable') counts.httpOkButNotPlayable += 1;
  }
  return { sources: results.length, ...counts };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`browser-playback-check: ${error.message}`);
    return 2;
  }
  if (options.help) {
    console.log('usage: node apps/backend/scripts/browser-playback-check.mjs [--url <manifest>]... [--out <path>] [--timeout-ms 25000] [--no-browser]');
    return 0;
  }

  const urls = options.urls.length > 0 ? options.urls : DEFAULT_SOURCES;
  const browserState = options.noBrowser === true ? { ok: false, reason: 'browser-disabled-by-flag' } : await launchBrowser();
  const results = [];
  try {
    for (const url of urls) results.push(await checkSource(browserState, url, options.timeoutMs));
  } finally {
    if (browserState.ok) await browserState.browser.close().catch(() => undefined);
  }

  const summary = summarize(results);
  const report = {
    tool: 'browser-playback-check',
    generatedAt: new Date().toISOString(),
    axes:
      'axisA = plain HTTP fetch of the manifest (reachability). axisB = observed playback in real Chromium. The verdict is never derived from axisA.',
    browser: browserState.ok
      ? { available: true, via: browserState.via, version: browserState.browser.version?.() ?? null }
      : { available: false, reason: browserState.reason },
    timeoutMs: options.timeoutMs,
    summary,
    sources: results.map(({ record }) => record),
  };

  await mkdir(dirname(options.out), { recursive: true });
  const serialized = `${JSON.stringify(report, jsonReplacer, 2)}\n`;
  await writeFile(options.out, serialized, 'utf8');
  // Sanity: a report that is not valid JSON is not evidence.
  JSON.parse(await readFile(options.out, 'utf8'));

  const browserLabel = browserState.ok ? `chromium ${report.browser.version ?? 'available'}` : `browser not-observable (${browserState.reason})`;
  console.log(
    `browser-playback-check: ${summary.sources} sources — played ${summary.played}, failed ${summary.failed}, not-observable ${summary.notObservable}, http-200-but-not-playable ${summary.httpOkButNotPlayable} [${browserLabel}] -> ${options.out}`,
  );
  for (const { record } of results.slice(0, MAX_DETAIL_LINES)) {
    const a = record.axisA;
    const b = record.axisB;
    console.log(
      `  ${shortUrl(record.url)} | A: ${a.status ?? 'ERR'} ${a.contentType ?? '-'} ${a.startsWithExtM3u ? 'hls' : 'not-hls'} | B: ${b.verdict} — ${String(b.reason).slice(0, 120)}`,
    );
  }
  if (results.length > MAX_DETAIL_LINES) {
    console.log(`  … ${results.length - MAX_DETAIL_LINES} more in the report`);
  }
  return 0;
}

/** `Set` in `manifest` would serialize as `{}`; keep it as a sorted array. */
function jsonReplacer(key, value) {
  if (value instanceof Set) return [...value].sort();
  return value;
}

function shortUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.slice(0, 90);
  } catch {
    return String(url).slice(0, 90);
  }
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`browser-playback-check: fatal: ${String(error?.stack ?? error).slice(0, 2000)}`);
      process.exitCode = 1;
    },
  );
}

export { DEFAULT_SOURCES, VERDICT_MEANING };
