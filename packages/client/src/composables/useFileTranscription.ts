import { onUnmounted, ref } from 'vue'
import {
  MeetingASRHttpError,
  meetingASRApi,
  type FileTranscriptionJob,
  type FileTranscriptionOptions,
  type FileTranscriptionResult,
} from '@/utils/meeting-asr-api'

export interface UseFileTranscriptionDeps {
  /**
   * Called once the backend job reaches `done`. The caller merges the
   * sentences into the active meeting (replace when the transcript is empty,
   * otherwise timestamp-match and fill speaker labels).
   */
  onComplete: (result: FileTranscriptionResult, options: FileTranscriptionOptions) => void | Promise<void>
  /**
   * Called on every failure. `status` is the HTTP status when the failure came
   * from the API (503 = service restarting, 502 = backend unreachable, 404 =
   * the in-memory job was lost), so callers can show a targeted message.
   */
  onError?: (message: string, status?: number) => void
}

const POLL_INTERVAL_MS = 1500
/** Hard ceiling so a stuck job cannot poll forever. */
const MAX_POLL_MS = 60 * 60 * 1000
/**
 * How long to keep polling through 502/503 before giving up. The Python
 * backend can be restarted underneath us (health monitor, code-hash reload);
 * riding that window out lets us report the real outcome instead of a bare
 * "502" while the service is still coming back.
 */
const TRANSIENT_GRACE_MS = 90 * 1000

/**
 * Whole-file transcription driver shared by the two entry points:
 *  - 「拆分人声」 on a finished recording (re-diarize the whole audio), and
 *  - the 「直接音频转录」 tab of the create-meeting dialog.
 *
 * Uploads the audio once, then polls the backend job until it settles.
 * Progress is reported as a 0–1 fraction so both call sites can render a
 * single progress bar.
 */
export function useFileTranscription(deps: UseFileTranscriptionDeps) {
  const isTranscribing = ref(false)
  const progress = ref(0)
  const phase = ref('')
  const errorMessage = ref('')

  let cancelled = false

  function stop() {
    cancelled = true
    isTranscribing.value = false
    phase.value = ''
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function pollUntilDone(jobId: string, profile?: string): Promise<FileTranscriptionJob> {
    const deadline = Date.now() + MAX_POLL_MS
    let transientSince: number | null = null

    for (;;) {
      if (cancelled) throw new Error('cancelled')

      let job: FileTranscriptionJob
      try {
        job = await meetingASRApi.getFileTranscriptionStatus(jobId, profile)
        transientSince = null
      } catch (err) {
        const status = err instanceof MeetingASRHttpError ? err.status : 0
        // 404: the job registry lives in the Python process, so a restart
        // wipes it — retrying cannot recover, report it precisely.
        if (status === 404) {
          throw new MeetingASRHttpError(
            'transcribe job lost: the ASR service restarted while transcribing',
            404,
          )
        }
        const transient = status === 502 || status === 503 || status === 0
        if (!transient) throw err
        transientSince ??= Date.now()
        if (Date.now() - transientSince > TRANSIENT_GRACE_MS) throw err
        phase.value = 'waiting_backend'
        await sleep(POLL_INTERVAL_MS)
        continue
      }

      progress.value = Math.max(progress.value, Math.min(0.98, job.progress || 0))
      phase.value = job.message || job.status
      if (job.status === 'done') return job
      if (job.status === 'error') throw new Error(job.error || 'transcription failed')
      if (Date.now() > deadline) throw new Error('transcription timed out')
      await sleep(POLL_INTERVAL_MS)
    }
  }

  async function transcribe(file: Blob, options: FileTranscriptionOptions): Promise<boolean> {
    if (isTranscribing.value) return false
    cancelled = false
    isTranscribing.value = true
    progress.value = 0
    phase.value = 'uploading'
    errorMessage.value = ''

    try {
      const started = await meetingASRApi.startFileTranscription(file, options)
      phase.value = 'transcribing'
      const job = await pollUntilDone(started.job_id, options.profile)
      if (cancelled) return false
      if (!job.result) throw new Error('transcription returned no result')
      progress.value = 1
      await deps.onComplete(job.result, options)
      return true
    } catch (err: any) {
      if (err?.message === 'cancelled') return false
      const status = err instanceof MeetingASRHttpError ? err.status : undefined
      const message = err?.message || String(err) || 'transcription failed'
      errorMessage.value = message
      deps.onError?.(message, status)
      return false
    } finally {
      isTranscribing.value = false
      phase.value = ''
    }
  }

  onUnmounted(() => {
    cancelled = true
  })

  return { isTranscribing, progress, phase, errorMessage, transcribe, stop }
}
