import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse } from 'acorn';
import { withDesignSourcePublication } from './design-source-publication.mjs';

const src = import.meta.dirname;
const ownerPath = realpathSync(join(src, 'design-source-publication.mjs'));

const walk = (node, visit) => {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object' && typeof value.type === 'string') walk(value, visit);
  }
};
const parseModule = path => parse(readFileSync(path, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });

// Fixed here, never derived from the owner's exports: the one exported entry
// is exactly what the CLI must import.
const OWNED_NAMES = [
  'assemblyReportStagesWithEvidence', 'guardAssemblyReportOverwrite', 'canonicalPrepareBuildOutputPath',
  'prepareBuildPathIdentity', 'PREPARE_BUILD_LOCK_SIBLING_SUFFIXES', 'prepareBuildReservedTreeContains',
  'assertOutsidePrepareBuildReservedTrees', 'assertDistinctPrepareBuildOutputPaths', 'preflightPrepareBuildOutputTargets',
  'publishPrepareBuildJsonOutputs', 'preparedDesignSourcePackageProblem', 'assertValidPreparedDesignSourcePackage',
  'readPriorDesignSourceProvenance', 'readJsonIfExistsQuietly', 'pendingDesignSourceProvenancePath',
  'recordPendingDesignSourceProvenance', 'DESIGN_SOURCE_PACKAGE_ORIGIN_SYNTHESIZED', 'DESIGN_SOURCE_PACKAGE_ORIGIN_ADOPTED',
  'sourceMaterialFile', 'manifestPagesForResolvedMappings', 'createCurrentHtmlFunnelScope', 'prepareDesignSourcePackage',
  'artifactRelativePath', 'withTargetLock', 'targetLockPath', 'linkSync',
];

test('the CLI restates no Design Source Package publication rule and imports the owner once', () => {
  const cliPath = join(src, 'cli.mjs');
  const ast = parseModule(cliPath);
  const identifiers = new Set();
  const strings = [];
  walk(ast, node => {
    if (node.type === 'Identifier') identifiers.add(node.name);
    else if (node.type === 'Literal' && typeof node.value === 'string') strings.push(node.value);
    else if (node.type === 'TemplateElement') strings.push(node.value.cooked ?? node.value.raw);
  });
  for (const name of OWNED_NAMES) assert.ok(!identifiers.has(name), `src/cli.mjs names ${name}`);
  for (const literal of ['pending-provenance', '.lock']) {
    const hit = strings.find(value => value.includes(literal));
    assert.equal(hit, undefined, `src/cli.mjs has a string containing ${JSON.stringify(literal)}`);
  }
  const ownerImports = ast.body.filter(node => node.type === 'ImportDeclaration'
    && /^\.\.?\//.test(node.source.value)
    && realpathSync(fileURLToPath(new URL(node.source.value, pathToFileURL(cliPath)))) === ownerPath);
  assert.equal(ownerImports.length, 1, 'src/cli.mjs must import the publication owner exactly once');
  assert.equal(ownerImports[0].specifiers.length, 1, 'src/cli.mjs must import exactly one binding from the publication owner');
});

test('only the publication owner takes the target lock with withTargetLock', () => {
  const callers = readdirSync(src, { recursive: true })
    .filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .filter(name => {
      let calls = false;
      walk(parseModule(join(src, name)), node => {
        if (node.type !== 'CallExpression') return;
        const callee = node.callee.type === 'MemberExpression' ? node.callee.property : node.callee;
        if (callee.type === 'Identifier' && callee.name === 'withTargetLock') calls = true;
      });
      return calls;
    });
  assert.deepEqual(callers, ['design-source-publication.mjs']);
});

test('the publication handle refuses its steps out of order and runs them in order', async t => {
  const target = mkdtempSync(join(tmpdir(), 'design-source-publication-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const sourceRoot = join(target, 'source');
  mkdirSync(sourceRoot);
  const outputs = {
    packetPath: join(target, 'campaign-runtime.build.json'),
    contextPath: join(target, 'context.json'),
    reportPath: join(target, 'report.json'),
    doctorOutPath: join(target, 'doctor.json'),
    briefPath: join(target, 'brief.json'),
  };
  const inputs = {
    activePages: [], mappings: [], manifestResult: { manifest: null }, sourceAssetCrawl: null, templateFamily: null,
    templateStockPageIds: [], commerceCatalog: null, sourceRoot, mapId: 'map-fixture', publicRouteSlug: 'fixture',
  };
  const inspection = {
    report: { status: 'fixture' },
    absolute_paths: {
      report_path: join(target, '.campaign-runtime/theme/theme-report.json'),
      css_path: join(target, '.campaign-runtime/theme/brand-theme.css'),
    },
  };
  const values = { packet: { kind: 'packet' }, brief: { kind: 'brief' }, context: { kind: 'context' }, report: { kind: 'report' } };
  const refuses = (call, message) => assert.throws(call, { name: 'TypeError', message });

  const mode = await withDesignSourcePublication({ targetRepo: target, outputs }, publication => {
    assert.deepEqual(Object.keys(publication), ['paths', 'package', 'writeTheme', 'publish', 'publishDoctorOutput']);
    refuses(() => publication.writeTheme(inspection, { writeCss: false }), /writeTheme\(\) cannot run before package\(\)/);
    refuses(() => publication.publish(values), /publish\(\) cannot run before package\(\)/);
    const prepared = publication.package(inputs);
    refuses(() => publication.package(inputs), /package\(\) already ran/);
    refuses(() => publication.publish(values), /publish\(\) cannot run before writeTheme\(\)/);
    publication.writeTheme(inspection, { writeCss: false });
    refuses(() => publication.publishDoctorOutput({}, { command: 'build' }), /publishDoctorOutput\(\) cannot run before publish\(\)/);
    publication.publish(values);
    refuses(() => publication.publish(values), /publish\(\) already ran/);
    publication.publishDoctorOutput({ schema_version: 'fixture' }, { command: 'build' });
    return prepared.mode;
  });

  assert.equal(mode, 'emitted');
  assert.ok(existsSync(join(target, '.campaign-runtime/input/design-source-package.json')));
  for (const [name, value] of Object.entries(values)) {
    assert.deepEqual(JSON.parse(readFileSync(outputs[`${name}Path`], 'utf8')), value);
  }
  assert.equal(JSON.parse(readFileSync(outputs.doctorOutPath, 'utf8')).generated_by, 'build');
  assert.ok(!existsSync(join(target, '.campaign-runtime/input/.design-source-package.json.pending-provenance.json')));
});
