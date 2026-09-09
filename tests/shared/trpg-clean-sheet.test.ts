import { describe, expect, it } from 'vitest'
import { cleanSheet, SHEET_KEYS } from '../../packages/shared/trpg'

describe('cleanSheet', () => {
  it('returns only SHEET_KEYS fields from a plain object', () => {
    const out = cleanSheet({ strength: '14', 六项属性: 'STR 14/DEX 16', 非字段键: 'x' })
    expect(out.strength).toBe('14')
    // 六项属性 与 非字段键 都不在 SHEET_KEYS 里，cleanSheet 第一遍不会写入
    expect((out as Record<string, unknown>).六项属性).toBeUndefined()
    expect((out as Record<string, unknown>).非字段键).toBeUndefined()
  })

  it('absorbs single-field Chinese synonyms (力量 → strength)', () => {
    const out = cleanSheet({ 力量: '14', 敏捷: '16', 体质: '12', 智力: '8', 感知: '13', 魅力: '10' })
    expect(out.strength).toBe('14')
    expect(out.dexterity).toBe('16')
    expect(out.constitution).toBe('12')
    expect(out.intelligence).toBe('8')
    expect(out.wisdom).toBe('13')
    expect(out.charisma).toBe('10')
  })

  it('absorbs single-field English abbreviations (STR / DEX / ... → strength / dexterity / ...)', () => {
    const out = cleanSheet({ STR: '14', DEX: '16', CON: '12', INT: '8', WIS: '13', CHA: '10', AC: '18', HP: '32' })
    expect(out.strength).toBe('14')
    expect(out.dexterity).toBe('16')
    expect(out.constitution).toBe('12')
    expect(out.intelligence).toBe('8')
    expect(out.wisdom).toBe('13')
    expect(out.charisma).toBe('10')
    expect(out.armorClass).toBe('18')
    expect(out.hpMax).toBe('32')
  })

  it('parses "六项属性" summary string into individual ability fields', () => {
    const out = cleanSheet({ 六项属性: '力量 14 敏捷 16 体质 12 智力 8 感知 13 魅力 10' })
    expect(out.strength).toBe('14')
    expect(out.dexterity).toBe('16')
    expect(out.constitution).toBe('12')
    expect(out.intelligence).toBe('8')
    expect(out.wisdom).toBe('13')
    expect(out.charisma).toBe('10')
  })

  it('parses English summary "STR 14 / DEX 16 / ..." into individual ability fields', () => {
    const out = cleanSheet({ abilities: 'STR 14 / DEX 16 / CON 12 / INT 8 / WIS 13 / CHA 10' })
    expect(out.strength).toBe('14')
    expect(out.dexterity).toBe('16')
    expect(out.constitution).toBe('12')
    expect(out.intelligence).toBe('8')
    expect(out.wisdom).toBe('13')
    expect(out.charisma).toBe('10')
  })

  it('structured field wins over summary string when both present', () => {
    const out = cleanSheet({ strength: '14', 六项属性: 'STR 18 / DEX 18 / ...' })
    expect(out.strength).toBe('14')
  })

  it('truncates long fields to 2000 chars and short fields to 120 chars', () => {
    const out = cleanSheet({ strength: '1'.repeat(500), backstory: 'x'.repeat(3000) })
    expect(out.strength?.length).toBe(120)
    expect(out.backstory?.length).toBe(2000)
  })

  it('returns an empty object for null / non-object / array input', () => {
    expect(cleanSheet(null)).toEqual({})
    expect(cleanSheet(undefined)).toEqual({})
    expect(cleanSheet('string')).toEqual({})
    expect(cleanSheet(['a', 'b'])).toEqual({})
    expect(cleanSheet(42)).toEqual({})
  })

  it('coerces numbers to strings', () => {
    const out = cleanSheet({ strength: 14, dexterity: 16.5 })
    expect(out.strength).toBe('14')
    expect(out.dexterity).toBe('16.5')
  })

  it('drops non-finite numbers', () => {
    const out = cleanSheet({ strength: NaN, dexterity: Infinity })
    expect(out.strength).toBeUndefined()
    expect(out.dexterity).toBeUndefined()
  })

  it('keeps the full SHEET_KEYS list usable', () => {
    // Smoke test: every SHEET_KEY passes through a same-name key without mutation.
    const payload: Record<string, string> = {}
    for (const k of SHEET_KEYS) payload[k] = 'x'
    const out = cleanSheet(payload)
    for (const k of SHEET_KEYS) expect(out[k as keyof typeof out]).toBe('x')
  })
})