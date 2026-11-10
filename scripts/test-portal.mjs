import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
const testBuild = join(root, 'node_modules/.cache/portal-test')
const output = join(testBuild, 'main/index.cjs')
// Match the app's main/../preload layout so toolbar clicks exercise its real bridge.
await Promise.all([
  ['tests/portal.entry.ts', output],
  ['src/preload/portalBar.ts', join(testBuild, 'preload/portalBar.js')]
].map(([entry, outfile]) => build({
  entryPoints: [join(root, entry)],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile
})))
// The production bootstrap relaunches once if these native startup inputs are absent.
const env = { ...process.env, TZ: 'America/New_York' }
delete env.ELECTRON_RUN_AS_NODE
const args = [join(root, 'tests/portal.electron.cjs'), output]
if (process.platform === 'darwin') args.push('-AppleLanguages', '(en-US,en)')
const result = spawnSync(require('electron'), args, {
  cwd: root, env, stdio: 'inherit', timeout: 120000
})
if (result.error) console.error(result.error)
process.exit(result.status ?? 1)
