<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { NModal, NButton } from 'naive-ui'

const props = defineProps<{
  visible: boolean
  createDisabled: boolean
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'create'): void
}>()

const { t } = useI18n()

function close() {
  emit('update:visible', false)
}

function onCreate() {
  emit('create')
}
</script>

<template>
  <NModal
    :show="props.visible"
    preset="card"
    :title="t('meeting.createMeeting')"
    :style="{ width: '640px' }"
    :bordered="false"
    :mask-closable="false"
    @update:show="(v: boolean) => emit('update:visible', v)"
  >
    <slot />
    <template #action>
      <NButton @click="close">{{ t('common.cancel') }}</NButton>
      <NButton
        type="primary"
        :disabled="props.createDisabled"
        @click="onCreate"
      >
        {{ t('meeting.create') }}
      </NButton>
    </template>
  </NModal>
</template>