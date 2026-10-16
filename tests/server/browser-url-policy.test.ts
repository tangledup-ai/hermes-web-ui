import { describe, expect, it } from 'vitest'
import {
  BLANK_PAGE_URL,
  BrowserUrlRejectedError,
  isBlockedHost,
  normalizeBrowserUrl,
  publicBrowserUrl,
  tryNormalizeBrowserUrl,
} from '../../packages/server/src/services/browser/url-policy'

describe('browser url normalization', () => {
  it('accepts http, https and the internal blank page', () => {
    expect(normalizeBrowserUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(normalizeBrowserUrl('http://example.com/')).toBe('http://example.com/')
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com/')
    expect(normalizeBrowserUrl(BLANK_PAGE_URL)).toBe(BLANK_PAGE_URL)
  })

  it.each([
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'javascript:alert(1)',
    'blob:https://example.com/uuid',
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    'ftp://example.com/file',
  ])('rejects the scheme in %s', (input) => {
    expect(() => normalizeBrowserUrl(input)).toThrow(BrowserUrlRejectedError)
    expect(tryNormalizeBrowserUrl(input)).toBeNull()
    try {
      normalizeBrowserUrl(input)
    } catch (err) {
      expect((err as BrowserUrlRejectedError).reason).toBe('scheme-not-allowed')
    }
  })

  it('rejects empty input and embedded credentials', () => {
    expect(() => normalizeBrowserUrl('   ')).toThrow(/empty/)
    expect(() => normalizeBrowserUrl('https://user:pass@example.com')).toThrow(/credentials-in-url/)
  })

  it.each([
    'http://localhost:6060/',
    'http://127.0.0.1/',
    'http://127.1.2.3/',
    'http://10.1.2.3/',
    'http://172.16.5.5/',
    'http://192.168.1.10/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.200/latest/meta-data/',
    'http://2130706433/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://thing.internal/',
    'http://service.localhost/',
    'http://0.0.0.0/',
  ])('blocks the private/metadata target %s', (input) => {
    expect(isBlockedHost(new URL(input).hostname)).toBe(true)
    expect(() => normalizeBrowserUrl(input)).toThrow(/blocked-host/)
  })

  it('allows ordinary public hosts', () => {
    for (const host of ['example.com', 'www.example.org', '203.0.113.10', '8.8.8.8', '[2606:4700::1111]']) {
      expect(isBlockedHost(host)).toBe(false)
    }
    expect(tryNormalizeBrowserUrl('https://example.com/ok')).toBe('https://example.com/ok')
  })
})

describe('public url projection', () => {
  it('masks sensitive query values and hashes', () => {
    const projected = publicBrowserUrl('https://example.com/cb?token=abc123&page=2#access_token=xyz')

    expect(projected).toContain('token=%5Bredacted%5D')
    expect(projected).toContain('page=2')
    expect(projected).not.toContain('abc123')
    expect(projected).not.toContain('xyz')
    expect(projected).toContain('#[redacted]')
  })

  it('keeps non-URL text bounded', () => {
    expect(publicBrowserUrl('not a url')).toBe('not a url')
    expect(publicBrowserUrl('')).toBe('')
    expect(publicBrowserUrl(BLANK_PAGE_URL)).toBe(BLANK_PAGE_URL)
  })
})
