<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { NAlert, NButton, NCheckbox, NCollapse, NCollapseItem, NForm, NFormItem, NInput, NRadio, NRadioGroup, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { saveMeetingTranscriptionSetting, type MeetingTranscriptionPatch, type MeetingTranscriptionSetting } from '@/api/studio/meeting-transcription'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { loadMeetingTranscriptionSetting } from '@/utils/meeting-transcription-settings'

const props = defineProps<{ profile: string }>()
const { t } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()
const prefix = 'models.meetingTranscription'
const saved = ref<MeetingTranscriptionSetting | null>(null)
const draft = ref<MeetingTranscriptionSetting | null>(null)
const loading = ref(true)
const saving = ref(false)
const error = ref('')
let disposed = false

const fields = [
  'asrModel', 'paraformerModel', 'minimaxAsrModel', 'minimaxBaseUrl',
  'ossBucket', 'ossEndpoint', 'ossPathPrefix',
] as const

const providerSecrets = [
  { key: 'dashscopeApiKey', status: 'dashscopeKeyConfigured', label: `${prefix}.dashscopeApiKey`, provider: 'dashscope', name: 'DashScope' },
  { key: 'minimaxApiKey', status: 'minimaxKeyConfigured', label: 'models.realtimeMinimaxApiKey', provider: 'minimax', name: 'MiniMax' },
] as const

const ossSecrets = [
  { key: 'ossAccessKeyId', status: 'ossAccessKeyIdConfigured', label: `${prefix}.ossAccessKeyId` },
  { key: 'ossAccessKeySecret', status: 'ossAccessKeySecretConfigured', label: `${prefix}.ossAccessKeySecret` },
] as const

const secretFields = [...providerSecrets, ...ossSecrets]
type SecretKey = typeof secretFields[number]['key']
const secretValues = reactive<Record<SecretKey, string>>({ dashscopeApiKey: '', minimaxApiKey: '', ossAccessKeyId: '', ossAccessKeySecret: '' })
const clearSecret = reactive<Record<SecretKey, boolean>>({ dashscopeApiKey: false, minimaxApiKey: false, ossAccessKeyId: false, ossAccessKeySecret: false })

function applySetting(setting: MeetingTranscriptionSetting) {
  saved.value = setting
  draft.value = { ...setting }
  for (const { key } of secretFields) {
    secretValues[key] = ''
    clearSecret[key] = false
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const setting = await loadMeetingTranscriptionSetting(props.profile, profilesStore.activeProfileName || 'default')
    if (!disposed) applySetting(setting)
  } catch {
    if (!disposed) error.value = t(`${prefix}.loadFailed`)
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!saved.value || !draft.value || saving.value) return
  const patch: MeetingTranscriptionPatch = {}
  const { asrProvider } = draft.value
  if (asrProvider !== saved.value.asrProvider) patch.asrProvider = asrProvider
  for (const field of fields) {
    const value = draft.value[field].trim()
    if (value !== saved.value[field]) patch[field] = value
  }
  for (const { key } of secretFields) {
    const value = secretValues[key].trim()
    if (clearSecret[key] || value) patch[key] = clearSecret[key] ? '' : value
  }
  if (Object.keys(patch).length === 0) return

  saving.value = true
  error.value = ''
  try {
    const setting = await saveMeetingTranscriptionSetting(patch, props.profile)
    if (!disposed) {
      applySetting(setting)
      message.success(t(`${prefix}.saved`))
    }
  } catch (err) {
    if (!disposed) error.value = err instanceof Error ? err.message : t(`${prefix}.saveFailed`)
  } finally {
    saving.value = false
  }
}

onMounted(load)
onUnmounted(() => { disposed = true })
</script>

<template>
  <section class="meeting-transcription" data-theme-surface="card" aria-labelledby="meeting-transcription-title">
    <header>
      <h3 id="meeting-transcription-title">{{ t(`${prefix}.title`) }}</h3>
      <p class="description">{{ t(`${prefix}.description`) }}</p>
    </header>
    <NSpin v-if="loading" :description="t('common.loading')" class="loading" />
    <NAlert v-if="error" type="error" class="error">
      {{ error }}
      <NButton v-if="!draft" size="small" @click="load">{{ t('common.retry') }}</NButton>
    </NAlert>
    <NForm v-if="draft" :disabled="saving" class="transcription-form" @submit.prevent="save">
      <NFormItem :label="t(`${prefix}.defaultProvider`)">
        <NRadioGroup v-model:value="draft.asrProvider" role="radiogroup" name="meeting-transcription-provider" :aria-label="t(`${prefix}.defaultProvider`)">
          <NRadio v-for="field in providerSecrets" :key="field.provider" :value="field.provider">{{ field.name }}</NRadio>
        </NRadioGroup>
      </NFormItem>

      <div class="provider-settings">
        <section v-for="field in providerSecrets" :key="field.key" :aria-labelledby="`meeting-transcription-${field.provider}`">
          <header class="provider-heading">
            <h4 :id="`meeting-transcription-${field.provider}`">{{ field.name }}</h4>
            <NTag size="small" :type="draft[field.status] ? 'success' : 'default'">
              {{ t(`${prefix}.${draft[field.status] ? 'configured' : 'notConfigured'}`) }}
            </NTag>
          </header>
          <NFormItem :label="t(field.label)">
            <div class="credential-field">
              <NInput v-model:value="secretValues[field.key]" type="password" :disabled="clearSecret[field.key] || saving"
                :placeholder="draft[field.status] ? t(`${prefix}.keepKey`) : undefined"
                :input-props="{ 'aria-label': t(field.label), autocomplete: 'new-password' }" />
              <NCheckbox v-if="draft[field.status]" v-model:checked="clearSecret[field.key]" :disabled="saving">
                {{ t(`${prefix}.removeCredential`) }}
              </NCheckbox>
            </div>
          </NFormItem>
          <template v-if="field.key === 'dashscopeApiKey'">
            <NFormItem :label="t(`${prefix}.liveModel`)">
              <NInput v-model:value="draft.paraformerModel" :input-props="{ 'aria-label': t(`${prefix}.liveModel`) }" />
            </NFormItem>
            <NFormItem :label="t(`${prefix}.speakerModel`)">
              <NInput v-model:value="draft.asrModel" :input-props="{ 'aria-label': t(`${prefix}.speakerModel`) }" />
            </NFormItem>
          </template>
          <template v-else>
            <NFormItem :label="t('models.realtimeMinimaxModelLabel')">
              <NInput v-model:value="draft.minimaxAsrModel" :input-props="{ 'aria-label': t('models.realtimeMinimaxModelLabel') }" />
            </NFormItem>
            <NFormItem :label="t('models.realtimeMinimaxBaseUrlLabel')">
              <NInput v-model:value="draft.minimaxBaseUrl" :input-props="{ 'aria-label': t('models.realtimeMinimaxBaseUrlLabel') }" />
            </NFormItem>
          </template>
        </section>
      </div>

      <NCollapse>
        <NCollapseItem :title="t(`${prefix}.ossTitle`)" name="oss">
          <template #header-extra>
            <NTag v-if="draft.ossConfigured" size="small" type="success">{{ t(`${prefix}.configured`) }}</NTag>
          </template>
          <p class="description oss-description">{{ t(`${prefix}.ossDescription`) }}</p>
          <div class="provider-settings">
            <NFormItem v-for="field in ossSecrets" :key="field.key" :label="t(field.label)">
              <div class="credential-field">
                <NInput v-model:value="secretValues[field.key]" type="password" :disabled="clearSecret[field.key] || saving"
                  :placeholder="draft[field.status] ? t(`${prefix}.keepKey`) : undefined"
                  :input-props="{ 'aria-label': t(field.label), autocomplete: 'new-password' }" />
                <NCheckbox v-if="draft[field.status]" v-model:checked="clearSecret[field.key]" :disabled="saving">
                  {{ t(`${prefix}.removeCredential`) }}
                </NCheckbox>
              </div>
            </NFormItem>
            <NFormItem :label="t(`${prefix}.ossBucket`)">
              <NInput v-model:value="draft.ossBucket" :input-props="{ 'aria-label': t(`${prefix}.ossBucket`) }" />
            </NFormItem>
            <NFormItem :label="t(`${prefix}.ossEndpoint`)">
              <NInput v-model:value="draft.ossEndpoint" placeholder="oss-cn-beijing.aliyuncs.com" :input-props="{ 'aria-label': t(`${prefix}.ossEndpoint`) }" />
            </NFormItem>
            <NFormItem :label="t(`${prefix}.ossPathPrefix`)">
              <NInput v-model:value="draft.ossPathPrefix" :input-props="{ 'aria-label': t(`${prefix}.ossPathPrefix`) }" />
            </NFormItem>
          </div>
        </NCollapseItem>
      </NCollapse>

      <div class="actions">
        <NButton type="primary" attr-type="submit" :loading="saving">{{ t('common.save') }}</NButton>
      </div>
    </NForm>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.meeting-transcription {
  margin-block: calc(16px * var(--spacing-scale, 1)) calc(24px * var(--spacing-scale, 1));
  padding: calc(16px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
}

h3,
h4 {
  color: $text-primary;
  margin: 0;
  font-size: inherit;
  font-weight: 600;
}

.description {
  color: $text-muted;
  margin-block: 6px 0;
}

.transcription-form,
.loading,
.error {
  margin-block-start: calc(14px * var(--spacing-scale, 1));
}

.provider-settings {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 270px), 1fr));
  gap: 0 calc(20px * var(--spacing-scale, 1));
}

.provider-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: calc(8px * var(--spacing-scale, 1));
  margin-block-end: calc(10px * var(--spacing-scale, 1));
}

.credential-field {
  display: grid;
  width: 100%;
  gap: calc(6px * var(--spacing-scale, 1));
}

.oss-description {
  margin-block: 0 calc(12px * var(--spacing-scale, 1));
}

.actions {
  margin-block-start: calc(16px * var(--spacing-scale, 1));
}
</style>
