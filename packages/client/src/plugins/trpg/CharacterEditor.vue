<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { request } from '@/api/client'
import type { CharacterCard } from './storage'
import { imageDataUri, fileDataUri } from './image-io'
import { cleanSheet, SHEET_KEYS, type SheetKey } from '../../../../shared/trpg'
import SheetFields, { type FieldDiff } from './SheetFields.vue'

interface DraftTraceEvent {
  type: 'status' | 'tool_call' | 'text' | 'final' | 'raw'
  message: string
  detail?: unknown
}
const props = defineProps<{ card: CharacterCard; disabled: boolean; portrait?: string; draftModel?: string }>()
const emit = defineEmits<{ remove: []; portrait: [file: File]; clearPortrait: [] }>()
const { t } = useI18n()
const expanded = ref(!props.card.name)
const source = ref(''), sourceFile = ref<File>(), sourcePreview = ref('')
const draft = ref<Partial<CharacterCard> | null>(null), filling = ref(false), error = ref('')
const trace = ref<DraftTraceEvent[]>([])
const abort = new AbortController()
let disposed = false
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp']
const MAX_BYTES = 5 * 1024 * 1024
const sourceIsImage = computed(() => sourceFile.value !== undefined && IMAGE_MIMES.includes(sourceFile.value.type))

/**
 * 对比 props.card.sheet 与 draft.sheet：每个 sheet 字段标「新增 / 覆盖 / 无变化」。
 * 让用户在点「应用已审阅字段」之前能看到哪些字段会被改掉，避免误覆盖。
 * 仅统计 draft 里有非空值的字段；空值不参与 diff（apply 也会跳过）。
 */
const sheetDiff = computed<Partial<Record<SheetKey, FieldDiff>>>(() => {
  if (!draft.value?.sheet) return {}
  const result: Partial<Record<SheetKey, FieldDiff>> = {}
  const cardSheet = (props.card.sheet || {}) as Record<string, string | undefined>
  const draftSheet = draft.value.sheet as Record<string, string | undefined>
  for (const key of SHEET_KEYS) {
    const draftVal = (draftSheet[key] || '').trim()
    if (!draftVal) continue
    const cardVal = (cardSheet[key] || '').trim()
    if (!cardVal) result[key] = { kind: 'new' }
    else if (cardVal === draftVal) result[key] = { kind: 'unchanged' }
    else result[key] = { kind: 'overwrite', from: cardSheet[key] }
  }
  return result
})
const diffStats = computed(() => {
  let newCount = 0, overwriteCount = 0, unchangedCount = 0
  for (const d of Object.values(sheetDiff.value)) {
    if (!d) continue
    if (d.kind === 'new') newCount++
    else if (d.kind === 'overwrite') overwriteCount++
    else unchangedCount++
  }
  return { newCount, overwriteCount, unchangedCount }
})

function choose(event: Event, avatar = false) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (avatar) {
    if (!IMAGE_MIMES.includes(file.type) || file.size > MAX_BYTES) { error.value = t('trpg.imageInvalid'); return }
    emit('portrait', file)
    return
  }
  const accepted = IMAGE_MIMES.includes(file.type) || file.type === 'application/pdf'
  if (!accepted || file.size > MAX_BYTES) { error.value = t('trpg.fileInvalid'); return }
  if (sourcePreview.value) URL.revokeObjectURL(sourcePreview.value)
  sourceFile.value = file
  sourcePreview.value = IMAGE_MIMES.includes(file.type) ? URL.createObjectURL(file) : ''
}
function clearSource() {
  if (sourcePreview.value) URL.revokeObjectURL(sourcePreview.value)
  sourcePreview.value = ''; sourceFile.value = undefined
}
async function fill() {
  if (filling.value || props.disabled) return
  filling.value = true; error.value = ''; draft.value = null; trace.value = []
  try {
    const image = sourceFile.value
      ? (sourceIsImage.value ? await imageDataUri(sourceFile.value) : await fileDataUri(sourceFile.value))
      : undefined
    if (disposed) return
    const result = await request<{ draft: Partial<CharacterCard>; trace?: DraftTraceEvent[] }>('/api/plugins/trpg/character-draft', {
      method: 'POST',
      signal: abort.signal,
      body: JSON.stringify({
        text: source.value,
        image,
        model: props.draftModel || undefined,
      }),
    })
    if (!disposed) {
      draft.value = { ...result.draft, sheet: cleanSheet(result.draft.sheet) }
      trace.value = result.trace ?? []
    }
  } catch (e) {
    if (disposed) return
    const err = e as { code?: string; message?: string; raw?: string; status?: number }
    const code = err.code
    let key: 'llm_not_configured' | 'agent_unreachable' | 'invalid_output' | 'image_format_unsupported' | 'draftFailed'
    if (code === 'llm_not_configured') key = 'llm_not_configured'
    else if (code === 'agent_unreachable') key = 'agent_unreachable'
    else if (code === 'image_format_unsupported') key = 'image_format_unsupported'
    else if (code === 'invalid_output') key = 'invalid_output'
    else key = 'draftFailed'
    const base = t(`trpg.${key}`)
    const raw = err.message || ''
    const detail = raw.replace(/^API Error \d+:\s*/, '').trim()
    let text = detail && detail !== base ? `${base} · ${detail}` : base
    if ((code === 'invalid_output' || code === 'image_format_unsupported') && err.raw) {
      text = `${text}\n\n${t('trpg.invalidOutputRaw')}\n${err.raw}`
    }
    error.value = text
  }
  finally { filling.value = false }
}
function apply() {
  if (!draft.value) return
  for (const key of ['name', 'player', 'appearance', 'card'] as const) if (draft.value[key]?.trim()) props.card[key] = draft.value[key]!
  props.card.sheet = { ...props.card.sheet, ...Object.fromEntries(Object.entries(cleanSheet(draft.value.sheet)).filter(([, v]) => v.trim())) }
  draft.value = null
}
function traceTag(type: DraftTraceEvent['type']): string {
  switch (type) {
    case 'status': return t('trpg.traceTagStatus')
    case 'tool_call': return t('trpg.traceTagTool')
    case 'text': return t('trpg.traceTagText')
    case 'final': return t('trpg.traceTagFinal')
    default: return t('trpg.traceTagRaw')
  }
}
onBeforeUnmount(() => { disposed = true; abort.abort(); clearSource() })
</script>
<template>
  <details class="character-card" :open="expanded" @toggle="expanded = ($event.target as HTMLDetailsElement).open">
    <summary class="character-summary">
      <img v-if="portrait" :src="portrait" :alt="card.name" class="avatar" />
      <span v-else class="avatar sigil" aria-hidden="true">♜</span>
      <span><strong>【{{ card.name || t('trpg.unnamed') }}】</strong><small>{{ card.sheet?.classLevel || t('trpg.characterSubtitle') }}</small></span>
      <span class="fold-mark" aria-hidden="true">⌄</span>
    </summary>
    <div v-if="expanded" class="character-body">
      <p v-if="error" role="alert">{{ error }}</p>
      <details v-if="trace.length" class="trace-panel">
        <summary>{{ t('trpg.traceTitle') }} <small>{{ trace.length }}</small></summary>
        <ol class="trace-list">
          <li v-for="(ev, idx) in trace" :key="idx" :class="['trace-item', `trace-item--${ev.type}`]">
            <span class="trace-tag">{{ traceTag(ev.type) }}</span>
            <span class="trace-msg">{{ ev.message }}</span>
          </li>
        </ol>
      </details>
      <fieldset :disabled="disabled || filling">
        <div class="field-grid">
          <label>{{ t('trpg.name') }}<input v-model="card.name" :aria-label="t('trpg.name')" maxlength="80" /></label>
          <label>{{ t('trpg.player') }}<input v-model="card.player" :aria-label="t('trpg.player')" maxlength="100" /></label>
          <label class="wide">{{ t('trpg.appearance') }}<textarea v-model="card.appearance" :aria-label="t('trpg.appearance')" maxlength="2000" rows="2" /></label>
        </div>
        <div class="portrait-tools">
          <label class="upload-label">{{ t('trpg.image') }}<input type="file" accept="image/png,image/jpeg,image/webp" :aria-label="t('trpg.image')" @change="choose($event, true)" /></label>
          <button v-if="portrait" class="quiet" type="button" @click="emit('clearPortrait')">{{ t('trpg.clearImage') }}</button>
        </div>
        <details class="ai-workshop">
          <summary>✧ {{ t('trpg.aiFill') }}</summary>
          <p class="muted">{{ t('trpg.aiHint') }}</p>
          <label>{{ t('trpg.sourceText') }}<textarea v-model="source" :aria-label="t('trpg.sourceText')" rows="3" maxlength="12000" /></label>
          <label>{{ t('trpg.sourceFile') }}<input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" :aria-label="t('trpg.sourceFile')" @change="choose($event)" /></label>
          <img v-if="sourcePreview" :src="sourcePreview" :alt="t('trpg.sourceFile')" class="source-preview" />
          <p v-else-if="sourceFile && !sourceIsImage" class="source-file-hint">{{ sourceFile.name }} · PDF</p>
          <div class="actions">
            <button v-if="sourceIsImage" type="button" @click="emit('portrait', sourceFile!)">{{ t('trpg.usePortrait') }}</button>
            <button v-if="sourceFile" type="button" @click="clearSource">{{ t('trpg.clearImage') }}</button>
            <button type="button" :disabled="!source.trim() && !sourceFile" @click="fill">{{ t('trpg.draft') }}</button>
          </div>
          <p v-if="filling" role="status" class="status-line">{{ t('trpg.filling') }}</p>
          <p v-else-if="error" role="alert" class="status-line error">{{ error }}</p>
        </details>
      </fieldset>
      <section v-if="draft" class="draft-review">
        <h4>{{ t('trpg.reviewDraft') }}</h4>
        <p class="muted">{{ t('trpg.reviewHint') }}</p>
        <p class="diff-summary">
          {{ t('trpg.diffSummary', { new: diffStats.newCount, overwrite: diffStats.overwriteCount, unchanged: diffStats.unchangedCount }) }}
        </p>
        <label v-for="key in (['name', 'player', 'appearance', 'card'] as const)" :key="key">{{ t(`trpg.${key}`) }}<textarea v-model="draft[key]" rows="2" :maxlength="key === 'card' ? 6000 : key === 'appearance' ? 2000 : key === 'name' ? 80 : 100" :disabled="disabled" /></label>
        <SheetFields v-if="draft.sheet" :sheet="draft.sheet" :disabled="disabled" :diff="sheetDiff" />
        <div class="actions"><button type="button" :disabled="disabled" @click="apply">{{ t('trpg.applyDraft') }}</button><button type="button" @click="draft = null">{{ t('trpg.discard') }}</button></div>
      </section>
      <SheetFields :sheet="card.sheet!" :disabled="disabled || filling" />
      <details class="sheet-group"><summary>{{ t('trpg.card') }}</summary><textarea v-model="card.card" :aria-label="t('trpg.card')" :disabled="disabled || filling" maxlength="6000" rows="4" /></details>
      <button type="button" class="danger quiet" :disabled="disabled || filling" @click="emit('remove')">{{ t('trpg.removeCharacter') }}</button>
    </div>
  </details>
</template>
