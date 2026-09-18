// Maintainer-only regeneration. Neither this toolchain nor its source tree ships.
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parse,parseFragment,serialize} from 'parse5';
import {DEMO_ROUTES,DEMO_CSP,validateDemoArtifact} from '../src/demo-artifact.mjs';
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const TOOLS=join(ROOT,'scripts/demo-toolchain/node_modules');
const TEMPLATE='11352c30c596db258679fd3a552b906086b11bb9';
const sha=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const stage=mkdtempSync(join(tmpdir(),'campaigns-os-demo-regenerate-'));
const project=join(stage,'project'),bundle=join(stage,'bundle');
const inputs={};const outputs=new Map();
const save=(name,value)=>{outputs.set(name,Buffer.isBuffer(value)?value:Buffer.from(value));};
const attrs=node=>Object.fromEntries((node.attrs||[]).map(attr=>[attr.prefix?`${attr.prefix}:${attr.name}`:attr.name,attr.value]));
const attr=(node,name,value)=>{node.attrs=(node.attrs||[]).filter(item=>item.name!==name);node.attrs.push({name,value});};
const relative=(from,target)=>posix.relative(posix.dirname(from),target);
function sourceTarget(value,from) {
  if(typeof value!=='string'||/[?#\\\u0000-\u001f]/.test(value)||/^[a-z][a-z0-9+.-]*:/i.test(value))throw Error('demo regeneration unexpected reference');
  const path=value.startsWith('/explore/')?`assets/${value.slice('/explore/'.length)}`:posix.normalize(posix.join(posix.dirname(from),value));
  if(!/^assets\/(?:css|images|fonts)\/[A-Za-z0-9_./-]+$/.test(path)||path.includes('/../'))throw Error('demo regeneration reference escapes reviewed assets');
  return path;
}
function includeAsset(name) {
  if(outputs.has(name))return;
  const source=join(project,'src/explore',name);const bytes=readFileSync(source);
  inputs[`src/explore/${name}`]=sha(bytes);
  if(name.endsWith('.css')) {
    save(name,''); // mark visited before traversing references
    let index=0;
    const text=bytes.toString().replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,(_,quote,value)=>{
      // These two obsolete stock CSS backgrounds have no files in the pinned
      // Apollo tree. Remove only these exact missing references in the sample.
      if(name==='assets/css/next-core.css'&&['../images/3x4.svg','../images/checkout/check.png'].includes(value))return 'none';
      if(value.startsWith('data:image/svg+xml,')) {
        const svg=decodeURIComponent(value.slice('data:image/svg+xml,'.length));const target=`assets/images/demo-inline-${sha(svg).slice(7,23)}.svg`;save(target,svg);index++;return `url("${relative(name,target)}")`;
      }
      if(value.startsWith('#'))return `url("${value}")`;
      const target=sourceTarget(value,name);includeAsset(target);return `url("${relative(name,target)}")`;
    });
    if(/@import\b/i.test(text))throw Error('demo regeneration unexpected CSS import');
    save(name,text);
  }else if(name.endsWith('.svg')) {
    if(/<!doctype[^>]*\[/i.test(bytes.toString()))throw Error('demo source SVG internal subset unsupported');
    save(name,bytes.toString().replace(/<!DOCTYPE[^>]*>/gi,''));
  }else save(name,bytes);
}
const removeTags=new Set(['script','iframe','object','embed','base','noscript','template','audio','video','source']);
const removeAttrs=new Set(['action','formaction','srcdoc','srcset','ping','integrity','nonce','poster','data','background','manifest','profile','codebase','archive']);
function projectPage(route) {
  const from=`${route}/index.html`;const raw=readFileSync(join(project,'_site/explore',from),'utf8');inputs[`rendered/${from}`]=sha(raw);
  const doc=parse(raw);let head,body;
  function visit(node) {
    if(node.tagName==='head')head=node;if(node.tagName==='body')body=node;
    const old=attrs(node);
    if(node.nodeName==='#text'&&node.value.trim()==='--')node.value='$29 (sample)';
    if(String(old.class||'').split(/\s+/).includes('summary-toggle__text'))node.childNodes=[{nodeName:'#text',value:'Sample order summary',parentNode:node}];
    if(node.tagName==='img')attr(node,'loading','eager');
    if(node.attrs) {
      node.attrs=node.attrs.filter(item=>!/^on|^data-next-|^os-checkout-|^next-/.test(item.name)&&!removeAttrs.has(item.name));
      if(node.tagName==='form'){node.tagName='div';node.nodeName='div';}
      if(old.role==='button'||String(old.class||'').split(/\s+/).includes('order-summary__trigger')){attr(node,'aria-disabled','true');attr(node,'class',`${old.class||''} demo-inert`);}
      if(node.tagName==='a') {node.attrs=node.attrs.filter(item=>item.name!=='href');attr(node,'aria-disabled','true');attr(node,'class',`${old.class||''} demo-inert`);}
      if(['button','input','select','textarea'].includes(node.tagName)){attr(node,'disabled','');attr(node,'aria-disabled','true');attr(node,'class',`${old.class||''} demo-inert`);}
      if(old['data-next-display']) {
        const key=old['data-next-display'];
        if(node.tagName==='img') {attr(node,'src','/explore/images/1x1_1.svg');attr(node,'alt','Sample product');}
        else {const text=/price|total|tax|amount/i.test(key)?'$29.00 (sample)':/name/i.test(key)?'Sample product':'Sample';node.childNodes=[{nodeName:'#text',value:text,parentNode:node}];}
      }
      node.attrs=node.attrs.filter(item=>{
        if(['src','href'].includes(item.name)&&/^(?:[a-z]+:)?\/\//i.test(item.value))return false;
        if(['src','href'].includes(item.name)&&item.value&&!item.value.startsWith('#')) {
          const target=sourceTarget(item.value,from);includeAsset(target);item.value=relative(from,target);
        }
        return true;
      });
    }
    if(node.childNodes)node.childNodes=node.childNodes.filter(child=>{
      const a=attrs(child);return !removeTags.has(child.tagName)&&!String(a.class||'').split(/\s+/).some(name=>['skeleton-wrapper','cart-items__scroll-hint','summary-toggle__icon'].includes(name))&&!(child.tagName==='link'&&(a.rel!=='stylesheet'||/^(?:[a-z]+:)?\/\//i.test(a.href||'')))&&!(child.tagName==='meta'&&(a['http-equiv']||/^next-/.test(a.name||'')));
    });
    for(const child of node.childNodes||[])visit(child);
  }
  visit(doc);
  if(!head||!body)throw Error('demo regeneration document missing shell');
  const shell=parseFragment(`<meta http-equiv="Content-Security-Policy" content="${DEMO_CSP}"><link rel="stylesheet" href="../assets/css/demo.css">`).childNodes;head.childNodes.unshift(...shell);shell.forEach(node=>node.parentNode=head);
  const nav=parseFragment(`<aside data-demo-banner="true" class="demo-banner"><strong>Demo only</strong><span>Sample content. Checkout, payment and source controls are disabled.</span><nav aria-label="Sample pages">${DEMO_ROUTES.map((name,index)=>`<a data-demo-nav="true" href="../${name}/index.html">${['Landing','Checkout','Offer','Receipt'][index]}</a>`).join('')}</nav><p>For a real campaign, start in a new folder with a saved Campaign Map. Keep this demo and any edits as reference.</p></aside>`).childNodes;body.childNodes.unshift(...nav);nav.forEach(node=>node.parentNode=body);
  save(from,serialize(doc));
}
try {
  if(process.argv[2]!=='--write')throw Error('Use node scripts/regenerate-demo.mjs --write after preparing the pinned maintainer toolchain.');
  for(const [name,version] of [['next-campaign-page-kit','0.2.0'],['tailwindcss','3.4.17']])if(JSON.parse(readFileSync(join(TOOLS,name,'package.json'))).version!==version)throw Error('demo maintainer tool version mismatch');
  mkdirSync(join(project,'_data'),{recursive:true});writeFileSync(join(project,'package.json'),'{"private":true}\n');
  writeFileSync(join(project,'_data/template-sources.json'),JSON.stringify({sources:{'pinned-apollo':{type:'github',repo:'NextCommerceCo/campaign-cart-starter-templates',ref:TEMPLATE}}}));
  const init=JSON.parse(execFileSync(process.execPath,[join(TOOLS,'next-campaign-page-kit/lib/actions/init.js'),'--json','--non-interactive','--source','pinned-apollo','--template','apollo','--slug','explore','--name','Static Apollo sample','--api-key','DEMO-NOT-A-CAMPAIGN-KEY','--ai-context','none'],{cwd:project,encoding:'utf8',timeout:60000}));
  if(init.status!=='ok'&&init.ok!==true&&init.exit_code!==0)throw Error('demo campaign-init did not complete');
  const source=join(project,'src/explore');
  function inputTree(dir,prefix){for(const name of readdirSync(dir,{withFileTypes:true})){const path=join(dir,name.name),key=`${prefix}/${name.name}`;if(name.isDirectory())inputTree(path,key);else if(name.isFile())inputs[key]=sha(readFileSync(path));else throw Error('demo source symlink unsupported');}}
  inputTree(source,'src/explore');inputs['_data/campaigns.json']=sha(readFileSync(join(project,'_data/campaigns.json')));
  for(const name of readdirSync(source))if(name.endsWith('.html')&&!DEMO_ROUTES.includes(name.slice(0,-5)))rmSync(join(source,name));
  for(const route of DEMO_ROUTES)inputs[`src/explore/${route}.html`]=sha(readFileSync(join(source,`${route}.html`)));
  const built=JSON.parse(execFileSync(process.execPath,[join(TOOLS,'next-campaign-page-kit/lib/actions/build.js'),'--json'],{cwd:project,encoding:'utf8',env:{...process.env,CPK_ENV:'development'},timeout:30000}));
  if(built.built!==4||built.errors!==0)throw Error('demo Page Kit build must render exactly four reviewed pages');
  for(const route of DEMO_ROUTES)projectPage(route);
  mkdirSync(bundle,{recursive:true});
  for(const [name,bytes] of outputs){mkdirSync(dirname(join(bundle,name)),{recursive:true});writeFileSync(join(bundle,name),bytes);}
  const compiler=join(stage,'tailwind.config.cjs');
  const colors=Object.fromEntries(['brand-primary','brand-secondary','brand-accent','surface-bg','surface-card','surface-alt','text-primary','text-secondary','text-inverse'].map(name=>[name,`var(--${name})`]));
  // Fixed transcribed theme.extend from the reviewed landing layout. The remote
  // font is projected to deterministic system typography; no source config runs.
  const config=`module.exports=${JSON.stringify({content:DEMO_ROUTES.map(route=>join(bundle,route,'index.html')),theme:{extend:{fontFamily:{sans:['system-ui','sans-serif']},colors}}})};\n`;
  writeFileSync(compiler,config);const input=join(stage,'tailwind.input.css');writeFileSync(input,'@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
  const css=join(bundle,'assets/css/demo.css');mkdirSync(dirname(css),{recursive:true});
  execFileSync(process.execPath,[join(TOOLS,'tailwindcss/lib/cli.js'),'-c',compiler,'-i',input,'-o',css,'--minify'],{cwd:stage,timeout:30000,stdio:['ignore','ignore','pipe']});
  const extras='\nhtml,body{font-family:system-ui,sans-serif!important}.demo-banner{position:relative;z-index:1;padding:16px;background:#09090b;color:#fff;font:16px/1.4 system-ui,sans-serif}.demo-banner strong{display:block;font-size:18px}.demo-banner nav{all:unset!important;display:flex!important;flex-wrap:wrap!important;justify-content:flex-start!important;gap:16px!important;margin:8px 0!important}.demo-banner nav a{all:unset!important;display:block!important;flex:none!important;color:#91b9ff!important;text-decoration:underline!important;cursor:pointer!important;font:inherit!important}.demo-banner nav a:focus-visible{outline:2px solid #fff!important;outline-offset:3px!important}.demo-banner p{font-size:13px;margin:0}.demo-inert{pointer-events:none!important;cursor:default!important;opacity:.65}.checkout-reveal-panel{display:block!important}.swiper{position:relative;overflow:hidden}.swiper-wrapper{display:block}.swiper-slide{display:none}.swiper-slide:first-child{display:block}.swiper-button-prev,.swiper-button-next,.swiper-pagination{display:none!important}\n';
  writeFileSync(css,readFileSync(css,'utf8')+extras);
  save('assets/css/demo.css',readFileSync(css));
  const notices=['Static Apollo sample projection','Copyright 2026 Next Commerce Pte. Ltd.','Selected public NEXT Apollo template HTML and referenced assets, pinned to '+TEMPLATE+'.','This sample is inert reference content and confers no campaign or QA evidence.','Typography uses system-ui, sans-serif; remote fonts and active SDK controls are omitted.','Existing source notices are retained below; no additional template licence grant is asserted.','',readFileSync(join(TOOLS,'next-campaign-page-kit/LICENSE'),'utf8'),readFileSync(join(TOOLS,'tailwindcss/LICENSE'),'utf8')].join('\n');save('NOTICE.txt',notices);writeFileSync(join(bundle,'NOTICE.txt'),notices);
  const provenance={schema_version:'campaigns-os-inert-demo/v0',template_commit:TEMPLATE,page_kit_version:'0.2.0',page_kit_commit:'eed0679b1d02ef5cbe7f21964165c4202724d91d',tailwind_version:'3.4.17',routes:DEMO_ROUTES,typography:'system-ui, sans-serif',input_hashes:inputs,toolchain_lock_hash:sha(readFileSync(join(ROOT,'scripts/demo-toolchain/package-lock.json'))),output_hashes:Object.fromEntries([...outputs].sort(([a],[b])=>a.localeCompare(b)).map(([name,bytes])=>[name,sha(bytes)]))};
  writeFileSync(join(bundle,'provenance.json'),JSON.stringify(provenance,null,2)+'\n');
  const validated=validateDemoArtifact(bundle);const destination=join(ROOT,'demo/apollo-v0');rmSync(destination,{recursive:true,force:true});mkdirSync(dirname(destination),{recursive:true});cpSync(bundle,destination,{recursive:true});
  console.log(JSON.stringify({pages:4,files:validated.files.size,bytes:validated.totalBytes,template_commit:TEMPLATE}));
}finally{rmSync(stage,{recursive:true,force:true});}
