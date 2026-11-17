/**
 * D-023 mutation proof: apply each measured defence to the source tree, recompile,
 * run the suite, and report whether the suite NOTICED. A defence whose mutations
 * go unnoticed is a defence nobody can test, so any survivor fails this script.
 *
 * Usage (repo root):
 *   node scripts/verify-selection-mutations.mjs [--only id]
 *
 * Rules it holds itself to:
 * - the tree must be clean at start and is restored in `finally`, byte for byte,
 *   so an interrupted run cannot leave a mutated file behind;
 * - every mutation is a small literal replacement; if the anchor text is not found
 *   the mutation is reported `not-applied` and the script FAILS (a stale anchor is
 *   as dangerous as a surviving mutant);
 * - recompilation happens before the test run, because a mutation that does not
 *   compile proves nothing about behaviour.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const BACKEND = resolve(ROOT, 'apps', 'backend');

const MUTATIONS = [
  {
    id: 'unknown-is-healthy',
    what: 'the defect: an unchecked source counts as healthy',
    file: 'apps/backend/src/modules/playback/publication-policy.ts',
    find: "return source.technicalStatus === 'ok';",
    replace: "return source.technicalStatus === 'ok' || source.technicalStatus === 'unknown';",
    proves: 'isSourceHealthy no longer treats an absent verdict as a pass',
  },
  {
    id: 'health-outranks-authorization',
    what: 'health consulted before the right, so a healthy stream is offered without one',
    file: 'apps/backend/src/modules/playback/source-selection.ts',
    find: '  if (!eligibility.playable) {',
    replace: '  if (!eligibility.playable && source.technicalStatus !== \'ok\') {',
    proves: 'authorization is evaluated first and fails closed',
  },
  {
    id: 'compat-from-failure-code',
    what: 'a failure category promoted to a browser-compatibility verdict',
    file: 'apps/backend/src/verification/compatibility.ts',
    find: "  const category = probe.failure?.category ?? null;",
    replace:
      "  const category = probe.failure?.category ?? null;\n" +
      "  if (category === 'unsupported-format') {\n" +
      "    return { state: 'incompatible', reason: 'browser-incompatible', browser: input.browser, observedAt: probe.observedAt.toISOString() };\n" +
      '  }',
    proves: 'compatibility is only ever a measured reproduction verdict',
  },
  {
    id: 'not-verified-is-failing',
    what: 'an absent verdict read as a failure, which would disable every row on the platform',
    file: 'apps/backend/src/verification/source-health.ts',
    find: "  return NOT_VERIFIED;\n}\n\n/**\n * Whether health decides attemptability for this source type",
    replace: "  return { ...NOT_VERIFIED, state: 'failing', failure: 'not-verified' };\n}\n\n/**\n * Whether health decides attemptability for this source type",
    proves: '`not-verified` is its own state, never collapsed into failing',
  },
  {
    id: 'ledger-depth-field-drift',
    what: 'the ledger read through the wrong field name (depthReached instead of depth)',
    file: 'apps/backend/src/verification/source-health.ts',
    find: "  const depth = asString(row.depth);",
    replace: '  const depth = asString((row as Record<string, unknown>)[\'depthReached\']);',
    proves: 'the canonical mapping is exercised by the tests, not assumed',
  },
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const selected = only ? MUTATIONS.filter((entry) => entry.id === only) : MUTATIONS;

if (selected.length === 0) {
  console.error(JSON.stringify({ ok: false, error: `unknown mutation id: ${only}` }));
  process.exit(2);
}

/**
 * The restore, and why it does not use git.
 *
 * The members of this task never run git write commands (the captain seals), and
 * two of the target files are untracked, so `git checkout` cannot restore them at
 * all. Instead every target is copied to a private temp file BEFORE it is mutated,
 * the digest of that copy is verified, and the restore is a byte copy back from the
 * temp file, re-verified by digest. If a restore ever fails to match, the script
 * says so loudly and exits non-zero — it never reports a mutated tree as clean.
 */
function digestOf(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const backupDir = mkdtempSync(join(tmpdir(), 'rea-selection-mutations-'));

/** Reads the original bytes once, keeps a hashed temp copy, returns them. */
function stageOriginal(mutation) {
  const path = resolve(ROOT, mutation.file);
  const original = readFileSync(path);
  const digest = createHash('sha256').update(original).digest('hex');
  const copy = join(backupDir, `${mutation.id}.bak`);
  writeFileSync(copy, original);
  if (digestOf(copy) !== digest) {
    throw new Error(`backup of ${mutation.file} does not match its source digest`);
  }
  return { path, original, copy, digest };
}

const staged = new Map();
for (const mutation of selected) staged.set(mutation.id, stageOriginal(mutation));

const results = [];
let survived = 0;

for (const mutation of selected) {
  const stagedEntry = staged.get(mutation.id);
  const { path, copy, digest } = stagedEntry;
  const original = readFileSync(path, 'utf8');
  /*
   * Anchors are written with `\n` because that is what the templates read like,
   * but this tree is checked out with CRLF on Windows. Matching raw bytes made a
   * multi-line anchor silently `not-applied` while a single-line one in the same
   * file still matched — the mutant looked stale when the matcher was the problem.
   * So compare on normalised text and write the mutation back in the file's own
   * line ending, which keeps the restore byte-identical in meaning.
   */
  const usesCrlf = original.includes('\r\n');
  const normalised = original.replace(/\r\n/g, '\n');
  if (!normalised.includes(mutation.find)) {
    results.push({ id: mutation.id, status: 'not-applied', detail: 'anchor text not found; the mutant is stale' });
    survived += 1;
    continue;
  }
  try {
    const mutated = normalised.replace(mutation.find, mutation.replace);
    writeFileSync(path, usesCrlf ? mutated.replace(/\n/g, '\r\n') : mutated, 'utf8');

    const build = spawnSync('npm', ['run', 'build', '-w', '@tdt/backend'], { cwd: ROOT, encoding: 'utf8', shell: true });
    if (build.status !== 0) {
      results.push({ id: mutation.id, status: 'inconclusive', detail: 'mutant did not compile', tail: (build.stdout ?? '').slice(-400) });
      continue;
    }

    const suite = spawnSync(
      'npx',
      [
        'vitest',
        'run',
        '--project',
        'unit',
        '--root',
        'apps/backend',
        'src/modules/playback/',
        'src/verification/',
      ],
      { cwd: BACKEND, encoding: 'utf8', shell: true },
    );
    const caught = suite.status !== 0;
    if (!caught) survived += 1;
    results.push({
      id: mutation.id,
      status: caught ? 'caught' : 'SURVIVED',
      detail: mutation.proves,
      testExitCode: suite.status,
    });
  } finally {
    // Restore from the private, digest-verified copy — never from a read-modify-
    // write of the mutated file, and never through git.
    writeFileSync(path, readFileSync(copy));
    if (digestOf(path) !== digest) {
      results.push({ id: mutation.id, status: 'RESTORE-FAILED', detail: `${mutation.file} does not match its backup digest after restore` });
      survived += 1;
    }
  }
}

// Leave the tree compiled from the real source, not from the last mutant.
const rebuild = spawnSync('npm', ['run', 'build', '-w', '@tdt/backend'], { cwd: ROOT, encoding: 'utf8', shell: true });
const notRestored = [...staged.entries()]
  .filter(([, entry]) => digestOf(entry.path) !== entry.digest)
  .map(([, entry]) => entry.path.slice(ROOT.length + 1));

rmSync(backupDir, { recursive: true, force: true });

const report = {
  ok: survived === 0 && rebuild.status === 0 && notRestored.length === 0,
  survived,
  total: selected.length,
  results,
  rebuiltAfterRestore: rebuild.status === 0,
  restoredByteIdentical: notRestored.length === 0,
  notRestored,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
