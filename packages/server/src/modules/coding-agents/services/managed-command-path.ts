import { delimiter, join } from 'node:path'

/** Studio-managed CLIs must survive Node runtime replacement and be writable
 * by the service user. Do not inherit a system/global prefix from npm config. */
export function codingAgentNpmEnvironment(env: NodeJS.ProcessEnv, webUiHome: string): NodeJS.ProcessEnv {
  const managed = { ...env }
  for (const key of Object.keys(managed)) if (key.toLowerCase() === 'npm_config_prefix') delete managed[key]
  managed.npm_config_prefix = join(webUiHome, 'coding-agents', 'npm')
  return managed
}

/** npm install -g writes to this prefix. Promote it even when it already
 * exists later in PATH; otherwise an older system CLI shadows the update. */
export function prioritizeManagedNpmBin(env: NodeJS.ProcessEnv, npmBin: string | null): void {
  if (!npmBin) return
  const key = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'
  const entries = (env[key] || '').split(delimiter).filter(Boolean)
  const identity = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  env[key] = [npmBin, ...entries.filter(entry => identity(entry) !== identity(npmBin))].join(delimiter)
}
