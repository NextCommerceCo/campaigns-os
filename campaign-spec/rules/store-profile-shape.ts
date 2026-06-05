/**
 * StoreProfileShape — light validation for two campaign-level store
 * profile fields introduced in Slice 4f.
 *
 * 1. campaign.store_phone_tel must be a `tel:`-prefixed URI containing
 *    a digit-shaped number when present. The build wires this value
 *    into `<a href="tel:...">` attributes; a value without the scheme
 *    renders a broken link, and a value containing HTML metacharacters
 *    or alternative schemes (javascript:, data:) is rejected as a
 *    defense-in-depth measure for downstream templates that may skip
 *    href escaping. Accepted shape: `tel:` then optional `+`, then a
 *    sequence of at least 4 chars drawn from digits, spaces, dashes,
 *    parens, and dots.
 *
 * 2. campaign.allowed_domains shape check: when present, must be a
 *    non-empty array of hostname strings. The Campaigns API treats
 *    domain allowlisting as the access boundary for public-by-design
 *    keys; the spec carries the allowlist so the build packet can bind
 *    config.js to the right surface.
 *
 *    Scope note: this rule fires only when allowed_domains is
 *    explicitly set. Absence is silent — a missing allowlist is
 *    common in pre-launch / draft specs and belongs to a separate
 *    launch-readiness check, not a shape rule. The launch gate
 *    can be added later without changing this rule's contract.
 *
 * Both checks are warning severity. Never blocks a build.
 */

import type { CampaignSpec, Rule, Violation } from '../types.ts'

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

// `tel:` followed by optional `+`, then 4+ chars of digits / space / dash /
// parens / dot. Rejects HTML metachars, javascript:/data: schemes, control
// chars, and obvious garbage. Liberal enough for international formats
// (e.g. "tel:+44 (0)20 7946 0958"); strict enough to keep a downstream
// `<a href>` safe even if a template skips escaping.
const TEL_URI_REGEX = /^tel:\+?[0-9 .()\-]{4,}$/i

export const StoreProfileShape: Rule = {
  id: 'StoreProfileShape',
  severity: 'warning',
  tags: ['fast', 'spec-only'],

  check(spec: CampaignSpec): Violation[] {
    const violations: Violation[] = []
    const campaign = spec.campaign

    // 1. tel: prefix on store_phone_tel.
    if (campaign?.store_phone_tel !== undefined) {
      const value = campaign.store_phone_tel
      if (typeof value !== 'string') {
        violations.push({
          ruleId: 'StoreProfileShape',
          severity: 'warning',
          message: `campaign.store_phone_tel must be a string (got ${value === null ? 'null' : typeof value}).`,
          path: '/campaign/store_phone_tel',
          data: { check: 'store-phone-tel-bad-type' },
        })
      } else if (!isNonEmptyString(value)) {
        violations.push({
          ruleId: 'StoreProfileShape',
          severity: 'warning',
          message: 'campaign.store_phone_tel is set but empty; remove the field or set a tel:-prefixed value (e.g. "tel:+18005551234").',
          path: '/campaign/store_phone_tel',
          data: { check: 'store-phone-tel-empty' },
        })
      } else {
        const trimmed = value.trim()
        if (!trimmed.toLowerCase().startsWith('tel:')) {
          violations.push({
            ruleId: 'StoreProfileShape',
            severity: 'warning',
            message: `campaign.store_phone_tel "${value}" must be a tel: URI (e.g. "tel:+18005551234"); without the scheme it renders a broken link in <a href> attributes.`,
            path: '/campaign/store_phone_tel',
            data: { check: 'store-phone-tel-missing-scheme', value },
          })
        } else if (!TEL_URI_REGEX.test(trimmed)) {
          violations.push({
            ruleId: 'StoreProfileShape',
            severity: 'warning',
            message: `campaign.store_phone_tel "${value}" is not a recognized tel: number. Use digits, spaces, dashes, parens, and dots only (e.g. "tel:+18005551234" or "tel:+44 (0)20 7946 0958"); HTML metacharacters and alternative schemes (javascript:, data:) are rejected as a defense-in-depth measure.`,
            path: '/campaign/store_phone_tel',
            data: { check: 'store-phone-tel-bad-content', value },
          })
        }
      }
    }

    // 2. allowed_domains shape (when present — absence is silent; see header
    //    note about scope).
    const domains = campaign?.allowed_domains
    if (domains === undefined || domains === null) {
      // Intentionally silent — launch-readiness check lives elsewhere.
    } else if (!Array.isArray(domains)) {
      violations.push({
        ruleId: 'StoreProfileShape',
        severity: 'warning',
        message: `campaign.allowed_domains must be an array of hostnames; got ${typeof domains}.`,
        path: '/campaign/allowed_domains',
        data: { check: 'allowed-domains-bad-shape', value: domains },
      })
    } else if (domains.length === 0) {
      violations.push({
        ruleId: 'StoreProfileShape',
        severity: 'warning',
        message: 'campaign.allowed_domains is empty. Add at least one production hostname (e.g. "store.example.com") before launch so the SDK key has a valid origin.',
        path: '/campaign/allowed_domains',
        data: { check: 'allowed-domains-empty' },
      })
    } else {
      domains.forEach((domain, idx) => {
        if (!isNonEmptyString(domain)) {
          violations.push({
            ruleId: 'StoreProfileShape',
            severity: 'warning',
            message: `campaign.allowed_domains[${idx}] must be a non-empty hostname string; got ${JSON.stringify(domain)}.`,
            path: `/campaign/allowed_domains/${idx}`,
            data: { check: 'allowed-domain-bad-entry', index: idx, value: domain },
          })
        }
      })
    }

    return violations
  },
}
