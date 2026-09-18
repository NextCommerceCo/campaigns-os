// Read-only source evidence. SDK migration names come exclusively from the supplied manifest.
import { parse as parseJs } from 'acorn';
import { parse as parseHtml } from 'parse5';
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, dirname, posix, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
const digest = value => createHash('sha256').update(value).digest('hex');
const version = value => {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value))
    throw new Error('SDK versions must be exact x.y.z versions.');
  return value.split('.').map(Number);
};
const compare = (a, b) => {
  a = version(a);
  b = version(b);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  }
  return 0;
};
const normalizePattern = key => key.replace(/\{[^}]*\}/g, '{}');
const bareKey = entry => entry.migration?.legacyKey ?? entry.key.replace('{__scope}', '');
function matchesTemplate(key, template) {
  const pieces = template.split(/\{[^}]*\}/g);
  if (pieces.length === 1)
    return key === template;
  if (!key.startsWith(pieces[0]) || !key.endsWith(pieces.at(-1)))
    return false;
  let offset = pieces[0].length;
  for (const piece of pieces.slice(1, -1)) {
    const next = key.indexOf(piece, offset);
    if (next < 0)
      return false;
    offset = next + piece.length;
  }
  return true;
}
function children(node) { return Object.values(node).flatMap(value => Array.isArray(value) ? value.filter(x => x?.type) : value?.type ? [value] : []); }
function names(pattern) {
  if (!pattern) return [];
  if (pattern.type === 'Identifier') return [pattern.name];
  return children(pattern).flatMap(names);
}
function normalizeScope(value) {
  if (typeof value !== 'string' || !value.length || value.includes('\\') || value.startsWith('/') || value.split('/').includes('..') || /[\[*?]/.test(value))
    throw new Error('Scope and exclusions must be literal repository-relative files or directories.');
  return value.replace(/^\.\//, '').replace(/\/$/, '') || '.';
}
const inside = (path, scope) => scope === '.' || path === scope || path.startsWith(scope + '/');
export function readStorageManifest(path) {
  const bytes = readFileSync(path);
  const value = JSON.parse(bytes);
  if (value.schemaVersion !== 1 || !Array.isArray(value.keys) || !value.provenance || typeof value.provenance.extractor !== 'string' || typeof value.provenance.registry !== 'string' || !/^[a-f0-9]{64}$/.test(value.provenance.inputSha256 ?? ''))
    throw new Error('Unrecognized or incomplete SDK storage manifest.');
  version(value.sdkVersion);
  version(value.supportedSdkVersions?.min);
  version(value.supportedSdkVersions?.max);
  if (compare(value.sdkVersion, value.supportedSdkVersions.max) !== 0)
    throw new Error('Manifest source SDK version must equal supported maximum.');
  const unique = new Set();
  if (compare(value.supportedSdkVersions.min, value.supportedSdkVersions.max) > 0)
    throw new Error('Invalid manifest version range.');
  for (const entry of value.keys) {
    if (typeof entry.key !== 'string' || !entry.key || typeof entry.pattern !== 'string' || entry.pattern !== normalizePattern(entry.key) || entry.scoped !== entry.key.includes('{__scope}') || !Array.isArray(entry.areas) || entry.areas.some(x => !['localStorage', 'sessionStorage'].includes(x)) || typeof entry.scoped !== 'boolean')
      throw new Error('Invalid storage manifest key.');
    if (unique.has(entry.key))
      throw new Error('Duplicate manifest storage key.');
    unique.add(entry.key);
    if (entry.migration !== null && (!entry.migration || typeof entry.migration !== 'object'))
      throw new Error('Migration must be explicit null or evidence object.');
    if (entry.replacement !== null && (!entry.replacement || entry.replacement.kind !== 'public-store' || typeof entry.replacement.export !== 'string' || typeof entry.replacement.guide !== 'string'))
      throw new Error('Invalid public replacement.');
    if (entry.migration) {
      version(entry.migration.since);
      if (!entry.areas.length || !entry.scoped || entry.migration.legacyKey !== entry.key.replace('{__scope}', '') || compare(entry.migration.since, value.sdkVersion) > 0)
        throw new Error('Migration and canonical storage key disagree.');
      if (typeof entry.migration.legacyKey !== 'string' || !/^[a-f0-9]{40}$/.test(entry.migration.releaseEvidence?.commit ?? '') || typeof entry.migration.releaseEvidence?.tag !== 'string')
        throw new Error('Migration lacks verified release evidence.');
    }
  }
  let source = { verification: 'unverified-local-file', repository: null, commit: null, repositoryPath: null };
  try {
    const root = execFileSync('git', ['-C', dirname(resolve(path)), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const repositoryPath = relative(root, resolve(path)).split(sep).join('/');
    const blob = execFileSync('git', ['-C', root, 'show', `${commit}:${repositoryPath}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (digest(blob) === digest(bytes))
      source = { verification: 'verified-git-blob', repository: root, commit, repositoryPath };
  }
  catch { /* A proposed generated manifest may not have been committed yet. */ }
  return { value, evidence: { path: resolve(path), sha256: digest(bytes), sdkVersion: value.sdkVersion, provenance: value.provenance, supportedSdkVersions: value.supportedSdkVersions, source } };
}
export function analyzeStorageJavaScript(source, { path = '<source>', lineOffset = 0, columnOffset = 0, manifest, targetSdkVersion } = {}) {
  const findings = [];
  const emit = (node, data) => findings.push({ path, line: (node.loc?.start.line ?? 1) + lineOffset, column: (node.loc?.start.column ?? 0) + 1 + ((node.loc?.start.line ?? 1) === 1 ? columnOffset : 0), ...data });
  let ast;
  try {
    ast = parseJs(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
  }
  catch (error) {
    emit({ loc: { start: error.loc } }, { operation: 'unknown', area: null, key: null, status: 'unknown', reason: 'parse-failure', detail: error.message, replacement: null });
    return findings;
  }
  const root = { bindings: new Map(), parent: null };
  const scopes = new WeakMap();
  function collect(node, scope) {
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'BlockStatement', 'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement', 'StaticBlock', 'ClassExpression', 'ClassDeclaration'].includes(node.type)) {
      if (['FunctionDeclaration', 'ClassDeclaration'].includes(node.type) && node.id)
        scope.bindings.set(node.id.name, { unknown: true });
      scope = { bindings: new Map(), parent: scope };
      for (const p of node.params ?? [])
        for (const name of names(p))
          scope.bindings.set(name, { unknown: true });
      for (const name of names(node.param))
        scope.bindings.set(name, { unknown: true });
      if (['FunctionExpression', 'ClassExpression', 'ClassDeclaration'].includes(node.type) && node.id)
        scope.bindings.set(node.id.name, { unknown: true });
    }
    scopes.set(node, scope);
    if (node.type === 'VariableDeclaration')
      for (const d of node.declarations)
        for (const name of names(d.id)) {
          let target = scope;
          if (node.kind === 'var')
            while (target.parent && !target.functionScope)
              target = target.parent;
          const property = d.id.type === 'ObjectPattern' ? d.id.properties.find(p => p.type === 'Property' && p.value.type === 'Identifier' && p.value.name === name) : null;
          target.bindings.set(name, {
            init: node.kind === 'const' && d.id.type === 'Identifier' ? d.init : null,
            destructure: property ? { object: d.init, property, mutable: node.kind !== 'const' } : null,
            scope, start: d.start,
          });
        }
    if (node.type.startsWith('Function') || node.type === 'ArrowFunctionExpression' || node.type === 'StaticBlock')
      scope.functionScope = true;
    if (node.type === 'ImportDeclaration')
      for (const s of node.specifiers)
        scope.bindings.set(s.local.name, { unknown: true });
    for (const child of children(node))
      collect(child, scope);
  }
  collect(ast, root);
  function binding(name, scope) { while (scope) {
    if (scope.bindings.has(name))
      return scope.bindings.get(name);
    scope = scope.parent;
  } return null; }
  function literal(node, scope, seen = new Set()) {
    if (!node)
      return null;
    if (node.type === 'Literal' && typeof node.value === 'string')
      return node.value;
    if (node.type === 'TemplateLiteral' && !node.expressions.length)
      return node.quasis[0].value.cooked;
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const a = literal(node.left, scope, seen), b = literal(node.right, scope, seen);
      return a !== null && b !== null ? a + b : null;
    }
    if (node.type === 'Identifier') {
      const b = binding(node.name, scope);
      if (!b?.init || seen.has(b) || b.start > node.start)
        return null;
      return literal(b.init, b.scope, new Set([...seen, b]));
    }
    return null;
  }
  function browserGlobal(node, scope, seen = new Set()) {
    if (node?.type !== 'Identifier') return null;
    const b = binding(node.name, scope);
    if (['window', 'globalThis', 'self'].includes(node.name)) return { shadowed: !!b };
    if (b?.init && !seen.has(b)) return browserGlobal(b.init, b.scope, new Set([...seen, b]));
    return null;
  }
  function area(node, scope, seen = new Set()) {
    if (node?.type === 'Identifier') {
      const b = binding(node.name, scope);
      if (['localStorage', 'sessionStorage'].includes(node.name)) return { name: node.name, shadowed: !!b };
      if (b?.init && !seen.has(b)) return area(b.init, b.scope, new Set([...seen, b]));
      if (b?.destructure) {
        const global = browserGlobal(b.destructure.object, b.scope);
        const property = b.destructure.property;
        const name = property.computed ? literal(property.key, b.scope) : property.key.name;
        if (global && ['localStorage', 'sessionStorage'].includes(name)) return { name, shadowed: global.shadowed || b.destructure.mutable };
      }
    }
    if (node?.type === 'MemberExpression') {
      const global = browserGlobal(node.object, scope);
      const name = node.computed ? literal(node.property, scope) : node.property.name;
      if (global && ['localStorage', 'sessionStorage'].includes(name)) return { name, shadowed: global.shadowed };
    }
    return null;
  }
  function record(node, storage, key, operation, reason = null) {
    let status = 'unaffected', replacement = null;
    if (storage.shadowed || key === null || reason) {
      status = 'unknown';
      reason ??= storage.shadowed ? 'shadowed-storage-reference' : 'dynamic-key';
    }
    else {
      const entries = manifest.keys.filter(e => e.areas.includes(storage.name));
      const entry = entries.find(e => bareKey(e) === key);
      if (entry?.migration && compare(targetSdkVersion, entry.migration.since) >= 0) {
        status = 'incompatible';
        reason = 'bare-migrated-sdk-key';
        replacement = entry.replacement ?? null;
      }
      else if (entry?.scoped && !entry.migration) {
        status = 'unknown';
        reason = 'migration-boundary-unverified';
      }
      else if (entries.some(e => e.scoped && (matchesTemplate(key, e.key) || matchesTemplate(key, bareKey(e)) || key.startsWith(bareKey(e) + '__')) && key !== bareKey(e))) {
        status = 'unknown';
        reason = 'guessed-scoped-sdk-key';
      }
      else
        reason = 'literal-unaffected-key';
    }
    emit(node, { operation, area: storage.name, key, status, reason, replacement });
  }
  const handled = new WeakSet();
  const aliasInitialization = (node, parent) => parent?.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'Identifier' && binding(parent.id.name, scopes.get(parent))?.init === node;
  const propertyName = (node, parent) => (
    (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
    (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent?.type) && parent.key === node && !parent.computed && !parent.shorthand) ||
    (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent?.type) && parent.label === node)
  );
  function visit(node, parent) {
    const scope = scopes.get(node);
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      const member = node.callee, storage = area(member.object, scope), method = member.computed ? literal(member.property, scope) : member.property.name;
      if (storage) {
        handled.add(member);
        const operation = { getItem: 'read', setItem: 'write', removeItem: 'remove' }[method];
        record(node, storage, operation ? literal(node.arguments[0], scope) : null, operation ?? 'unknown', operation ? null : 'unsupported-storage-method');
      }
    }
    if (node.type === 'MemberExpression' && !handled.has(node)) {
      const storage = area(node.object, scope);
      if (storage) {
        const operation = parent?.type === 'AssignmentExpression' && parent.left === node ? 'write' : parent?.type === 'UnaryExpression' && parent.operator === 'delete' ? 'remove' : parent?.type === 'UpdateExpression' ? 'write' : 'read';
        const key = node.computed ? literal(node.property, scope) : node.property.name;
        const reserved = ['getItem', 'setItem', 'removeItem', 'clear', 'key', 'length'].includes(key);
        if (key === 'length' && operation === 'read' && !storage.shadowed) {
          emit(node, { operation, area: storage.name, key, status: 'unaffected', reason: 'storage-metadata-read', replacement: null });
        } else {
          record(node, storage, key, operation, reserved ? 'unsupported-storage-member' : null);
        }
      }
    }
    const storage = area(node, scope);
    if (storage && !propertyName(node, parent) && !(parent?.type === 'MemberExpression' && parent.object === node) && !aliasInitialization(node, parent) && !(parent?.type === 'VariableDeclarator' && parent.id === node) && !(parent?.params ?? []).includes(node)) {
      // Passing/destructuring/mutably aliasing the Storage object loses bounded data flow.
      record(node, storage, null, 'unknown', 'storage-object-escape');
    }
    for (const child of children(node))
      visit(child, node);
  }
  visit(ast, null);
  return findings;
}
export function scanSdkStorageCompatibility({ cwd = process.cwd(), targetSdkVersion, manifestPath, scope, exclude = [] }) {
  version(targetSdkVersion);
  if (!Array.isArray(scope) || !scope.length)
    throw new Error('At least one explicit --scope is required; include shared script directories explicitly.');
  scope = scope.map(normalizeScope);
  exclude = exclude.map(normalizeScope);
  let root;
  try { root = execFileSync('git', ['-C', resolve(cwd), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { throw new Error('SDK storage scan target must be a readable Git repository root.'); }
  const rootIdentity = statSync(root);
  const targetIdentity = statSync(cwd);
  if (rootIdentity.dev !== targetIdentity.dev || rootIdentity.ino !== targetIdentity.ino)
    throw new Error('--target must be the Git repository root.');
  const { value: manifest, evidence } = readStorageManifest(manifestPath);
  let tracked;
  try { tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); }
  catch { throw new Error('Cannot inventory tracked Git source files.'); }
  for (const item of scope)
    if (!tracked.some(p => inside(p, item)))
      throw new Error(`Scope has no tracked files: ${item}`);
  const selected = tracked.filter(p => /\.(?:html?|[cm]?js)$/i.test(p) && scope.some(s => inside(p, s)) && !exclude.some(s => inside(p, s))).sort();
  const files = [], findings = [];
  const unknown = (path, reason, detail, line = 1) => findings.push({ path, line, column: 1, operation: 'unknown', area: null, key: null, status: 'unknown', reason, detail, replacement: null });
  if (compare(targetSdkVersion, manifest.supportedSdkVersions.min) < 0 || compare(targetSdkVersion, manifest.supportedSdkVersions.max) > 0)
    unknown(evidence.path, 'target-outside-manifest-range', targetSdkVersion);
  if (!selected.length)
    unknown('.', 'empty-source-scope', 'No tracked HTML or JavaScript files selected.');
  for (const path of selected) {
    const absolute = resolve(root, path);
    let stat;
    try {
      stat = lstatSync(absolute);
    }
    catch (error) {
      unknown(path, 'source-unreadable', error.code ?? error.message);
      continue;
    }
    if (stat.isSymbolicLink() || !realpathSync(absolute).startsWith(realpathSync(root) + sep)) {
      unknown(path, 'unsafe-source-path', 'Symlinks and paths outside target are not scanned.');
      continue;
    }
    let bytes;
    try { bytes = readFileSync(absolute); }
    catch (error) { unknown(path, 'source-unreadable', error.code ?? error.message); continue; }
    files.push({ path, sha256: digest(bytes) });
    if (!isUtf8(bytes)) { unknown(path, 'source-invalid-utf8', 'Source bytes are not valid UTF-8.'); continue; }
    const text = bytes.toString('utf8');
    const analyze = (source, lineOffset = 0, columnOffset = 0) => findings.push(...analyzeStorageJavaScript(source, { path, lineOffset, columnOffset, manifest, targetSdkVersion }));
    if (!/\.html?$/i.test(path)) {
      analyze(text);
      continue;
    }
    const document = parseHtml(text, { sourceCodeLocationInfo: true });
    let baseHref = null;
    function findBase(node) {
      if (baseHref === null && node.tagName === 'base') baseHref = node.attrs?.find(attr => attr.name === 'href')?.value ?? null;
      for (const child of node.childNodes ?? []) findBase(child);
    }
    findBase(document);
    function html(node) {
      if (node.tagName === 'script') {
        const attrs = Object.fromEntries((node.attrs ?? []).map(a => [a.name, a.value]));
        const type = (attrs.type ?? '').trim().toLowerCase();
        if (!type || ['module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(type)) {
          if (attrs.src) {
            if (baseHref !== null && !attrs.src.startsWith('/') && !/^[a-z]+:/i.test(attrs.src)) {
              unknown(path, 'html-base-script-resolution', `Relative script ${attrs.src} resolves against base ${baseHref}; include/review the actual dependency.`, node.sourceCodeLocation?.startLine ?? 1);
            }
            if (!/^(?:[a-z]+:)?\/\//i.test(attrs.src) && !attrs.src.startsWith('data:')) {
              const localSource = attrs.src.split(/[?#]/)[0];
              const sourcePath = posix.normalize(localSource.startsWith('/') ? localSource.slice(1) : posix.join(posix.dirname(path), localSource));
              if (!selected.includes(sourcePath))
                unknown(path, 'shared-script-outside-scope', sourcePath, node.sourceCodeLocation?.startLine ?? 1);
            }
          }
          else if (node.sourceCodeLocation?.startTag) {
            const start = node.sourceCodeLocation.startTag.endOffset, end = node.sourceCodeLocation.endTag?.startOffset ?? node.sourceCodeLocation.endOffset;
            const before = text.slice(0, start);
            const lines = before.split('\n');
            analyze(text.slice(start, end), lines.length - 1, lines.at(-1).length);
          }
        }
      }
      for (const child of node.childNodes ?? [])
        html(child);
      if (node.content)
        html(node.content);
    }
    html(document);
  }
  const status = findings.some(f => f.status === 'incompatible') ? 'incompatible' : findings.some(f => f.status === 'unknown') ? 'unknown' : 'source-compatible';
  return { schemaVersion: 1, targetSdkVersion, manifest: evidence, scope, exclude, files, findings, status, evidenceBoundary: 'Static tracked source compatibility only; no browser, order, or analytics proof.' };
}
export function formatStorageCompatibilityReport(result) {
  const counts = status => result.findings.filter(f => f.status === status).length;
  return [`SDK storage compatibility: ${result.status} (target ${result.targetSdkVersion})`, `${result.files.length} tracked source files; ${counts('incompatible')} incompatible, ${counts('unknown')} unknown, ${counts('unaffected')} unaffected storage accesses.`, `Manifest ${result.manifest.sha256} (${result.manifest.source.verification})`, ...result.findings.filter(f => f.status !== 'unaffected').map(f => `${f.path}:${f.line}:${f.column} ${f.status}: ${f.reason}${f.key ? ` (${f.key})` : ''}${f.detail ? ` — ${f.detail}` : ''}`), result.evidenceBoundary].join('\n');
}
