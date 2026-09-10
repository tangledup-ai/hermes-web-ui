import { it, expect } from 'vitest'
import { parseDraftJson, responseText } from '../../packages/server/src/services/trpg/draft-parser'
it('reads nested Chinese drafts and score objects, ignoring trailing metadata and quoted prose', () => {
  const raw = 'He said "hello". ```json\n{"data":{"角色卡":{"角色名称":"甘棠","属性":{"STR":{"score":14},"敏捷":16},"种族":"精灵"}}}\n```\n{}'
  expect(parseDraftJson(raw)).toMatchObject({ name: '甘棠', sheet: { strength: '14', dexterity: '16', race: '精灵' } })
  expect(parseDraftJson('{"draft":{"characterName":"A","sheet":{"hpMax":0}}}')).toMatchObject({ name: 'A', sheet: { hpMax: '0' } })
  expect(parseDraftJson('I cannot read the file')).toBeNull()
  expect(responseText([{ type: 'text', text: 'one' }, { text: { value: 'two' } }])).toBe('one\ntwo')
})
