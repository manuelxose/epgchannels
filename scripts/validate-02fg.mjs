#!/usr/bin/env node
/**
 * TDT-API-02FG — consolidated validation runner (captain-owned).
 *
 * Runs every required stage once, in the order the execution contract fixes
 * (`build` before `typecheck`, because the workspace packages resolve emitted
 * declarations), and writes one JSON record with the real exit code, duration and
 * a bounded output tail per stage. Nothing here interprets a result: a stage is
 * `ok` only when its exit code is 0.
 *
 *   node scripts/validate-02fg.mjs            # all stages
 *   node scripts/validate-02fg.mjs build unit # selected stages
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'evidence/02fg/gate.json');

/** The order matters: see the execution contract §7. */
const STAGES = [
  { id: 'build', argv: ['npm', 'run', 'build'], cwd: ROOT, timeoutMs: 600_000 },
  { id: 'typecheck', argv: ['npm', 'run', 'typecheck'], cwd: ROOT, timeoutMs: 600_000 },
  { id: 'unit', argv: ['npm', 'run', 'test:unit'], cwd: ROOT, timeoutMs: 600_000 },
  { id: 'integration', argv: ['npm', 'run', 'test:integration'], cwd: ROOT, timeoutMs: 900_000 },
  { id: 'ingestion', argv: ['node', 'apps/backend/scripts/ingestion-scenario.mjs'], cwd: ROOT, timeoutMs: 600_000 },
  { id: 'independence', argv: ['npm', 'run', 'test:independence'], cwd: ROOT, timeoutMs: 600_000 },
  { id: 'client', argv: ['npm', 'run', 'test', '-w', '@tdt/api-client'], cwd: ROOT, timeoutMs: 600_000 },
  { id: 'frontend-build', argv: ['npm', '--prefix', 'apps/frontend', 'run', 'build'], cwd: ROOT, timeoutMs: 600_000 },
  { id: 'frontend-unit', argv: ['npm', '--prefix', 'apps/frontend', 'run', 'test'], cwd: ROOT, timeoutMs: 900_000 },
  { id: 'openapi', argv: ['npm', 'run', 'openapi:export'], cwd: ROOT, timeoutMs: 300_000 },
  { id: 'migrations', argv: ['npm', 'run', 'migrate', '--', 'status'], cwd: ROOT, timeoutMs: 300_000 },
];

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const selected = requested.length === 0 ? STAGES : STAGES.filter((stage) => requested.includes(stage.id));

function tail(text, limit = 2_500) {
  const trimmed = (text ?? '').trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(trimmed.length - limit)}`;
}

const results = [];
let failed = 0;
for (const stage of selected) {
  const startedAt = Date.now();
  const run = spawnSync(stage.argv[0], stage.argv.slice(1), {
    cwd: stage.cwd,
    shell: process.platform === 'win32',
    encoding: 'utf8',
    timeout: stage.timeoutMs,
    env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
  });
  const durationMs = Date.now() - startedAt;
  const ok = run.status === 0;
  if (!ok) failed += 1;
  const combined = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const summary =
    (combined.match(/(Tests\s+\d+.*|Test Files\s+\d+.*|SUMMARY.*|PASS .*|OK .*)/g) ?? []).slice(-4).join(' | ') ||
    tail(combined, 400);
  results.push({
    id: stage.id,
    argv: stage.argv.join(' '),
    exitCode: run.status,
    timedOut: run.error?.code === 'ETIMEDOUT' || run.signal === 'SIGTERM',
    durationMs,
    ok,
    summary,
    outputTail: ok ? null : tail(combined),
  });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage.id.padEnd(16)} exit=${String(run.status).padEnd(4)} ${(durationMs / 1000).toFixed(1)}s  ${summary}`);
}

const record = {
  schemaVersion: 'tdt-02fg-gate/1',
  generatedAt: new Date().toISOString(),
  commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim(),
  branch: spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim(),
  stages: results,
  failed,
  verdict: failed === 0 ? 'PASS' : 'FAIL',
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
console.log(`\n${record.verdict}: ${results.length - failed}/${results.length} stages green → ${OUT}`);
process.exit(failed === 0 ? 0 : 1);
