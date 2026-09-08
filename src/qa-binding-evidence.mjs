import { parse as parseHtml } from 'parse5';
import { parse as parseJs } from 'acorn';
import { createPageSourceLoader, resolveCommercialApiKey } from './qa-commercial-parity.mjs';

export const BINDING_SCHEMA = 'campaigns-os-page-binding/v0';
export const BINDING_LIMITS = Object.freeze({ scripts_per_page: 6, scripts_per_run: 24, script_bytes: 262144, timeout_ms: 5000 });
const SDK = /^https:\/\/cdn\.jsdelivr\.net\/gh\/NextCommerceCo\/campaign-cart@[^/]+\/(?:dist\/index\.js|public\/loader\.js)(?:\?[^#]*)?$/;
const str = value => typeof value === 'string' && value.length ? value : null;

// The expected credential uses the existing producer resolver. Disagreement
// among authored inputs is still unknown, even where that resolver has priority.
export function expectedBinding(resolved, env = process.env) {
  const spec = resolved.rawSpec || resolved.spec || {};
  const values = [resolved.packet?.campaign?.campaigns_api_key, resolved.packet?.campaign?.api_key,
    spec.campaign?.campaigns_api_key, spec.campaigns_api_key, spec.campaign?.api_key].filter(str);
  const selected = resolveCommercialApiKey(resolved, env).value;
  if (selected) values.push(selected);
  return { value: selected, conflict: new Set(values).size > 1 };
}

// Auth-free, no redirects, no nested imports/crawl. Reuses the canonical
// streaming byte/deadline/aggregate loader, with a tighter config budget.
export function createBindingScriptLoader({ fetchImpl = globalThis.fetch } = {}) {
  const cache = new Map();
  const loader = createPageSourceLoader({ limits: {
    max_html_bytes: BINDING_LIMITS.script_bytes,
    max_aggregate_html_bytes: BINDING_LIMITS.script_bytes * BINDING_LIMITS.scripts_per_run,
    request_timeout_ms: BINDING_LIMITS.timeout_ms,
  }, fetchImpl: (url, options) => fetchImpl(url, { ...options, redirect: 'manual', credentials: 'omit', headers: { Accept: 'application/javascript' } }) });
  return async (src, pageUrl) => {
    let url;
    try {
      const base = new URL(pageUrl);
      url = new URL(src, base);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin || url.username || url.password || url.hash) return { ok: false };
    } catch { return { ok: false }; }
    const key = url.href;
    if (!cache.has(key)) {
      if (cache.size >= BINDING_LIMITS.scripts_per_run) return { ok: false };
      // Do not allow loader exceptions (which may contain URLs/credentials) out.
      cache.set(key, loader({ url: key }).then(source => source.ok ? { ok: true, html: source.html } : { ok: false }, () => ({ ok: false })));
    }
    return cache.get(key);
  };
}

function isConfig(node) {
  return node?.type === 'MemberExpression' && !node.computed && node.object?.name === 'window' && node.property?.name === 'nextConfig';
}
function literalObject(node) {
  if (node?.type === 'Literal') return typeof node.value !== 'object' || node.value === null;
  if (node?.type === 'ArrayExpression') return node.elements.every(literalObject);
  if (node?.type === 'ObjectExpression') return node.properties.every(p => p.type === 'Property' && !p.computed && p.kind === 'init' && !p.method && !p.shorthand && literalObject(p.value));
  return false;
}
function declarations(text) {
  // Only whole, unconditional literal assignments are accepted. No evaluation,
  // constant propagation, getters, spreads, callbacks, aliases, or branch guesses.
  let ast;
  try { ast = parseJs(text, { ecmaVersion: 2022, sourceType: 'script' }); }
  catch { return { values: [], dynamic: true }; }
  const values = [];
  let dynamic = false;
  for (const statement of ast.body) {
    if (statement.type === 'EmptyStatement' || statement.directive) continue;
    const assignment = statement.expression;
    if (statement.type !== 'ExpressionStatement' || assignment?.type !== 'AssignmentExpression' || assignment.operator !== '=') { dynamic = true; continue; }
    if (isConfig(assignment.left) && assignment.right.type === 'ObjectExpression' && literalObject(assignment.right)) {
      const keys = assignment.right.properties.filter(p => (p.key.name ?? p.key.value) === 'apiKey');
      if (keys.length !== 1 || typeof keys[0].value.value !== 'string') dynamic = true;
      else values.push(keys[0].value.value);
    } else if (assignment.left?.type === 'MemberExpression' && !assignment.left.computed && isConfig(assignment.left.object) && assignment.left.property.name === 'apiKey' && assignment.right.type === 'Literal' && typeof assignment.right.value === 'string') {
      values.push(assignment.right.value);
    } else dynamic = true;
  }
  return { values, dynamic };
}

export async function observeBinding({ source, page, expected, scriptLoader }) {
  const kinds = new Set();
  const result = (outcome, reason) => ({ schema_version: BINDING_SCHEMA, observation: 'static_declaration',
    outcome, reason, source_kinds: [...kinds].sort(), identity: 'not_verified' });
  if (!source?.ok) return result('unknown', 'page_unavailable');
  let pageUrl = page.url;
  if (source.final_url) {
    try {
      const final = new URL(source.final_url);
      if (final.origin !== new URL(page.url).origin) return result('unknown', 'page_unavailable');
      pageUrl = final.href;
    } catch { return result('unknown', 'page_unavailable'); }
  }
  const values = [];
  const scripts = [];
  let dynamic = false;
  const walk = node => {
    const attrs = Object.fromEntries((node.attrs || []).map(a => [a.name, a.value]));
    if (node.tagName === 'base' || Object.entries(attrs).some(([name, value]) => /^on/i.test(name) || /^\s*javascript:/i.test(value))) dynamic = true;
    if (node.tagName === 'meta' && attrs.name === 'next-api-key') { values.push(attrs.content ?? ''); kinds.add('meta'); }
    if (node.tagName === 'script') scripts.push({ attrs, text: (node.childNodes || []).map(n => n.value || '').join('') });
    // parse5 keeps template content separate; it is inert, as is noscript at boot.
    if (node.tagName !== 'noscript') for (const child of node.childNodes || []) walk(child);
  };
  try { walk(parseHtml(source.html)); } catch { return result('unknown', 'dynamic_unresolved'); }
  let count = 0, unavailable = false;
  for (const script of scripts) {
    const { attrs } = script;
    if (attrs.type && !['text/javascript', 'application/javascript', 'module'].includes(attrs.type.toLowerCase())) continue;
    if (attrs.src && SDK.test(attrs.src)) continue;
    let text = script.text;
    let kind = 'inline';
    if (attrs.src) {
      kind = 'config_script';
      if (++count > BINDING_LIMITS.scripts_per_page) { unavailable = true; continue; }
      const loaded = await scriptLoader(attrs.src, pageUrl);
      if (!loaded.ok) { unavailable = true; continue; }
      text = loaded.html;
    }
    const found = declarations(text);
    if (found.values.length) { kinds.add(kind); values.push(...found.values); }
    if (found.dynamic || 'async' in attrs || 'nomodule' in attrs || attrs.type === 'module') dynamic = true;
  }
  if (new Set(values).size > 1) return result('unknown', 'conflicting_declarations');
  if (expected?.conflict) return result('unknown', 'conflicting_expected');
  if (!expected?.value) return result('unknown', 'expected_unavailable');
  if (unavailable) return result('unknown', 'script_unavailable_or_limit');
  if (dynamic) return result('unknown', 'dynamic_unresolved');
  if (!values.length) return result('unknown', 'no_source');
  return result(values[0] === expected.value ? 'match' : 'mismatch', 'credential_comparison');
}

export function bindingAssertion(page, evidence) {
  // No source URLs, values, hashes, masked fragments, or inferred App IDs.
  return { id: `page-binding:${page.page_id}`, family: 'api-metadata', page: page.page_id,
    status: evidence.outcome === 'match' ? 'pass' : evidence.outcome === 'mismatch' ? 'fail' : 'manual_review',
    ...(evidence.outcome === 'match' ? {} : { severity: evidence.outcome === 'mismatch' ? 'blocker' : 'warn' }),
    expected: 'expected credential declaration', actual: evidence.outcome, evidence };
}
