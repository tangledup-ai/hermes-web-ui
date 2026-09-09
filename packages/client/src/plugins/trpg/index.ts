import { defineAsyncComponent } from 'vue'
import type { HermesClientPlugin, SupportedLocale } from '../types'
import { messages } from './messages'

// 20 面骰（D20）轮廓：外接五边形 + 内五边形 + 5 条径线；
// 与 SceneTemplatePicker 现有 24×24 stroke-currentColor 风格一致。
const TRPG_SCENE_ICON_SVG = `
  <polygon points="12,2 22,9 18.5,20 5.5,20 2,9"/>
  <polygon points="12,2 2,9 12,13 22,9"/>
  <line x1="5.5" y1="20" x2="12" y2="13"/>
  <line x1="18.5" y1="20" x2="12" y2="13"/>`

const plugin: HermesClientPlugin = {
  id: 'trpg', name: 'TRPG / 跑团模式', version: '0.1.1',
  description: 'Meeting character cards and ASR highlight image prompts.',
  install(ctx) {
    for (const [locale, text] of Object.entries(messages)) ctx.addI18nMessages(locale as SupportedLocale, { trpg: text })
    ctx.addMeetingPanel({ id: 'trpg', preferredWidth: 'min(680px, 60vw)', labelKey: 'trpg.title', component: defineAsyncComponent(() => import('./TrpgPanel.vue')) })
    ctx.addSceneTemplate({
      id: 'trpg',
      labelKey: 'trpg.sceneLabel',
      descriptionKey: 'trpg.sceneDesc',
      iconSvg: TRPG_SCENE_ICON_SVG,
    })
  },
}
export default plugin
