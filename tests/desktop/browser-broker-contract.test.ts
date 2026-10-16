/**
 * Desktop side of the shared broker contract fixture (spec-05 acceptance 24).
 *
 * The Electron broker cannot be instantiated in Vitest (it needs Electron), so
 * this test guards the *source* of truth instead: every literal the fixture
 * pins must still exist in `browser-broker.ts` / `browser-types.ts`. If someone
 * renames a method, an error string or a projected field on the desktop side,
 * this test fails and the Web broker cannot silently drift away from it.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const brokerSource = readFileSync(
  join(root, 'packages', 'desktop', 'src', 'main', 'browser', 'browser-broker.ts'),
  'utf8',
)
const typesSource = readFileSync(
  join(root, 'packages', 'desktop', 'src', 'main', 'browser', 'browser-types.ts'),
  'utf8',
)
const managerSource = readFileSync(
  join(root, 'packages', 'desktop', 'src', 'main', 'browser', 'browser-manager.ts'),
  'utf8',
)

const fixture = JSON.parse(
  readFileSync(join(root, 'tests', 'fixtures', 'browser-broker-contract.json'), 'utf8'),
) as {
  methods: string[]
  nonMutatingMethods: string[]
  publicTabKeys: string[]
  screenshotMediaType: string
  maxTabs: number
  leaseTtlMs: number
  maxRequestBodyBytes: number
  errors: Record<string, string>
  statusCodes: Record<string, number>
  descriptor: { dirName: string, fileName: string, requiredKeys: string[] }
}

describe('desktop browser broker contract fixture', () => {
  it('still implements every method the fixture pins', () => {
    for (const method of fixture.methods) {
      expect(brokerSource, `missing desktop broker method: ${method}`)
        .toContain(`case '${method}':`)
    }
  })

  it('keeps the non-mutating method list (no lease needed for reads)', () => {
    const list = fixture.nonMutatingMethods.map(method => `'${method}'`).join(', ')
    expect(brokerSource).toContain(`[${list}]`)
  })

  it('projects exactly the public tab keys', () => {
    for (const key of fixture.publicTabKeys) {
      expect(brokerSource).toContain(`${key}:`)
    }
    // Fields the projection must never leak.
    for (const forbidden of ['faviconUrl', 'profileId', 'sessionPath', 'downloadPath']) {
      expect(brokerSource).not.toContain(`${forbidden}: tab.`)
    }
    expect(brokerSource).toContain('redactBrowserText(tab.title, 500)')
    expect(brokerSource).toContain('publicBrowserUrl(tab.url)')
  })

  it('keeps the error strings and status mapping', () => {
    for (const key of ['notFound', 'originRejected', 'unauthorized', 'bodyTooLarge', 'bodyNotObject', 'clientPid', 'leaseOwnership', 'takeoverCancelled']) {
      expect(brokerSource, `missing desktop error literal: ${key}`)
        .toContain(fixture.errors[key])
    }
    expect(brokerSource).toContain(fixture.errors.unknownMethodPrefix)
    expect(brokerSource).toContain(fixture.errors.leaseConflictPrefix)
    expect(brokerSource).toContain('/lease|control|cancel|takeover/i')
    expect(brokerSource).toContain('409')
    expect(brokerSource).toContain('404')
    expect(brokerSource).toContain('403')
    expect(brokerSource).toContain('401')
  })

  it('keeps the limits the fixture pins', () => {
    expect(brokerSource).toContain('1024 * 1024')
    expect(brokerSource).toContain(`LEASE_TTL_MS = ${fixture.leaseTtlMs / 1000}_000`)
    expect(managerSource).toContain(`MAX_TABS = ${fixture.maxTabs}`)
    expect(brokerSource).toContain('x-hermes-browser-client')
    expect(brokerSource).toContain('leaseTimers')
  })

  it('keeps the descriptor shape the MCP layer reads', () => {
    for (const key of fixture.descriptor.requiredKeys) {
      expect(brokerSource, `missing descriptor key: ${key}`).toContain(`${key}:`)
    }
    expect(brokerSource).toContain("'broker.json'")
    expect(brokerSource).toContain(`schema: ${fixture.descriptor.schema}`)
  })

  it('keeps the result shapes the MCP layer consumes', () => {
    // The MCP maps screenshot.mediaType onto its MIME type.
    expect(typesSource).toContain(`mediaType: 'image/png' | 'image/jpeg'`)
    expect(typesSource).toContain('snapshotId: string')
    expect(typesSource).toContain('totalLength: number')
    expect(typesSource).toContain('returnedLength: number')
    expect(typesSource).toContain('hasMore: boolean')
    expect(typesSource).toContain('nextOffset?: number')
    expect(fixture.screenshotMediaType).toBe('image/png')
  })
})
