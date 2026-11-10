import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(require('electron'), [join(root, 'tests/add-account.electron.cjs'), join(root, 'out/main/index.js')], {
  cwd: root, env, stdio: 'inherit', timeout: 120000
})
if (result.error) console.error(result.error)
process.exit(result.status ?? 1)
