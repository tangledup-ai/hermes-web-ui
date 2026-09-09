<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { meetingPanels } from '@/plugins/registry'
import { useMeetingStore } from '@/stores/hermes/meeting'
const meetingStore = useMeetingStore()

/**
 * 场景 → 插件自动绑定：当活跃会议的 sceneTemplate 等于某个已注册插件的 id 时，
 * 右栏直接渲染该插件面板（例如 scene='trpg' + 插件已启用 → 直接显示跑团面板，
 * 不再经过下拉框选择）。其他场景统一走 standard analysis / agent / realtime 分发。
 * 插件被运行时禁用（localStorage 关掉）时不入选 meetingPanels，自动回退到
 * 通用分发；面板不提供手动切换入口。
 */
const pluginPanel = computed(() => {
  const sceneTemplate = meetingStore.activeSession?.sceneTemplate
  return sceneTemplate ? meetingPanels.find(p => p.id === sceneTemplate) : undefined
})

/**
 * Right panel shell for the meeting view. Owns the outer chrome (aside,
 * resize handle, header with title + close button, scrollable inner area)
 * and exposes four mutually-exclusive slots for the content modes:
 *
 *   #analysis  - rendered when !showAgentPanel && !isSpeechScene && !showRealtimeDialog
 *   #agent     - rendered when showAgentPanel (Agent realtime assist)
 *   #realtime  - rendered when showRealtimeDialog (Omni Realtime dialog)
 *   #speech    - rendered when isSpeechScene (SpeechEvaluationPanel)
 *
 * The toolbar above the content (analysis trigger / report buttons /
 * agent toggle) is exposed as its own slot so MeetingView keeps all the
 * Naive UI tooltip/loading wiring in one place. Resize handle is bound
 * here because it logically lives on the aside element itself; parent
 * passes a `resizeStyle` + pointerdown handler through props.
 *
 * Modes are derived in the parent and passed as booleans, not computed
 * here, so the dispatch order (speech > agent > realtime > analysis) stays
 * explicit and matches the original template.
 */

const props = withDefaults(defineProps<{
  visible: boolean
  isSpeechScene: boolean
  isLegalScene?: boolean
  isInterviewScene?: boolean
  showAgentPanel: boolean
  showRealtimeDialog?: boolean
  resizeStyle?: Record<string, string>
}>(), {
  showRealtimeDialog: false,
  resizeStyle: () => ({}),
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'resize-start', event: PointerEvent): void
}>()

const { t } = useI18n()

const panelTitle = computed(() => {
  if (props.isSpeechScene) return t('meeting.scene.speech')
  if (props.isLegalScene) return t('meeting.scene.legal')
  if (props.isInterviewScene) return t('meeting.scene.interview')
  if (props.showAgentPanel) return t('meeting.agentChat')
  if (props.showRealtimeDialog) return t('meeting.realtime.title')
  return t('meeting.analysis')
})
</script>

<template>
  <aside
    v-if="props.visible"
    class="right-panel"
    :style="pluginPanel?.preferredWidth ? { ...props.resizeStyle, width: pluginPanel.preferredWidth } : props.resizeStyle"
  >
    <div
      class="right-panel-resize-handle"
      @pointerdown="emit('resize-start', $event)"
    />
    <div class="right-panel-inner">
      <div class="right-panel-header">
        <h2>{{ pluginPanel ? t(pluginPanel.labelKey) : panelTitle }}</h2>
        <div class="right-panel-actions">
          <!-- 关闭按钮：始终位于最右，确保不被遮挡 -->
          <button
            class="panel-close-btn"
            :title="t('sidebar.collapse')"
            @click="emit('close')"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- 分析工具栏：仅在 analysis 模式下显示（parent passes the wired buttons） -->
      <div v-if="!pluginPanel && !props.showAgentPanel && !props.isSpeechScene && !props.showRealtimeDialog" class="right-panel-toolbar">
        <slot name="toolbar" />
      </div>

      <!-- 四类内容分发：speech > agent > realtime > analysis -->
      <component v-if="pluginPanel && meetingStore.activeSession" :is="pluginPanel.component"
        :key="pluginPanel.id + meetingStore.activeSession.id" :session-id="meetingStore.activeSession.id"
        :sentences="meetingStore.activeSession.sentences" />
      <template v-else-if="props.isSpeechScene">
        <slot name="speech" />
      </template>
      <template v-else-if="props.isLegalScene">
        <slot name="legal" />
      </template>
      <template v-else-if="props.isInterviewScene">
        <slot name="interview" />
      </template>
      <template v-else-if="props.showAgentPanel">
        <slot name="agent" />
      </template>
      <template v-else-if="props.showRealtimeDialog">
        <slot name="realtime" />
      </template>
      <template v-else>
        <slot name="analysis" />
      </template>
    </div>
  </aside>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.right-panel {
  position: relative;
  flex: 0 0 auto;
  min-width: 280px;
  max-width: 100%;
  background: $bg-card;
  border-left: 1px solid $border-color;
  display: flex;
  align-self: stretch;
  min-height: 0;
  overflow: hidden;
}

.right-panel-resize-handle {
  position: absolute;
  left: -7px;
  top: 0;
  bottom: 0;
  width: 14px;
  cursor: col-resize;
  z-index: 20;

  &::after {
    content: "";
    position: absolute;
    left: 6px;
    top: 0;
    bottom: 0;
    width: 1px;
    background:
      linear-gradient($border-color, $border-color) top / 1px calc(50% - 26px) no-repeat,
      linear-gradient($border-color, $border-color) bottom / 1px calc(50% - 26px) no-repeat;
    transition: background $transition-fast;
    z-index: 1;
  }

  &::before {
    content: "";
    position: absolute;
    left: 1px;
    top: 50%;
    width: 12px;
    height: 38px;
    transform: translateY(-50%);
    border-radius: 6px;
    background:
      linear-gradient($text-muted, $text-muted) center 12px / 6px 1px no-repeat,
      linear-gradient($text-muted, $text-muted) center 19px / 6px 1px no-repeat,
      linear-gradient($text-muted, $text-muted) center 26px / 6px 1px no-repeat,
      $bg-card;
    border: 1px solid $border-color;
    opacity: 0.9;
    transition: all $transition-fast;
    z-index: 2;
  }

  &:hover::after {
    background:
      linear-gradient(var(--accent-primary), var(--accent-primary)) top / 1px calc(50% - 26px) no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) bottom / 1px calc(50% - 26px) no-repeat;
  }

  &:hover::before {
    background:
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 12px / 6px 1px no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 19px / 6px 1px no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 26px / 6px 1px no-repeat,
      $bg-card;
    border-color: var(--accent-primary);
    opacity: 1;
  }
}

.right-panel-inner {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.right-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
  gap: 8px;

  h2 {
    font-size: 14px;
    font-weight: 600;
    margin: 0;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.right-panel-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

// 分析工具栏（独立一行，承载触发/启动/配置 + Agent 切换）
.right-panel-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid $border-color;
  background: rgba($accent-primary, 0.02);
  flex-shrink: 0;
  min-width: 0;
}

.panel-close-btn {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;

  &:hover {
    background: rgba(239, 68, 68, 0.1);
    color: #ef4444;
  }
}

/* 工具栏槽位内部按钮在窄面板中优雅收缩（扁平选择器，避免 SCSS 在 :deep 块中展开嵌套失败） */
:deep(.toolbar-actions) {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

:deep(.toolbar-actions::-webkit-scrollbar) {
  display: none;
}

:deep(.toolbar-actions .n-button) {
  flex-shrink: 0;
}

/* 分析内容槽：让父组件传入的 .right-panel-content 仍然能撑满滚动区 */
:deep(.right-panel-content) {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

:deep(.right-panel-empty) {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: $text-secondary;
  padding: 40px;
}
</style>