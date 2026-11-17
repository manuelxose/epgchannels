// Extract compact, credential-free observations from exported REA capture JSONs.
// usage: node extract-captures.mjs <capture.json> [<capture.json> ...] > resumen.json
// Reads only network *metadata* already retained in the REA Evidence record (no bodies,
// no header values). Cookies/tokens are never copied: query parameter VALUES are dropped
// for any parameter whose name looks credential-like.
import { readFileSync } from 'node:fs';

const SENSITIVE_PARAM = /(token|auth|session|sig|signature|key|secret|password|credential|jwt|uid|mid|blob)/i;
const MEDIA_EXT = /\.(m3u8|mpd|ts|m4s|mp4|m4a|aac|vtt|webvtt)(\?|$)/i;
const SEGMENT_EXT = /\.(ts|m4s|mp4|m4a|aac|vtt|webvtt)(\?|$)/i;

const safeUrl = (raw) => {
  try {
    const u = new URL(raw);
    const params = [...u.searchParams.keys()].map((k) =>
      SENSITIVE_PARAM.test(k) ? `${k}=<redacted>` : k,
    );
    return `${u.origin}${u.pathname}${params.length ? `?[${params.join(',')}]` : ''}`;
  } catch {
    return '<unparsable>';
  }
};

const out = [];
for (const path of process.argv.slice(2)) {
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  const ev = rec.evidence ?? rec;
  const norm = ev.normalized_result ?? {};
  const events = norm.events?.items ?? [];
  const transactions = new Map();
  for (const e of events) {
    if (!e.transaction_id) continue;
    const t = transactions.get(e.transaction_id) ?? {
      id: e.transaction_id,
      method: null,
      url: null,
      type: null,
      status: null,
      failure: null,
      request_header_names: null,
      response_header_names: null,
    };
    if (e.kind === 'request') {
      t.method = e.method;
      t.url = e.url?.url ?? null;
      t.type = e.resource_type;
      t.request_header_names = e.header_names ?? null;
    }
    if (e.kind === 'response') {
      t.status = e.status;
      t.response_header_names = e.header_names ?? null;
    }
    if (e.kind === 'request-failed') t.failure = e.failure;
    transactions.set(e.transaction_id, t);
  }
  const all = [...transactions.values()];
  const media = all.filter((t) => t.url && MEDIA_EXT.test(t.url.split('?')[0] + (t.url.includes('?') ? '?' : '')));
  const counts = {};
  for (const t of all) counts[t.type] = (counts[t.type] ?? 0) + 1;
  out.push({
    source_file: path.split(/[\\/]/).pop(),
    evidence_id: ev.evidence_id ?? null,
    operation: ev.operation ?? null,
    confidence: ev.confidence ?? null,
    authority: ev.authority ?? null,
    parameters: ev.parameters ?? null,
    browser: norm.browser ?? null,
    start_origin: norm.scenario?.start_origin ?? null,
    duration_ms: norm.duration_ms ?? null,
    steps: (norm.steps ?? []).map((s) => ({
      step_id: s.step_id,
      action: s.action,
      status: s.status,
      elapsed_ms: s.elapsed_ms,
      after_url: s.after_url?.url ?? null,
    })),
    event_counts: { retained: norm.events?.retained ?? null, dropped: norm.events?.dropped ?? null },
    resource_type_counts: counts,
    media_requests: media.map((t) => ({
      method: t.method,
      url: safeUrl(t.url),
      resource_type: t.type,
      status: t.status,
      failure: t.failure,
      request_header_names: t.request_header_names,
      response_header_names: t.response_header_names,
      is_segment: SEGMENT_EXT.test(t.url),
    })),
    console_lines: events
      .filter((e) => e.kind === 'console')
      .map((e) => ({ level: e.level, text: e.text.slice(0, 300) })),
    page_errors: events.filter((e) => e.kind === 'page-error').map((e) => e.message.slice(0, 300)),
    failures: all.filter((t) => t.failure).map((t) => ({ url: safeUrl(t.url), failure: t.failure })),
    non_2xx: all
      .filter((t) => t.status && (t.status < 200 || t.status >= 400))
      .map((t) => ({ url: safeUrl(t.url), status: t.status })),
    dom_measurements: (() => {
      const step = (norm.steps ?? []).find((s) => s.artifacts?.dom?.state === 'captured');
      const text = step?.artifacts?.dom?.value?.text ?? '';
      const pick = (re) => (text.match(re) ?? []).map((s) => s.slice(0, 400));
      return {
        dom_bytes: text.length || null,
        video_elements: pick(/<video\b[^>]{0,400}>/gi).slice(0, 5),
        source_children: pick(/(?:<source\b[^>]{0,300}>|data-src="[^"]{0,300}")/gi).slice(0, 5),
        iframes: pick(/<iframe\b[^>]{0,300}>/gi)
          .map((s) => s.replace(/\s+/g, ' '))
          .filter((s) => /player|embed|video|directe|stream/i.test(s))
          .slice(0, 8),
        player_libs: pick(
          /(bitmovin[a-z0-9._-]*|hls\.js|shaka-player|dashjs|dash\.js|videojs|jwplayer|youbora[a-z0-9._-]*)/gi,
        )
          .map((s) => s.toLowerCase())
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 12),
        geo_script: pick(/geoZoneHandler[^"]{0,80}/gi).slice(0, 3),
        drm_hints: pick(/(widevine|playready|fairplay|eme|drm)/gi)
          .map((s) => s.toLowerCase())
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 6),
      };
    })(),
    limitations: ev.limitations ?? null,
  });
}
console.log(JSON.stringify(out, null, 1));
