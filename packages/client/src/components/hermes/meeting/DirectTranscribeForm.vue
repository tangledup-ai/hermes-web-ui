<script setup lang="ts">
// 「直接音频转录」选项卡表单（新建会议弹窗的第二个 tab）。
//
// 与实时语音 tab 的区别：这里不上麦克风，而是上传一整段音频交给 ASR
// 一次性识别。父级持有全部状态（创建按钮的禁用条件与创建后的转录任务都
// 需要这些值），本组件只负责渲染与用户交互。
//
// 引擎能力差异（见 packages/server/.../app/file_transcribe.py）：
//  - MiniMax：支持区分人声（response_format=verbose_json），整段音频 >480s
//    时由后端自动分片；
//  - Qwen（阿里云百炼）：走同步 base64 接口，仅支持 ≤5 分钟且不支持区分人声。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NRadio, NRadioGroup, NSelect, NSwitch, NUpload } from 'naive-ui'
import type { UploadFileInfo } from 'naive-ui'

defineProps<{
  minimaxConfigured?: boolean
  dashscopeConfigured?: boolean
}>()

const engine = defineModel<'minimax' | 'qwen'>('engine', { default: 'minimax' })
const diarize = defineModel<boolean>('diarize', { default: true })
const speakerCount = defineModel<number>('speakerCount', { default: 0 })
const file = defineModel<File | null>('file', { default: null })

const { t } = useI18n()

const speakerCountOptions = computed(() => [
  { label: t('meeting.speakerCountAuto'), value: 0 },
  ...['2', '3', '4', '5', '6', '7', '8'].map(n => ({ label: n, value: Number(n) })),
])

/** Qwen 的同步接口不返回 speaker，区分人声只对 MiniMax 可用。 */
const diarizeSupported = computed(() => engine.value === 'minimax')

function onEngineChange(value: 'minimax' | 'qwen') {
  engine.value = value
  if (value !== 'minimax') diarize.value = false
}

function onUploadChange(options: { fileList: UploadFileInfo[] }) {
  const info = options.fileList[options.fileList.length - 1]
  file.value = (info?.file as File) || null
}
</script>

<template>
  <div class="form-section">
    <div class="form-section-title">{{ t('meeting.directTranscribe') }}</div>
    <NAlert type="info" :show-icon="false" style="margin-bottom: 12px">
      {{ t('meeting.directTranscribeHint') }}
    </NAlert>

    <div class="form-item">
      <label class="form-label">{{ t('meeting.directEngine') }}</label>
      <NRadioGroup :value="engine" @update:value="onEngineChange">
        <NRadio value="minimax" :disabled="!minimaxConfigured">
          <div class="radio-content">
            <span class="radio-title">{{ t('meeting.asrProviderMinimax') }}</span>
            <span class="radio-desc">{{ t('meeting.directEngineMinimaxDesc') }}</span>
          </div>
        </NRadio>
        <NRadio value="qwen" :disabled="!dashscopeConfigured">
          <div class="radio-content">
            <span class="radio-title">{{ t('meeting.asrProviderDashscope') }}</span>
            <span class="radio-desc">{{ t('meeting.directEngineQwenDesc') }}</span>
          </div>
        </NRadio>
      </NRadioGroup>
    </div>

    <div class="form-item" style="margin-top: 12px">
      <label class="form-label direct-switch-label">
        <NSwitch
          :value="diarize"
          :disabled="!diarizeSupported"
          size="small"
          @update:value="(v: boolean) => (diarize = v)"
        />
        <span>{{ t('meeting.directDiarize') }}</span>
      </label>
      <div class="form-hint">
        {{ diarizeSupported ? t('meeting.directDiarizeHint') : t('meeting.directDiarizeUnsupported') }}
      </div>
    </div>

    <div v-if="diarize" class="form-item" style="margin-top: 12px">
      <label class="form-label">{{ t('meeting.speakerCount') }}</label>
      <NSelect
        :value="speakerCount"
        :options="speakerCountOptions"
        size="small"
        :style="{ width: '160px' }"
        @update:value="(v: number) => (speakerCount = v ?? 0)"
      />
    </div>

    <div class="form-item" style="margin-top: 12px">
      <label class="form-label">{{ t('meeting.directAudioFile') }}</label>
      <div class="direct-file-row">
        <NUpload
          :default-upload="false"
          :show-file-list="false"
          :max="1"
          accept="audio/*,video/*"
          @change="onUploadChange"
        >
          <NButton size="small">{{ t('meeting.directSelectFile') }}</NButton>
        </NUpload>
        <span class="direct-file-name">
          {{ file ? file.name : t('meeting.directNoFile') }}
        </span>
      </div>
      <div v-if="engine === 'qwen'" class="form-hint">
        {{ t('meeting.directQwenLengthHint') }}
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.form-section {
  padding: 12px;
  background: rgba(var(--accent-primary-rgb), 0.03);
  border-radius: 8px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.1);
}

.form-section-title {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
  margin-bottom: 12px;
}

.form-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-label {
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
  display: flex;
  align-items: center;
  gap: 8px;
}

.direct-switch-label {
  cursor: pointer;
}

.form-hint {
  font-size: 12px;
  color: $text-secondary;
  line-height: 1.4;
}

.radio-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.radio-title {
  font-size: 14px;
  font-weight: 500;
  color: $text-primary;
}

.radio-desc {
  font-size: 12px;
  color: $text-secondary;
}

.direct-file-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.direct-file-name {
  font-size: 12px;
  color: $text-secondary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
