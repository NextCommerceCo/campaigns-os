import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync,readdirSync,cpSync,utimesSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {createServer} from 'node:http';
import Ajv from 'ajv/dist/2020.js';
import {PROGRESS_SNAPSHOT_SCHEMA,PROGRESS_STAGES,canonicalProgressJson,progressSnapshotId,verifyProgressSnapshot,validateProgressSnapshot,groupProgressHistories,progressStorageKey} from './progress.mjs';
import {projectProgressObservation,persistProgressObservation,remitProgressSnapshot,resolveProgressEndpoint,observeProgress,PROGRESS_OBSERVATION} from './progress-node.mjs';
import {specMaterialHash} from './spec-identity.mjs';
import {writeConsentConfig} from './consent.mjs';
import {nextStage,recordQaStageOutcome} from './cli.mjs';
import {computeBuildFingerprint} from './built-site-scope.mjs';
const ROOT=new URL('..',import.meta.url).pathname;
const fixture=JSON.parse(readFileSync(join(ROOT,'contracts/fixtures/progress/observation.v0.json'),'utf8'));
const H=letter=>`sha256:${letter.repeat(64)}`;
const clone=value=>JSON.parse(JSON.stringify(value));
const observation=()=>{const {snapshot_id,stream_id,sequence,previous_snapshot_id,observed_at,...value}=clone(fixture);return value;};
function scratch(fn){return async()=>{const dir=mkdtempSync(join(tmpdir(),'campaigns-progress-'));try{await fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}};}
async function snapshot(patch={}) {const s={...clone(fixture),...patch};s.snapshot_id=await progressSnapshotId(s);return s;}
function setup(dir){
 const spec={map_id:'example-map',campaign:{slug:'example'},lifecycle:{stage:'build'},spec_identity:{map_id:'example-map',spec_hash:H('a')},secret:'private@example.test'};
 writeFileSync(join(dir,'spec.json'),JSON.stringify(spec));writeFileSync(join(dir,'packet.json'),'{}');
 const workspace={packetPath:join(dir,'packet.json'),targetRepo:dir,contextPath:join(dir,'context.json'),reportPath:join(dir,'report.json'),packet:{spec:{map_id:'example-map',local_path:'spec.json'},deploy:{preview_url:'https://user:password@preview.test/?customer=private@example.test'}}};
 const local=specMaterialHash(spec);
 const context={packet_path:'packet.json',intake:{proxy_base:'https://bound.example.test',saved_map_revision:{map_id:'example-map',hash:H('a'),algorithm:'map-store-v1',local_spec_material_hash:local}}};
 const report={identity:{map_id:'example-map',spec_hash:H('f'),spec_material_hash:local},stages:Object.fromEntries(PROGRESS_STAGES.map(stage=>[stage,{status:'completed',commands:['private@example.test'],build_fingerprint:stage==='assembly'?H('c'):null}]))};
 const doctor={derived:{build_output_fingerprint:{status:'pass',value:H('c')},prepare_build_gate:null}};
 const continuation={ok:true,stage:'qa',gates:[{id:'doctor',status:'pass',reason:'private@example.test'}],next_actions:[{id:'qa_run',command:'private@example.test'}]};
 return {spec,workspace,context,report,doctor,continuation,packageVersion:'1.36.0'};
}

test('portable contract fixture, JSON schema and digest agree',async()=>{
 const schema=JSON.parse(readFileSync(join(ROOT,'schemas/campaigns-os-progress-snapshot.v0.schema.json')));
 assert.deepEqual(schema,PROGRESS_SNAPSHOT_SCHEMA);
 assert.equal(new Ajv().compile(schema)(fixture),true);
 assert.deepEqual(await verifyProgressSnapshot(fixture),{ok:true,errors:[]});
 assert.equal(progressStorageKey(fixture,H('d')).split(':')[0],'progress');
 const source=readFileSync(join(ROOT,'src/progress.mjs'),'utf8');
 assert.equal(/\b(?:process|Buffer|require)\b|from ['"]node:|\bfetch\(/.test(source),false);
});

test('schema rejects secrets, unknown fields/enums, fake matching evidence and unbounded wire',async()=>{
 for (const mutate of [s=>s.identity.map_id='user@example.test',s=>s.identity.local_spec_material_hash='/private/tmp/spec.json',s=>s.identity.map_revision_hash='https://user:password@host',s=>s.prompt='source content',s=>s.continuation.stage='preview',s=>s.continuation.action_ids=['execute_secret'],s=>s.qa={verdict_id:'email@example.test',disposition:'ready',binding:'unconfirmed',publish_state:'ok'},s=>s.stages[0].status='ready',s=>s.stages[0].build_binding='matching',s=>s.continuation.gates[0]={id:'unknown',state:'pass'},s=>s.continuation.action_ids=['unknown'],s=>s.stages.push(s.stages[0]),s=>s.sequence=1e30]) {
  const s=clone(fixture);mutate(s);assert.equal(validateProgressSnapshot(s).ok,false);
 }
 const altered=clone(fixture);altered.continuation.stage='qa';assert.deepEqual(await verifyProgressSnapshot(altered),{ok:false,errors:['progress.digest_mismatch']});
});

test('projection separates saved Map hash, raw bytes, semantic local and output identity',scratch(async dir=>{
 const input=setup(dir);const s=projectProgressObservation(input);
 assert.equal(s.identity.map_revision_hash,H('a'));assert.equal(s.identity.local_spec_material_hash,specMaterialHash(input.spec));assert.notEqual(s.identity.local_spec_material_hash,input.report.identity.spec_hash);
 assert.equal(s.identity.saved_revision_alignment,'aligned');assert.equal(s.stages[2].build_binding,'matching');
 const text=canonicalProgressJson(s);for(const secret of ['private@example.test','password','https://','/private/','commands'])assert.equal(text.includes(secret),false);
 input.spec.lifecycle.stage='qa';writeFileSync(join(dir,'spec.json'),JSON.stringify(input.spec));
 assert.equal(projectProgressObservation(input).identity.saved_revision_alignment,'unconfirmed','Map proxy excludes lifecycle but local material includes it');
 input.spec.lifecycle.stage='build';
 input.spec.spec_identity.map_id='other-map';writeFileSync(join(dir,'spec.json'),JSON.stringify(input.spec));assert.ok(projectProgressObservation(input).stages.every(stage=>stage.status==='unknown'));
 input.report.identity.map_id='other-map';assert.ok(projectProgressObservation(input).stages.every(stage=>stage.status==='unknown'));
}));

test('blocked, divergent, stale, unsupported and QA exceptions remain independent observations',scratch(async dir=>{
 const input=setup(dir);
 input.continuation={...input.continuation,ok:false,stage:'doctor-blocked',divergences:[{secret:'private@example.test'}],gates:[{id:'doctor',status:'blocked'}],next_actions:[{id:'divergence_inspect',command:'secret'}]};
 let s=projectProgressObservation(input);assert.equal(s.continuation.blocked,true);assert.equal(s.continuation.divergent,true);assert.deepEqual(s.continuation.action_ids,['divergence_inspect']);
 input.doctor.derived.build_output_fingerprint={status:'stale',value:H('d')};s=projectProgressObservation(input);assert.equal(s.identity.build_fingerprint,H('d'));assert.equal(s.stages[2].build_binding,'unconfirmed');
 input.continuation={ok:true,stage:'done',gates:[{id:'private@example.test',status:'pass'}],next_actions:[{id:'private@example.test',command:'secret'}]};s=projectProgressObservation(input);assert.equal(s.continuation.blocked,true);assert.deepEqual(s.continuation.gates,[{id:'unknown',state:'unknown'}]);
 input.doctor.derived.build_output_fingerprint={status:'pass',value:H('c')};input.report.stages.qa={status:'completed_with_warnings',verdict_run_id:'qa_example',evidence:{source_build_fingerprint:H('c')}};
 input.qaResult={verdict:{run_id:'qa_example',disposition:'ready_with_exceptions',spec_hash:specMaterialHash(input.spec),assertions:[{order_id:'secret'}]},qa_verdict_publish:{state:'failed',error:'private@example.test'}};
 s=projectProgressObservation(input);assert.deepEqual(s.qa,{verdict_id:'qa_example',disposition:'ready_with_exceptions',binding:'matching',publish_state:'failed'});assert.equal(s.stages[5].status,'completed_with_warnings');
 input.context.packet_path='other.json';assert.equal(projectProgressObservation(input).identity.saved_revision_alignment,'unconfirmed');assert.equal(projectProgressObservation(input).qa.binding,'unconfirmed');
}));

test('source endpoint precedence, malformed/credential transport and foreign context fail closed',scratch(async dir=>{
 const {workspace,context}=setup(dir);
 assert.equal(resolveProgressEndpoint({},workspace,context).base,'https://bound.example.test');
 assert.equal(resolveProgressEndpoint({'proxy-base':'http://127.0.0.1:1234'},workspace,context).base,'http://127.0.0.1:1234');
 assert.equal(resolveProgressEndpoint({},workspace,{}).base,'https://campaign-map.nextcommerce.com');
 for(const base of ['http://remote.test','https://user:secret@host','https://host/?token=secret','https://host/#secret','ftp://127.0.0.1','',true]) assert.equal(resolveProgressEndpoint({'proxy-base':base},workspace,context).ok,false);
 context.packet_path='other.json';assert.deepEqual(resolveProgressEndpoint({},workspace,context),{ok:false,reason:'source_binding_invalid'});
 delete context.packet_path;assert.deepEqual(resolveProgressEndpoint({},workspace,context),{ok:false,reason:'source_binding_invalid'});
 assert.equal(resolveProgressEndpoint({'proxy-base':'http://127.0.0.1:1234'},workspace,context).ok,true,'explicit override remains independent of context');
 assert.equal(projectProgressObservation({...setup(dir),context}).identity.saved_revision_alignment,'unconfirmed');
}));

test('abandoned allocation owners recover while a live owner remains exclusive',scratch(async dir=>{
 const lock=join(dir,'.allocation-lock');mkdirSync(lock);const old=new Date(Date.now()-20000);utimesSync(lock,old,old);
 assert.equal((await persistProgressObservation(observation(),{dir})).snapshot.sequence,1,'old ownerless crash gap recovers');
 mkdirSync(lock);const child=spawnSync(process.execPath,['-e','process.exit(0)']);
 writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:child.pid,token:'dead-owner'}));
 assert.equal((await persistProgressObservation(observation(),{dir})).reused,true,'dead PID owner recovers immediately');
 mkdirSync(lock);const owner=JSON.stringify({pid:process.pid,token:'live-owner'});writeFileSync(join(lock,'owner.json'),owner);
 await assert.rejects(persistProgressObservation(observation(),{dir}),/progress.lock_unavailable/);
 assert.equal(readFileSync(join(lock,'owner.json'),'utf8'),owner,'a live owner is never evicted');
 rmSync(lock,{recursive:true});mkdirSync(lock);writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:child.pid,token:'dead-owner'}));mkdirSync(join(lock,'.recovery'));
 await assert.rejects(persistProgressObservation(observation(),{dir}),/progress.lock_unavailable/,'interrupted recovery requires the documented offline procedure');
 assert.equal(existsSync(join(lock,'.recovery')),true,'ambiguous recovery is not stolen');
 rmSync(lock,{recursive:true});assert.equal(existsSync(lock),false);assert.equal((await persistProgressObservation(observation(),{dir})).reused,true);
}));

test('multiple processes reclaim one dead owner without evicting new live allocation',scratch(async dir=>{
 const lock=join(dir,'.allocation-lock');mkdirSync(lock);const dead=spawnSync(process.execPath,['-e','process.exit(0)']);writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:dead.pid,token:'dead-owner'}));
 const moduleUrl=new URL('./progress-node.mjs',import.meta.url).href;
 const run=index=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',`import {persistProgressObservation} from ${JSON.stringify(moduleUrl)};const result=await persistProgressObservation(${JSON.stringify({...observation(),preview:{present:true,url_hash:H(String(index))}})},{dir:${JSON.stringify(dir)}});console.log(JSON.stringify(result.snapshot));`],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',value=>out+=value);child.stderr.on('data',value=>err+=value);child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));});
 const results=await Promise.all(Array.from({length:6},(_,index)=>run(index)));assert.deepEqual(results.map(value=>value.sequence).sort(),[1,2,3,4,5,6]);assert.equal(new Set(results.map(value=>value.stream_id)).size,1);assert.equal(existsSync(lock),false);
}));

test('unchanged observation reuses immutable ID/time; serialized concurrent allocation and build isolation',scratch(async dir=>{
 const first=await persistProgressObservation(observation(),{dir,now:()=>new Date('2026-09-18T00:00:00Z')});
 const same=await Promise.all(Array.from({length:5},()=>persistProgressObservation(observation(),{dir})));assert.ok(same.every(item=>item.reused&&item.snapshot.snapshot_id===first.snapshot.snapshot_id&&item.snapshot.observed_at===first.snapshot.observed_at));
 const updates=await Promise.all(Array.from({length:5},(_,index)=>persistProgressObservation({...observation(),preview:{present:true,url_hash:H(String(index))}},{dir})));
 assert.deepEqual(updates.map(item=>item.snapshot.sequence).sort(),[2,3,4,5,6]);
 const changed=observation();changed.identity.build_fingerprint=H('d');changed.stages[2].build_binding='unconfirmed';
 const other=await persistProgressObservation(changed,{dir});assert.equal(other.snapshot.sequence,1);assert.notEqual(other.snapshot.stream_id,first.snapshot.stream_id);assert.equal(other.snapshot.previous_snapshot_id,null);
 for(let i=0;i<35;i++)await persistProgressObservation({...changed,preview:{present:true,url_hash:H((i%16).toString(16))}},{dir});
 assert.ok(readdirSync(dir).filter(name=>name.endsWith('.snapshot.json')).length<=32);
}));

test('consumer histories preserve conflicts, gaps, unknown identity and Map/spec/build isolation',async()=>{
 const first=await snapshot();const second=await snapshot({sequence:2,previous_snapshot_id:first.snapshot_id,observed_at:'2026-09-18T00:00:01.000Z'});
 let grouped=await groupProgressHistories([second,first,first]);assert.equal(grouped.groups[0].state,'observed');assert.equal(grouped.groups[0].snapshots.length,2);
 const conflict=await snapshot({...second,producer:'qa'});grouped=await groupProgressHistories([first,second,conflict]);assert.equal(grouped.groups[0].state,'conflicted');
 assert.equal((await groupProgressHistories([second])).groups[0].state,'incomplete');
 for(const field of ['map_id','map_revision_hash','local_spec_material_hash','build_fingerprint']) {
  const identity={...first.identity,[field]:field==='map_id'?'other-map':H('d')};const other=await snapshot({identity,stages:first.stages.map(s=>({...s,build_binding:'unconfirmed'}))});assert.equal((await groupProgressHistories([first,other])).groups.length,2);
 }
 const unconfirmed=await snapshot({identity:{...first.identity,saved_revision_alignment:'unconfirmed'}});assert.equal((await groupProgressHistories([unconfirmed])).groups[0].state,'unconfirmed');
 assert.equal((await groupProgressHistories(Array(257).fill(first))).ok,false);
});

async function receiver(fn,run){const server=createServer(fn);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{await run(`http://127.0.0.1:${server.address().port}`);}finally{await new Promise(resolve=>server.close(resolve));}}
const ack=s=>({ok:true,snapshot_id:s.snapshot_id,digest:s.snapshot_id});
test('lost response retry uses identical durable bytes/time/ID and strict matching acknowledgment',async()=>{
 const bodies=[];await receiver(async(req,res)=>{let body='';for await(const part of req)body+=part;bodies.push(body);if(bodies.length===1){req.socket.destroy();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify(ack(JSON.parse(body))));},async base=>{
  const result=await remitProgressSnapshot(fixture,{base,campaignKey:'test_key'});assert.equal(result.state,'ok');assert.equal(result.attempts,2);assert.equal(bodies[0],bodies[1]);assert.equal(bodies[0],canonicalProgressJson(fixture));
 });
});
for(const status of [400,401,403,409,429,500])test(`HTTP${status} never grants success without matching acknowledgment`,async()=>{
 let attempts=0;await receiver((req,res)=>{req.resume();attempts++;res.statusCode=status;res.end(JSON.stringify({ok:true,snapshot_id:H('f'),digest:H('f'),error:'private@example.test'}));},async base=>{
  const result=await remitProgressSnapshot(fixture,{base,campaignKey:'test_key'});assert.equal(result.state,'failed');assert.equal(result.attempts,[429,500].includes(status)?2:1);assert.equal(JSON.stringify(result).includes('private@example.test'),false);
 });
});
test('matching409 ack is idempotent success; oversized/invalid success body is failure',async()=>{
 for(const body of [ack(fixture),{ok:true},'x'.repeat(5000)]) await receiver((req,res)=>{req.resume();res.statusCode=body===Object(body)&&body.snapshot_id?409:200;res.end(typeof body==='string'?body:JSON.stringify(body));},async base=>{assert.equal((await remitProgressSnapshot(fixture,{base,campaignKey:'test_key'})).state,body.snapshot_id?'ok':'failed');});
});

test('capture precedes request; consent off/malformed/scoped, flags, missing Map/key and no-session behavior',scratch(async dir=>{
 const input=setup(dir);const configPath=join(dir,'consent.json');let requests=0;
 await receiver(async(req,res)=>{requests++;let body='';for await(const part of req)body+=part;const s=JSON.parse(body);const files=readdirSync(join(dir,'.campaign-runtime','progress'));assert.ok(files.some(scope=>readdirSync(join(dir,'.campaign-runtime','progress',scope)).includes(`${s.snapshot_id.slice(7)}.snapshot.json`)));res.end(JSON.stringify(ack(s)));},async base=>{
  input.context.intake.proxy_base=base;Object.defineProperty(input.continuation,PROGRESS_OBSERVATION,{value:input});
  const opts={packageVersion:'1.36.0',resolveKey:()=>({key:'test_key'}),configPath,env:{},warn:()=>{}};
  assert.equal((await observeProgress({'no-write':true},input.continuation,opts)).reason,'no_write');assert.equal(requests,0);
  assert.equal((await observeProgress({'no-remit':true},input.continuation,opts)).reason,'no_remit');
  assert.equal((await observeProgress({},input.continuation,opts)).reason,'consent_off');
  assert.equal((await observeProgress({},input.continuation,{...opts,env:{CAMPAIGNS_OS_TELEMETRY:'on'}})).reason,'scoped_consent_required');
  writeFileSync(configPath,'{');assert.equal((await observeProgress({},input.continuation,opts)).reason,'consent_off');
  writeConsentConfig('on',{configPath,proxyBase:base});
  assert.equal((await observeProgress({},input.continuation,{...opts,env:{CAMPAIGNS_OS_TELEMETRY:'invalid-secret@example.test'}})).reason,'consent_off');
  assert.equal((await observeProgress({},input.continuation,{...opts,resolveKey:()=>({key:null})})).reason,'campaign_key_missing');
  const sent=await observeProgress({'no-run-session':true},input.continuation,opts);assert.equal(sent.state,'ok');assert.equal(requests,1);
  assert.equal((await observeProgress({},input.continuation,opts)).reason,'already_acknowledged');assert.equal(requests,1);
  input.workspace.packet.spec.map_id=null;assert.equal((await observeProgress({},input.continuation,opts)).reason,'map_id_missing');assert.equal(requests,1);
  assert.equal(readdirSync(join(dir,'.campaign-runtime')).includes('run-session.json'),false);
 });
}));

test('canonical default consent sends only exact target and explicit off remains local',scratch(async dir=>{
 const input=setup(dir);input.context.intake.proxy_base=null;Object.defineProperty(input.continuation,PROGRESS_OBSERVATION,{value:input});let targets=[];
 const opts={packageVersion:'1.36.0',resolveKey:()=>({key:'test_key'}),configPath:join(dir,'absent.json'),env:{},warn:()=>{},fetchImpl:async(url,options)=>{targets.push(url);return new Response(JSON.stringify(ack(JSON.parse(options.body))),{status:200});}};
 assert.equal((await observeProgress({},input.continuation,{...opts,env:{CAMPAIGNS_OS_TELEMETRY:'off'}})).reason,'consent_off');
 assert.equal((await observeProgress({},input.continuation,opts)).state,'ok');assert.deepEqual(targets,['https://campaign-map.nextcommerce.com/api/progress']);
}));

test('real next dispatch observes actual picker, no-write capture disabled and no-run-session never opens a session',scratch(async dir=>{
 cpSync(join(ROOT,'contracts/fixtures/sidecar-bundle/production-shaped'),dir,{recursive:true});
 const packet=join(dir,'campaign-runtime.build.json');const args={packet,'no-write':true};const continuation=nextStage(null,args,null);assert.ok(continuation[PROGRESS_OBSERVATION]);
 for(const noWrite of [true,false]){
  const result=spawnSync(process.execPath,[join(ROOT,'bin/campaigns-os.mjs'),'next','--packet',packet,'--json','--no-run-session','--no-remit',...(noWrite?['--no-write']:[])],{cwd:dir,encoding:'utf8',env:{...process.env,CAMPAIGNS_OS_TELEMETRY:'off'}});
  const parsed=JSON.parse(result.stdout);assert.equal(parsed.stage,continuation.stage);assert.equal(result.status,parsed.ok?0:2);
  const runtime=readdirSync(join(dir,'.campaign-runtime'));assert.equal(runtime.includes('run-session.json'),false);assert.equal(runtime.includes('progress'),!noWrite);
 }
}));

test('actual next and committed QA bind complete local spec/build evidence and reject independent mutations',scratch(async dir=>{
 cpSync(join(ROOT,'contracts/fixtures/sidecar-bundle/production-shaped'),dir,{recursive:true});
 cpSync(join(ROOT,'examples/campaignspec.v42.basic.json'),join(dir,'campaignspec.v42.basic.json'));
 cpSync(join(ROOT,'examples/source-html'),join(dir,'source-html'),{recursive:true});
 const packetPath=join(dir,'campaign-runtime.build.json');const packet=JSON.parse(readFileSync(packetPath));
 const specPath=join(dir,packet.spec.local_path);const spec=JSON.parse(readFileSync(specPath));
 spec.spec_identity={map_id:packet.spec.map_id,spec_hash:H('a')};writeFileSync(specPath,JSON.stringify(spec));
 const localHash=specMaterialHash(spec);const contextPath=join(dir,'.campaign-runtime/build-context.json');const context=JSON.parse(readFileSync(contextPath));
 context.intake={proxy_base:'https://bound.example.test',saved_map_revision:{map_id:packet.spec.map_id,hash:H('a'),algorithm:'map-store-v1',local_spec_material_hash:localHash}};
 context.spec.hash=H('f');context.spec.material_hash=localHash;writeFileSync(contextPath,JSON.stringify(context));
 const output=join(dir,'_site',packet.campaign.public_route_slug);mkdirSync(output,{recursive:true});writeFileSync(join(output,'index.html'),'<html><body>Local fixture</body></html>');
 const build=computeBuildFingerprint(output).fingerprint;const reportPath=join(dir,'.campaign-runtime/assembly-report.json');const report=JSON.parse(readFileSync(reportPath));
 report.identity.spec_material_hash=localHash;report.stages.assembly.status='completed';report.stages.assembly.build_fingerprint=build;writeFileSync(reportPath,JSON.stringify(report));
 const qaResult={verdict:{run_id:'qa_bound_example',disposition:'ready_with_exceptions',completed_at:'2026-09-18T00:00:00.000Z',spec_hash:localHash,assertions:[{id:'template-residue:landing:placeholder-text',status:'pass'}]},local_path:join(dir,'qa_bound_example.json'),qa_verdict_publish:{state:'failed'}};
 writeFileSync(qaResult.local_path,JSON.stringify(qaResult.verdict));assert.equal(recordQaStageOutcome({packet:packetPath},qaResult),true);
 const project=()=>{const continuation=nextStage(null,{packet:packetPath,'no-write':true},null);return {continuation,source:continuation[PROGRESS_OBSERVATION],snapshot:projectProgressObservation({...continuation[PROGRESS_OBSERVATION],continuation,qaResult,packageVersion:'1.36.0'})};};
 const positive=project();assert.equal(positive.source.doctor.derived.build_output_fingerprint.status,'pass');assert.equal(positive.snapshot.identity.saved_revision_alignment,'aligned');
 assert.equal(positive.snapshot.stages.find(stage=>stage.stage==='assembly').build_binding,'matching');
 assert.deepEqual(positive.snapshot.qa,{verdict_id:'qa_bound_example',disposition:'ready_with_exceptions',binding:'matching',publish_state:'failed'});
 assert.equal(positive.source.report.stages.qa.verdict_run_id,qaResult.verdict.run_id,'actual QA producer committed this verdict');
 assert.equal(positive.snapshot.continuation.stage,positive.continuation.stage,'canonical picker alone determines continuation');
 const originalContext=readFileSync(contextPath,'utf8');const originalPacket=readFileSync(packetPath,'utf8');packet.design_source_package={};writeFileSync(packetPath,JSON.stringify(packet));delete context.packet_path;writeFileSync(contextPath,JSON.stringify(context));
 const foreign=project();assert.equal(foreign.continuation.stage,'prepare-build');assert.match(foreign.continuation.reason,/context_packet_mismatch/);assert.equal(foreign.snapshot.identity.saved_revision_alignment,'unconfirmed');assert.ok(foreign.snapshot.stages.every(stage=>stage.status==='unknown'));assert.equal(foreign.snapshot.qa.binding,'unconfirmed');assert.equal(foreign.snapshot.continuation.blocked,true);assert.equal(resolveProgressEndpoint({},foreign.source.workspace,foreign.source.context).reason,'source_binding_invalid');
 writeFileSync(packetPath,originalPacket);writeFileSync(contextPath,originalContext);const originalSpec=readFileSync(specPath,'utf8');spec.campaign={...spec.campaign,slug:'changed'};writeFileSync(specPath,JSON.stringify(spec));
 assert.equal(project().snapshot.identity.saved_revision_alignment,'unconfirmed');assert.equal(project().snapshot.qa.binding,'unconfirmed');
 writeFileSync(specPath,originalSpec);writeFileSync(join(output,'index.html'),'<html><body>Changed build</body></html>');
 const stale=project();assert.equal(stale.source.doctor.derived.build_output_fingerprint.status,'stale');assert.equal(stale.snapshot.stages.find(stage=>stage.stage==='assembly').build_binding,'unconfirmed');assert.equal(stale.snapshot.qa.binding,'unconfirmed');assert.equal(stale.snapshot.continuation.blocked,true);
 writeFileSync(join(output,'index.html'),'<html><body>Local fixture</body></html>');qaResult.verdict.run_id='qa_other';assert.equal(project().snapshot.qa.binding,'unconfirmed');
}));

for(const disposition of ['ready','ready_with_exceptions','blocked']) test(`QA ${disposition} observation never changes closed records or session ownership`,scratch(async dir=>{
 cpSync(join(ROOT,'contracts/fixtures/sidecar-bundle/production-shaped'),dir,{recursive:true});
 const packet=join(dir,'campaign-runtime.build.json');
 const runRecord=join(dir,'.campaign-runtime','closed-run.json');const sessionPath=join(dir,'.campaign-runtime','run-session.json');
 writeFileSync(runRecord,JSON.stringify({run_id:'closed_run',status:'ready',secret:'private@example.test'}));
 if(disposition==='blocked')writeFileSync(sessionPath,JSON.stringify({run_id:'active_run',packet,started_at:new Date().toISOString(),updated_at:new Date().toISOString()}));
 const beforeRecord=readFileSync(runRecord,'utf8');const beforeSession=disposition==='blocked'?readFileSync(sessionPath,'utf8'):null;
 const qaResult={verdict:{run_id:'qa_example',disposition,completed_at:'2026-09-18T00:00:00.000Z',assertions:[],spec_hash:H('b')},local_path:join(dir,'qa_example.json'),qa_verdict_publish:{state:'failed'}};
 assert.equal(recordQaStageOutcome({packet},qaResult),true);
 const continuation=nextStage(null,{packet,'no-write':true},null);
 assert.equal((await observeProgress({'no-remit':true},continuation,{qaResult,packageVersion:'1.36.0',warn:()=>{}})).state,'skipped');
 assert.equal(readFileSync(runRecord,'utf8'),beforeRecord);
 assert.equal(disposition==='blocked'?readFileSync(sessionPath,'utf8'):null,beforeSession);
 assert.equal(readdirSync(join(dir,'.campaign-runtime')).includes('run-session.json'),disposition==='blocked');
 const contextPath=join(dir,'.campaign-runtime','build-context.json');const context=JSON.parse(readFileSync(contextPath));context.report_path='.campaign-runtime/custom-report.json';writeFileSync(contextPath,JSON.stringify(context));
 const report=readFileSync(join(dir,'.campaign-runtime','assembly-report.json'),'utf8');writeFileSync(join(dir,'.campaign-runtime','custom-report.json'),report);
 const custom=nextStage(null,{packet,'no-write':true},null);assert.equal(custom[PROGRESS_OBSERVATION].workspace.reportPath,join(dir,'.campaign-runtime','custom-report.json'));
}));
