import { resolveBuiltSiteScope } from "./built-site-scope.mjs";
import { runtimeRelativeRouteForSpecValue } from "./route-identity.mjs";

// Use the recorded declaration, not a doctor's cached derived scope: failed
// intake also writes skip_reason mappings, which must never hide missing pages.
export function applyQaBuildScope(topologies, { packet, report, targetRepo, publicRouteSlug } = {}) {
  const declared = report?.stages?.prepare_build?.declared_out_of_scope;
  if (!Array.isArray(declared) || !packet) return { topologies, excludedPages: [] };
  const declaredIds = new Set(declared.map(page => page?.page_id));
  const skippedIds = new Set((packet.source_html?.pages || [])
    .filter(page => declaredIds.has(page.page_id) && !page.path && typeof page.skip_reason === "string" && page.skip_reason.trim())
    .map(page => page.page_id));
  if (!skippedIds.size) return { topologies, excludedPages: [] };
  const built = targetRepo ? resolveBuiltSiteScope(targetRepo, { slug: publicRouteSlug }) : null;
  const normalizeRoute = route => runtimeRelativeRouteForSpecValue(route, publicRouteSlug).replace(/^\/+|\/+$/g, "").replace(/(?:^|\/)index\.html$/, "").replace(/\/$/, "");
  const builtRoutes = new Set((built?.pages || []).map(page => normalizeRoute(page.route)));
  const excludedPages = [];
  const scoped = topologies.map(topology => ({
    ...topology,
    partial_build_scope: topology.pages.some(page => skippedIds.has(page.page_id)),
    pages: topology.pages.filter(page => {
      if (!skippedIds.has(page.page_id)) return true;
      // An explicitly materialized stock page rejoins QA. A declaration alone
      // is not an instruction to build it, nor proof that it exists.
      const route = page.url ? new URL(page.url).pathname : null;
      if (route !== null && builtRoutes.has(normalizeRoute(route))) return true;
      excludedPages.push(page);
      return false;
    }),
  }));
  return { topologies: scoped, excludedPages };
}

export function specForQaScope(spec, excludedPages = []) {
  const excluded = new Set(excludedPages.map(page => page.page_id));
  if (Array.isArray(spec.funnel_pages) && !spec.funnels?.length) {
    return { ...spec, funnel_pages: spec.funnel_pages.filter(page => !excluded.has(page.id)) };
  }
  return { ...spec, funnels: (spec.funnels || []).map(funnel => ({
    ...funnel, pages: (funnel.pages || []).filter(page => !excluded.has(page.id)),
  })) };
}
