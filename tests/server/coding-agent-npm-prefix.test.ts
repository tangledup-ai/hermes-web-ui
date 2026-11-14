import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { codingAgentNpmEnvironment, prioritizeManagedNpmBin } from '../../packages/server/src/modules/coding-agents/services/managed-command-path'

const exec = promisify(execFile)

it('installs, discovers, and removes a CLI without writing to the Node runtime prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coding-agent-npm-'))
  try {
    const source = join(root, 'fixture')
    await mkdir(source)
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'studio-install-probe', version: '1.0.0', bin: { 'studio-install-probe': 'cli.js' } }))
    await writeFile(join(source, 'cli.js'), '#!/usr/bin/env node\nconsole.log("1.0.0")\n')
    await chmod(join(source, 'cli.js'), 0o755)
    const home = join(root, 'state')
    const env = codingAgentNpmEnvironment({ ...process.env, NPM_CONFIG_PREFIX: join(root, 'system-node') }, home)
    const prefix = join(home, 'coding-agents', 'npm')
    expect((await exec('npm', ['prefix', '-g'], { env })).stdout.trim()).toBe(prefix)
    await exec('npm', ['install', '-g', source, '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { env })
    prioritizeManagedNpmBin(env, process.platform === 'win32' ? prefix : join(prefix, 'bin'))
    expect(env.PATH?.split(delimiter)[0]).toBe(process.platform === 'win32' ? prefix : join(prefix, 'bin'))
    if (process.platform !== 'win32') expect((await exec('studio-install-probe', [], { env })).stdout.trim()).toBe('1.0.0')
    await exec('npm', ['uninstall', '-g', 'studio-install-probe', '--offline', '--no-audit', '--no-fund'], { env })
    expect((await exec('npm', ['ls', '-g', '--json'], { env })).stdout).not.toContain('studio-install-probe')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)
