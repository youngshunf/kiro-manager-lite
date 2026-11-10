import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import net from 'node:net'

if (process.platform !== 'darwin') {
  console.error('Native portal startup isolation is currently verified only on macOS')
  process.exit(1)
}
const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const readEnvironment = `({zone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.DateTimeFormat().resolvedOptions().locale,language:navigator.language,languages:[...navigator.languages],winterOffset:new Date('2026-01-15T12:00:00Z').getTimezoneOffset(),summerOffset:new Date('2026-07-15T12:00:00Z').getTimezoneOffset()})`
const expectedEnvironment = {
  zone: 'America/New_York', locale: 'en-US', language: 'en-US',
  languages: ['en-US', 'en'], winterOffset: 300, summerOffset: 240
}

async function testStartup(nativeArguments, takeScreenshots = false, expectFailure = false) {
  const data = await mkdtemp(join(tmpdir(), 'kiro-portal-startup-'))
  const sockets = new Set(), connections = [], arrivals = []
  // The proxy is the fixture responder, not a forwarder. No real account or registration traffic.
  const proxy = http.createServer((req, res) => {
    arrivals.push({ url: req.url, language: req.headers['accept-language'] })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(`<!doctype html><meta charset="utf-8"><title>Local privacy fixture</title><script>window.firstEnvironment=${readEnvironment}</script><h1>本地隐私环境测试</h1><p>仅本地页面，不连接外网。</p><pre id="environment"></pre><script>document.getElementById('environment').textContent=JSON.stringify(firstEnvironment,null,2)</script>`)
  })
  proxy.on('connect', (_req, socket) => socket.end('HTTP/1.1 502 No External Forwarding\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'))
  proxy.on('connection', socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  const env = { ...process.env, TZ: 'Etc/UTC' }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'KIRO_PORTAL_ENV_RESTART']) delete env[key]
  if (expectFailure) {
    env.KIRO_PORTAL_ENV_RESTART = '1'
    env.KIRO_STARTUP_EXPECT_FAILURE = '1'
  }
  const args = [
    join(root, 'tests/portal-startup.electron.cjs'), join(root, 'out/main/index.js'),
    `--user-data-dir=${data}`, `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1', '--privacy-probe=preserved', ...nativeArguments
  ]
  const child = spawn(require('electron'), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostic = '', browserPid
  child.stdout.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-10000) })
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-10000) })
  const parentExit = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', error => resolve({ error: error.message }))
  })
  async function until(action, label) {
    for (let i = 0; i < 250; i++) {
      const result = await action()
      if (result) return result
      await pause(80)
    }
    throw Error(`Timeout: ${label}; app diagnostics: ${diagnostic}`)
  }
  async function get(path) {
    try { return await (await fetch(`http://127.0.0.1:${port}/${path}`)).json() } catch { return undefined }
  }
  async function connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    let id = 0
    const pending = new Map()
    socket.addEventListener('message', event => {
      const response = JSON.parse(event.data)
      const entry = pending.get(response.id)
      if (!entry) return
      pending.delete(response.id)
      clearTimeout(entry.timer)
      if (response.error) entry.reject(Error(JSON.stringify(response.error)))
      else entry.resolve(response.result)
    })
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++id
      const timer = setTimeout(() => { pending.delete(key); reject(Error('CDP timeout: ' + method)) }, 10000)
      pending.set(key, { resolve, reject, timer })
      socket.send(JSON.stringify({ id: key, method, params }))
    })
    const evaluate = async expression => {
      const response = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails))
      return response.result.value
    }
    connections.push(socket)
    return { command, evaluate }
  }
  async function capture(page, name) {
    const directory = process.env.KIRO_BROWSER_SCREENSHOT_DIR
    if (!takeScreenshots || !directory) return
    await page.command('Page.bringToFront')
    await pause(300)
    await writeFile(join(directory, name), Buffer.from((await page.command('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  }
  try {
    if (expectFailure) {
      assert.deepEqual(await Promise.race([parentExit, pause(10000).then(() => null)]), { code: 1, signal: null })
      assert.match(diagnostic, /EXPECTED_STARTUP_FAILURE/)
      assert.equal(await get('json/list'), undefined, 'failed bootstrap never creates a renderer')
      console.log('PASS invalid environment after restart fails closed instead of looping or opening a webpage')
      return
    }
    const version = await until(() => get('json/version'), 'relaunch debugging endpoint')
    const browser = await connect(version.webSocketDebuggerUrl)
    browserPid = (await browser.command('SystemInfo.getProcessInfo')).processInfo.find(row => row.type === 'browser').id
    assert.notEqual(browserPid, child.pid, 'startup without native environment must relaunch')
    assert.deepEqual(await parentExit, { code: 0, signal: null }, 'initial process exits cleanly')
    // Read only this test process, not the machine's other process arguments.
    const nativeArgs = execFileSync('/bin/ps', ['-p', String(browserPid), '-o', 'command='], { encoding: 'utf8' })
    assert(nativeArgs.includes('--privacy-probe=preserved'), 'custom argument preserved across relaunch')
    assert(nativeArgs.includes(`--user-data-dir=${data}`), 'temporary profile preserved')
    assert.equal((nativeArgs.match(/-AppleLanguages/g) || []).length, 1, 'language argument normalized once')
    assert(nativeArgs.includes('-AppleLanguages (en-US,en)'))
    const target = await until(async () => (await get('json/list'))?.find(page => page.type === 'page' && page.url.startsWith('file:')), 'cold-start main window')
    const main = await connect(target.webSocketDebuggerUrl)
    await until(() => main.evaluate(`!!window.api && !!document.querySelector('.app-sidebar .ant-menu-item')`), 'mounted UI')
    assert.equal((await main.evaluate('window.api.loadAccounts()')).data.accounts.length, 0)
    assert.equal((await main.evaluate(`window.api.saveSettings({autoRefresh:false,autoRefreshUsage:false,backupEnabled:false,trayEnabled:false,portalProxyUrl:${JSON.stringify(proxyUrl)}})`)).success, true)
    await main.evaluate(`[...document.querySelectorAll('.app-sidebar .ant-menu-item')].find(el=>el.textContent.includes('设置')).click()`)
    await until(() => main.evaluate(`!!document.getElementById('portal-environment-summary')`), 'privacy settings UI')
    assert.match(await main.evaluate(`document.getElementById('portal-environment-summary').innerText`), /en-US.*America\/New_York/)
    await main.evaluate(`document.getElementById('portal-environment-summary').scrollIntoView({block:'center'})`)
    await capture(main, 'native-privacy-settings.png')
    const url = 'http://127.0.0.1:19877/privacy-first-script'
    assert.equal((await main.evaluate(`window.api.openInAppBrowser(${JSON.stringify(url)},'本地隐私测试')`)).success, true)
    const pageTarget = await until(async () => (await get('json/list'))?.find(page => page.url === url), 'private fixture window')
    const page = await connect(pageTarget.webSocketDebuggerUrl)
    await until(() => page.evaluate('!!window.firstEnvironment'), 'first-script environment')
    assert.deepEqual(await page.evaluate('window.firstEnvironment'), expectedEnvironment)
    assert.equal(arrivals.find(row => row.url === url).language, 'en-US,en;q=0.9')
    assert.equal(await page.evaluate(`navigator.permissions.query({name:'geolocation'}).then(p=>p.state)`), 'denied')
    await capture(page, 'native-privacy-page.png')
    assert.equal((await browser.command('SystemInfo.getProcessInfo')).processInfo.find(row => row.type === 'browser').id, browserPid, 'no relaunch loop')
    console.log('PASS native cold start relaunches once, preserves arguments/profile, renders settings and fixes first-script environment')
  } finally {
    if (browserPid) { try { process.kill(browserPid, 'SIGTERM') } catch {} }
    else if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    for (const socket of connections) socket.close()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => proxy.close(resolve))
    await pause(600)
    await rm(data, { recursive: true, force: true })
  }
}

await testStartup([], true)
await testStartup(['--AppleLanguages', '(fr-FR)', '-AppleLanguages=(de-DE)'])
await testStartup([], false, true)
