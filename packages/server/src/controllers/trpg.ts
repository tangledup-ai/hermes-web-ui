import type { Context } from 'koa'
import { generateHighlight, parseInput } from '../services/trpg/highlight'
import { getActiveProfileName } from '../services/hermes/hermes-profile'

function resolveDraftProfile(ctx: Context): string {
  const headerProfile = (ctx.request.headers['x-hermes-profile'] as string | undefined)?.trim() || ''
  const stateProfile = (ctx.state.profile?.name as string | undefined)?.trim() || ''
  return stateProfile || headerProfile || getActiveProfileName() || 'default'
}

export async function highlight(ctx: Context) {
  let input
  try { input = parseInput(ctx.request.body) }
  catch { ctx.status = 400; ctx.body = { code: 'invalid_input' }; return }
  try { ctx.body = await generateHighlight(input) }
  catch (error) {
    const known = ['llm_not_configured', 'no_highlight', 'invalid_output']
    const code = error instanceof Error && known.includes(error.message) ? error.message : 'generation_failed'
    ctx.status = code === 'no_highlight' ? 422 : code === 'llm_not_configured' ? 503 : 502
    ctx.body = { code }
  }
}

export async function characterDraft(ctx: Context) {
  const { parseDraftInput, draftCharacter } = await import('../services/trpg/character-draft')
  let input
  try { input = parseDraftInput(ctx.request.body) }
  catch { ctx.status = 400; ctx.body = { code: 'invalid_input' }; return }
  const profile = resolveDraftProfile(ctx)
  try {
    const result = await draftCharacter(input, profile)
    ctx.body = { draft: result.draft, trace: result.trace }
  }
  catch (error) {
    const known = ['llm_not_configured', 'agent_unreachable', 'invalid_output', 'image_format_unsupported']
    const msg = error instanceof Error ? error.message : String(error)
    const code = known.includes(msg) ? msg : 'generation_failed'
    if (code === 'image_format_unsupported') ctx.status = 400
    else if (code === 'llm_not_configured' || code === 'agent_unreachable') ctx.status = 503
    else ctx.status = 502
    const raw = (error as { raw?: string }).raw
    const upstreamStatus = (error as { upstreamStatus?: number }).upstreamStatus
    const body: Record<string, unknown> = { code, message: msg }
    if (raw) body.raw = raw
    if (upstreamStatus) body.upstreamStatus = upstreamStatus
    ctx.body = body
    // eslint-disable-next-line no-console
    console.error(`[trpg.characterDraft] profile=${profile} code=${code} status=${ctx.status} message=${msg}${raw ? `\n--- raw response ---\n${raw}\n--- end raw ---` : ''}`)
  }
}