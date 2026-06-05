/**
 * CycleDetection — flags any page whose routing eventually loops back to it.
 *
 * DFS with path tracking: distinguishes DAG convergence (two paths into the
 * same page, fine) from true cycles (a path that revisits a page already in
 * the current traversal).
 *
 * Tags: structure, spec-only. NOT fast — graph traversal can be O(pages * edges)
 * in pathological specs, so Map Builder skips this in per-keystroke mode.
 */

import type { CampaignSpec, Page, Rule, Violation } from '../types.ts'

function getNextIds(page: Page): string[] {
  const ids: string[] = []
  switch (page.type) {
    case 'presell':
    case 'landing':
      if (page.next_page) ids.push(page.next_page)
      if (page.success_url) ids.push(page.success_url)
      break
    case 'checkout':
      if (page.success_url) ids.push(page.success_url)
      break
    case 'upsell':
    case 'downsell':
      if (page.on_accept) ids.push(page.on_accept)
      if (page.on_decline) ids.push(page.on_decline)
      break
    case 'thankyou':
      // Terminal — no outgoing edges.
      break
  }
  return ids
}

/**
 * Walk the spec and produce a flat list of { page, funnelIdx, pageIdx } so
 * we can build JSON Pointer paths back to the offender.
 */
interface PageRef {
  page: Page
  funnelIdx: number
  pageIdx: number
}

function collectPages(spec: CampaignSpec): PageRef[] {
  const refs: PageRef[] = []
  spec.funnels.forEach((funnel, funnelIdx) => {
    const pages = funnel.pages ?? []
    pages.forEach((page, pageIdx) => {
      refs.push({ page, funnelIdx, pageIdx })
    })
  })
  return refs
}

function buildPageMap(refs: PageRef[]): Map<string, PageRef> {
  const map = new Map<string, PageRef>()
  for (const ref of refs) {
    if (ref.page.id && !map.has(ref.page.id)) {
      // Duplicate page IDs are caught by a separate rule
      // (PageRouteUniqueness, not yet extracted). Keep the first.
      map.set(ref.page.id, ref)
    }
  }
  return map
}

/**
 * Returns the list of page IDs in the cycle reachable from `startId`, or
 * null if no cycle is reachable. The first element of the returned list is
 * the page that's revisited (the cycle's entry); subsequent elements are
 * the cycle's path.
 */
function findCycleFrom(
  startId: string,
  pageMap: Map<string, PageRef>,
): string[] | null {
  const inPath: string[] = []
  const inPathSet = new Set<string>()
  const fullyExplored = new Set<string>()

  function dfs(id: string): string[] | null {
    if (inPathSet.has(id)) {
      // Found a cycle. Slice the path from the revisited node.
      const idx = inPath.indexOf(id)
      return [...inPath.slice(idx), id]
    }
    if (fullyExplored.has(id)) return null

    inPath.push(id)
    inPathSet.add(id)

    const ref = pageMap.get(id)
    if (ref) {
      for (const next of getNextIds(ref.page)) {
        const cycle = dfs(next)
        if (cycle) return cycle
      }
    }

    inPath.pop()
    inPathSet.delete(id)
    fullyExplored.add(id)
    return null
  }

  return dfs(startId)
}

export const CycleDetection: Rule = {
  id: 'CycleDetection',
  severity: 'error',
  tags: ['structure', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const refs = collectPages(spec)
    const pageMap = buildPageMap(refs)
    const violations: Violation[] = []

    // Two-level dedup: a cycle reached from different starting positions
    // produces different "entries" (the rotation depends on the starting node)
    // but the same node SET. Canonicalize by sorted node IDs to dedupe.
    const reportedSignatures = new Set<string>()
    // Skip outer iteration over pages already known to be in a reported cycle.
    const inReportedCycle = new Set<string>()

    for (const ref of refs) {
      if (!ref.page.id) continue
      if (inReportedCycle.has(ref.page.id)) continue

      const cycle = findCycleFrom(ref.page.id, pageMap)
      if (!cycle || cycle.length === 0) continue

      // cycle is [entry, ...path, entry] — drop the trailing duplicate for the signature.
      const cycleNodes = cycle.slice(0, -1)
      const signature = [...cycleNodes].sort().join('|')
      if (reportedSignatures.has(signature)) {
        for (const id of cycleNodes) inReportedCycle.add(id)
        continue
      }
      reportedSignatures.add(signature)
      for (const id of cycleNodes) inReportedCycle.add(id)

      const entryId = cycle[0]
      const entryRef = pageMap.get(entryId)
      const path = entryRef
        ? `/funnels/${entryRef.funnelIdx}/pages/${entryRef.pageIdx}`
        : '/funnels'

      // Any cycle is release-blocking. Draft UIs can choose to filter or soften
      // this rule, but exported/compiled specs must not route back to themselves.
      const isSelfLoop = cycle.length === 2 && cycle[0] === cycle[1]

      violations.push({
        ruleId: 'CycleDetection',
        severity: 'error',
        message: isSelfLoop
          ? `Page "${entryRef?.page.label ?? entryId}" routes to itself.`
          : `Circular route detected starting at "${entryRef?.page.label ?? entryId}". Cycle: ${cycle.join(' → ')}`,
        path,
        data: { cycle, entryPageId: entryId },
      })
    }

    return violations
  },
}
