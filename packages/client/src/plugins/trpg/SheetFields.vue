<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { SHEET_GROUPS, LONG_FIELDS, type CharacterSheet, type SheetKey } from '../../../../shared/trpg'

/** Diff marker for a single sheet field, computed by the parent. */
export interface FieldDiff {
  /** 'new' = card had no value, draft provides one. */
  /** 'overwrite' = card had a different non-empty value, draft replaces it. */
  /** 'unchanged' = card already had this exact value, draft matches. */
  kind: 'new' | 'overwrite' | 'unchanged'
  /** The previous value when kind === 'overwrite'. */
  from?: string
}

const props = defineProps<{
  sheet: CharacterSheet
  disabled?: boolean
  /** Optional map of sheet key → diff marker; rendered next to the field label. */
  diff?: Partial<Record<SheetKey, FieldDiff>>
}>()
const { t } = useI18n()
function modifier(value?: string) {
  if (!value?.trim() || !Number.isFinite(Number(value))) return '—'
  const n = Math.floor((Number(value) - 10) / 2)
  return n >= 0 ? `+${n}` : String(n)
}
function diffLabel(key: SheetKey): string | null {
  const d = props.diff?.[key]
  if (!d) return null
  if (d.kind === 'new') return t('trpg.diffNew')
  if (d.kind === 'overwrite') return t('trpg.diffOverwrite', { from: d.from || '' })
  return t('trpg.diffUnchanged')
}
function diffClass(key: SheetKey): string | null {
  const d = props.diff?.[key]
  if (!d) return null
  return `diff-${d.kind}`
}
</script>
<template>
  <div class="sheet-fields">
    <details v-for="(fields, group) in SHEET_GROUPS" :key="group" class="sheet-group" :open="group === 'identity' || group === 'abilities'">
      <summary>{{ t(`trpg.groups.${group}`) }}</summary>
      <div class="field-grid" :class="{ abilities: group === 'abilities' }">
        <label v-for="key in fields" :key="key" :class="{ wide: LONG_FIELDS.has(key), [diffClass(key) || '']: !!diffClass(key) }">
          <span>{{ t(`trpg.fields.${key}`) }}<small v-if="diffLabel(key)" class="diff-tag">{{ diffLabel(key) }}</small></span>
          <textarea v-if="LONG_FIELDS.has(key)" v-model="sheet[key]" :aria-label="t(`trpg.fields.${key}`)" :disabled="disabled" maxlength="2000" rows="3" />
          <input v-else v-model="sheet[key]" :aria-label="t(`trpg.fields.${key}`)" :disabled="disabled" maxlength="120" :inputmode="group === 'abilities' ? 'numeric' : 'text'" />
          <b v-if="group === 'abilities'" class="modifier">{{ modifier(sheet[key]) }}</b>
        </label>
      </div>
    </details>
  </div>
</template>
