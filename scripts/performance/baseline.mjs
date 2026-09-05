// Fresh-process samples, warm OS filesystem cache. Run from a prepared worktree.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, platform, arch, tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const samples = Number(process.argv[2] ?? 5);
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 30, 'samples must be 1..30');
const sandbox = mkdtempSync(join(tmpdir(), 'campaigns-os-perf-env-'));
// Do not inherit ambient campaigns credentials, sessions, or telemetry settings.
const env = {
  PATH: process.env.PATH, HOME: sandbox, TMPDIR: sandbox,
  CAMPAIGNS_OS_TELEMETRY: 'off', CI: 'true',
};
const run = (file, args, options = {}) => execFileSync(file, args, {
  cwd: root, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options,
});
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return { samples: values, min: sorted[0], median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, max: sorted.at(-1) };
}
try {
  // Rebuild before any import-based workload so results cannot use stale dist.
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'campaign-spec/tsconfig.build.json']);
  const result = {
    schema: 'campaigns-os-performance-baseline/v1',
    measured_at: new Date().toISOString(),
    commit: run('git', ['rev-parse', 'HEAD']).trim(),
    tracked_diff_sha256: createHash('sha256').update(run('git', ['diff', 'HEAD', '--'])).digest('hex'),
    working_tree_status: run('git', ['status', '--porcelain']).trim(),
    node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
    sample_count: samples, cache: 'fresh process; OS filesystem cache not flushed', workloads: {},
  };
  for (const name of ['help', 'doctor', 'copy-scans', 'static-qa', 'cycle-chain', 'build-spec']) {
    const rows = [];
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      if (name === 'help') {
        const output = run(process.execPath, [join(root, 'bin/campaigns-os.mjs'), 'help'], { cwd: sandbox });
        assert.match(output, /campaigns-os/);
        rows.push({ duration_ms: performance.now() - start });
      } else if (name === 'build-spec') {
        run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'campaign-spec/tsconfig.build.json']);
        rows.push({ duration_ms: performance.now() - start });
      } else {
        rows.push(JSON.parse(run(process.execPath, ['scripts/performance/worker.mjs', name])));
      }
    }
    if (rows[0].output_sha256) {
      assert.equal(new Set(rows.map(row => row.output_sha256)).size, 1, `${name} output changed between samples`);
    }
    result.workloads[name] = { duration_ms: summarize(rows.map(row => row.duration_ms)), evidence: rows };
  }
  result.harness_sha256 = createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .update(readFileSync(join(root, 'scripts/performance/worker.mjs'))).digest('hex');
  console.log(JSON.stringify(result, null, 2));
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
