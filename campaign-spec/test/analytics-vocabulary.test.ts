import { describe, expect, test } from './harness.ts'
import {
  CAMPAIGN_CART_ANALYTICS_IDENTITY_MIN_SDK_VERSION,
  CAMPAIGN_CART_ANALYTICS_VOCABULARY_SDK_VERSION,
  DL_EVENTS,
  DL_EVENT_NAMES,
  DL_EVENT_NAME_SET,
  isKnownDlEvent,
} from '../analytics-vocabulary.ts'

// Guards the snapshot synced from the Campaign Cart SDK manifest. This catches
// a hand-edit that introduces a malformed/duplicate name; it does NOT detect
// SDK drift (campaigns-os takes no SDK dependency) — resync is manual, per the
// module header. See executive design note for the cross-repo rationale.
describe('analytics dl_* vocabulary (synced snapshot)', () => {
  test('every name is a well-formed dl_* identifier', () => {
    for (const name of DL_EVENT_NAMES) {
      expect(/^dl_[a-z_]+$/.test(name)).toBe(true)
    }
  })

  test('has no duplicate event names', () => {
    expect(DL_EVENT_NAMES.length).toBe(DL_EVENT_NAME_SET.size)
    expect(DL_EVENT_NAMES.length).toBe(DL_EVENTS.length)
  })

  test('every event declares a category', () => {
    for (const def of DL_EVENTS) {
      expect(typeof def.category).toBe('string')
      expect(def.category.length > 0).toBe(true)
    }
  })

  test('every event carries picker metadata', () => {
    expect(CAMPAIGN_CART_ANALYTICS_VOCABULARY_SDK_VERSION).toBe('0.4.30')
    expect(CAMPAIGN_CART_ANALYTICS_IDENTITY_MIN_SDK_VERSION).toBe('0.4.30')
    for (const def of DL_EVENTS) {
      expect(typeof def.description).toBe('string')
      expect(def.description.length > 0).toBe(true)
    }
  })

  test('isKnownDlEvent recognizes vocabulary and rejects unknowns', () => {
    expect(isKnownDlEvent('dl_purchase')).toBe(true)
    expect(isKnownDlEvent('dl_upsell_purchase')).toBe(true)
    expect(isKnownDlEvent('purchase')).toBe(false)
    expect(isKnownDlEvent('dl_not_a_real_event')).toBe(false)
  })

  test('carries the core ecommerce + upsell events the picker/validator rely on', () => {
    for (const core of ['dl_purchase', 'dl_upsell_purchase', 'dl_add_to_cart', 'dl_begin_checkout']) {
      expect(DL_EVENT_NAME_SET.has(core)).toBe(true)
    }
  })
})
