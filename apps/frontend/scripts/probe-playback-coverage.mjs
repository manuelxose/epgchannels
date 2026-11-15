// Probe a sample of real catalog sources for reachability and CORS from this host.
// READ-ONLY: fetches manifests, never downloads media segments.
import { readFileSync, writeFileSync } from 'node:fs';

const tv = JSON.parse(readFileSync('../reference/data/tv.json', 'utf8'));
const channels = tv.countries.flatMap((country) => country.ambits.flatMap((ambit) => ambit.channels ?? []));

const candidates = [];
for (const channel of channels) {
  for (const option of (channel.options ?? []).slice(0, 1)) {
    if (option.format === 'm3u8') {
      candidates.push({ channel: channel.name, url: option.url, tags: (channel.extra_info ?? []).join(',') });
    }
  }
}

// Deterministic sample: first N plus spread across the list.
const sampleSize = Number(process.env['SAMPLE'] ?? 24);
const step = Math.max(1, Math.floor(candidates.length / sampleSize));
const sample = candidates.filter((_, index) => index % step === 0).slice(0, sampleSize);

const results = [];
for (const item of sample) {
  const started = Date.now();
  try {
    const response = await fetch(item.url, {
      method: 'GET',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/157 Safari/537.36',
        origin: 'http://127.0.0.1:4400',
      },
      signal: AbortSignal.timeout(12_000),
    });
    const body = response.ok ? (await response.text()).slice(0, 500) : '';
    results.push({
      channel: item.channel,
      tags: item.tags,
      status: response.status,
      cors: response.headers.get('access-control-allow-origin'),
      isManifest: body.trimStart().startsWith('#EXTM3U'),
      contentType: response.headers.get('content-type'),
      ms: Date.now() - started,
    });
  } catch (error) {
    results.push({ channel: item.channel, tags: item.tags, error: String(error).slice(0, 120), ms: Date.now() - started });
  }
}

const ok = results.filter((r) => r.isManifest);
const corsOk = ok.filter((r) => r.cors === '*' || r.cors === 'http://127.0.0.1:4400');
const report = {
  probedAt: new Date().toISOString(),
  totalHlsInCatalog: candidates.length,
  sampled: sample.length,
  manifestReachable: ok.length,
  manifestWithCors: corsOk.length,
  results,
};
writeFileSync('docs/research/PLAYBACK-PROBES.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ totalHlsInCatalog: report.totalHlsInCatalog, sampled: report.sampled, manifestReachable: report.manifestReachable, manifestWithCors: report.manifestWithCors }, null, 2));
for (const row of results) {
  console.log(`${row.status ?? 'ERR'}\tcors=${row.cors ?? '-'}\t${row.channel}${row.error ? ' — ' + row.error : ''}`);
}
