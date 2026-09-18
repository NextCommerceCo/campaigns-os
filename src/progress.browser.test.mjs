import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
const fixture=JSON.parse(readFileSync(new URL('../contracts/fixtures/progress/observation.v0.json',import.meta.url)));
test('portable progress contract validates identical digest in Chromium window and module worker',async t=>{
 let browser;
 try{const {chromium}=await import('playwright');browser=await chromium.launch();}catch(error){if(process.env.CAMPAIGNS_OS_REQUIRE_BROWSER==='1')throw error;t.skip('Chromium unavailable');return;}
 const source=readFileSync(new URL('./progress.mjs',import.meta.url),'utf8');
 const server=createServer((req,res)=>{
  res.setHeader('content-type',req.url==='/progress.mjs'?'text/javascript':'text/html');
  res.end(req.url==='/progress.mjs'?source:'<!doctype html><title>Progress contract test</title>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result=await page.evaluate(async snapshot=>{
   const module=await import('/progress.mjs');const main=await module.verifyProgressSnapshot(snapshot);
   const workerCode=`import {verifyProgressSnapshot} from '${location.origin}/progress.mjs';onmessage=async e=>postMessage(await verifyProgressSnapshot(e.data));`;
   const objectUrl=URL.createObjectURL(new Blob([workerCode],{type:'text/javascript'}));const worker=new Worker(objectUrl,{type:'module'});
   const workerResult=await new Promise((resolve,reject)=>{worker.onmessage=e=>resolve(e.data);worker.onerror=reject;worker.postMessage(snapshot);});worker.terminate();URL.revokeObjectURL(objectUrl);
   return {main,workerResult};
  },fixture);
  assert.deepEqual(result,{main:{ok:true,errors:[]},workerResult:{ok:true,errors:[]}});
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
