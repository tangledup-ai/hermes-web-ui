<script setup lang="ts">
// 会议转写流列表：
//   - 空状态
//   - 句子列表（序号 + 说话人 + 文本），支持高亮与点击 seek
//   - 说话人重命名（NPopover + NInput，内部自持 state）
//   - partial 实时占位文本
//
// 数据从父级传入；seek / 重命名通过 emits 通知父级执行真正的业务逻辑
// （seekToSentence 需要 audioUrl 上下文，rename 需要 meetingStore 持久化）。

import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NPopover, NInput, NButton } from 'naive-ui'
import { formatMeetingOffset } from '@/utils/meeting-time'
import type { TranscriptSentence } from '@/stores/hermes/meeting'

const props = defineProps<{
  sentences: TranscriptSentence[]
  partialText: string
  highlightedIndex: number
  isRecording: boolean
  hasAudio?: boolean
  hideSpeakerDiarization: boolean
}>()

const emit = defineEmits<{
  (e: 'seek', index: number): void
  (e: 'rename', speakerId: string, name: string): void
}>()

const { t } = useI18n()
function canSeek(sentence: TranscriptSentence) {
  return props.hasAudio !== false && sentence.startTime !== undefined && !props.isRecording
}

const renamingKey = ref<string | null>(null) // `${speakerId}:${index}`
const renameInput = ref('')

function isRenaming(speakerId: string | undefined, index: number): boolean {
  return renamingKey.value === `${speakerId}:${index}`
}

function startRename(speakerId: string | undefined, index: number, currentName: string) {
  if (!speakerId) return
  renamingKey.value = `${speakerId}:${index}`
  renameInput.value = currentName
}

function cancelRename() {
  renamingKey.value = null
  renameInput.value = ''
}

function confirmRename() {
  const key = renamingKey.value
  if (!key) return
  const speakerId = key.split(':')[0]
  const name = renameInput.value.trim()
  if (!speakerId || !name) return
  emit('rename', speakerId, name)
  cancelRename()
}
</script>

<template>
  <div id="transcript-container" class="transcript-content">
    <div v-if="props.sentences.length === 0 && !props.partialText" class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/>
        <path d="M8 12l3 3 5-5"/>
      </svg>
      <p>{{ t('meeting.emptyState') }}</p>
    </div>

    <div
      v-for="(sentence, index) in props.sentences"
      :key="index"
      :data-index="index"
      tabindex="-1"
      class="sentence-item"
      :class="{
        highlighted: props.highlightedIndex === index,
        clickable: canSeek(sentence),
      }"
      @click="canSeek(sentence) ? emit('seek', index) : undefined"
    >
      <button
        v-if="canSeek(sentence) && sentence.startTime !== undefined"
        class="sentence-time"
        type="button"
        :aria-label="t('meeting.deviceMarker', { time: formatMeetingOffset(sentence.startTime) })"
        @click.stop="emit('seek', index)"
      >{{ formatMeetingOffset(sentence.startTime) }}</button>
      <span v-else class="sentence-time" aria-hidden="true">{{ sentence.startTime === undefined ? '—' : formatMeetingOffset(sentence.startTime) }}</span>
      <div class="sentence-body">
        <NPopover
          v-if="sentence.speakerId && !props.hideSpeakerDiarization"
          trigger="click"
          placement="top"
          :show="isRenaming(sentence.speakerId, index)"
          @update:show="(val: boolean) => { if (!val) cancelRename() }"
        >
          <template #trigger>
            <span
              class="sentence-speaker"
              @click.stop="sentence.speakerId ? startRename(sentence.speakerId, index, sentence.speaker || '') : undefined"
              :title="t('meeting.renameSpeaker')"
            >
              {{ sentence.speaker }}
              <!-- 可点击重命名的提示：仅 hover 时出现，不干扰阅读 -->
              <svg class="speaker-edit-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
              </svg>
            </span>
          </template>
          <div class="speaker-rename-popover">
            <div class="speaker-rename-title">{{ t('meeting.renameSpeaker') }}</div>
            <NInput
              v-model:value="renameInput"
              size="small"
              :placeholder="t('meeting.speakerPlaceholder')"
              @keyup.enter="confirmRename"
              autofocus
            />
            <div class="speaker-rename-actions">
              <NButton size="tiny" @click="cancelRename">{{ t('common.cancel') }}</NButton>
              <NButton size="tiny" type="primary" @click="confirmRename">{{ t('common.confirm') }}</NButton>
            </div>
          </div>
        </NPopover>
        <span class="sentence-text">{{ sentence.text }}</span>
      </div>
    </div>

    <div v-if="props.partialText" class="partial-text">
      <span class="partial-indicator">{{ t('meeting.partial') }}</span>
      {{ props.partialText }}
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.transcript-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px clamp(16px, 4vw, 42px);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  color: $text-secondary;

  p {
    font-size: 14px;
  }
}

.sentence-item {
  display: flex;
  gap: 18px;
  padding: 13px 0;
  border-bottom: 1px solid rgba($border-color, 0.5);
  border-radius: 4px;
  transition: background-color 0.2s ease;

  &:last-child {
    border-bottom: none;
  }

  &.highlighted {
    background: rgba($accent-primary, 0.15);
    border-left: 3px solid $accent-primary;
  }

  &.clickable {
    cursor: pointer;

    &:hover {
      background: rgba($accent-primary, 0.06);
    }
  }
}

.sentence-time {
  flex-shrink: 0;
  min-width: 54px;
  align-self: flex-start;
  padding: 3px 0;
  border: 0;
  background: transparent;
  color: $text-secondary;
  text-align: left;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

button.sentence-time {
  cursor: pointer;
  &:hover { color: $accent-primary; }
}

.sentence-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.sentence-speaker {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: rgba($accent-primary, 0.1);
  color: $accent-primary;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  width: fit-content;

  &:hover {
    background: rgba($accent-primary, 0.2);
  }

  .speaker-edit-icon {
    opacity: 0;
    transition: opacity 0.2s ease;
    flex-shrink: 0;
  }

  &:hover .speaker-edit-icon {
    opacity: 0.7;
  }
}

.sentence-text {
  font-size: 16px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.speaker-rename-popover {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 0;
}

.speaker-rename-title {
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
}

.speaker-rename-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.partial-text {
  padding: 8px 0;
  color: $text-secondary;
  font-style: italic;
  font-size: 14px;
}

.partial-indicator {
  display: inline-block;
  padding: 2px 6px;
  background: rgba($accent-primary, 0.1);
  color: $accent-primary;
  border-radius: 4px;
  font-size: 11px;
  font-style: normal;
  margin-right: 8px;
}
</style>