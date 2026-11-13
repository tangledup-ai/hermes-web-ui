<script setup lang="ts">
import { NButton, NInput, NSelect, type SelectOption } from 'naive-ui'
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useRealtimeModelStore } from '@/stores/hermes/realtime-model'
import { useMessage } from '@/composables/useAppMessage'

const { t } = useI18n()
const message = useMessage()
const store = useRealtimeModelStore()

// Tina is verified with the default qwen3.8 model. Ethan is rejected by that
// model, so it must not appear as a default option.
const voiceOptions: SelectOption[] = [
  { label: 'Tina (女声 · 中文 · 默认)', value: 'Tina' },
  { label: 'Serena (女声 · 中文)', value: 'Serena' },
  { label: 'Jennifer (女声 · 中文)', value: 'Jennifer' },
  { label: 'Ryan (男声 · 中文)', value: 'Ryan' },
]

const apiKey = ref(store.config.apiKey)
const model = ref(store.config.model)
const voice = ref(store.config.voice)
const saving = ref(false)

onMounted(async () => {
  // Refresh from the active profile's server row so the form always shows
  // profile-persisted values (e.g. after switching profiles / browsers).
  await store.loadFromServer(null, { force: true })
  apiKey.value = store.config.apiKey
  model.value = store.config.model
  voice.value = store.config.voice
})

async function handleSave() {
  saving.value = true
  try {
    const result = await store.updateConfig({
      apiKey: apiKey.value.trim(),
      model: model.value.trim() || 'qwen3.8-omni-flash-realtime',
      voice: voice.value || 'Tina',
    })
    if (result.ok) {
      message.success(t('models.realtimeSaved'))
    } else {
      message.error(result.error || t('models.realtimeSaveFailed'))
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : t('models.realtimeSaveFailed'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="realtime-models-panel">
    <div class="realtime-models-header">
      <h3>{{ t('models.realtimeTitle') }}</h3>
      <p class="realtime-models-subtitle">{{ t('models.realtimeSubtitle') }}</p>
    </div>

    <div class="realtime-models-form">
      <div class="realtime-models-field">
        <label>
          {{ t('models.realtimeApiKey') }}
          <a
            href="https://dashscope.aliyun.com/"
            target="_blank"
            rel="noopener noreferrer"
            class="realtime-models-link"
            @click.stop
          >{{ t('meeting.howToGetApiKey') }}</a>
        </label>
        <NInput
          v-model:value="apiKey"
          type="password"
          show-password-on="click"
          :placeholder="t('models.realtimeApiKeyPlaceholder')"
        />
        <div class="realtime-models-hint">{{ t('models.realtimeApiKeyHint') }}</div>
      </div>

      <div class="realtime-models-field">
        <label>{{ t('models.realtimeModelLabel') }}</label>
        <NInput
          v-model:value="model"
          :placeholder="t('models.realtimeModelPlaceholder')"
        />
      </div>

      <div class="realtime-models-field">
        <label>{{ t('models.realtimeVoiceLabel') }}</label>
        <NSelect v-model:value="voice" :options="voiceOptions" />
      </div>

      <div class="realtime-models-actions">
        <NButton
          type="primary"
          :loading="saving"
          data-guide-id="models-realtime-save"
          @click="handleSave"
        >
          {{ t('common.save') }}
        </NButton>
      </div>
    </div>

    <div>
      <RouterLink class="realtime-models-link" :to="{ name: 'hermes.models', query: { tab: 'stt' } }">
        {{ t('models.meetingTranscription.openSettings') }}
      </RouterLink>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.realtime-models-panel {
  max-width: 640px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.realtime-models-header h3 {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 600;
  color: $text-primary;
}

.realtime-models-subtitle {
  margin: 0;
  font-size: 13px;
  color: $text-secondary;
  line-height: 1.5;
}

.realtime-models-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.12);
  border-radius: $radius-md;
  background: rgba(var(--accent-primary-rgb), 0.03);
}

.realtime-models-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.realtime-models-field label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
}

.realtime-models-link {
  font-size: 12px;
  font-weight: 400;
  color: var(--color-primary, #667eea);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  opacity: 0.75;
  transition: opacity 0.2s;
}

.realtime-models-link:hover {
  opacity: 1;
}

.realtime-models-hint {
  font-size: 12px;
  color: $text-secondary;
  line-height: 1.4;
}

.realtime-models-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
