/**
 * PackagePricingSanity — per-package sanity check: a package with price_retail
 * explicitly set to $0 while price > 0 is almost certainly a data entry error
 * (the retail and sale prices got swapped, or someone meant to leave retail
 * unset rather than zero it out).
 *
 * Warning severity. Message text inherited verbatim from the pre-#110
 * validator. Note the parseFloat() coercion — packages sometimes
 * arrive with string-typed prices from upstream CSV imports.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

export const PackagePricingSanity: Rule = {
  id: 'PackagePricingSanity',
  severity: 'warning',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []

    spec.funnels.forEach((funnel, funnelIdx) => {
      const pages = funnel.pages ?? []
      pages.forEach((page, pageIdx) => {
        if (!page.packages) return
        page.packages.forEach((pkg, pkgIdx) => {
          if (pkg.price_retail === undefined) return
          const retail = parseFloat(String(pkg.price_retail))
          const price = parseFloat(String(pkg.price))
          if (retail === 0 && price > 0) {
            const name = pkg.name || pkg.ref_id
            violations.push({
              ruleId: 'PackagePricingSanity',
              severity: 'warning',
              message: `"${page.label}" — Package "${name}" has retail price $0.00. Verify pricing with offers model.`,
              path: `/funnels/${funnelIdx}/pages/${pageIdx}/packages/${pkgIdx}/price_retail`,
              data: { pageId: page.id, packageName: name, price, priceRetail: retail },
            })
          }
        })
      })
    })

    return violations
  },
}
