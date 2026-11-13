import { getDb } from '../infrastructure/database'
import { MEETING_TRANSCRIPTION_SETTINGS_TABLE } from '../infrastructure/database/schemas'

export type StoredMeetingTranscriptionSettings = Record<string, string>

export function getMeetingTranscriptionSettings(profile: string): { settings: StoredMeetingTranscriptionSettings; saved: boolean } | null {
  const row = getDb()?.prepare(
    `SELECT config_json, panel_saved FROM ${MEETING_TRANSCRIPTION_SETTINGS_TABLE} WHERE profile = ?`,
  ).get(profile) as { config_json: string; panel_saved: number } | undefined
  if (!row) return null
  return { settings: JSON.parse(row.config_json) as StoredMeetingTranscriptionSettings, saved: row.panel_saved === 1 }
}

export function saveMeetingTranscriptionSettings(
  profile: string,
  patch: StoredMeetingTranscriptionSettings,
  source: 'legacy' | 'migration' | 'panel',
): void {
  const db = getDb()
  if (!db) throw new Error('Meeting transcription settings storage is unavailable')
  const settings = JSON.stringify(patch)
  // SQLite's patch operation merges partial updates atomically and retains
  // empty strings so explicitly removed secrets cannot fall back to old ones.
  const table = MEETING_TRANSCRIPTION_SETTINGS_TABLE
  const preserveExisting = source === 'migration'
  const config = preserveExisting ? 'json_patch(excluded.config_json, config_json)' : 'json_patch(config_json, excluded.config_json)'
  db.prepare(`INSERT INTO ${table} (profile, config_json, panel_saved) VALUES (?, ?, ?)
    ON CONFLICT(profile) DO UPDATE SET config_json = ${config}, panel_saved = excluded.panel_saved
    WHERE ? = 1 OR ${table}.panel_saved = 0`).run(profile, settings, source === 'legacy' ? 0 : 1, source === 'panel' ? 1 : 0)
}
