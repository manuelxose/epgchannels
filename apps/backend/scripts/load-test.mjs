/**
 * Load test: bounded concurrency against the real API.
 *
 * No dependency: it measures what matters for the acceptance criteria (latency
 * percentiles, error rate, throughput) and fails with a non-zero exit when a
 * budget is exceeded, so it can gate a release.
 *
 *   node scripts/load-test.mjs --base http://127.0.0.1:4010/api/v1 --requests 2000 --concurrency 25
 */
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const base = argOf('--base', process.env.API_BASE ?? 'http://127.0.0.1:4010/api/v1');
const total = Number(argOf('--requests', '1000'));
const concurrency = Number(argOf('--concurrency', '20'));
const budgetP95 = Number(argOf('--p95-ms', '400'));
const budgetErrorRate = Number(argOf('--max-error-rate', '0.01'));

/** A deterministic mix of the endpoints a real client uses. */
const mix = [
  { weight: 40, path: (page) => `/channels?page=${1 + (page % 10)}&pageSize=24` },
  { weight: 15, path: () => '/channels?q=la' },
  { weight: 10, path: () => '/channels?category=deportes' },
  { weight: 10, path: () => '/categories' },
  { weight: 10, path: () => '/regions' },
  { weight: 10, path: () => '/epg/now?limit=20' },
  { weight: 5, path: () => '/health' },
];
const weighted = mix.flatMap((entry) => Array.from({ length: entry.weight }, () => entry));

function pathFor(index) {
  return weighted[index % weighted.length].path(index);
}

const latencies = [];
let errors = 0;
let statusCounts = {};

async function one(index) {
  const started = performance.now();
  try {
    const response = await fetch(`${base}${pathFor(index)}`, { headers: { accept: 'application/json' } });
    await response.arrayBuffer();
    statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1;
    if (!response.ok && response.status !== 304) errors += 1;
  } catch {
    errors += 1;
  } finally {
    latencies.push(performance.now() - started);
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index];
}

async function main() {
  const started = performance.now();
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= total) return;
      await one(index);
    }
  });
  await Promise.all(workers);
  const elapsedMs = performance.now() - started;

  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const p99 = percentile(latencies, 0.99);
  const errorRate = errors / total;
  const rps = total / (elapsedMs / 1000);

  const report = {
    command: 'load-test',
    base,
    requests: total,
    concurrency,
    elapsedMs: Math.round(elapsedMs),
    requestsPerSecond: Number(rps.toFixed(1)),
    latencyMs: { p50: Math.round(p50), p95: Math.round(p95), p99: Math.round(p99) },
    errors,
    errorRate: Number(errorRate.toFixed(4)),
    statusCounts,
    budgets: { p95Ms: budgetP95, errorRate: budgetErrorRate },
  };

  const failed = [];
  if (total < 1) failed.push('no requests issued');
  if (p95 > budgetP95) failed.push(`p95 ${Math.round(p95)}ms exceeds ${budgetP95}ms`);
  if (errorRate > budgetErrorRate) failed.push(`error rate ${errorRate} exceeds ${budgetErrorRate}`);

  console.log(JSON.stringify({ ...report, verdict: failed.length === 0 ? 'PASS' : 'FAIL', failures: failed }, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ command: 'load-test', verdict: 'FAIL', error: String(error) }));
  process.exitCode = 1;
});
