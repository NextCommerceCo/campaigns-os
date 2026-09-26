import { campaignSpecIdentity, campaignIdentitiesMatch, localSpecIdentityFields } from "./spec-source-identity.mjs";
// Best-effort producer adapter. Sanitized immutable bytes are durable before delivery.
import {randomBytes,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,rmSync,readdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {PROGRESS_SCHEMA_VERSION,PROGRESS_STAGES,PROGRESS_STAGE_STATUSES,PROGRESS_CONTINUATIONS,PROGRESS_ACTION_IDS,PROGRESS_GATE_IDS,canonicalProgressJson,progressSnapshotId,verifyProgressSnapshot} from './progress.mjs';
import {specMaterialHash} from './spec-identity.mjs';
import {sameFile} from './fs-identity.mjs';
import {withDirectoryLock} from './directory-lock.mjs';
import {resolveConsent,CANONICAL_REMIT_SCOPE,normalizeConsentScope,announceDefaultOnTelemetry} from './consent.mjs';
import {boundedResponseText,isLoopbackHostname} from './remit.mjs';
export const PROGRESS_OBSERVATION = Symbol('canonical progress observation');
export const PROGRESS_ENDPOINT = '/api/progress';
const accepted = (value,values,fallback='unknown')=>values.includes(value)?value:fallback;
const hash = value=>typeof value==='string'&&/^(?:sha256:)?[0-9a-f]{64}$/i.test(value)?`sha256:${value.replace(/^sha256:/i,'').toLowerCase()}`:null;
const id = value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value)?value:null;
const digest = value=>`sha256:${createHash('sha256').update(value).digest('hex')}`;
const read = path=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch{return null;}};
function atomic(path,value) {const tmp=`${path}.${randomBytes(8).toString('hex')}.tmp`;writeFileSync(tmp,`${canonicalProgressJson(value)}\n`,{mode:0o600});renameSync(tmp,path);}
export function resolveProgressEndpoint(args,workspace,context) {
  // A foreign context cannot donate a source endpoint or quietly fall back.
  const named=context?.packet_path;
  const bound=typeof named==='string'&&named.trim()&&sameFile(resolve(workspace.targetRepo,named),workspace.packetPath,{requireExisting:true});
  const explicit=args['proxy-base'];
  const source=context?.intake?.proxy_base;
  if (!explicit && !bound && source) return {ok:false,reason:'source_binding_invalid'};
  if (explicit===undefined && (source===null||source===undefined) && workspace.packet?.spec?.spec_url) {
    try { if (new URL(workspace.packet.spec.spec_url).origin!==CANONICAL_REMIT_SCOPE) return {ok:false,reason:'source_binding_missing'}; } catch { return {ok:false,reason:'source_binding_invalid'}; }
  }
  const raw=explicit!==undefined?explicit:source!==null&&source!==undefined?source:CANONICAL_REMIT_SCOPE;
  if (typeof raw!=='string'||!raw.trim()) return {ok:false,reason:'endpoint_invalid'};
  try {
    const url=new URL(raw);
    if (url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol)||(url.protocol==='http:'&&!isLoopbackHostname(url.hostname))) return {ok:false,reason:'endpoint_invalid'};
    const base=url.href.replace(/\/+$/,'');
    return {ok:true,base,scope:normalizeConsentScope(base)};
  } catch {return {ok:false,reason:'endpoint_invalid'};}
}
export function projectProgressObservation({workspace,context,report,doctor,continuation,qaResult=null,packageVersion}) {
  const packet=workspace.packet;
  let spec=null;
  try {spec=JSON.parse(readFileSync(resolve(dirname(workspace.packetPath),packet.spec.local_path),'utf8'));}catch{}
  const mapId=id(packet?.spec?.map_id);
  const localHash=spec?hash(specMaterialHash(spec)):null;
  const localMapId=id(spec?.spec_identity?.map_id||spec?.map_id);
  const baseline=context?.intake?.saved_map_revision;
  const contextBound=typeof context?.packet_path==='string'&&context.packet_path.trim()&&sameFile(resolve(workspace.targetRepo,context.packet_path),workspace.packetPath,{requireExisting:true});
  const aligned=contextBound&&mapId&&localMapId===mapId&&baseline?.map_id===mapId&&baseline?.algorithm==='map-store-v1'&&hash(baseline.hash)&&localHash&&localHash===hash(baseline.local_spec_material_hash);
  const build=hash(doctor?.derived?.build_output_fingerprint?.value);
  const recordedBuild=hash(report?.stages?.assembly?.build_fingerprint);
  const reportBound=doctor?.derived?.prepare_build_gate?.binding_failure!==true&&contextBound&&campaignIdentitiesMatch(packet?.spec,campaignSpecIdentity(spec))&&campaignIdentitiesMatch(packet?.spec,report?.identity)&&localHash&&localHash===hash(report?.identity?.spec_material_hash);
  const qaSource=hash(report?.stages?.qa?.evidence?.source_build_fingerprint);
  const verdict=qaResult?.verdict;
  const qa=verdict?{
    verdict_id:id(verdict.run_id),disposition:accepted(verdict.disposition,['ready','ready_with_exceptions','blocked']),
    binding:reportBound&&id(verdict.run_id)&&id(verdict.run_id)===id(report?.stages?.qa?.verdict_run_id)&&build&&qaSource===build&&doctor?.derived?.build_output_fingerprint?.status==='pass'&&hash(verdict.spec_hash)===localHash?'matching':'unconfirmed',
    publish_state:accepted(qaResult?.qa_verdict_publish?.state,['skipped','ok','failed']),
  }:null;
  const gates=(Array.isArray(continuation?.gates)?continuation.gates:[]).slice(0,16).map(gate=>({id:accepted(gate?.id,PROGRESS_GATE_IDS),state:PROGRESS_GATE_IDS.includes(gate?.id)?accepted(gate?.status,['pass','blocked','waived','not_applicable']):'unknown'}));
  const actions=[...new Set((Array.isArray(continuation?.next_actions)?continuation.next_actions:[]).slice(0,64).map(action=>accepted(action?.id,PROGRESS_ACTION_IDS)))];
  const stage=accepted(continuation?.stage,PROGRESS_CONTINUATIONS);
  const preview=typeof packet?.deploy?.preview_url==='string'&&packet.deploy.preview_url?packet.deploy.preview_url:null;
  return {
    schema_version:PROGRESS_SCHEMA_VERSION,package_version:packageVersion,producer:qaResult?'qa':'next',
    identity:{map_id:mapId,...localSpecIdentityFields(packet?.spec),map_revision_hash:mapId?(contextBound&&baseline?.map_id===mapId?hash(baseline?.hash):(localMapId===mapId?hash(spec?.spec_identity?.spec_hash||spec?.spec_hash):null)):null,map_revision_algorithm:'map-store-v1',saved_revision_alignment:aligned?'aligned':'unconfirmed',local_spec_material_hash:localHash,local_spec_material_algorithm:'campaign-spec-material-v1',build_fingerprint:build,build_fingerprint_algorithm:'sha256-manifest/v1'},
    stages:PROGRESS_STAGES.map(stage=>{
      const status=reportBound?accepted(report?.stages?.[stage]?.status,PROGRESS_STAGE_STATUSES):'unknown';
      const source=stage==='assembly'?recordedBuild:stage==='qa'?qaSource:null;
      return {stage,status,source_build_fingerprint:source,build_binding:reportBound&&build&&source===build&&doctor?.derived?.build_output_fingerprint?.status==='pass'?'matching':'unconfirmed'};
    }),
    preview:{present:Boolean(preview),url_hash:preview?digest(preview):null},
    continuation:{stage,blocked:continuation?.ok!==true||(Array.isArray(continuation?.divergences)&&continuation.divergences.length>0)||stage==='unknown'||gates.some(gate=>['blocked','unknown'].includes(gate.state))||actions.includes('unknown'),divergent:Array.isArray(continuation?.divergences)&&continuation.divergences.length>0,action_ids:actions,gates},qa,
  };
}
function lock(dir,fn,{budgetMs=1500}={}) {
  return withDirectoryLock(join(dir,'.allocation-lock'),fn,{budgetMs,unavailable:()=>new Error('progress.lock_unavailable')});
}
export async function persistProgressObservation(observation,{dir,now=()=>new Date(),historyLimit=32}={}) {
  mkdirSync(dir,{recursive:true,mode:0o700});
  return lock(dir,async()=>{
    const latest=read(join(dir,'latest.json'));
    const latestValid=latest&&(await verifyProgressSnapshot(latest)).ok;
    const observationHash=digest(canonicalProgressJson(observation));
    if (latestValid) {
      const {snapshot_id,stream_id,sequence,previous_snapshot_id,observed_at,...old}=latest;
      if (digest(canonicalProgressJson(old))===observationHash) return {snapshot:latest,reused:true};
    }
    // A new spec/build identity starts an independent history; stage completion
    // from the old output cannot become completion for the new output.
    const sameIdentity=latestValid&&canonicalProgressJson(latest.identity)===canonicalProgressJson(observation.identity);
    const snapshot={...observation,stream_id:sameIdentity?latest.stream_id:`progress_${randomBytes(16).toString('hex')}`,sequence:sameIdentity?latest.sequence+1:1,previous_snapshot_id:sameIdentity?latest.snapshot_id:null,observed_at:now().toISOString()};
    snapshot.snapshot_id=await progressSnapshotId(snapshot);
    if (!(await verifyProgressSnapshot(snapshot)).ok) throw new Error('progress.invalid_projection');
    atomic(join(dir,`${snapshot.snapshot_id.slice(7)}.snapshot.json`),snapshot);
    atomic(join(dir,'latest.json'),snapshot);
    const history=readdirSync(dir).filter(name=>/^[0-9a-f]{64}\.snapshot\.json$/.test(name)).map(name=>({name,at:read(join(dir,name))?.observed_at||''})).sort((a,b)=>a.name===`${snapshot.snapshot_id.slice(7)}.snapshot.json`?-1:b.name===`${snapshot.snapshot_id.slice(7)}.snapshot.json`?1:b.at.localeCompare(a.at)||b.name.localeCompare(a.name));
    const limit=Math.min(32,Math.max(1,historyLimit));
    for (const old of history.slice(limit)) if(old.name!==`${snapshot.snapshot_id.slice(7)}.snapshot.json`) {rmSync(join(dir,old.name),{force:true});rmSync(join(dir,old.name.replace('.snapshot.json','.remit.json')),{force:true});}
    return {snapshot,reused:false};
  });
}
export async function remitProgressSnapshot(snapshot,{base,campaignKey,fetchImpl=globalThis.fetch,budgetMs=2000}={}) {
  const bytes=canonicalProgressJson(snapshot);const deadline=Date.now()+Math.min(2000,Math.max(1,budgetMs));
  let reason='transport_failed';let attempts=0;let httpStatus=null;
  for (let attempt=0;attempt<2&&Date.now()<deadline;attempt++) {
    attempts++;
    try {
      const response=await fetchImpl(`${base}${PROGRESS_ENDPOINT}`,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','Accept':'application/json','X-Campaign-Key':campaignKey},body:bytes,signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
      httpStatus=response.status;
      let ack=null;try{ack=JSON.parse(await boundedResponseText(response,{maxBodyBytes:4096,timeoutMs:Math.max(1,deadline-Date.now())}));}catch{}
      if ((response.ok||response.status===409)&&ack?.ok===true&&ack.snapshot_id===snapshot.snapshot_id&&ack.digest===snapshot.snapshot_id) return {state:'ok',reason:'acknowledged',attempts,http_status:httpStatus};
      reason=response.status===409?'conflict':response.ok?'ack_invalid':'http_refused';
      if (!(response.status===429||response.status>=500)) break;
    } catch {reason='transport_failed';}
  }
  return {state:'failed',reason,attempts,http_status:httpStatus};
}
export async function observeProgress(args,continuation,{qaResult=null,packageVersion,resolveKey,env=process.env,configPath,fetchImpl,warn=message=>process.stderr.write(`${message}\n`)}={}) {
  if (args['no-write']===true) return {state:'disabled',reason:'no_write'};
  try {
    const source=continuation?.[PROGRESS_OBSERVATION];
    if (!source) return {state:'skipped',reason:'observation_unavailable'};
    const {workspace,context}=source;
    const endpoint=resolveProgressEndpoint(args,workspace,context);
    const observation=projectProgressObservation({...source,continuation,qaResult,packageVersion});
    const storageScope=digest(canonicalProgressJson({packet:workspace.packetPath,context:workspace.contextPath,report:workspace.reportPath,endpoint:endpoint.ok?endpoint.scope:null})).slice(7);
    const dir=join(workspace.targetRepo,'.campaign-runtime','progress',storageScope);
    const {snapshot,reused}=await persistProgressObservation(observation,{dir});
    const metaPath=join(dir,`${snapshot.snapshot_id.slice(7)}.remit.json`);
    const prior=read(metaPath);
    if (prior?.state==='ok') return {state:'ok',reason:'already_acknowledged',snapshot_id:snapshot.snapshot_id,reused};
    let reason=!snapshot.identity.map_id?'map_id_missing':!endpoint.ok?endpoint.reason:args['no-remit']===true?'no_remit':null;
    const consent=reason?null:resolveConsent({env,...(configPath?{configPath}:{}),proxyBase:endpoint.base,warn:()=>{}});
    if (!reason&&consent.state!=='on') reason='consent_off';
    if (!reason&&consent.scope_bypassed) reason='scoped_consent_required';
    const key=reason?null:resolveKey?.(workspace.packet,workspace.packetPath,env)?.key;
    if (!reason&&!key) reason='campaign_key_missing';
    if (!reason) announceDefaultOnTelemetry(`${endpoint.base}${PROGRESS_ENDPOINT}`);
    const remit=reason?{state:'skipped',reason,attempts:0,http_status:null}:await remitProgressSnapshot(snapshot,{base:endpoint.base,campaignKey:key,fetchImpl});
    atomic(metaPath,{...remit,snapshot_id:snapshot.snapshot_id});
    if(remit.state==='failed')warn('[campaigns-os] Progress delivery pending; the local observation is retained. Lifecycle result is unchanged.');
    return {...remit,snapshot_id:snapshot.snapshot_id,reused};
  } catch(error) {
    if(error?.message==='progress.lock_unavailable')warn('[campaigns-os] Progress allocation lock occupied; wait for the current writer. For abandoned or interrupted recovery, stop target writers and follow the offline lock recovery in docs/progress-snapshots.md. Lifecycle result is unchanged.');
    else warn('[campaigns-os] Progress observation unavailable; lifecycle result is unchanged.');
    return {state:'failed',reason:'capture_unavailable'};
  }
}
