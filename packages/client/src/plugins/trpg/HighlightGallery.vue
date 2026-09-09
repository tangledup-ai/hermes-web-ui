<script setup lang="ts">
import { ref, computed } from 'vue'
import { NModal } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { Highlight } from './storage'
const props = defineProps<{ highlights: Highlight[]; images: Record<string, string>; busy: boolean; direct: boolean }>()
const emit = defineEmits<{ remove: [id: string]; save: []; render: [highlight: Highlight] }>()
const { t } = useI18n()
const selected = ref<string | null>(null), copyError = ref('')
const current = computed(() => props.highlights.find(h => h.id === selected.value))
const show = computed({ get: () => !!current.value, set: value => { if (!value) selected.value = null } })
async function copy() { try { await navigator.clipboard.writeText(current.value?.prompt || ''); copyError.value = t('trpg.copied') } catch { copyError.value = t('trpg.copyError') } }
</script>
<template>
  <section class="gallery-section">
    <header class="section-heading"><h3>{{ t('trpg.history') }}</h3><span class="count">{{ highlights.length }} / 30</span></header>
    <div v-if="!highlights.length" class="gallery-empty"><span aria-hidden="true">✧</span><h4>{{ t('trpg.waitingScene') }}</h4><p>{{ t('trpg.galleryHint') }}</p></div>
    <div v-else class="highlight-grid">
      <article v-for="(h, i) in highlights" :key="h.id" class="highlight-card" :class="{ latest: i === 0 }">
        <button type="button" class="scene-image" :aria-label="t('trpg.enlarge')" @click="selected = h.id; copyError = ''">
          <img v-if="images[h.id]" :src="images[h.id]" :alt="`${t('trpg.scene')} ${highlights.length - i}`" />
          <span v-else class="prompt-tile"><span aria-hidden="true">◇</span>{{ t('trpg.promptReady') }}</span>
          <span class="image-caption">{{ i === 0 ? t('trpg.currentScene') : t('trpg.scene') }} · {{ new Date(h.createdAt).toLocaleTimeString() }} <span>↗</span></span>
        </button>
        <div class="scene-footer"><small>{{ h.referenceNames?.join(' · ') || t('trpg.noReferences') }}</small><button type="button" class="quiet" :disabled="busy" @click="emit('remove', h.id)">{{ t('trpg.remove') }}</button></div>
      </article>
    </div>
    <NModal v-model:show="show" preset="card" :title="t('trpg.sceneDetails')" class="trpg-workspace trpg-lightbox" :style="{ width: 'min(1080px, 94vw)' }">
      <div v-if="current" class="lightbox-content">
        <img v-if="images[current.id]" class="full-image" :src="images[current.id]" :alt="t('trpg.scene')" />
        <div class="actions"><a v-if="images[current.id]" :href="images[current.id]" :download="`trpg-${current.id}.${current.image?.type === 'image/jpeg' ? 'jpg' : current.image?.type === 'image/webp' ? 'webp' : 'png'}`">{{ t('trpg.downloadImage') }}</a><button v-if="direct && !current.image" type="button" :disabled="busy" @click="emit('render', current)">{{ t('trpg.generateImage') }}</button></div>
        <label>{{ t('trpg.imagePrompt') }}<textarea v-model="current.prompt" :disabled="busy" :aria-label="t('trpg.imagePrompt')" rows="6" maxlength="20000" /></label>
        <div class="actions"><button type="button" @click="copy">{{ t('trpg.copy') }}</button><button type="button" :disabled="busy" @click="emit('save')">{{ t('trpg.save') }}</button></div>
        <p v-if="copyError" role="status">{{ copyError }}</p>
        <details class="sheet-group"><summary>{{ t('trpg.evidence') }}</summary><p v-for="(a, i) in current.actions" :key="i">{{ a.name }}：{{ a.evidence }}</p></details>
        <p class="muted">{{ current.imageModel }} · {{ current.referenceNames?.join(' · ') }}</p>
      </div>
    </NModal>
  </section>
</template>
