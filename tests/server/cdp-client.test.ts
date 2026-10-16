import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import {
  CdpClient,
  CdpClosedError,
  CdpProtocolError,
  CdpTimeoutError,
} from '../../packages/server/src/services/browser/cdp-client'
import { logger } from '../../packages/server/src/services/logger'

class FakePipe {
  readonly inbound = new PassThrough()
  readonly outbound = new PassThrough()
  private buffers: Buffer[] = []

  constructor() {
    this.outbound.on('data', (chunk: Buffer) => this.buffers.push(chunk))
  }

  get streams() {
    return { read: this.inbound, write: this.outbound }
  }

  /** Messages the client wrote, decoded. */
  written(): any[] {
    return Buffer.concat(this.buffers)
      .toString('utf8')
      .split('\0')
      .filter(part => part.trim().length > 0)
      .map(part => JSON.parse(part))
  }

  rawWritten(): string {
    return Buffer.concat(this.buffers).toString('utf8')
  }

  pushMessage(message: unknown): void {
    this.inbound.write(`${JSON.stringify(message)}\0`)
  }

  pushRaw(chunk: Buffer | string): void {
    this.inbound.write(chunk)
  }

  clear(): void {
    this.buffers = []
  }
}

function createClient(pipe: FakePipe, commandTimeoutMs = 1_000) {
  return new CdpClient({ streams: pipe.streams, commandTimeoutMs })
}

describe('CDP framing', () => {
  it('writes null-delimited JSON, one frame per command', async () => {
    const pipe = new FakePipe()
    const client = createClient(pipe)

    const promise = client.send('Target.getTargets', { filter: [] }, 'session-1')
    pipe.pushMessage({ id: 1, result: { targetInfos: [] } })
    await expect(promise).resolves.toEqual({ targetInfos: [] })

    expect(pipe.written()).toEqual([
      { id: 1, method: 'Target.getTargets', params: { filter: [] }, sessionId: 'session-1' },
    ])
    expect(pipe.rawWritten().endsWith('\0')).toBe(true)
  })

  it('reassembles a message split across chunks, including inside a multi-byte character', async () => {
    const pipe = new FakePipe()
    const client = createClient(pipe)

    const promise = client.send('Page.getNavigationHistory')
    // "标题" is 6 bytes in UTF-8; cut the frame in the middle of it.
    const frame = Buffer.from(`${JSON.stringify({ id: 1, result: { title: '标题' } })}\0`, 'utf8')
    const cut = frame.indexOf(Buffer.from('标', 'utf8')) + 1
    expect(cut).toBeGreaterThan(1)
    pipe.pushRaw(frame.subarray(0, cut))
    pipe.pushRaw(frame.subarray(cut))

    await expect(promise).resolves.toEqual({ title: '标题' })
  })

  it('dispatches several messages arriving in a single chunk', async () => {
    const pipe = new FakePipe()
    const client = createClient(pipe)
    const events: string[] = []
    client.on('Page.loadEventFired', (_params, meta) => events.push(meta.method))

    const promise = client.send('Ping')
    pipe.pushRaw(
      `${JSON.stringify({ id: 1, result: { ok: true } })}\0`
      + `${JSON.stringify({ method: 'Page.loadEventFired', params: {} })}\0`,
    )

    await expect(promise).resolves.toEqual({ ok: true })
    expect(events).toEqual(['Page.loadEventFired'])
  })

  it('drops a malformed frame and keeps serving', async () => {
    const pipe = new FakePipe()
    const client = createClient(pipe)

    pipe.pushRaw('{not json}\0')
    const promise = client.send('Ping')
    pipe.pushMessage({ id: 1, result: { pong: true } })

    await expect(promise).resolves.toEqual({ pong: true })
  })
})

describe('CDP request/response', () => {
  it('rejects with the CDP error code and message instead of swallowing it', async () => {
    const pipe = new FakePipe()
    const client = createClient(pipe)

    const promise = client.send('Target.createTarget', { url: 'about:blank' })
    pipe.pushMessage({ id: 1, error: { code: -32602, message: 'Invalid parameters' } })

    await expect(promise).rejects.toBeInstanceOf(CdpProtocolError)
    await promise.catch((err: CdpProtocolError) => {
      expect(err.code).toBe(-32602)
      expect(err.message).toContain('Invalid parameters')
      expect(err.method).toBe('Target.createTarget')
    })
  })

  it('times out a command and leaves no pending entry behind', async () => {
    vi.useFakeTimers()
    try {
      const pipe = new FakePipe()
      const client = createClient(pipe, 50)

      const promise = client.send('Page.captureScreenshot')
      const assertion = expect(promise).rejects.toBeInstanceOf(CdpTimeoutError)
      vi.advanceTimersByTime(60)
      await assertion

      expect(client.pendingCount).toBe(0)
      // A late response for the timed-out id must be ignored silently.
      pipe.pushMessage({ id: 1, result: { data: 'late' } })
      await vi.advanceTimersByTimeAsync(1)
      expect(client.pendingCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects every pending command when the pipe closes', async () => {
    const pipe = new FakePipe()
    const client = createClient(pipe)

    const first = client.send('Page.navigate')
    const second = client.send('Page.reload')
    pipe.inbound.destroy()

    await expect(first).rejects.toBeInstanceOf(CdpClosedError)
    await expect(second).rejects.toBeInstanceOf(CdpClosedError)
    expect(client.pendingCount).toBe(0)
    expect(client.isClosed).toBe(true)
    await expect(client.send('Page.reload')).rejects.toBeInstanceOf(CdpClosedError)
  })
})

describe('CDP events and disposal', () => {
  it('routes events by sessionId and supports unsubscribe', () => {
    const pipe = new FakePipe()
    const client = createClient(pipe)
    const seen: Array<{ value: string, sessionId?: string }> = []

    const off = client.on<{ value: string }>('Runtime.consoleAPICalled', (params, meta) => {
      seen.push({ value: params.value, sessionId: meta.sessionId })
    })

    pipe.pushMessage({ method: 'Runtime.consoleAPICalled', params: { value: 'a' }, sessionId: 's1' })
    pipe.pushMessage({ method: 'Runtime.consoleAPICalled', params: { value: 'b' }, sessionId: 's2' })

    expect(seen).toEqual([
      { value: 'a', sessionId: 's1' },
      { value: 'b', sessionId: 's2' },
    ])

    off()
    pipe.pushMessage({ method: 'Runtime.consoleAPICalled', params: { value: 'c' }, sessionId: 's1' })
    expect(seen).toHaveLength(2)
  })

  it('dispose drops listeners, pending commands and stream handlers', async () => {
    const pipe = new FakePipe()
    const client = createClient(pipe)
    const handler = vi.fn()
    client.on('Page.loadEventFired', handler)

    const pending = client.send('Page.navigate')
    client.dispose()

    await expect(pending).rejects.toBeInstanceOf(CdpClosedError)
    expect(client.pendingCount).toBe(0)
    expect(client.isClosed).toBe(true)

    pipe.pushMessage({ method: 'Page.loadEventFired', params: {} })
    expect(handler).not.toHaveBeenCalled()

    // No leftover listeners on the pipe streams.
    expect(pipe.inbound.listenerCount('data')).toBe(0)
    expect(pipe.inbound.listenerCount('close')).toBe(0)
    expect(pipe.outbound.listenerCount('error')).toBe(0)
  })

  it('never logs the CDP payload', async () => {
    const pipe = new FakePipe()
    const client = createClient(pipe)
    const debug = vi.fn()
    const spy = vi.spyOn(logger, 'debug').mockImplementation(debug)

    try {
      const promise = client.send('Runtime.callFunctionOn', { functionDeclaration: 'secret()' })
      pipe.pushMessage({ id: 1, result: { secret: 'value' } })
      await promise

      const logged = debug.mock.calls.flat().join(' ')
      expect(logged).toContain('Runtime.callFunctionOn')
      expect(logged).not.toContain('secret()')
      expect(logged).not.toContain('value')
    } finally {
      spy.mockRestore()
    }
  })
})
