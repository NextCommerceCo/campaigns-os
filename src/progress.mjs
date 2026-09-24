// Portable wire contract. No filesystem, network, Node globals or lifecycle picker.
export const PROGRESS_SCHEMA_VERSION = 'campaigns-os-progress-snapshot/v0';
export const PROGRESS_STAGES = ['prepare_build', 'setup', 'assembly', 'polish', 'deploy', 'qa'];
export const PROGRESS_CONTINUATIONS = ['prepare-build', 'doctor-blocked', 'setup', 'build', 'polish', 'deploy', 'qa', 'done', 'unknown'];
export const PROGRESS_STAGE_STATUSES = ['pending', 'required', 'blocked', 'completed', 'completed_with_warnings', 'skipped', 'unknown'];
export const PROGRESS_GATE_IDS = ['doctor', 'prepare_build', 'theme_gate', 'polish_gate', 'page_kit.sdk_version', 'page_kit.store_profile', 'built_output.upsell_selector_scope', 'polish.hidden_eager_media', 'unknown'];
export const PROGRESS_ACTION_IDS = [
  'doctor_recheck', 'restore_prepare_build_binding', 'recheck', 'rerun_prepare_build',
  'divergence_inspect', 'setup_skill', 'build_skill', 'build_local_proof', 'build_production_parity',
  'polish_skill', 'deploy', 'advance', 'install_browser', 'qa_run', 'run_end', 'run_record_present',
  'run_record_remit_recovery', 'run_record_closeout', 'purchase_proof_unknown',
  'theme_gate.starter_palette_blocks_qa', 'theme_gate.brand_contract_unreadable',
  'theme_gate.theme_generate', 'theme_gate.apply_brand_layer', 'theme_gate.waive_theme', 'theme_gate.fix_load_order',
  'polish_gate.rerun_build', 'polish_gate.run_polish', 'polish_gate.repair_waiver',
  'checkpoint.page_kit.sdk_version.repair_spec', 'checkpoint.page_kit.sdk_version.refresh_spec',
  'checkpoint.page_kit.store_profile.repair_spec', 'checkpoint.built_output.upsell_selector_scope.repair_selectors',
  ...['page_kit.sdk_version', 'page_kit.store_profile', 'built_output.upsell_selector_scope'].flatMap(id => ['repair_target', 'align_store_profile', 'align_sdk_version', 'repair_waiver', 'waive'].map(action => `checkpoint.${id}.${action}`)),
  ...['capture', 'install_browser', 'repair', 'repair_authority', 'local_proof_rebuild', 'waive'].map(action => `checkpoint.polish.hidden_eager_media.${action}`),
  'unknown',
];
const str = pattern => ({type:'string', pattern});
const hash = {type:['string','null'], pattern:'^sha256:[0-9a-f]{64}$'};
const opaque = {type:['string','null'], pattern:'^[A-Za-z0-9_-]{1,64}$'};
const enumeration = values => ({enum:values});
const object = (properties, optional=[]) => ({type:'object', additionalProperties:false, required:Object.keys(properties).filter(key=>!optional.includes(key)), properties});
export const PROGRESS_SNAPSHOT_SCHEMA = {
  $schema:'https://json-schema.org/draft/2020-12/schema',
  $id:'https://nextcommerce.com/schemas/campaigns-os-progress-snapshot.v0.schema.json',
  title:'Campaigns OS minimal progress observation v0',
  ...object({
    schema_version:{const:PROGRESS_SCHEMA_VERSION}, snapshot_id:str('^sha256:[0-9a-f]{64}$'),
    stream_id:str('^progress_[0-9a-f]{32}$'), sequence:{type:'integer',minimum:1,maximum:2147483647},
    previous_snapshot_id:hash, observed_at:str('^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'),
    package_version:str('^\\d{1,6}\\.\\d{1,6}\\.\\d{1,6}$'), producer:enumeration(['next','qa']),
    identity:object({map_id:opaque,local_spec_id:str('^[A-Za-z0-9_-]{1,64}$'),map_revision_hash:hash,map_revision_algorithm:{const:'map-store-v1'},
      saved_revision_alignment:enumeration(['aligned','unconfirmed']),local_spec_material_hash:hash,
      local_spec_material_algorithm:{const:'campaign-spec-material-v1'},build_fingerprint:hash,
      build_fingerprint_algorithm:{const:'sha256-manifest/v1'}},['local_spec_id']),
    stages:{type:'array',minItems:6,maxItems:6,items:object({stage:enumeration(PROGRESS_STAGES),status:enumeration(PROGRESS_STAGE_STATUSES),
      build_binding:enumeration(['matching','unconfirmed']),source_build_fingerprint:hash})},
    preview:object({present:{type:'boolean'},url_hash:hash}),
    continuation:object({stage:enumeration(PROGRESS_CONTINUATIONS),blocked:{type:'boolean'},divergent:{type:'boolean'},
      action_ids:{type:'array',maxItems:64,uniqueItems:true,items:enumeration(PROGRESS_ACTION_IDS)},
      gates:{type:'array',maxItems:16,items:object({id:enumeration(PROGRESS_GATE_IDS),state:enumeration(['pass','blocked','waived','not_applicable','unknown'])})}}),
    qa:{anyOf:[{type:'null'},object({verdict_id:opaque,disposition:enumeration(['ready','ready_with_exceptions','blocked','unknown']),
      binding:enumeration(['matching','unconfirmed']),publish_state:enumeration(['skipped','ok','failed','unknown'])})]},
  }),
};

export function canonicalProgressJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalProgressJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalProgressJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function progressDigest(value, cryptoImpl = globalThis.crypto) {
  const bytes = new TextEncoder().encode(canonicalProgressJson(value));
  const digest = await cryptoImpl.subtle.digest('SHA-256',bytes);
  return `sha256:${Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')}`;
}
export async function progressSnapshotId(snapshot, cryptoImpl) {
  const {snapshot_id:ignored,...content} = snapshot;
  return progressDigest(content,cryptoImpl);
}
// Small bounded validator for exactly the schema vocabulary above. Fixed error codes,
// never values or property names from an untrusted payload.
export function validateProgressSnapshot(value) {
  const errors = [];
  let count = 0;
  function check(data,schema,depth=0) {
    if (++count>2048 || depth>12) return false;
    if (schema.anyOf) return schema.anyOf.some(branch=>check(data,branch,depth+1));
    if (Object.hasOwn(schema,'const') && data!==schema.const) return false;
    if (schema.enum && !schema.enum.includes(data)) return false;
    if (schema.type) {
      const type = data===null?'null':Array.isArray(data)?'array':typeof data==='number'&&Number.isInteger(data)?'integer':typeof data;
      const allowed = Array.isArray(schema.type)?schema.type:[schema.type];
      if (!allowed.includes(type)) return false;
    }
    if (typeof data==='string' && schema.pattern && !new RegExp(schema.pattern).test(data)) return false;
    if (typeof data==='number' && (data<schema.minimum||data>schema.maximum)) return false;
    if (Array.isArray(data)) {
      if (data.length<(schema.minItems||0)||data.length>(schema.maxItems||0)) return false;
      if (Object.keys(data).length!==data.length) return false;
      if (schema.uniqueItems && new Set(data).size!==data.length) return false;
      return data.every(item=>check(item,schema.items,depth+1));
    }
    if (data && typeof data==='object') {
      if (!schema.properties || Object.keys(data).some(key=>!Object.hasOwn(schema.properties,key))) return false;
      if (schema.required.some(key=>!Object.hasOwn(data,key))) return false;
      return Object.entries(data).every(([key,item])=>check(item,schema.properties[key],depth+1));
    }
    return true;
  }
  if (!check(value,PROGRESS_SNAPSHOT_SCHEMA)) errors.push('progress.invalid_shape');
  if (!errors.length && (new Set(value.stages.map(stage=>stage.stage)).size!==6 || value.stages.some((stage,index)=>stage.stage!==PROGRESS_STAGES[index]))) errors.push('progress.invalid_stages');
  if (!errors.length && value.identity.local_spec_id && (value.identity.map_id || value.identity.map_revision_hash || value.identity.saved_revision_alignment !== 'unconfirmed')) errors.push('progress.invalid_local_identity');
  if (!errors.length && value.identity.saved_revision_alignment==='aligned' && (!value.identity.map_id||!value.identity.map_revision_hash||!value.identity.local_spec_material_hash)) errors.push('progress.invalid_alignment');
  if (!errors.length && value.continuation.gates.some(gate=>gate.id==='unknown'&&gate.state!=='unknown')) errors.push('progress.unsupported_authority');
  if (!errors.length && value.sequence===1 && value.previous_snapshot_id!==null) errors.push('progress.invalid_chain');
  if (!errors.length && value.sequence>1 && value.previous_snapshot_id===null) errors.push('progress.invalid_chain');
  if (!errors.length && value.stages.some(stage=>stage.build_binding==='matching'&&(!value.identity.build_fingerprint||stage.source_build_fingerprint!==value.identity.build_fingerprint))) errors.push('progress.invalid_build_binding');
  if (!errors.length && value.qa?.binding==='matching'&&(!value.qa.verdict_id||!value.identity.build_fingerprint||value.stages.find(stage=>stage.stage==='qa').build_binding!=='matching')) errors.push('progress.invalid_qa_binding');
  if (!errors.length && (value.continuation.stage==='unknown'||value.continuation.action_ids.includes('unknown')||value.continuation.gates.some(gate=>gate.id==='unknown'||gate.state==='unknown'))&&!value.continuation.blocked) errors.push('progress.unsupported_authority');
  if (!errors.length && value.preview.present!==(value.preview.url_hash!==null)) errors.push('progress.invalid_preview');
  if (!errors.length && value.continuation.divergent&&!value.continuation.blocked) errors.push('progress.invalid_divergence');
  if (!errors.length && !Number.isFinite(Date.parse(value.observed_at))) errors.push('progress.invalid_time');
  return {ok:errors.length===0,errors};
}
export async function verifyProgressSnapshot(snapshot,cryptoImpl) {
  const checked=validateProgressSnapshot(snapshot);
  if (!checked.ok) return checked;
  return (await progressSnapshotId(snapshot,cryptoImpl))===snapshot.snapshot_id?checked:{ok:false,errors:['progress.digest_mismatch']};
}
// Identity groups include build, local spec and saved revision; never merge stages
// across builds. Histories contain whole observations, not a readiness decision.
export async function groupProgressHistories(snapshots,{cryptoImpl,maxSnapshots=256}={}) {
  if (!Array.isArray(snapshots)||snapshots.length>Math.min(maxSnapshots,256)) return {ok:false,groups:[],errors:['progress.history_bound']};
  const groups=new Map(); let rejected=0;
  for (const snapshot of snapshots) {
    if (!(await verifyProgressSnapshot(snapshot,cryptoImpl)).ok) {rejected++;continue;}
    const key=canonicalProgressJson({identity:snapshot.identity,stream_id:snapshot.stream_id});
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(snapshot);
  }
  return {ok:rejected===0,errors:rejected?['progress.invalid_history_member']:[],groups:[...groups.values()].map(items=>{
    const unique=[...new Map(items.map(item=>[item.snapshot_id,item])).values()].sort((a,b)=>a.sequence-b.sequence);
    const conflicted=new Set(unique.map(item=>item.sequence)).size!==unique.length;
    const incomplete=unique[0].sequence!==1 || unique.some((item,index)=>index>0&&(item.sequence!==unique[index-1].sequence+1||item.previous_snapshot_id!==unique[index-1].snapshot_id));
    return {identity:unique[0].identity,stream_id:unique[0].stream_id,state:conflicted?'conflicted':incomplete?'incomplete':unique[0].identity.saved_revision_alignment!=='aligned'||!unique[0].identity.build_fingerprint?'unconfirmed':'observed',snapshots:unique};
  })};
}
export function progressStorageKey(snapshot,scopeHash) {
  if (!validateProgressSnapshot(snapshot).ok||!/^sha256:[0-9a-f]{64}$/.test(scopeHash)||!snapshot.identity.map_id||!snapshot.identity.map_revision_hash) return null;
  return `progress:v0:${scopeHash.slice(7)}:${snapshot.identity.map_id}:${snapshot.identity.map_revision_hash.slice(7)}:${snapshot.stream_id}:${snapshot.sequence}:${snapshot.snapshot_id.slice(7)}`;
}
