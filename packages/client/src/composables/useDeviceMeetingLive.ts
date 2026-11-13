import { onMounted, onUnmounted, ref, shallowRef, watch, type Ref } from 'vue'
import { io, type Socket } from 'socket.io-client'
import { getApiKey, getBaseUrl } from '@/api/client'
import { onAuthInvalidated } from '@/api/auth-invalidation'
import { socketEndpoint } from '@/utils/deployment-url'
import type { MeetingLiveSession, MeetingLiveEvent } from '../../../shared/meeting-live'

const MAX_LIVE_SENTENCES = 120

export function useDeviceMeetingLive(profile: Ref<string>) {
  const sessions = shallowRef<MeetingLiveSession[]>([])
  const connection = ref<'connecting' | 'ready' | 'unavailable'>('connecting')
  let socket: Socket | undefined
  let unsubscribe = () => {}

  function reconnect() {
    socket?.disconnect()
    sessions.value = []
    connection.value = 'connecting'
    const token = getApiKey()
    if (!token) {
      connection.value = 'unavailable'
      return
    }

    const endpoint = socketEndpoint(getBaseUrl(), '/meeting-live')
    const client = io(endpoint.url, {
      path: endpoint.path,
      auth: { token, profile: profile.value },
      transports: ['websocket', 'polling'],
    })
    socket = client
    client.on('connect_error', () => { connection.value = 'unavailable' })
    client.on('disconnect', () => { connection.value = 'unavailable' })
    client.on('sessions', (items: MeetingLiveSession[]) => {
      sessions.value = items
      connection.value = 'ready'
    })
    client.on('session', (update: MeetingLiveEvent) => {
      if (update.type === 'upsert') {
        sessions.value = [update.session, ...sessions.value.filter(item => item.id !== update.session.id)]
      } else if (update.type === 'remove') {
        sessions.value = sessions.value.filter(item => item.id !== update.id)
      } else {
        sessions.value = sessions.value.map(item => {
          if (item.id !== update.id) return item
          if (update.type === 'partial') return { ...item, partial: update.text }
          return { ...item, partial: '', sentences: [...item.sentences, update.sentence].slice(-MAX_LIVE_SENTENCES) }
        })
      }
    })
  }

  onMounted(() => {
    reconnect()
    unsubscribe = onAuthInvalidated(reconnect)
  })
  watch(profile, reconnect)
  onUnmounted(() => {
    unsubscribe()
    socket?.disconnect()
  })

  return { sessions, connection, reconnect }
}
