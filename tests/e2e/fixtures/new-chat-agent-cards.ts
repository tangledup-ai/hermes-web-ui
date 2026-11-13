import { createApp, defineComponent, h, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import NewChatAgentCards from '../../../packages/client/src/components/hermes/chat/NewChatAgentCards.vue'

const options = ['Hermes', 'Ekko', 'Codex', 'Claude', 'Pi', 'Grok'].map(label => ({ value: label.toLowerCase(), label }))
createApp(defineComponent({
  setup() {
    const value = ref('hermes')
    return () => h('main', { style: { height: '330px', width: '100%' } }, [
      h(NewChatAgentCards, { value: value.value, options, 'onUpdate:value': (next: string) => { value.value = next } }),
    ])
  },
})).use(createI18n({ legacy: false, locale: 'en', messages: { en: { chat: { agent: 'Agent' } } } })).mount('#app')
