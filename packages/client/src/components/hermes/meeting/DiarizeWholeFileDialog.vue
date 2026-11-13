<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NModal, NRadio, NRadioGroup, NSelect } from 'naive-ui'

export type DiarizeEngine = 'minimax' | 'qwen'

const props = withDefaults(defineProps<{
  visible: boolean
  /** 打开时预选的引擎（一般取当前会话的 ASR provider）。 */
  defaultEngine?: DiarizeEngine
  /** 打开时预选的说话人数（0 = 自动）。 */
  defaultSpeakerCount?: number
  /** 是否已配置 MiniMax API Key（缺失时禁用该引擎）。 */
  minimaxKeyAvailable?: boolean
  /** 是否已配置 DashScope API Key（缺失时禁用该引擎）。 */
  dashscopeKeyAvailable?: boolean
  ossConfigured?: boolean
  busy?: boolean
}>(), {
  defaultEngine: 'minimax',
  defaultSpeakerCount: 0,
  minimaxKeyAvailable: false,
  dashscopeKeyAvailable: false,
  ossConfigured: false,
  busy: false,
})

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'start', payload: { engine: DiarizeEngine; speakerCount: number }): void
  (e: 'open-settings'): void
}>()

const { t } = useI18n()

const engine = ref<DiarizeEngine>('minimax')
const speakerCount = ref(0)

/** 每次打开都从外部状态重新播种，避免上次填了一半的值残留。 */
watch(() => props.visible, (visible) => {
  if (!visible) return
  engine.value = props.defaultEngine
  speakerCount.value = props.defaultSpeakerCount
}, { immediate: true })

const speakerCountOptions = computed(() => [
  { label: t('meeting.speakerCountAuto'), value: 0 },
  ...['2', '3', '4', '5', '6', '7', '8'].map(n => ({ label: n, value: Number(n) })),
])

const engineKeyAvailable = computed(() =>
  engine.value === 'minimax' ? props.minimaxKeyAvailable : props.dashscopeKeyAvailable,
)

const canStart = computed(() => !props.busy && engineKeyAvailable.value
  && (engine.value === 'minimax' || props.ossConfigured),
)

function close() {
  emit('update:visible', false)
}

function start() {
  if (!canStart.value) return
  emit('start', {
    engine: engine.value,
    speakerCount: speakerCount.value || 0,
  })
}
</script>

<template>
  <NModal
    :show="props.visible"
    preset="card"
    :title="t('meeting.diarizeDialogTitle')"
    :style="{ width: '560px' }"
    :bordered="false"
    :mask-closable="!props.busy"
    @update:show="(v: boolean) => emit('update:visible', v)"
  >
    <div class="diarize-form">
      <div class="form-item">
        <label class="form-label">{{ t('meeting.diarizeEngine') }}</label>
        <NRadioGroup v-model:value="engine">
          <NRadio value="minimax">
            <div class="radio-content">
              <span class="radio-title">{{ t('meeting.asrProviderMinimax') }}</span>
              <span class="radio-desc">{{ t('meeting.directEngineMinimaxDesc') }}</span>
            </div>
          </NRadio>
          <NRadio value="qwen">
            <div class="radio-content">
              <span class="radio-title">{{ t('meeting.asrProviderDashscope') }}</span>
              <span class="radio-desc">{{ t('meeting.directEngineQwenDesc') }}</span>
            </div>
          </NRadio>
        </NRadioGroup>
      </div>

      <div v-if="engine === 'qwen'" class="form-item">
        <label class="form-label">{{ t('meeting.speakerCount') }}</label>
        <NSelect
          :value="speakerCount"
          :options="speakerCountOptions"
          size="small"
          :style="{ width: '160px' }"
          @update:value="(v: number) => (speakerCount = v ?? 0)"
        />
      </div>

      <NAlert v-if="!engineKeyAvailable" type="warning" :show-icon="true">
        {{ engine === 'minimax' ? t('meeting.diarizeNoMinimaxKey') : t('meeting.diarizeNoDashscopeKey') }}
      </NAlert>

      <NAlert v-if="engine === 'qwen' && !props.ossConfigured" type="warning">
        {{ t('meeting.diarizeQwenOssRequired') }}
      </NAlert>
      <NButton v-if="!canStart && !props.busy" text type="primary" @click="emit('open-settings')">
        {{ t('models.meetingTranscription.openSettings') }}
      </NButton>
    </div>

    <template #action>
      <NButton :disabled="props.busy" @click="close">{{ t('common.cancel') }}</NButton>
      <NButton type="primary" :disabled="!canStart" :loading="props.busy" @click="start">
        {{ t('meeting.diarizeStart') }}
      </NButton>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.diarize-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
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

</style>
