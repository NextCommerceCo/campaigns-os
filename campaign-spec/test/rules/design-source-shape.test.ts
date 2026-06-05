import { describe, expect, test } from 'bun:test'
import { DesignSourceShape } from '../../rules/design-source-shape.ts'
import { normalize } from '../../normalize.ts'
import { fixtureByName } from '../../fixtures/index.ts'
import type { CampaignSpec } from '../../types.ts'

function baseSpec(overrides: Partial<CampaignSpec> = {}): CampaignSpec {
  return {
    schema_version: '4.3',
    runtime: { sdk_version: '0.4.0' },
    campaign: { ref_id: 1, slug: 'test', payment_env_key: 'test_key' },
    shipping_methods: [{ ref_id: 'ship-standard' }],
    funnels: [
      {
        id: 'f',
        name: 'F',
        hypothesis: 'Test funnel for the design source rule.',
        weight: 100,
        pages: [
          {
            id: 'p-l',
            type: 'landing',
            label: 'Landing',
            next_page: 'p-ty',
          },
          {
            id: 'p-ty',
            type: 'thankyou',
            label: 'Thank You',
          },
        ],
      },
    ],
    ...overrides,
  }
}

describe('DesignSourceShape rule', () => {
  test('silent when no page has design_source', () => {
    expect(DesignSourceShape.check(normalize(baseSpec()))).toEqual([])
  })

  test('matches corpus fixture violations', () => {
    const fixture = fixtureByName('design-source-malformed')
    const violations = DesignSourceShape.check(normalize(fixture.spec))
    expect(violations).toEqual(fixture.expected.violations)
  })

  test('accepts a fully-populated figma design_source', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![0].design_source = {
      type: 'figma',
      file_url: 'https://www.figma.com/design/abc123/Sections',
      breakpoints: {
        desktop: 'https://www.figma.com/design/abc123/Sections?node-id=143-10518',
        tablet: 'https://www.figma.com/design/abc123/Sections?node-id=143-10610',
        mobile: 'https://www.figma.com/design/abc123/Sections?node-id=143-12936',
      },
    }
    expect(DesignSourceShape.check(normalize(spec))).toEqual([])
  })

  test('accepts design_source without breakpoints block at all', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![0].design_source = {
      type: 'figma',
      file_url: 'https://www.figma.com/design/abc123/Sections',
    }
    expect(DesignSourceShape.check(normalize(spec))).toEqual([])
  })

  test('flags missing type', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![0].design_source = {
      // @ts-expect-error — intentionally missing type
      type: '',
      file_url: 'https://www.figma.com/design/abc123/Sections',
    }
    const violations = DesignSourceShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('type-missing')
  })

  test('flags missing file_url', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![0].design_source = {
      type: 'figma',
      file_url: '',
    }
    const violations = DesignSourceShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('file-url-missing')
  })

  test('flags non-URL file_url', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![0].design_source = {
      type: 'figma',
      file_url: 'not-a-url',
    }
    const violations = DesignSourceShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('file-url-shape')
  })

  test('flags non-figma file_url when type is figma', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![0].design_source = {
      type: 'figma',
      file_url: 'https://example.com/not-figma',
    }
    const violations = DesignSourceShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('file-url-not-figma')
  })

  test('accepts non-figma file_url when type is not figma', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![0].design_source = {
      type: 'penpot',
      file_url: 'https://design.penpot.app/some-file',
    }
    expect(DesignSourceShape.check(normalize(spec))).toEqual([])
  })

  test('flags empty breakpoints block', () => {
    const spec = baseSpec()
    spec.funnels[0].pages![0].design_source = {
      type: 'figma',
      file_url: 'https://www.figma.com/design/abc123/Sections',
      breakpoints: {},
    }
    const violations = DesignSourceShape.check(normalize(spec))
    expect(violations).toHaveLength(1)
    expect(violations[0].data?.check).toBe('breakpoints-empty')
  })

  test('rule severity is warning', () => {
    expect(DesignSourceShape.severity).toBe('warning')
  })

  test('rule has fast + spec-only tags', () => {
    expect(DesignSourceShape.tags).toContain('fast')
    expect(DesignSourceShape.tags).toContain('spec-only')
  })
})
