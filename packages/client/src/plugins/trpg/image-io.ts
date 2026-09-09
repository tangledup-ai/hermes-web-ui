/** Downscale reference inputs before JSON transport; originals remain local Blobs. */
export async function imageDataUri(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob)
  try {
    const ratio = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('imageInvalid')
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.88)
  } finally { bitmap.close() }
}
/**
 * Encode any file (e.g. PDF character sheet) as a data URI without canvas conversion.
 * The downstream LLM is expected to consume the raw bytes for non-image MIME types
 * (vision-capable models read PDFs via the same `image_url` channel as images).
 */
export async function fileDataUri(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return `data:${blob.type};base64,${btoa(binary)}`
}
export function generatedImageBlob(base64: string): Blob {
  if (typeof base64 !== 'string' || base64.length > 40 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(base64)) throw new Error('imageFailed')
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  const webp = String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  if (!png && !jpeg && !webp) throw new Error('imageFailed')
  return new Blob([bytes], { type: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp' })
}
