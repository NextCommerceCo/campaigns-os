import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
test('standalone packing rebuilds, pipeline packing reuses, and missing dist fails closed', { timeout: 30_000 }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'pack-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Copy tracked working files, never .git or another stream's generated state.
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const path of paths) {
    const destination = join(dir, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, path), destination);
  }
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  // Record the lifecycle boundary inside the isolated fixture, then run real tsc.
  pkg.scripts['build:spec'] = `node ./record-build.mjs && ${pkg.scripts['build:spec']}`;
  writeFileSync(pkgPath, JSON.stringify(pkg));
  writeFileSync(join(dir, 'record-build.mjs'), `import { appendFileSync } from 'node:fs'; appendFileSync('build-count.txt', 'build\\n');`);
  const scratch = join(dir, 'tmp');
  mkdirSync(scratch);
  const run = extra => spawnSync(process.execPath, ['scripts/check-pack.mjs', ...extra], {
    cwd: dir, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, TMPDIR: scratch, npm_config_cache: join(dir, '.npm-cache') },
  });
  const standalone = run([]);
  assert.equal(standalone.status, 0, standalone.stderr);
  const recorded = readFileSync(join(dir, 'build-count.txt'), 'utf8');
  assert.equal(recorded, 'build\n');
  const pipeline = run(['--skip-prepare']);
  assert.equal(pipeline.status, 0, pipeline.stderr);
  assert.equal(readFileSync(join(dir, 'build-count.txt'), 'utf8'), recorded);
  rmSync(join(dir, 'campaign-spec/dist'), { recursive: true });
  const missing = run(['--skip-prepare']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /dist\/index.js missing/);
  assert.deepEqual(readdirSync(scratch).filter(name => name.startsWith('campaigns-os-pack-')), [], 'failed packing must remove its tarball and extraction');
  assert.equal(readFileSync(join(dir, 'build-count.txt'), 'utf8'), recorded);
});
