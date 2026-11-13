import Koa from 'koa'
import serve from 'koa-static'
import { createServer, request, type IncomingHttpHeaders } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { once } from 'node:events'
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { createStaticCompressionMiddleware } from '../../packages/server/src/modules/studio/middleware/static-compression'
import { getStaticCacheControl } from '../../packages/server/src/modules/studio/middleware/static-cache'
import { precompressClientAssets } from '../../scripts/precompress-client-assets.mjs'

it('builds gzip variants only for sizable static scripts and styles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-compression-build-'))
  try {
    const assets = join(root, 'assets', 'nested')
    await mkdir(assets, { recursive: true })
    const large = 'body { display: block; }\n'.repeat(1024)
    await Promise.all([
      writeFile(join(assets, 'theme.css'), large),
      writeFile(join(assets, 'small.js'), 'export default 1'),
      writeFile(join(assets, 'model.onnx'), large),
      writeFile(join(root, 'index.html'), large),
    ])
    const stats = precompressClientAssets(root)
    const gzip = await readFile(join(assets, 'theme.css.gz'))
    expect(stats).toEqual({ files: 1, bytes: gzip.length })
    expect(gunzipSync(gzip).toString()).toBe(large)
    for (const name of [join(assets, 'small.js'), join(assets, 'model.onnx'), join(root, 'index.html')]) {
      await expect(readFile(`${name}.gz`)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('serves cached bytes, preserves explicit Brotli preference and falls back safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-compression-http-'))
  const app = new Koa()
  app.use(createStaticCompressionMiddleware({ precompressedRoot: root }))
  app.use(serve(root, {
    gzip: false,
    brotli: false,
    setHeaders(res, path) {
      const cacheControl = getStaticCacheControl(relative(root, path))
      if (cacheControl) res.setHeader('Cache-Control', cacheControl)
    },
  }))
  const server = createServer(app.callback())
  const source = Buffer.from('export function render() { return "test"; }\n'.repeat(1024))
  // A different gzip level proves the response came from disk, not the fallback.
  const variant = gzipSync(source, { level: 1 })
  try {
    await mkdir(join(root, 'assets'))
    await Promise.all([
      writeFile(join(root, 'assets', 'entry.js'), source),
      writeFile(join(root, 'assets', 'entry.js.gz'), variant),
      writeFile(join(root, 'assets', 'legacy.js'), source),
    ])
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP server')
    function get(path: string, accepted: string, method = 'GET', range?: string) {
      return new Promise<{ headers: IncomingHttpHeaders, body: Buffer }>((resolve, reject) => {
        const req = request({
          host: '127.0.0.1', port: address.port, path, method,
          headers: { 'Accept-Encoding': accepted, ...(range ? { Range: range } : {}) },
        }, res => {
          const chunks: Buffer[] = []
          res.on('data', chunk => chunks.push(chunk))
          res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
          res.on('error', reject)
        })
        req.on('error', reject)
        req.end()
      })
    }

    const cached = await get('/assets/entry.js', 'gzip, br')
    expect(cached.body.equals(variant)).toBe(true)
    expect(cached.headers).toMatchObject({
      'content-encoding': 'gzip',
      'content-length': String(variant.length),
      'cache-control': 'public, max-age=31536000, immutable',
      vary: 'Accept-Encoding',
    })
    expect(cached.headers['content-type']).toMatch(/javascript/)

    const head = await get('/assets/entry.js', 'gzip', 'HEAD')
    expect(head.headers['content-encoding']).toBe('gzip')
    expect(head.headers['content-length']).toBe(String(variant.length))
    expect(head.body.length).toBe(0)

    const preferred = await get('/assets/entry.js', 'br;q=1, gzip;q=0.5')
    expect(preferred.headers['content-encoding']).toBe('br')
    expect(brotliDecompressSync(preferred.body).equals(source)).toBe(true)

    for (const raw of [
      await get('/assets/entry.js', 'identity, gzip;q=0'),
      await get('/assets/entry.js', 'gzip', 'GET', 'bytes=0-10'),
    ]) {
      expect(raw.headers['content-encoding']).toBeUndefined()
      expect(raw.headers.vary).toBe('Accept-Encoding')
      expect(raw.body.equals(source)).toBe(true)
    }

    const legacy = await get('/assets/legacy.js', 'gzip')
    expect(legacy.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(legacy.body).equals(source)).toBe(true)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
