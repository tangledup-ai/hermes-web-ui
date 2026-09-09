import { cleanSheet, type CharacterSheet } from '../../../../shared/trpg'
export interface CharacterCard {
  id: string; name: string; player: string; appearance: string; card: string
  sheet?: CharacterSheet
  image?: Blob; imageName?: string
}
export interface Highlight {
  id: string; prompt: string; createdAt: number; transcript: string
  image?: Blob; imageModel?: string; referenceNames?: string[]
  actions: { characterId: string; name: string; action: string; evidence: string }[]
}
export interface ImageSettings { enabled: boolean; provider: string; model: string; size: string; quality: string; useReferences: boolean }
export const defaultImageSettings = (): ImageSettings => ({ enabled: false, provider: '', model: '', size: '1536x1024', quality: 'auto', useReferences: true })
export interface Campaign { imageSettings?: ImageSettings; cameraId?: string; draftModel?: string; characters: CharacterCard[]; setting: string; style: string; highlights: Highlight[] }
export const emptyCampaign = (): Campaign => ({ characters: [], setting: '', style: '', highlights: [] })

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('hermes-plugin-trpg', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('campaigns')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
export async function campaignStorage(key: string, value?: Campaign): Promise<Campaign> {
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('campaigns', value ? 'readwrite' : 'readonly')
      const store = tx.objectStore('campaigns')
      const request = value ? store.put(value, key) : store.get(key)
      tx.oncomplete = () => resolve(value ?? request.result ?? emptyCampaign())
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}

export function recentTranscript(sentences: { text: string; speaker?: string }[]): string {
  return sentences.slice(-60).map(s => `${s.speaker ? `[${s.speaker}] ` : ''}${s.text}`).join('\n').slice(-12000)
}

/** Build a plain IndexedDB record even after reactive arrays were filtered/replaced. */
export function snapshotCampaign(value: Campaign): Campaign {
  return {
    setting: value.setting, style: value.style, imageSettings: { ...defaultImageSettings(), ...value.imageSettings }, cameraId: value.cameraId || '', draftModel: value.draftModel || '',
    characters: value.characters.map(c => ({ id: c.id, name: c.name, player: c.player, appearance: c.appearance, card: c.card, image: c.image, imageName: c.imageName, sheet: cleanSheet(c.sheet) })),
    highlights: value.highlights.map(h => ({ id: h.id, prompt: h.prompt, createdAt: h.createdAt, transcript: h.transcript, image: h.image, imageModel: h.imageModel, referenceNames: h.referenceNames ? [...h.referenceNames] : [],
      actions: h.actions.map(a => ({ characterId: a.characterId, name: a.name, action: a.action, evidence: a.evidence })) })),
  }
}
