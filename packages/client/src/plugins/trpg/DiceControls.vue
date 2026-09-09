<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
const cameraId = defineModel<string>({ default: '' })
const { t } = useI18n()
const cameras = ref<MediaDeviceInfo[]>([]), error = ref('')
async function list() {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) throw new Error()
    cameras.value = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput')
    error.value = cameras.value.length ? '' : t('trpg.noCameras')
  } catch { error.value = t('trpg.cameraUnavailable') }
}
</script>
<template>
  <details class="utility-section dice-controls">
    <summary><span>⚄ {{ t('trpg.dice') }}</span><small>{{ t('trpg.comingSoon') }}</small></summary>
    <p class="muted">{{ t('trpg.diceHint') }}</p>
    <div class="actions"><button type="button" @click="list">{{ t('trpg.listCameras') }}</button>
      <label>{{ t('trpg.camera') }}<select v-model="cameraId" :aria-label="t('trpg.camera')"><option value="">{{ t('trpg.defaultCamera') }}</option><option v-for="(camera, i) in cameras" :key="camera.deviceId || i" :value="camera.deviceId">{{ camera.label || `${t('trpg.camera')} ${i + 1}` }}</option></select></label>
    </div>
    <p v-if="error" role="status">{{ error }}</p>
    <button type="button" disabled>{{ t('trpg.detectDice') }}</button>
  </details>
</template>
