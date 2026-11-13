import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const MIN_ASSET_BYTES = 8 * 1024

export function precompressClientAssets(clientDir) {
  const assetsDir = join(clientDir, 'assets')
  const stats = { files: 0, bytes: 0 }
  if (!existsSync(assetsDir)) return stats

  for (const entry of readdirSync(assetsDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:js|css)$/.test(entry.name)) continue
    const filename = join(entry.parentPath, entry.name)
    if (statSync(filename).size < MIN_ASSET_BYTES) continue

    // Keep only gzip variants: LAN browsers can use them over plain HTTP, and
    // shipping both encodings would almost double the extra archive bytes.
    const original = readFileSync(filename)
    const encoded = gzipSync(original)
    if (encoded.byteLength >= original.byteLength) continue

    writeFileSync(`${filename}.gz`, encoded)
    stats.files++
    stats.bytes += encoded.byteLength
  }

  return stats
}
