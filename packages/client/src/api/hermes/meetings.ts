import { request } from '../client'
import type { RecapEntry, RecapOptions } from '../../../../shared/trpg-recap'
const path = (id: string) => `/api/meeting-storage/${encodeURIComponent(id)}/recaps`
export const listRecaps = (id: string) => request<{ recaps: RecapEntry[] }>(path(id))
export const deleteRecap = (id: string, recapId: string) => request(`${path(id)}/${encodeURIComponent(recapId)}`, { method: 'DELETE' })
export const prepareRecap = (input: RecapOptions & { meetingId: string; sentences: { text: string; speaker?: string }[] }) => request<{ requestId: string }>('/api/plugins/trpg/recap', { method: 'POST', body: JSON.stringify(input) })
