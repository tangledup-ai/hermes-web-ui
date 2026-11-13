import { getDb } from '../infrastructure/database'
import { MEETING_DEVICE_CONSENT_TABLE } from '../infrastructure/database/schemas'

export function getDeviceConsentRow(userId: number, profile: string, provider: string): boolean {
  return Boolean(getDb()?.prepare(`
    SELECT 1 FROM ${MEETING_DEVICE_CONSENT_TABLE} WHERE user_id = ? AND profile = ? AND provider = ?
  `).get(userId, profile, provider))
}

export function writeDeviceConsentRow(userId: number, profile: string, provider: string, granted: boolean): void {
  const db = getDb()
  if (!db) throw new Error('Meeting device consent storage is unavailable')
  const sql = granted
    ? `INSERT OR IGNORE INTO ${MEETING_DEVICE_CONSENT_TABLE} (user_id, profile, provider) VALUES (?, ?, ?)`
    : `DELETE FROM ${MEETING_DEVICE_CONSENT_TABLE} WHERE user_id = ? AND profile = ? AND provider = ?`
  db.prepare(sql).run(userId, profile, provider)
}
