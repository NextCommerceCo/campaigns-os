import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { readdirSync, realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const cli = resolve(import.meta.dirname, '../bin/campaigns-os.mjs');
test('lightweight CLI commands do not load QA, while QA dispatch still does', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-loading-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const loader = join(dir, 'reject-qa.mjs');
  writeFileSync(loader, `export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/qa-node.mjs')) throw new Error('QA_MODULE_LOADED');
    return nextResolve(specifier, context);
  }`);
  const run = args => spawnSync(process.execPath, ['--loader', pathToFileURL(loader).href, cli, ...args], {
    cwd: dir, encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: dir, CAMPAIGNS_OS_TELEMETRY: 'off' },
  });
  const help = run(['help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /campaigns-os/);
  const doctor = run(['doctor', '--packet', join(dir, 'missing.json')]);
  assert.notEqual(doctor.status, 0);
  assert.match(doctor.stderr, /file not found/);
  assert.doesNotMatch(doctor.stderr, /QA_MODULE_LOADED/);
  const journal = join(dir, 'lifecycle.jsonl');
  const qa = run(['qa', '--help', '--lifecycle-journal', journal]);
  assert.notEqual(qa.status, 0);
  assert.match(qa.stderr, /QA_MODULE_LOADED/);
  const lifecycle = JSON.parse(readFileSync(journal, 'utf8').trim());
  assert.equal(lifecycle.command, 'qa');
  assert.equal(lifecycle.exit_status, 1);
  const ordinaryQa = spawnSync(process.execPath, [cli, 'qa', '--help'], {
    cwd: dir, encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: dir, CAMPAIGNS_OS_TELEMETRY: 'off' },
  });
  assert.equal(ordinaryQa.status, 0, ordinaryQa.stderr);
  assert.match(ordinaryQa.stdout, /campaigns-os qa/);
});

// Source-observed, because an import of the CLI from these modules loads
// without a cycle or ordering error: nothing at runtime would notice it.
test('doctor and the shared helper modules never import the CLI module', () => {
  const src = import.meta.dirname;
  const cliModule = join(src, 'cli.mjs');
  const files = [
    ...readdirSync(join(src, 'doctor'), { recursive: true })
      .filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
      .map(name => join(src, 'doctor', name)),
    join(src, 'install-invocation.mjs'),
    join(src, 'cli-helpers.mjs'),
    join(src, 'campaigns-api-key.mjs'),
  ];
  assert.ok(files.length > 0, 'no modules were scanned');
  assert.ok(files.includes(join(src, 'doctor', 'checks.mjs')), 'src/doctor/checks.mjs was not scanned');
  // Parsed, not pattern-matched: a comment or unusual spacing between
  // `import` and its specifier must not hide the dependency.
  const moduleSpecifiers = source => {
    const specifiers = [];
    const visit = node => {
      if (!node || typeof node.type !== 'string') return;
      if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
        if (node.source) specifiers.push(node.source.value);
      } else if (node.type === 'ImportExpression') {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') specifiers.push(node.source.value);
        else if (node.source.type === 'TemplateLiteral' && node.source.expressions.length === 0) specifiers.push(node.source.quasis[0].value.cooked);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value);
      }
    };
    visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
    return specifiers;
  };
  // Classified the way Node classifies a specifier: `./`, `../` and `/` are
  // relative URLs against the importing file, an absolute URL is taken as is,
  // and everything else is a bare package or builtin, which cannot be this
  // file. Percent-encoding decodes through fileURLToPath; the native realpath
  // folds symlinks and, on a case-insensitive disk, letter case.
  const samePath = path => { try { return realpathSync.native(path); } catch { return path; } };
  const cliPath = samePath(cliModule);
  const resolvesToCli = (file, specifier) => {
    let url;
    if (/^(\.\.?\/|\/)/.test(specifier)) url = new URL(specifier, pathToFileURL(file));
    else { try { url = new URL(specifier); } catch { return false; } }
    if (url.protocol !== 'file:') return false;
    return samePath(fileURLToPath(url)) === cliPath;
  };
  for (const file of files) {
    for (const specifier of moduleSpecifiers(readFileSync(file, 'utf8'))) {
      assert.ok(
        !resolvesToCli(file, specifier),
        `src/${relative(src, file)} imports the CLI module as "${specifier}"`,
      );
    }
  }
});
