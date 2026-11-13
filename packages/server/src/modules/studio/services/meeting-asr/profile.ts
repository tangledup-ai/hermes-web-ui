import type { Context } from 'koa'
import type { AuthenticatedUser } from '../../public/auth'
import { getDefaultProfileForUser, getUserActiveProfile } from '../../public/users'

export class MeetingProfileError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export function resolveMeetingProfile(user?: AuthenticatedUser, requested?: string): string {
  const explicit = requested?.trim() || ''
  const active = !explicit && user ? getUserActiveProfile(user.id) : null
  const allowed = user?.profiles ?? []
  const profile = explicit || (active && (user?.role === 'super_admin' || allowed.includes(active)) ? active : '')
  if (profile.length > 128 || profile === '.' || profile === '..' || /[\\/\x00-\x1f\x7f]/.test(profile)) {
    throw new MeetingProfileError('Invalid profile', 400)
  }
  if (!user || user.role === 'super_admin') return profile || 'default'

  if (profile && allowed.includes(profile)) return profile
  if (!profile) {
    if (allowed.length === 1) return allowed[0]
    const fallback = getDefaultProfileForUser(user.id)
    if (allowed.includes(fallback)) return fallback
  }
  throw new MeetingProfileError('Profile is not available for this user', 403)
}

export function resolveMeetingRequestProfile(ctx: Context): string {
  const query = typeof ctx.query?.profile === 'string' ? ctx.query.profile : undefined
  return resolveMeetingProfile(ctx.state?.user, ctx.state?.profile?.name || ctx.get?.('x-hermes-profile') || query)
}
