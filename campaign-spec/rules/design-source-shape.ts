/**
 * DesignSourceShape — validates the per-page `design_source` block when
 * present. `design_source` is the pointer used by figma-sections-export
 * (and future design-tool exporters) to locate prepared HTML; campaigns-os
 * doctor reads it to distinguish "designer hasn't exported yet" from
 * generic `collect-inputs` when no source-html manifest is found.
 *
 * The block is fully optional — a page without `design_source` is silent
 * (existing manual handoff workflow keeps working). When `design_source`
 * IS set, this rule catches authoring drift before doctor sees it:
 *
 *   1. `type` must be a non-empty string (warning — currently only
 *      "figma" has tooling support, but we accept other strings so the
 *      schema doesn't break ahead of new exporters).
 *   2. `file_url` must be present and look like a real URL (warning).
 *   3. For `type: "figma"`, the file_url should be a figma.com URL
 *      (warning — easy paste mistake).
 *   4. `breakpoints` should declare at least one of desktop/tablet/mobile
 *      when present (warning — empty breakpoints object is meaningless).
 *   5. Each non-empty breakpoint value should look like a URL (warning).
 *   6. For `type: "figma"`, breakpoint URLs should be figma.com selection
 *      URLs (warning — same paste-mistake guard as file_url).
 *
 * Severity is `warning` across the board: this is authoring guidance, not
 * a build blocker. The export tool itself is the real validator at handoff
 * time; this rule keeps Map Builder authors honest while editing.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

const FIGMA_URL_PATTERN = /^https:\/\/(?:www\.)?figma\.com\//i
const ANY_URL_PATTERN = /^https?:\/\/\S+/i

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export const DesignSourceShape: Rule = {
  id: 'DesignSourceShape',
  severity: 'warning',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []

    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = funnel.pages ?? []
      pages.forEach((page, pageIdx) => {
        const design = page.design_source
        if (!design) return

        const basePath = `/funnels/${funnelIdx}/pages/${pageIdx}/design_source`
        const pageLabel = page.label || page.id || '(unnamed page)'

        // 1. type
        if (!isNonEmptyString(design.type)) {
          violations.push({
            ruleId: 'DesignSourceShape',
            severity: 'warning',
            message: `"${pageLabel}" — design_source.type is missing; expected a string like "figma".`,
            path: `${basePath}/type`,
            data: { pageId: page.id, check: 'type-missing' },
          })
        }

        // 2. file_url presence and URL-shape
        if (!isNonEmptyString(design.file_url)) {
          violations.push({
            ruleId: 'DesignSourceShape',
            severity: 'warning',
            message: `"${pageLabel}" — design_source.file_url is missing; expected the design-tool file URL.`,
            path: `${basePath}/file_url`,
            data: { pageId: page.id, check: 'file-url-missing' },
          })
        } else if (!ANY_URL_PATTERN.test(design.file_url)) {
          violations.push({
            ruleId: 'DesignSourceShape',
            severity: 'warning',
            message: `"${pageLabel}" — design_source.file_url does not look like a URL: ${truncate(design.file_url)}`,
            path: `${basePath}/file_url`,
            data: { pageId: page.id, check: 'file-url-shape', value: design.file_url },
          })
        } else if (design.type === 'figma' && !FIGMA_URL_PATTERN.test(design.file_url)) {
          // 3. figma-specific: must be a figma.com URL
          violations.push({
            ruleId: 'DesignSourceShape',
            severity: 'warning',
            message: `"${pageLabel}" — design_source.type is "figma" but file_url is not a figma.com URL: ${truncate(design.file_url)}`,
            path: `${basePath}/file_url`,
            data: { pageId: page.id, check: 'file-url-not-figma', value: design.file_url },
          })
        }

        // 4 + 5 + 6. breakpoints
        if (design.breakpoints !== undefined) {
          const bps = design.breakpoints
          const known: Array<'desktop' | 'tablet' | 'mobile'> = ['desktop', 'tablet', 'mobile']
          const declared = known.filter((bp) => isNonEmptyString(bps[bp]))

          if (declared.length === 0) {
            violations.push({
              ruleId: 'DesignSourceShape',
              severity: 'warning',
              message: `"${pageLabel}" — design_source.breakpoints is present but no desktop/tablet/mobile URL is set.`,
              path: `${basePath}/breakpoints`,
              data: { pageId: page.id, check: 'breakpoints-empty' },
            })
          }

          for (const bp of known) {
            const value = bps[bp]
            if (value === undefined) continue
            if (!isNonEmptyString(value)) {
              violations.push({
                ruleId: 'DesignSourceShape',
                severity: 'warning',
                message: `"${pageLabel}" — design_source.breakpoints.${bp} is set but empty.`,
                path: `${basePath}/breakpoints/${bp}`,
                data: { pageId: page.id, check: 'breakpoint-empty', breakpoint: bp },
              })
              continue
            }
            if (!ANY_URL_PATTERN.test(value)) {
              violations.push({
                ruleId: 'DesignSourceShape',
                severity: 'warning',
                message: `"${pageLabel}" — design_source.breakpoints.${bp} does not look like a URL: ${truncate(value)}`,
                path: `${basePath}/breakpoints/${bp}`,
                data: { pageId: page.id, check: 'breakpoint-url-shape', breakpoint: bp, value },
              })
              continue
            }
            if (design.type === 'figma' && !FIGMA_URL_PATTERN.test(value)) {
              violations.push({
                ruleId: 'DesignSourceShape',
                severity: 'warning',
                message: `"${pageLabel}" — design_source.type is "figma" but breakpoints.${bp} is not a figma.com URL: ${truncate(value)}`,
                path: `${basePath}/breakpoints/${bp}`,
                data: { pageId: page.id, check: 'breakpoint-not-figma', breakpoint: bp, value },
              })
            }
          }
        }
      })
    })

    return violations
  },
}

function truncate(value: string, max = 80): string {
  return value.length > max ? value.slice(0, max - 1) + '…' : value
}
