// Validator for the one reviewed bundled projection; never a general sanitizer.
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,posix} from 'node:path';
import {parse,parseFragment} from 'parse5';
export const DEMO_ROUTES=['landing','checkout','upsell-bundle-stepper','receipt'];
export const DEMO_CSP="default-src 'none'; img-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'none'; base-uri 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'";
const digest=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const allowedPath=name=>/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:html|css|svg|png|jpe?g|webp|gif|woff2?|txt|json)$/.test(name)&&!name.split('/').some(part=>part==='.'||part==='..');
const image=name=>/\.(?:svg|png|jpe?g|webp|gif)$/.test(name);
const inactiveTags=new Set(['script','iframe','frame','frameset','object','embed','base','form','noscript','template','foreignobject','animate','animatetransform','animatemotion','set','audio','video']);
const resourceAttrs=new Set(['href','xlink:href','src','srcset','poster','data','action','formaction','ping','background','manifest','profile','codebase','archive','dynsrc','lowsrc','srcdoc']);
function localReference(value,from,files,{fragment=false}={}) {
  if(fragment&&/^#[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value))return null;
  if(typeof value!=='string'||!value||/[\\%?#\s\u0000-\u001f]/.test(value)||value.startsWith('/')||/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value))throw Error('demo.resource_invalid');
  const target=posix.normalize(posix.join(posix.dirname(from),value));
  if(!allowedPath(target)||!files.has(target))throw Error('demo.resource_missing');
  return target;
}
function cssText(text,from,files) {
  // Decode CSS escapes before inspecting resource constructs, including escaped
  // identifiers. This projection has no imports, image-set or active behavior.
  const decoded=text.replace(/\\([0-9a-f]{1,6})(?:\r\n|[\t\n\r\f ])?/gi,(_,hex)=>String.fromCodePoint(Math.min(parseInt(hex,16)||0xfffd,0x10ffff))).replace(/\\([^\n\r\f])/g,'$1').replace(/\/\*[\s\S]*?\*\//g,'');
  if(/@import\b|\b(?:image-set|expression|element)\s*\(|-moz-binding|behavior\s*:/i.test(decoded))throw Error('demo.css_active');
  for(const match of decoded.matchAll(/url\s*\(\s*([^)]*)\)/gi)) {
    let value=match[1].trim();if(/^(['"])[\s\S]*\1$/.test(value))value=value.slice(1,-1);
    const target=localReference(value,from,files,{fragment:true});
    if(target&&!image(target)&&!/\.woff2?$/.test(target))throw Error('demo.css_resource_invalid');
  }
  if((decoded.match(/url\s*\(/gi)||[]).length!==[...decoded.matchAll(/url\s*\(\s*([^)]*)\)/gi)].length)throw Error('demo.css_invalid');
}
function markup(text,from,files,{svg=false}={}) {
  if(svg&&(/<!doctype/i.test(text)||/<\?(?!xml(?:\s|\?))/i.test(text)))throw Error('demo.svg_document_active');
  const document=svg?parseFragment(text):parse(text);let head=null,banner=false,nav=0,csp=0;
  function visit(node) {
    const tag=node.tagName?.toLowerCase();const attrs=Object.fromEntries((node.attrs||[]).map(attr=>[attr.prefix?`${attr.prefix}:${attr.name}`:attr.name,attr.value]));
    if(inactiveTags.has(tag)||node.content)throw Error('demo.markup_active');
    if(tag==='head')head=node;
    if(attrs.role==='button'&&attrs['aria-disabled']!=='true')throw Error('demo.control_active');
    if(tag==='aside'&&attrs['data-demo-banner']==='true')banner=true;
    if(['button','input','select','textarea'].includes(tag)&&!Object.hasOwn(attrs,'disabled'))throw Error('demo.control_active');
    for(const [name,value] of Object.entries(attrs)) {
      if(/^on/i.test(name)||/^data-next-|^os-checkout-|^next-/.test(name))throw Error('demo.attribute_active');
      if(name==='style')cssText(value,from,files);
      if(!resourceAttrs.has(name))continue;
      let target;
      if(tag==='a'&&name==='href'&&attrs['data-demo-nav']==='true') {
        target=localReference(value,from,files);if(!DEMO_ROUTES.some(route=>target===`${route}/index.html`))throw Error('demo.navigation_invalid');nav++;
      }else if(tag==='link'&&name==='href'&&attrs.rel==='stylesheet') {
        target=localReference(value,from,files);if(!target.endsWith('.css'))throw Error('demo.stylesheet_invalid');
      }else if(tag==='img'&&name==='src') {
        target=localReference(value,from,files);if(!image(target))throw Error('demo.image_invalid');
      }else if(['use','image'].includes(tag)&&['href','xlink:href'].includes(name)) {
        target=localReference(value,from,files,{fragment:true});if(target&&!image(target))throw Error('demo.svg_reference_invalid');
      }else throw Error('demo.resource_attribute_invalid');
    }
    if(tag==='meta'&&Object.hasOwn(attrs,'http-equiv')) {
      if(attrs['http-equiv'].toLowerCase()!=='content-security-policy'||attrs.content!==DEMO_CSP)throw Error('demo.policy_invalid');csp++;
    }
    if(tag==='style')cssText((node.childNodes||[]).map(child=>child.value||'').join(''),from,files);
    for(const child of node.childNodes||[])visit(child);
  }
  visit(document);
  if(!svg) {
    const first=(head?.childNodes||[]).find(node=>node.tagName);
    if(csp!==1||first?.tagName!=='meta'||!banner||nav!==4)throw Error('demo.shell_invalid');
  }
}
export function validateDemoArtifact(root) {
  const files=new Map();let total=0;
  function collect(dir,prefix='') {
    for(const name of readdirSync(dir).sort()) {
      const path=join(dir,name),stat=lstatSync(path),relative=prefix?`${prefix}/${name}`:name;
      if(stat.isSymbolicLink())throw Error('demo.symlink_invalid');
      if(stat.isDirectory()){if(!/^[A-Za-z0-9_-]+$/.test(name))throw Error('demo.path_invalid');collect(path,relative);continue;}
      if(!stat.isFile()||!allowedPath(relative)||stat.size>2097152||(total+=stat.size)>8388608||files.size>=256)throw Error('demo.file_invalid');
      files.set(relative,readFileSync(path));
    }
  }
  collect(root);
  const provenance=JSON.parse(files.get('provenance.json')?.toString()||'null');
  if(provenance?.schema_version!=='campaigns-os-inert-demo/v0'||provenance.template_commit!=='11352c30c596db258679fd3a552b906086b11bb9'||provenance.page_kit_version!=='0.2.0'||provenance.tailwind_version!=='3.4.17'||JSON.stringify(provenance.routes)!==JSON.stringify(DEMO_ROUTES))throw Error('demo.provenance_invalid');
  const expected=provenance.output_hashes;
  const provenanceFields=['schema_version','template_commit','page_kit_version','page_kit_commit','tailwind_version','routes','typography','input_hashes','toolchain_lock_hash','output_hashes'];
  if(Object.keys(provenance).length!==provenanceFields.length||Object.keys(provenance).some(name=>!provenanceFields.includes(name))||provenance.page_kit_commit!=='eed0679b1d02ef5cbe7f21964165c4202724d91d'||provenance.typography!=='system-ui, sans-serif'||!/^sha256:[0-9a-f]{64}$/.test(provenance.toolchain_lock_hash)||!provenance.input_hashes||Object.keys(provenance.input_hashes).length>256||Object.entries(provenance.input_hashes).some(([name,value])=>!/^(?:src\/explore|rendered|_data)\/[A-Za-z0-9_./-]+$/.test(name)||name.split('/').includes('..')||!/^sha256:[0-9a-f]{64}$/.test(value)))throw Error('demo.provenance_invalid');
  if(!expected||Object.keys(expected).length!==files.size-1||Object.keys(expected).some(name=>!files.has(name)||name==='provenance.json'))throw Error('demo.manifest_invalid');
  for(const [name,bytes] of files) {
    if(name!=='provenance.json'&&expected[name]!==digest(bytes))throw Error('demo.digest_mismatch');
    if(name.endsWith('.html')){if(!DEMO_ROUTES.some(route=>name===`${route}/index.html`))throw Error('demo.route_invalid');markup(bytes.toString(),name,files);}
    if(name.endsWith('.svg'))markup(bytes.toString(),name,files,{svg:true});
    if(name.endsWith('.css'))cssText(bytes.toString(),name,files);
    if(name.endsWith('.json')&&name!=='provenance.json')throw Error('demo.json_invalid');
  }
  for(const route of DEMO_ROUTES)if(!files.has(`${route}/index.html`))throw Error('demo.route_missing');
  if(!files.has('NOTICE.txt'))throw Error('demo.notice_missing');
  return {files,provenance,totalBytes:total};
}
