import type { Context } from 'koa'
import * as service from '../services/trpg/recap'
import { getActiveProfileName } from '../services/hermes/hermes-profile'
import { userCanAccessProfile } from '../db/hermes/users-store'
function profile(ctx: Context) {
  const name = ctx.state.profile?.name || ctx.get('x-hermes-profile') || getActiveProfileName() || 'default'
  if (ctx.state.user && ctx.state.user.role !== 'super_admin' && !ctx.state.serverTokenAuth && !userCanAccessProfile(ctx.state.user.id, name)) ctx.throw(403, 'profile_forbidden')
  return name
}
async function handle(ctx: Context, fn: (profile: string) => Promise<unknown>) {
  try { ctx.body = await fn(profile(ctx)) }
  catch (e) { const err = e as { status?: number; code?: string }; ctx.status = err.status || (err.code === 'ENOENT' ? 404 : 500); ctx.body = { code: ctx.status === 400 ? 'invalid_recap' : ctx.status === 403 ? 'profile_forbidden' : 'recap_failed' } }
}
export const prepare = (ctx: Context) => handle(ctx, p => service.prepareRecap(ctx.request.body, p))
export const list = (ctx: Context) => handle(ctx, async p => ({ recaps: await service.listRecaps(ctx.params.meetingId, p) }))
export const save = (ctx: Context) => handle(ctx, p => service.saveRecap(ctx.params.meetingId, ctx.request.body, p))
export const remove = (ctx: Context) => handle(ctx, async p => { await service.deleteRecap(ctx.params.meetingId, ctx.params.recapId, p); return { ok: true } })
export const transcript = (ctx: Context) => handle(ctx, p => service.recapTranscript(ctx.params.meetingId, String(ctx.query.requestId || ''), p, Number(ctx.query.cursor || 0)))
