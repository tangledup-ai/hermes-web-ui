<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { request, getBaseUrlValue, getStoredUserId, getActiveProfileName } from '@/api/client'
import { useModelsStore } from '@/stores/hermes/models'
import { campaignStorage, snapshotCampaign, emptyCampaign, recentTranscript, defaultImageSettings, type CharacterCard, type Highlight } from './storage'
import { imageDataUri, generatedImageBlob } from './image-io'
import { cleanSheet } from '../../../../shared/trpg'
import CharacterEditor from './CharacterEditor.vue'
import DiceControls from './DiceControls.vue'
import HighlightGallery from './HighlightGallery.vue'
import './trpg.css'
const props = defineProps<{ sessionId: string; sentences: { text: string; speaker?: string }[] }>()
const { t } = useI18n()
const campaign = ref(emptyCampaign())
const loading = ref(true), busy = ref(false), error = ref(''), notice = ref(''), stage = ref('')
const previews = ref<Record<string, string>>({}), sceneImages = ref<Record<string, string>>({})
const key = JSON.stringify([getBaseUrlValue(), getStoredUserId(), getActiveProfileName(), props.sessionId])
const abort = new AbortController()
let disposed = false
let saveQueue = Promise.resolve()
const transcript = computed(() => recentTranscript(props.sentences))
const settings = computed(() => campaign.value.imageSettings!)

const modelsStore = useModelsStore()
// 拉一次当前 profile 可用模型列表；下拉里按 provider 分组，让用户直接挑而不手敲。
modelsStore.fetchProviders().catch(() => { /* 让 UI 仍渲染空选项 */ })
const profileModelGroups = computed(() => modelsStore.providers)
function add() {
  if (campaign.value.characters.length < 20) campaign.value.characters.push({ id: crypto.randomUUID(), name: '', player: '', appearance: '', card: '', sheet: {} })
}
function revoke(map: Record<string, string>, id: string) { if (map[id]) URL.revokeObjectURL(map[id]); delete map[id] }
function remove(id: string) { revoke(previews.value, id); campaign.value.characters = campaign.value.characters.filter(c => c.id !== id) }
function portrait(c: CharacterCard, file: File) { revoke(previews.value, c.id); c.image = file; c.imageName = file.name; previews.value[c.id] = URL.createObjectURL(file) }
function clearPortrait(c: CharacterCard) { revoke(previews.value, c.id); delete c.image; delete c.imageName }
function valid() {
  const names = campaign.value.characters.map(c => c.name.replace(/[【】\r\n]/g, '').trim())
  return names.length <= 20 && names.every(n => n.length > 0 && n.length <= 80) && new Set(names).size === names.length
}
async function save() {
  error.value = ''; notice.value = ''
  if (!valid()) { error.value = t('trpg.invalid'); return false }
  const snapshot = snapshotCampaign(campaign.value)
  const pending = saveQueue.then(() => campaignStorage(key, snapshot))
  saveQueue = pending.then(() => undefined, () => undefined)
  try { await pending; if (!disposed) notice.value = t('trpg.saved'); return true }
  catch { if (!disposed) error.value = t('trpg.storageError'); return false }
}
async function renderImage(h: Highlight) {
  stage.value = t('trpg.painting')
  const options = { ...settings.value }
  const ids = new Set(h.actions.map(a => a.characterId))
  const references = options.useReferences ? campaign.value.characters.filter(c => ids.has(c.id) && c.image) : []
  if (references.length > 4) throw new Error('tooManyReferences')
  const names = references.map(c => `【${c.name.replace(/[【】\r\n]/g, '').trim()}】`)
  const images = await Promise.all(references.map(c => imageDataUri(c.image!)))
  if (disposed) return
  const referenceMap = names.map((name, i) => `参考图 ${i + 1} 对应 ${name}，只借鉴外观，不照搬原图姿势和场景。`).join('\n')
  const response = await request<{ images: string[] }>('/api/hermes/media/apikey-image-generate', {
    method: 'POST', signal: abort.signal, body: JSON.stringify({
      mode: images.length ? 'edit' : 'text', prompt: [h.prompt, referenceMap].filter(Boolean).join('\n\n'),
      provider: options.provider || undefined, model: options.model || undefined, size: options.size, quality: options.quality,
      n: 1, return_base64: true, reference_images: images.length ? images : undefined, timeout_ms: 180000,
    }),
  })
  if (disposed) return
  h.image = generatedImageBlob(response.images?.[0])
  h.referenceNames = names; h.imageModel = options.model || t('trpg.profileDefault')
  revoke(sceneImages.value, h.id); sceneImages.value[h.id] = URL.createObjectURL(h.image)
}
async function renderExisting(h: Highlight) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await renderImage(h); if (!disposed) await save() }
  catch (e) { if (!disposed) error.value = t((e as Error).message === 'tooManyReferences' ? 'trpg.tooManyReferences' : 'trpg.imageFailed') }
  finally { busy.value = false; stage.value = '' }
}
async function generate() {
  if (busy.value || !transcript.value.trim() || !campaign.value.characters.length) return
  error.value = ''; notice.value = ''
  const source = transcript.value
  busy.value = true; stage.value = t('trpg.generating')
  try {
    if (!await save() || disposed) return
    const result = await request<{ prompt: string; actions: Highlight['actions'] }>('/api/plugins/trpg/highlight', {
      method: 'POST', signal: abort.signal,
      body: JSON.stringify({ transcript: source, setting: campaign.value.setting, style: campaign.value.style,
        characters: campaign.value.characters.map(({ id, name, player, appearance, card }) => ({ id, name, player, appearance, card })) }),
    })
    if (disposed) return
    const h: Highlight = { ...result, id: crypto.randomUUID(), createdAt: Date.now(), transcript: source }
    campaign.value.highlights.unshift(h)
    for (const old of campaign.value.highlights.slice(30)) revoke(sceneImages.value, old.id)
    campaign.value.highlights = campaign.value.highlights.slice(0, 30)
    if (!await save()) return
    if (settings.value.enabled) {
      try { await renderImage(h); if (!disposed) await save() }
      catch (e) { if (!disposed) error.value = t((e as Error).message === 'tooManyReferences' ? 'trpg.tooManyReferences' : 'trpg.imageFailed') }
    }
  } catch (e) {
    if (!disposed) {
      const code = (e as { code?: string }).code ?? ''
      error.value = t(`trpg.${['llm_not_configured', 'no_highlight', 'invalid_output'].includes(code) ? code : 'generation_failed'}`)
    }
  } finally { busy.value = false; stage.value = '' }
}
async function removeHighlight(id: string) { revoke(sceneImages.value, id); campaign.value.highlights = campaign.value.highlights.filter(h => h.id !== id); await save() }
onMounted(async () => {
  try {
    const value = await campaignStorage(key)
    if (disposed) return
    value.imageSettings = { ...defaultImageSettings(), ...value.imageSettings }
    for (const c of value.characters) c.sheet = cleanSheet(c.sheet)
    campaign.value = value
    for (const c of value.characters) if (c.image) previews.value[c.id] = URL.createObjectURL(c.image)
    for (const h of value.highlights) if (h.image) sceneImages.value[h.id] = URL.createObjectURL(h.image)
    loading.value = false
  } catch { error.value = t('trpg.storageError') }
})
onBeforeUnmount(() => { disposed = true; abort.abort(); Object.keys(previews.value).forEach(id => revoke(previews.value, id)); Object.keys(sceneImages.value).forEach(id => revoke(sceneImages.value, id)) })
</script>
<template>
  <section class="trpg-workspace" data-testid="trpg-panel" :aria-busy="busy">
    <header class="campaign-banner"><span class="rune" aria-hidden="true">✧</span><div><small>{{ t('trpg.eyebrow') }}</small><h2>{{ t('trpg.workspaceTitle') }}</h2><p>{{ t('trpg.intro') }}</p></div></header>
    <p v-if="error" class="feedback error" role="alert">{{ error }}</p>
    <p v-if="notice" class="feedback" role="status">{{ notice }}</p>
    <p v-if="loading">{{ t('trpg.loading') }}</p>
    <template v-else>
      <div class="scene-command"><div><span class="live-dot" />{{ t('trpg.asrContext') }} <b>{{ Math.min(sentences.length, 60) }}</b></div><button class="primary" type="button" :disabled="busy || !transcript.trim() || !campaign.characters.length" @click="generate">✧ {{ busy ? stage : t(settings.enabled ? 'trpg.generateImage' : 'trpg.generate') }}</button></div>
      <p v-if="!transcript.trim() || !campaign.characters.length" class="muted">{{ t('trpg.empty') }}</p>
      <HighlightGallery :highlights="campaign.highlights" :images="sceneImages" :busy="busy" :direct="settings.enabled" @remove="removeHighlight" @save="save" @render="renderExisting" />
      <details class="utility-section"><summary>{{ t('trpg.sceneSettings') }}</summary><fieldset :disabled="busy"><label>{{ t('trpg.setting') }}<textarea v-model="campaign.setting" :aria-label="t('trpg.setting')" maxlength="3000" rows="3" /></label><label>{{ t('trpg.style') }}<input v-model="campaign.style" :aria-label="t('trpg.style')" maxlength="500" :placeholder="t('trpg.styleHint')" /></label></fieldset></details>
      <details class="utility-section"><summary>{{ t('trpg.imageSettings') }}<small>{{ t(settings.enabled ? 'trpg.on' : 'trpg.off') }}</small></summary>
        <fieldset :disabled="busy"><label class="check"><input v-model="settings.enabled" type="checkbox" />{{ t('trpg.directGeneration') }}</label><p class="muted">{{ t('trpg.imageSettingsHint') }}</p>
          <div class="field-grid"><label>{{ t('trpg.provider') }}<input v-model="settings.provider" :aria-label="t('trpg.provider')" :placeholder="t('trpg.profileDefault')" maxlength="150" /></label><label>{{ t('trpg.model') }}<input v-model="settings.model" :aria-label="t('trpg.model')" :placeholder="t('trpg.profileDefault')" maxlength="150" /></label>
            <label>{{ t('trpg.size') }}<select v-model="settings.size" :aria-label="t('trpg.size')"><option value="1536x1024">{{ t('trpg.landscape') }}</option><option value="1024x1024">{{ t('trpg.square') }}</option><option value="1024x1536">{{ t('trpg.portraitSize') }}</option></select></label><label>{{ t('trpg.quality') }}<select v-model="settings.quality" :aria-label="t('trpg.quality')"><option v-for="v in ['auto','low','medium','high']" :key="v" :value="v">{{ t(`trpg.quality_${v}`) }}</option></select></label></div>
          <label class="check"><input v-model="settings.useReferences" type="checkbox" />{{ t('trpg.useReferences') }}</label>
          <label>{{ t('trpg.draftModel') }}<select v-model="campaign.draftModel" :aria-label="t('trpg.draftModel')"><option value="">{{ t('trpg.meetingDefault') }} — {{ modelsStore.defaultModel || '—' }} ({{ modelsStore.defaultProvider || '—' }})</option><optgroup v-for="group in profileModelGroups" :key="group.provider" :label="group.label"><option v-for="m in group.models" :key="group.provider + '|' + m" :value="m">{{ m }}{{ m === modelsStore.defaultModel && group.provider === modelsStore.defaultProvider ? ` ${t('trpg.defaultSuffix')}` : '' }}</option></optgroup></select></label>
        </fieldset>
      </details>
      <section class="party-section"><header class="section-heading"><div><small>{{ t('trpg.partyEyebrow') }}</small><h3>{{ t('trpg.characters') }}</h3></div><button type="button" :disabled="busy || campaign.characters.length >= 20" @click="add">+ {{ t('trpg.add') }}</button></header>
        <CharacterEditor v-for="c in campaign.characters" :key="c.id" :card="c" :portrait="previews[c.id]" :disabled="busy" :draft-model="campaign.draftModel" @remove="remove(c.id)" @portrait="portrait(c, $event)" @clear-portrait="clearPortrait(c)" />
      </section>
      <DiceControls v-model="campaign.cameraId" />
      <footer class="workspace-footer"><small>{{ t('trpg.localData') }}</small><button type="button" :disabled="busy" @click="save">{{ t('trpg.save') }}</button></footer>
    </template>
  </section>
</template>
