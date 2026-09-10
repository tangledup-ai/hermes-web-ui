import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getWebUiHome } from '../../config'
import { recapModes, recapTones, type RecapOptions, type RecapEntry } from '../../../../shared/trpg-recap'
export type { RecapEntry } from '../../../../shared/trpg-recap'
const fail = () => { throw Object.assign(new Error('invalid_recap'), { status: 400 }) }
export function meetingDir(id: string) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) fail()
  return join(getWebUiHome(), 'meetings', id)
}
function text(v: unknown, max: number, required = true): string {
  if (typeof v !== 'string' || v.length > max || (required && !v.trim())) return fail()
  return v
}
export function parseRecapInput(v: any): RecapOptions {
  if (!v || !recapModes.includes(v.mode) || !recapTones.includes(v.tone || 'epic') ||
    (v.chapterHint != null && (!Number.isInteger(v.chapterHint) || v.chapterHint < 2 || v.chapterHint > 8)) ||
    !Array.isArray(v.characters) || v.characters.length > 20) return fail()
  const ids = new Set<string>()
  const characters = v.characters.map((c: any) => {
    const id = text(c?.id, 80), name = text(c?.name, 80).replace(/[【】\r\n]/g, '').trim()
    if (!name || ids.has(id)) return fail()
    ids.add(id)
    return { id, name, player: text(c.player || '', 100, false) }
  })
  return { mode: v.mode, tone: v.tone || 'epic', chapterHint: v.chapterHint ?? undefined, characters, setting: text(v.setting || '', 3000, false), style: text(v.style || '', 500, false) }
}
interface Snapshot { id: string; meetingId: string; profile: string; options: RecapOptions; sentences: { text: string; speaker?: string; timestamp?: string | number }[] }
async function atomicJson(path: string, value: unknown) {
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
  await rename(tmp, path)
}
export async function prepareRecap(v: any, profile: string) {
  const dir = meetingDir(v?.meetingId), options = parseRecapInput(v)
  if (!Array.isArray(v.sentences) || !v.sentences.length || v.sentences.length > 20000) return fail()
  const sentences = v.sentences.map((s: any) => ({ text: text(s?.text, 12000), speaker: text(s.speaker || '', 100, false), timestamp: typeof s.timestamp === 'number' ? s.timestamp : text(s.timestamp || '', 100, false) }))
  if (JSON.stringify(sentences).length > 2000000) return fail()
  const id = randomUUID()
  await mkdir(join(dir, 'recap-requests'), { recursive: true })
  await atomicJson(join(dir, 'recap-requests', `${id}.json`), { id, meetingId: v.meetingId, profile, options, sentences } satisfies Snapshot)
  return { requestId: id }
}
async function snapshot(meetingId: string, id: string, profile: string): Promise<Snapshot> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return fail()
  const data = JSON.parse(await readFile(join(meetingDir(meetingId), 'recap-requests', `${id}.json`), 'utf8')) as Snapshot
  if (data.profile !== profile) throw Object.assign(new Error('profile_forbidden'), { status: 403 })
  return data
}
export async function recapTranscript(meetingId: string, id: string, profile: string, cursor = 0) {
  const data = await snapshot(meetingId, id, profile)
  if (!Number.isInteger(cursor) || cursor < 0 || cursor >= data.sentences.length) return fail()
  let end = cursor, count = 0
  while (end < data.sentences.length && count + data.sentences[end].text.length <= 60000) count += data.sentences[end++].text.length
  return { meetingId, requestId: id, options: data.options, sentences: data.sentences.slice(cursor, end), nextCursor: end < data.sentences.length ? end : null, total: data.sentences.length }
}
export function validateRecap(v: any, source: Snapshot): RecapEntry {
  if (!v || !Array.isArray(v.chapters) || !v.chapters.length || v.chapters.length > 8 || !Array.isArray(v.timeline) || v.timeline.length > 300) return fail()
  const transcript = source.sentences.map(s => s.text).join('\n')
  const quote = (v: unknown) => { const q = text(v, 2000); if (!transcript.includes(q)) return fail(); return q }
  const chapters = v.chapters.map((c: any) => {
    if (!Array.isArray(c?.highlights) || c.highlights.length > 30) return fail()
    const startQuote = quote(c.startQuote), endQuote = quote(c.endQuote)
    const start = transcript.indexOf(startQuote)
    if (transcript.indexOf(endQuote, start) < 0) return fail()
    return { id: randomUUID(), title: text(c.title, 200), startQuote, endQuote, body: text(c.body, 1800), highlights: c.highlights.map((h: any) => {
      const character = source.options.characters.find(c => c.id === h?.characterId)
      if (!character) return fail()
      return { characterId: character.id, name: `【${character.name}】`, action: text(h.action, 500), evidence: quote(h.evidence) }
    }) }
  })
  return { ...source.options, id: source.id, meetingId: source.meetingId, title: text(v.title, 200), chapters,
    timeline: v.timeline.map((t: any) => ({ time: text(t?.time, 100, false), text: text(t?.text, 1000) })), generatedAt: Date.now(), skillUsed: 'trpg-recap' }
}
type StoredEntry = RecapEntry & { profile: string }
async function readEntries(meetingId: string): Promise<StoredEntry[]> {
  try { return JSON.parse(await readFile(join(meetingDir(meetingId), 'recaps.json'), 'utf8')) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
}
export async function listRecaps(meetingId: string, profile: string) {
  return (await readEntries(meetingId)).filter(r => r.profile === profile).map(({ profile: _, ...r }) => r)
}
const queues = new Map<string, Promise<unknown>>()
async function update(meetingId: string, fn: (entries: StoredEntry[]) => StoredEntry[]) {
  const key = meetingDir(meetingId), previous = queues.get(key) || Promise.resolve()
  const next = previous.catch(() => {}).then(async () => { const entries = fn(await readEntries(meetingId)); await mkdir(key, { recursive: true }); await atomicJson(join(key, 'recaps.json'), entries) })
  queues.set(key, next)
  try { await next } finally { if (queues.get(key) === next) queues.delete(key) }
}
export async function saveRecap(meetingId: string, body: any, profile: string) {
  const source = await snapshot(meetingId, body?.requestId, profile)
  const entry = validateRecap(body, source)
  await update(meetingId, entries => [{ ...entry, profile }, ...entries.filter(r => r.id !== entry.id)])
  return entry
}
export async function deleteRecap(meetingId: string, id: string, profile: string) {
  await update(meetingId, entries => entries.filter(r => r.id !== id || r.profile !== profile))
}
