import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import { campaignIdentitiesMatch, campaignSpecIdentity, localSpecIdentityFields, resolveCampaignIdentity } from './spec-source-identity.mjs';
import { doctorPacket, recordQaStageOutcome } from './cli.mjs';
import { __qaNodeTestHooks } from './qa-node.mjs';
import { qaVerdictIdentityMatch, discoverQaVerdicts } from './qa-verdict-discovery.mjs';
import { publishStoredVerdict } from './qa-publish.mjs';
import { publishQaVerdict } from './qa-verdict-publish.mjs';
import { assemblyReportMatchesPacket } from './stage-ledger.mjs';
import { identityMatches } from './run-record-closeout.mjs';
import { specMaterialHash } from './spec-identity.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const CLI = join(ROOT, 'bin/campaigns-os.mjs');
const LOCAL_ID = '831db9b2-9055-45e4-a9c0-3ef04b2b06f0';
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
function run(argv, cwd) {
  return spawnSync(process.execPath, [CLI, ...argv, '--json'], { cwd, encoding: 'utf8', env: { ...process.env, CAMPAIGNS_OS_TELEMETRY: 'off' } });
}
function fixture(t, { identity = { local_spec_id: LOCAL_ID } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'local-spec-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'target');
  cpSync(join(ROOT, 'examples/target-page-kit'), target, { recursive: true });
  cpSync(join(ROOT, 'examples/source-html'), join(target, 'source'), { recursive: true });
  const spec = read(join(ROOT, 'examples/campaignspec.v42.basic.json'));
  delete spec.map_id;
  spec.spec_identity = { ...identity, public_route_slug: spec.spec_identity.public_route_slug };
  const specPath = join(target, 'campaign-spec.json');
  write(specPath, spec);
  const args = ['prepare-build', '--spec', specPath, '--source', join(target, 'source'), '--target', target, '--template-family', 'olympus', '--no-run-session'];
  return { dir, target, spec, specPath, args, packetPath: join(target, 'campaign-runtime.build.json'), reportPath: join(target, '.campaign-runtime/assembly-report.json') };
}
function prepare(f) {
  const result = run(f.args, f.dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { packet: read(f.packetPath), report: read(f.reportPath) };
}
const ajv = new Ajv({ strict: false, validateFormats: false });
function schemaValid(file, value) {
  const validator = ajv.compile(read(join(ROOT, 'schemas', file)));
  assert.equal(validator(value), true, JSON.stringify(validator.errors));
}

test('local identity is distinct from Map identity and rejects ambiguous/path-shaped IDs', () => {
  assert.equal(campaignIdentitiesMatch({ map_id: LOCAL_ID }, { local_spec_id: LOCAL_ID }), false);
  for (const fields of [{}, { map_id: 'map', local_spec_id: LOCAL_ID }, { local_spec_id: '../escape' }, { local_spec_id: '' }, { local_spec_id: 42 }]) {
    assert.equal(resolveCampaignIdentity(fields), null);
  }
  assert.equal(campaignIdentitiesMatch({ map_id: null, local_spec_id: LOCAL_ID }, { local_spec_id: LOCAL_ID }), true);
  assert.deepEqual(resolveCampaignIdentity({ map_id: '  existing-map  ' }), { kind: 'saved_map', id: 'existing-map' });
  assert.deepEqual(localSpecIdentityFields({ map_id: 'existing-map' }), {});
  assert.deepEqual(localSpecIdentityFields({ map_id: null, local_spec_id: LOCAL_ID }), { local_spec_id: LOCAL_ID });
  for (const fields of [{ local_spec_id: '  existing-map  ' }, { local_spec_id: '' }, { local_spec_id: '../escape' }, { local_spec_id: 'x'.repeat(65) }, { local_spec_id: 42 }, { local_spec_id: LOCAL_ID, map_id: 'existing-map' }]) {
    assert.equal(resolveCampaignIdentity(fields), null);
    assert.throws(() => localSpecIdentityFields(fields), /Invalid local_spec_id/);
  }
});

test('doctor diagnoses malformed local identities without adopting them or throwing', t => {
  const f = fixture(t);
  const { packet, report } = prepare(f);
  const reportBytes = readFileSync(f.reportPath, 'utf8');
  for (const fields of [{ local_spec_id: ' padded ' }, { local_spec_id: '' }, { local_spec_id: 42 }, { local_spec_id: LOCAL_ID, map_id: 'saved-map' }]) {
    write(f.packetPath, { ...packet, spec: { ...packet.spec, ...fields } });
    const doctor = doctorPacket(f.packetPath);
    assert.equal(doctor.status, 'blocked');
    assert.ok(doctor.errors.some(issue => issue.code === 'spec.local_identity' && issue.detail?.kind === 'local_spec'));
    assert.equal(doctor.errors.some(issue => issue.code === 'spec.map_id'), false);
    assert.equal(doctor.derived.local_spec_id, undefined);
    const next = JSON.parse(run(['next', '--packet', f.packetPath, '--no-write'], f.dir).stdout);
    assert.equal(next.ok, false);
    assert.equal(readFileSync(f.reportPath, 'utf8'), reportBytes);
  }
  write(f.packetPath, packet);
  write(f.reportPath, { ...report, identity: { ...report.identity, local_spec_id: ' bad-report ' } });
  assert.equal(doctorPacket(f.packetPath).derived.prepare_build_gate.binding_failure, true);
});

test('prepare, doctor, next and fresh-checkout continuation retain local identity and revision binding', t => {
  const f = fixture(t);
  const { packet, report } = prepare(f);
  assert.equal(packet.spec.map_id, null);
  assert.equal(packet.spec.local_spec_id, LOCAL_ID);
  assert.equal(packet.spec.spec_url, null);
  assert.equal(report.identity.local_spec_id, LOCAL_ID);
  assert.equal(report.identity.spec_material_hash, specMaterialHash(f.spec));
  schemaValid('campaign-runtime-build-packet.v0.schema.json', packet);
  schemaValid('campaign-runtime-assembly-report.v0.schema.json', report);
  schemaValid('campaign-spec.v4.schema.json', f.spec);
  const specValidator = ajv.getSchema('https://nextcommerce.com/schemas/campaign-spec.v4.schema.json');
  assert.equal(specValidator({ ...f.spec, map_id:'borrowed' }),false);
  assert.equal(specValidator({ ...f.spec, spec_identity:{ ...f.spec.spec_identity,map_id:'borrowed' } }),false);
  const reportValidator = new Ajv({strict:false,validateFormats:false}).compile(read(join(ROOT,'schemas/campaign-runtime-assembly-report.v0.schema.json')));
  const noIdentity=structuredClone(report);delete noIdentity.identity.local_spec_id;
  assert.equal(reportValidator(noIdentity),false);
  const doctor = doctorPacket(f.packetPath);
  assert.equal(doctor.derived.local_spec_id, LOCAL_ID);
  assert.equal(doctor.errors.some(e => e.code === 'spec.map_id'), false);
  assert.equal(doctor.warnings.some(e => e.code === 'spec_identity.export'), false);
  assert.equal(doctor.derived.prepare_build_gate?.binding_failure === true, false);
  const next = run(['next', '--packet', f.packetPath, '--no-write'], f.dir);
  const nextResult = JSON.parse(next.stdout);
  assert.equal(nextResult.doctor?.derived?.prepare_build_gate?.binding_failure === true, false);
  const copied = join(f.dir, 'second-checkout');
  cpSync(f.target, copied, { recursive: true });
  const copiedDoctor = doctorPacket(join(copied, 'campaign-runtime.build.json'));
  assert.equal(copiedDoctor.derived.local_spec_id, LOCAL_ID);
  assert.equal(copiedDoctor.derived.prepare_build_gate?.binding_failure === true, false);
  assert.equal(assemblyReportMatchesPacket(report, packet), true);
  assert.equal(identityMatches({ identity: { ...report.identity, campaign_slug: packet.campaign.public_route_slug } }, packet), true);
  const foreignReport = structuredClone(report);
  foreignReport.identity.local_spec_id = 'different-local-campaign';
  assert.equal(assemblyReportMatchesPacket(foreignReport, packet), false);
  write(f.reportPath, foreignReport);
  assert.equal(doctorPacket(f.packetPath).derived.prepare_build_gate.binding_failure, true);
  write(f.reportPath, report);
  const changed = structuredClone(f.spec);
  changed.campaign.currency = 'EUR';
  write(f.specPath, changed);
  assert.notEqual(specMaterialHash(changed), report.identity.spec_material_hash);
  assert.equal(doctorPacket(f.packetPath).derived.prepare_build_gate.status, 'blocked');
});

test('prepare refuses absent, conflicting and invalid identities before creating artifacts', t => {
  for (const identity of [{}, { local_spec_id: '../escape' }, { map_id: 'map', local_spec_id: LOCAL_ID }]) {
    const f = fixture(t, { identity });
    const result = run(f.args, f.dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one identity/);
    assert.equal(existsSync(f.packetPath), false);
  }
});

test('local packet QA resolves, finalizes a blocked verdict and never posts it, even with an explicit publish flag', async t => {
  const f = fixture(t);
  const { packet } = prepare(f);
  const campaignsPath = join(f.target, '_data/campaigns.json');
  const campaigns = read(campaignsPath);
  campaigns[packet.campaign.public_route_slug].store_url = 'https://wrong-store.invalid';
  write(campaignsPath, campaigns);
  const args = { _: ['qa', 'run'], packet: f.packetPath, 'base-url': 'http://localhost:8080', 'post-verdict': true };
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => { requests.push(String(input)); throw new Error('fixture route offline'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(__qaNodeTestHooks.resolveQaInputs({ _: ['qa','run','saved-map'], spec: f.specPath }), /requires --packet/);
  const resolved = await __qaNodeTestHooks.resolveQaInputs(args);
  assert.equal(resolved.mapId, null);
  assert.equal(resolved.localSpecId, LOCAL_ID);
  assert.equal(resolved.portalManaged, false);
  // The fixture lacks completed commerce/visual proof; identity support must not bypass those gates.
  const result = await __qaNodeTestHooks.runResolvedQa(args, resolved);
  assert.equal(result.status, 'blocked');
  assert.equal(result.publish_skipped, true);
  assert.equal(result.dashboard_url, null);
  assert.equal(result.publish_decision.reason, 'local_spec');
  assert.equal(requests.some(url => /\/api\/(spec|qa|maps)/.test(url)), false);
  const verdict = read(result.local_path);
  assert.equal(verdict.local_spec_id, LOCAL_ID);
  assert.equal(qaVerdictIdentityMatch(verdict, packet), true);
  assert.equal(qaVerdictIdentityMatch({ ...verdict, local_spec_id: 'other' }, packet), false);
  assert.equal(qaVerdictIdentityMatch({ ...verdict, local_spec_id: undefined, campaign_slug: packet.campaign.public_route_slug }, packet), false);
  const sidecar = read(join(f.target, '.campaign-runtime/qa-verdict.json'));
  assert.equal(sidecar.local_spec_id, LOCAL_ID);
  schemaValid('campaigns-os-qa-verdict.v0.schema.json', verdict);
  schemaValid('campaigns-os-qa-verdict-sidecar.v0.schema.json', sidecar);
  assert.equal(discoverQaVerdicts({ packet, roots: [f.target] }).filter(x => x.identityMatch).length, 1);
  const publish = await publishStoredVerdict({ packet: f.packetPath }, { post: async () => { throw new Error('unexpected publish'); } });
  assert.equal(publish.refusal.code, 'local_spec');
  assert.equal((await publishQaVerdict(verdict, 'http://localhost:1')).attempted, false);
  const recordArgs = ['run-record','--packet',f.packetPath,'--no-remit'];
  const persisted=run([...recordArgs,'--run-id','run_local_identity'],f.dir);
  assert.equal(persisted.status,0,persisted.stderr);
  const recordResult=JSON.parse(persisted.stdout);
  const record=read(recordResult.record_path);
  assert.equal(record.identity.local_spec_id,LOCAL_ID);
  assert.equal(record.identity.map_id,null);
  assert.equal(record.observations.qa.disposition,'blocked');
  assert.equal(identityMatches(record,packet),true);
  const resumed=JSON.parse(run(recordArgs,f.dir).stdout);
  assert.equal(resumed.record.run_id,'run_local_identity');
  assert.equal(resumed.run_id_source,'latest_record');
  const foreign=structuredClone(verdict);delete foreign.local_spec_id;
  foreign.disposition='ready';
  write(result.local_path,foreign);
  const inferred=JSON.parse(run([...recordArgs,'--new-run','--no-write'],f.dir).stdout);
  assert.equal(inferred.record.artifacts.some(a=>a.kind==='qa_verdict'),false,'foreign saved-Map verdict in local directory is not inferred');
  const explicit=run([...recordArgs,'--qa-verdict',result.local_path],f.dir);
  assert.notEqual(explicit.status,0);
  assert.match(explicit.stderr,/does not match.*local_spec_id/);
  write(result.local_path,verdict);
  const savedPacket=structuredClone(packet);savedPacket.spec.map_id=verdict.campaign_slug;delete savedPacket.spec.local_spec_id;
  write(f.packetPath,savedPacket);
  const savedInferred=JSON.parse(run([...recordArgs,'--new-run','--no-write'],f.dir).stdout);
  assert.equal(savedInferred.record.artifacts.some(a=>a.kind==='qa_verdict'),false,'saved Map cannot infer local verdict with same storage key');
  assert.notEqual(run([...recordArgs,'--qa-verdict',result.local_path],f.dir).status,0);
  write(f.packetPath,packet);
  assert.equal(recordQaStageOutcome(args,result),true);
  const beforeStage=readFileSync(f.reportPath,'utf8');
  assert.equal(recordQaStageOutcome(args,{...result,verdict:{...verdict,local_spec_id:'other'}}),false);
  assert.equal(readFileSync(f.reportPath,'utf8'),beforeStage);
  assert.equal(recordQaStageOutcome(args,{...result,verdict:{...verdict,spec_hash:'sha256:'+'0'.repeat(64)}}),false);
  assert.equal(readFileSync(f.reportPath,'utf8'),beforeStage);
  const currentReport = read(f.reportPath);
  write(f.reportPath, { ...currentReport, identity: { ...currentReport.identity, local_spec_id: 'foreign' } });
  await assert.rejects(__qaNodeTestHooks.resolveQaInputs(args), /matching Assembly Report/);
  write(f.reportPath, currentReport);
  const revised = structuredClone(f.spec);
  revised.campaign.currency = 'EUR';
  write(f.specPath, revised);
  await assert.rejects(__qaNodeTestHooks.resolveQaInputs(args), /current spec material hash/);
  f.spec.spec_identity.local_spec_id = 'other';
  write(f.specPath, f.spec);
  await assert.rejects(__qaNodeTestHooks.resolveQaInputs(args), /does not match/);
  assert.equal(doctorPacket(f.packetPath).errors.some(e => e.code === 'spec.local_identity' && e.detail?.kind === 'local_spec'), true);
  await assert.rejects(__qaNodeTestHooks.resolveQaInputs({ ...args, 'map-id': 'invented' }), /Map ID override/);
});

test('page-kit sync and spec derive accept local identity and refuse a foreign local spec before writes', t => {
  const f=fixture(t);
  prepare(f);
  for(const command of [['page-kit','sync'],['spec','derive']]) {
    const positive=run([...command,'--packet',f.packetPath,'--dry-run'],f.dir);
    const result=JSON.parse(positive.stdout);
    assert.equal((result.errors||[]).some(e=>e.code.endsWith('spec_identity_mismatch')),false,positive.stdout);
  }
  f.spec.spec_identity.local_spec_id='foreign-local';write(f.specPath,f.spec);
  const specBytes=readFileSync(f.specPath,'utf8');
  const configPath=join(f.target,'_data/campaigns.json');
  const configBytes=readFileSync(configPath,'utf8');
  for(const command of [['page-kit','sync'],['spec','derive']]) {
    const negative=run([...command,'--packet',f.packetPath],f.dir);
    assert.notEqual(negative.status,0,negative.stdout);
    assert.ok(JSON.parse(negative.stdout).errors.some(e=>e.code.endsWith('spec_identity_mismatch')));
    assert.equal(readFileSync(f.specPath,'utf8'),specBytes);
    assert.equal(readFileSync(configPath,'utf8'),configBytes);
  }
});
