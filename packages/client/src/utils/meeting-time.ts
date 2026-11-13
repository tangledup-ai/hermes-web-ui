export function formatMeetingOffset(offsetMs: number): string {
  const seconds = Math.floor(offsetMs / 1000)
  const minutes = Math.floor(seconds / 60)
  const fields = minutes >= 60 ? [Math.floor(minutes / 60), minutes % 60, seconds % 60] : [minutes, seconds % 60]
  return fields.map(value => String(value).padStart(2, '0')).join(':')
}
