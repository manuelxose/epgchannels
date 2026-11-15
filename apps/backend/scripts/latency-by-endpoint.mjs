// Latency by endpoint: where does the p95 come from?
const base = 'http://127.0.0.1:4010/api/v1';
const endpoints = [
  ['/health', 10],
  ['/categories', 10],
  ['/regions', 10],
  ['/channels?page=1&pageSize=24', 10],
  ['/channels?q=la', 10],
  ['/channels?category=deportes', 10],
  ['/epg/now?limit=20', 10],
  ['/channels/la-1/playback', 10],
  ['/channels/la-1/schedule', 10],
];

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

for (const [path, samples] of endpoints) {
  const latencies = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const response = await fetch(`${base}${path}`);
    await response.arrayBuffer();
    latencies.push(performance.now() - started);
  }
  console.log(
    path.padEnd(34),
    'p50',
    String(Math.round(percentile(latencies, 0.5))).padStart(4),
    'p95',
    String(Math.round(percentile(latencies, 0.95))).padStart(4),
    'max',
    String(Math.round(Math.max(...latencies))).padStart(4),
  );
}

// Re-validation (304) path, which is what a browser does most of the time.
const first = await fetch(`${base}/channels?page=1&pageSize=24`);
const etag = first.headers.get('etag');
await first.arrayBuffer();
const latencies = [];
for (let index = 0; index < 10; index += 1) {
  const started = performance.now();
  const response = await fetch(`${base}/channels?page=1&pageSize=24`, { headers: { 'if-none-match': etag ?? '' } });
  await response.arrayBuffer();
  latencies.push(performance.now() - started);
}
console.log('304 revalidation p50', Math.round(percentile(latencies, 0.5)), 'p95', Math.round(percentile(latencies, 0.95)));
