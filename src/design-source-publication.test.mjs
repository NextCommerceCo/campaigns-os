import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse } from 'acorn';
import { withDesignSourcePublication } from './design-source-publication.mjs';
import { computeDesignSourcePackageMaterialFingerprint } from './design-source-package.mjs';

const src = import.meta.dirname;
const ownerPath = realpathSync(join(src, 'design-source-publication.mjs'));

for (const [sourceKind, adopted, recovery] of [
  ['figma_frames', false, path => 'prepare-build cannot show it synthesized these bytes (no Assembly Report records them as its own output, or the package changed since), so it will not overwrite it. '
    + `Reconcile the package with the current inputs, or, if no downstream stage has consumed it, delete ${path} and rerun prepare-build to synthesize a fresh one.`],
  ['figma_frames', true, () => 'Keep the original source-kind declaration; --adopt cannot convert an existing package.'],
  ['html_funnel', true, () => 'Keep the original source-kind declaration; --adopt cannot convert an existing package.'],
  ['built_first', false, () => 'This package was declared built first; rerun with --adopt src/example-route. Keep the original source-kind declaration; an intake without --adopt cannot change it.'],
]) {
  test(`source-kind refusal recovery for ${sourceKind}, adoption: ${adopted}`, async t => {
    const target = mkdtempSync(join(tmpdir(), 'campaigns-os-source-recovery-'));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    const sourceRoot = join(target, 'source');
    mkdirSync(sourceRoot);
    const outputs = Object.fromEntries(['packet', 'context', 'report', 'doctorOut', 'brief'].map(name => [`${name}Path`, join(target, `${name}.json`)]));
    const inputs = {
      activePages: [], mappings: [], manifestResult: { manifest: null }, sourceAssetCrawl: null, templateFamily: null,
      templateStockPageIds: [], commerceCatalog: null, sourceRoot, mapId: 'example-map', publicRouteSlug: 'example-route',
    };
    const original = await withDesignSourcePublication({ targetRepo: target, outputs }, publication => publication.package(inputs));
    const value = { ...original.value, source_kind: sourceKind };
    value.material_fingerprint = computeDesignSourcePackageMaterialFingerprint(value);
    const bytes = `${JSON.stringify(value)}\n`;
    writeFileSync(original.path, bytes);
    for (const force of [false, true]) {
      await assert.rejects(withDesignSourcePublication({ targetRepo: target, outputs, force }, publication => publication.package({ ...inputs, adopted })), error => {
        assert.ok(error.message.startsWith(`Design Source Package at ${original.path} is invalid, stale, or contradictory: `), error.message);
        assert.ok(error.message.endsWith(recovery(original.path)), error.message);
        if (sourceKind === 'figma_frames' && !adopted) {
          assert.equal(error.message, `Design Source Package at ${original.path} is invalid, stale, or contradictory: declares source_kind "figma_frames"; html_funnel prepare-build requires "html_funnel". ${recovery(original.path)}`);
        }
        return true;
      });
      assert.equal(readFileSync(original.path, 'utf8'), bytes, 'refusal must preserve the existing package');
    }
  });
}

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
  assert.deepEqual(ownerImports[0].specifiers.map(specifier => specifier.imported.name).sort(),
    ['readRecordedDesignSourcePackage', 'withDesignSourcePublication'], 'the CLI uses the publication entry and its shared recorded-intake reader');
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
