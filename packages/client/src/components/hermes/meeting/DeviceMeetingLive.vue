<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { MeetingLiveSession } from '../../../../../shared/meeting-live'
import { formatMeetingOffset } from '@/utils/meeting-time'

const props = defineProps<{
  session: MeetingLiveSession
  connected: boolean
  archiveDisabled: boolean
}>()
const emit = defineEmits<{ archive: []; retry: [] }>()
const { t } = useI18n()
const transcript = ref<HTMLElement>()
const following = ref(true)
const status = computed(() => props.connected ? props.session.status : 'disconnected')
const startTime = computed(() => new Date(props.session.startedAt).toLocaleTimeString(undefined, {
  hour: '2-digit', minute: '2-digit',
}))

function updateFollowing() {
  const element = transcript.value
  if (element) following.value = element.scrollHeight - element.scrollTop - element.clientHeight < 48
}

async function followLatest() {
  following.value = true
  await nextTick()
  if (transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight
}

watch(() => props.session.id, followLatest)
watch(() => [props.session.sentences, props.session.partial], () => {
  if (following.value) void followLatest()
})
</script>

<template>
  <section class="live-meeting" data-testid="meeting-device-live" aria-labelledby="device-live-title">
    <header class="live-header">
      <div>
        <h2 id="device-live-title">{{ t('meeting.workspace.device') }}</h2>
        <p>H618 · {{ startTime }}</p>
      </div>
      <div class="live-actions">
        <span class="live-status" :class="`status-${status}`" role="status">
          {{ t(`meeting.workspace.${status}`) }}
        </span>
        <NButton v-if="status === 'saved'" size="small" type="primary" :disabled="archiveDisabled" @click="emit('archive')">
          {{ t('meeting.workspace.openArchive') }}
        </NButton>
        <NButton v-else-if="!connected" size="small" @click="emit('retry')">{{ t('meeting.deviceConsentRetry') }}</NButton>
      </div>
    </header>
    <div ref="transcript" class="live-transcript" @scroll.passive="updateFollowing" tabindex="0" :aria-label="t('meeting.workspace.liveTranscript')">
      <p v-if="!session.sentences.length && !session.partial" class="live-empty">{{ t('meeting.workspace.waitingSpeech') }}</p>
      <div v-for="(sentence, index) in session.sentences" :key="`${sentence.timestamp}-${sentence.startTime ?? index}-${sentence.text}`" class="live-line">
        <span class="line-time">{{ sentence.startTime == null ? '—' : formatMeetingOffset(sentence.startTime) }}</span>
        <p>{{ sentence.text }}</p>
      </div>
      <div v-if="session.partial && status === 'transcribing'" class="live-line line-partial" data-testid="meeting-device-partial">
        <span class="line-time">{{ t('meeting.partial') }}</span>
        <p>{{ session.partial }}</p>
      </div>
    </div>
    <footer v-if="!following" class="live-footer">
      <NButton size="small" secondary @click="followLatest">{{ t('meeting.workspace.followLatest') }}</NButton>
    </footer>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.live-meeting { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.live-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; padding: 18px clamp(16px, 4vw, 42px); border-bottom: 1px solid $border-color; }
.live-header h2 { margin: 0; font-size: 19px; font-weight: 650; }
.live-header p { margin: 5px 0 0; color: $text-secondary; font-size: 12px; }
.live-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.live-status { padding: 5px 10px; border-radius: 999px; border: 1px solid $border-color; color: $text-secondary; font-size: 12px; }
.status-transcribing { color: var(--success); background: rgba(var(--success-rgb), 0.08); }
.status-disconnected, .status-syncing { color: var(--warning); }
.live-transcript { overflow-y: auto; flex: 1; padding: 14px clamp(16px, 4vw, 42px); }
.live-line { display: grid; grid-template-columns: minmax(54px, max-content) minmax(0, 1fr); gap: 18px; max-width: 840px; padding: 13px 0; border-bottom: 1px solid $border-color; }
.live-line p { margin: 0; font-size: 16px; line-height: 1.65; overflow-wrap: anywhere; }
.line-time { color: $text-secondary; font-size: 12px; line-height: 2.2; font-variant-numeric: tabular-nums; }
.line-partial, .line-partial .line-time { color: $accent-primary; }
.live-empty { margin: 30px 0; color: $text-secondary; }
.live-footer { display: flex; justify-content: flex-end; padding: 10px clamp(16px, 4vw, 42px); border-top: 1px solid $border-color; }
</style>
