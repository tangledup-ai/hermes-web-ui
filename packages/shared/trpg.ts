/** D&D 5E character-sheet field groups, mirroring the supplied three-page form. */
export const SHEET_GROUPS = {
  identity: ['classLevel', 'background', 'race', 'alignment', 'xp'],
  abilities: ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'],
  combat: ['inspiration', 'proficiencyBonus', 'armorClass', 'initiative', 'speed', 'hpMax', 'hpCurrent', 'hpTemp', 'hitDice', 'deathSuccesses', 'deathFailures', 'passivePerception', 'savingThrows', 'attacks'],
  skills: ['acrobatics', 'animalHandling', 'arcana', 'athletics', 'deception', 'history', 'insight', 'intimidation', 'investigation', 'medicine', 'nature', 'perception', 'performance', 'persuasion', 'religion', 'sleightOfHand', 'stealth', 'survival'],
  story: ['age', 'height', 'weight', 'eyes', 'skin', 'hair', 'personality', 'ideals', 'bonds', 'flaws', 'backstory', 'allies'],
  equipment: ['proficienciesLanguages', 'equipment', 'coins', 'features', 'treasure'],
  spells: ['spellcastingClass', 'spellcastingAbility', 'spellSaveDC', 'spellAttackBonus', 'cantrips', 'spells1', 'spells2', 'spells3', 'spells4', 'spells5', 'spells6', 'spells7', 'spells8', 'spells9'],
} as const
export const SHEET_KEYS = Object.values(SHEET_GROUPS).flat()
export type SheetKey = typeof SHEET_KEYS[number]
export type CharacterSheet = Partial<Record<SheetKey, string>>
export const LONG_FIELDS = new Set<string>(['savingThrows', 'attacks', 'personality', 'ideals', 'bonds', 'flaws', 'backstory', 'allies', 'proficienciesLanguages', 'equipment', 'coins', 'features', 'treasure', 'cantrips', ...Array.from({ length: 9 }, (_, i) => `spells${i + 1}`)])

/**
 * 模型经常返回六项属性的中文 / 缩写键名（力量 / 敏捷 / STR / DEX / 六项属性）。
 * 把这些别名吸收到结构化字段，避免「重复」的现象。
 */
const ABILITY_TARGETS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'] as const
const SHEET_SYNONYMS: Record<string, string> = {
  // 中文能力名 → 结构化
  '力量': 'strength', '敏捷': 'dexterity', '体质': 'constitution',
  '智力': 'intelligence', '感知': 'wisdom', '魅力': 'charisma',
  // 英文缩写
  'STR': 'strength', 'DEX': 'dexterity', 'CON': 'constitution',
  'INT': 'intelligence', 'WIS': 'wisdom', 'CHA': 'charisma',
  // 常用别称
  'AC': 'armorClass', 'HP': 'hpMax', 'HP_max': 'hpMax', 'hitPoints': 'hpMax',
  '六项属性': '__ability_summary__', '六维属性': '__ability_summary__',
  'abilities': '__ability_summary__', 'abilityScores': '__ability_summary__',
  'attributes': '__ability_summary__',
}

/**
 * 把 "STR 14 / DEX 16 ..." / "力量 14 敏捷 16 ..." 风格的字符串切回结构化字段。
 * 如果传入字符串里每个 token 对应一个能力 + 数字，就把数字写到对应字段。
 */
function parseAbilitySummary(value: string): Partial<CharacterSheet> {
  const out: Record<string, string> = {}
  // 按空白、斜杠、逗号、中文顿号切；保留冒号分隔符不切。
  const tokens = value.split(/[\s,/，、]+/).map(t => t.trim()).filter(Boolean)
  for (let i = 0; i < tokens.length - 1; i++) {
    const keyRaw = tokens[i]
    const valRaw = tokens[i + 1]
    const stripped = keyRaw.replace(/:$/, '')
    const target = SHEET_SYNONYMS[stripped] || SHEET_SYNONYMS[stripped.toUpperCase()]
    if (!target || !ABILITY_TARGETS.includes(target as typeof ABILITY_TARGETS[number])) continue
    if (/^-?\d+(?:\.\d+)?$/.test(valRaw)) {
      out[target] = valRaw.slice(0, 120)
    }
  }
  return out as Partial<CharacterSheet>
}

export function cleanSheet(value: unknown): CharacterSheet {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: CharacterSheet = {}
  const raw = value as Record<string, unknown>

  // 1. 直接命中结构化字段。
  for (const key of SHEET_KEYS) {
    const v = raw[key]
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) result[key] = String(v).slice(0, LONG_FIELDS.has(key) ? 2000 : 120)
  }

  // 2. 单字段别名吸收（力量 → strength 等），只在结构化字段尚未填值时覆盖。
  for (const [synKey, targetKey] of Object.entries(SHEET_SYNONYMS)) {
    if (targetKey === '__ability_summary__') continue
    if (raw[synKey] === undefined || result[targetKey as SheetKey]) continue
    const v = raw[synKey]
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) {
      result[targetKey as SheetKey] = String(v).slice(0, LONG_FIELDS.has(targetKey) ? 2000 : 120)
    }
  }

  // 3. 「六项属性」类总字段：尝试把字符串解析回六个能力。
  for (const summaryKey of ['六项属性', '六维属性', 'abilities', 'abilityScores', 'attributes']) {
    const v = raw[summaryKey]
    if (typeof v === 'string') {
      const parsed = parseAbilitySummary(v)
      for (const [k, val] of Object.entries(parsed)) {
        if (!result[k as SheetKey]) result[k as SheetKey] = val
      }
    }
  }

  return result
}
