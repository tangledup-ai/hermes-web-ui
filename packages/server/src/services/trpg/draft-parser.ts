import { cleanSheet, SHEET_KEYS } from '../../../../shared/trpg'

/** Providers may return typed text blocks instead of a single string. */
export function responseText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(v => typeof v?.text === 'string' ? v.text : typeof v?.text?.value === 'string' ? v.text.value : '').join('\n')
  return ''
}

export function jsonObjects(raw: string): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  const add = (text: string) => { try { const v = JSON.parse(text); if (v && typeof v === 'object' && !Array.isArray(v)) result.push(v) } catch {} }
  add(raw.trim())
  // Start string tracking only inside a JSON object; quotes in surrounding prose are unrelated.
  let depth = 0, start = -1, quoted = false, escaped = false
  for (let i = 0; i < Math.min(raw.length, 100000); i++) {
    const c = raw[i]
    if (!depth) { if (c === '{') { start = i; depth = 1; quoted = false; escaped = false }; continue }
    if (escaped) { escaped = false; continue }
    if (quoted && c === '\\') { escaped = true; continue }
    if (c === '"') { quoted = !quoted; continue }
    if (quoted) continue
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) add(raw.slice(start, i + 1))
  }
  return result
}
const aliases: Record<string, string> = {
  charactername: 'name', '角色名称': 'name', '角色名': 'name', '姓名': 'name', playername: 'player', '玩家姓名': 'player', '玩家': 'player',
  '外观': 'appearance', '外貌': 'appearance', '形象描述': 'appearance', description: 'appearance', '角色卡': 'card',
  str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma',
  '力量': 'strength', '敏捷': 'dexterity', '体质': 'constitution', '智力': 'intelligence', '感知': 'wisdom', '魅力': 'charisma',
  '职业与等级': 'classLevel', classlevel: 'classLevel', '种族': 'race', '阵营': 'alignment', '背景': 'background',
  ac: 'armorClass', '护甲等级': 'armorClass', hpmax: 'hpMax', hpcurrent: 'hpCurrent', '最大生命值': 'hpMax', '当前生命值': 'hpCurrent',
  '特性与专长': 'features', '装备': 'equipment', '背景故事': 'backstory', '法术': 'cantrips',
}
const canonical = new Map([...SHEET_KEYS, 'name', 'player', 'appearance', 'card'].map(k => [k.toLowerCase(), k]))
function normalize(value: Record<string, unknown>) {
  const fields: Record<string, string> = {}
  const visit = (obj: Record<string, unknown>, depth: number) => {
    if (depth > 4) return
    for (const [key, value] of Object.entries(obj)) {
      const normalized = key.replace(/[\s_-]/g, '').toLowerCase()
      const field = aliases[normalized] || canonical.get(normalized)
      const scalar = typeof value === 'string' || typeof value === 'number'
      if (field && scalar) fields[field] = String(value)
      else if (field && value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>
        const v = record.score ?? record.value ?? record['数值']
        if (typeof v === 'number' || typeof v === 'string') fields[field] = String(v)
        else if (normalized === '角色卡') visit(record, depth + 1)
      } else if (value && typeof value === 'object' && !Array.isArray(value) && /^(draft|character|characterdata|charactersheet|sheet|data|result|abilities|abilityscores|attributes|stats|skills|identity|combat|角色|角色卡|属性|六项属性|基础信息)$/.test(normalized)) visit(value as Record<string, unknown>, depth + 1)
    }
  }
  visit(value, 0)
  return { name: (fields.name || '').slice(0, 80), player: (fields.player || '').slice(0, 100), appearance: (fields.appearance || '').slice(0, 2000), card: (fields.card || '').slice(0, 6000), sheet: cleanSheet(fields) }
}
export function parseDraftJson(raw: string) {
  // Prefer the last substantive draft, not trailing tool metadata or an empty object.
  const drafts = jsonObjects(raw).map(normalize).filter(d => [d.name, d.player, d.appearance, d.card, ...Object.values(d.sheet)].some(v => v.trim()))
  return drafts.at(-1) || null
}
