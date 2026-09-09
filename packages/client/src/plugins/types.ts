import type { App, Component } from 'vue'
import type { Router, RouteRecordRaw } from 'vue-router'
import type { I18n } from 'vue-i18n'

/**
 * 客户端插件接口。
 *
 * 设计目标：
 *   1. **解耦**：插件代码全部在自己文件夹下，Web UI 核心代码不直接 import
 *      插件的具体实现，只通过本接口通信。
 *   2. **可热插拔**：插件被加入 / 移除 = 修改 `packages/client/src/plugins/registry.ts`
 *      一行；其它代码不动。删除插件文件夹即彻底卸载。
 *   3. **运行时可启停**：每个插件有独立 enable 状态（localStorage 持久化），
 *      未启用的插件不会注册路由、侧边栏或 i18n 文案。
 *   4. **依赖注入**：插件 install() 收到的 ctx 提供 router/i18n 等核心
 *      能力，避免插件再去 import 内部模块导致硬编码耦合。
 */

export type SupportedLocale =
  | 'ar' | 'de' | 'en' | 'es' | 'fr' | 'ja' | 'ko'
  | 'pt' | 'ru' | 'zh' | 'zh-TW'

export interface PluginSidebarItem {
  /** 路由 name，与插件注册 addRoute() 的 name 对应。 */
  routeName: string
  /** 侧边栏分组：Agent / Monitoring / Tools / System。 */
  group: 'Agent' | 'Monitoring' | 'Tools' | 'System'
  /** i18n key，例如 'plugins.scanner.sidebarLabel'。 */
  labelKey: string
  /** 是否要求超级管理员。 */
  requiresSuperAdmin?: boolean
  /** 内联 SVG path d="..."；不需要图标可省略。 */
  iconPath?: string
}

export interface MeetingPanelContribution {
  preferredWidth?: string
  id: string
  labelKey: string
  component: Component
}

/**
 * 插件贡献的会议场景模板（出现在创建会议 picker 里）。
 *
 * 与 `MeetingPanelContribution` 的区别：场景模板只在「创建会议」对话框里
 * 让用户选择一次；会议开启后场景本身由后端 sceneTemplate 字符串识别，
 * 插件的运行时 UI（角色卡、高光面板等）仍走 `addMeetingPanel()`。
 *
 * `id` 唯一且不能与内置 6 个 SceneId 重名；服务端对未知 id 走通用 prompt 回退，
 * 无需在 server scene-templates 注册。
 */
export interface SceneTemplateContribution {
  id: string
  /** 卡片标题 i18n key；插件需同时通过 addI18nMessages 注册。 */
  labelKey: string
  /** 卡片副标题 i18n key；插件需同时通过 addI18nMessages 注册。 */
  descriptionKey: string
  /** 内联 SVG 子内容（path/polygon/line 等；不含外层 <svg> 标签），与现有 24×24 风格一致。 */
  iconSvg: string
}

export interface PluginContext {
  addMeetingPanel(panel: MeetingPanelContribution): void
  /**
   * 贡献一个会议场景模板；出现在创建会议对话框的 SceneTemplatePicker。
   * 重复 id 静默忽略；install 期间调用一次。
   */
  addSceneTemplate(scene: SceneTemplateContribution): void
  /** Vue app 实例，插件可注册全局组件 / directive。 */
  app: App
  /** Vue Router 实例，插件 addRoute() 走它。 */
  router: Router
  /** vue-i18n 实例，插件 addI18nMessages() 走它。 */
  i18n: I18n
  /** 添加一个侧边栏条目；插件 install 期间调用。 */
  addSidebarItem(item: PluginSidebarItem): void
  /** 注册一条 Vue Router 路由；插件 install 期间调用。 */
  addRoute(route: RouteRecordRaw): void
  /** 合并指定 locale 的 i18n 文案到全局 i18n。 */
  addI18nMessages(locale: SupportedLocale, messages: Record<string, unknown>): void
}

export interface HermesClientPlugin {
  /** 唯一 id（kebab-case），用于 localStorage 启停与日志。 */
  id: string
  /** 展示名，i18n key 或字面量。 */
  name: string
  /** 插件版本（semver）。 */
  version: string
  /** 简短描述，i18n key。 */
  description: string
  /** 插件作者（可选）。 */
  author?: string
  dependencies?: string[]
  /** install 入口；只有当插件被启用时才会被调用。 */
  install(ctx: PluginContext): void | Promise<void>
  /** 可选：用户主动禁用时调用，用于清理全局副作用（默认 noop）。 */
  uninstall?(ctx: PluginContext): void
}

/** 已注册插件清单（编译期）。 */
export interface PluginRegistration {
  plugin: HermesClientPlugin
  /** 是否默认启用；用户可在运行期切换。 */
  enabledByDefault: boolean
}

/**
 * 插件启用状态持久化 key（localStorage）。
 * 存储格式：JSON object { [pluginId]: boolean }
 */
export const PLUGIN_STATE_STORAGE_KEY = 'hermes.plugins.enabled'

export function readPluginEnabledMap(): Record<string, boolean> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(PLUGIN_STATE_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>
    }
  } catch {
    /* ignore corrupt storage */
  }
  return {}
}

export function writePluginEnabledMap(map: Record<string, boolean>): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(PLUGIN_STATE_STORAGE_KEY, JSON.stringify(map))
}

export function isPluginEnabled(pluginId: string, enabledByDefault: boolean): boolean {
  const map = readPluginEnabledMap()
  if (Object.prototype.hasOwnProperty.call(map, pluginId)) {
    return map[pluginId] !== false
  }
  return enabledByDefault
}
