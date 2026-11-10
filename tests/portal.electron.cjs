const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { createHash } = require('node:crypto')
const { app, BaseWindow, webContents, session } = require('electron')

const userData = mkdtempSync(join(tmpdir(), 'kiro-portal-test-'))
app.setPath('userData', userData)
app.on('window-all-closed', () => {})
app.commandLine.appendSwitch('disable-quic')
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp')
const timeout = setTimeout(() => { console.error('Portal tests timed out'); app.exit(1) }, 90000)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, label) {
  for (let n = 0; n < 100; n++) { const result = await predicate(); if (result) return result; await delay(50) }
  throw new Error(`Timed out: ${label}`)
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
function contentPages() { return webContents.getAllWebContents().filter(wc => wc.session !== session.defaultSession) }
async function opened(action) {
  const before = new Set(contentPages().map(wc => wc.id))
  await action()
  return until(() => contentPages().find(wc => !before.has(wc.id)), 'new browser content')
}
function toolbarFor(page) {
  const win = BaseWindow.getAllWindows().find(win => win.contentView.children.some(view => view.webContents === page))
  assert(win, 'page has a browser window')
  return win.contentView.children.find(view => view.webContents && view.webContents !== page).webContents
}
async function clickToolbar(page, id) {
  const bar = toolbarFor(page)
  await until(() => bar.executeJavaScript(`!!window.portalBar && document.readyState === 'complete'`), 'toolbar ready')
  assert.equal(await bar.executeJavaScript(`(() => { const button=document.getElementById(${JSON.stringify(id)}); if(!button)return false; button.click(); return true })()`), true, `toolbar button ${id} exists`)
}
async function navigateWithToolbar(page, url) {
  const bar = toolbarFor(page)
  await bar.executeJavaScript(`document.getElementById('url').value=${JSON.stringify(url)}`)
  await clickToolbar(page, 'go')
  await until(() => page.getURL() === url && !page.isLoading(), `address-bar navigation: ${url}`)
    .catch(async error => { throw new Error(`${error.message}; page=${page.getURL()}; route=${await page.session.resolveProxy(url)}`) })
}
function proxyServer(label, tunnels, password) {
  const hits = []
  const sockets = new Set()
  const expected = password && `Basic ${Buffer.from(password).toString('base64')}`
  function authorized(req, socket) {
    if (!expected || req.headers['proxy-authorization'] === expected) return true
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\nContent-Length: 0\r\n\r\n')
    return false
  }
  const server = http.createServer((req, res) => {
    if (expected && req.headers['proxy-authorization'] !== expected) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' }); res.end(); return
    }
    hits.push(req.url)
    const target = new URL(req.url)
    const headers = { ...req.headers, 'x-test-proxy': label }
    delete headers['proxy-authorization']
    const upstream = http.request(target, { method: req.method, headers }, reply => {
      res.writeHead(reply.statusCode, reply.headers); reply.pipe(res)
    })
    upstream.on('error', () => { res.writeHead(502); res.end() })
    req.pipe(upstream)
  })
  server.on('connect', (req, socket, head) => {
    if (!authorized(req, socket)) return
    hits.push(`CONNECT ${req.url}`)
    const [host, port] = req.url.split(':')
    const upstream = net.connect(Number(port), host, () => {
      tunnels.add(upstream.localPort)
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
    sockets.add(upstream)
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  return { server, hits, url: () => `http://127.0.0.1:${server.address().port}`, async stop() {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  } }
}

async function main() {
  const portal = require(process.argv[2])
  await app.whenReady()
  // No real account traffic: HTTPS portal pages are fixtures; HTTP exercises actual Chromium sockets.
  app.on('session-created', ses => {
    ses.protocol.handle('https', () => new Response('<title>Account fixture</title>', { headers: { 'Content-Type': 'text/html' } }))
  })
  const tunnels = new Set(), arrivals = []
  const targetServer = http.createServer((req, res) => {
    arrivals.push({ path: req.url, ua: req.headers['user-agent'], language: req.headers['accept-language'], proxy: req.headers['x-test-proxy'] || (tunnels.has(req.socket.remotePort) ? 'tunnel' : 'DIRECT') })
    res.setHeader('Cache-Control', 'no-store')
    if (req.url === '/resource') { res.end('resource-ok'); return }
    const readEnvironment = `({zone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.DateTimeFormat().resolvedOptions().locale,language:navigator.language,languages:[...navigator.languages],winterOffset:new Date('2026-01-15T12:00:00Z').getTimezoneOffset(),summerOffset:new Date('2026-07-15T12:00:00Z').getTimezoneOffset()})`
    if (req.url === '/worker.js' || req.url === '/shared.js' || req.url === '/sw.js') {
      res.setHeader('Content-Type', 'application/javascript')
      const snapshot = `const snapshot=${readEnvironment};`
      if (req.url === '/worker.js') res.end(snapshot+'postMessage(snapshot)')
      else if (req.url === '/shared.js') res.end(snapshot+'onconnect=e=>e.ports[0].postMessage(snapshot)')
      else res.end(snapshot+`addEventListener('install',e=>e.waitUntil(skipWaiting()));addEventListener('activate',e=>e.waitUntil(clients.claim()));addEventListener('message',e=>e.ports[0].postMessage(snapshot))`)
      return
    }
    res.setHeader('Content-Type', 'text/html')
    if (req.url === '/cross-frame') {
      res.end(`<script>parent.postMessage({kind:'cross-frame-environment',environment:${readEnvironment}},'*')</script>`)
      return
    }
    res.end(`<title>Local portal fixture</title><script>window.firstEnvironment=${readEnvironment}</script><img src="/image"><iframe src="/frame"></iframe>`)
  })
  targetServer.on('upgrade', (req, socket) => {
    arrivals.push({ path: req.url, proxy: tunnels.has(req.socket.remotePort) ? 'tunnel' : req.headers['x-test-proxy'] || 'DIRECT' })
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.write(Buffer.from([0x81, 2, 111, 107]))
    socket.on('error', () => {})
    socket.on('data', () => socket.end())
  })
  await listen(targetServer)
  const target = `http://127.0.0.1:${targetServer.address().port}`
  const a = proxyServer('A', tunnels), b = proxyServer('B', tunnels)
  await listen(a.server); await listen(b.server)
  try {
    // Real Session API + HTTP arrival: catch proxy preference propagation races
    // when a protocol handler initialized the NetworkContext before setProxy.
    for (let iteration = 0; iteration < 200; iteration++) {
      let createdSession
      app.once('session-created', ses => { createdSession = ses })
      const login = await portal.createLoginBrowser(a.url(), () => false)
      try {
        assert.equal(await createdSession.resolveProxy(target), `PROXY 127.0.0.1:${a.server.address().port}`, `new login session proxy ready at iteration ${iteration}`)
        const response = await login.request(`${target}/resource`)
        assert.equal(response.status, 200)
        assert.equal(await response.text(), 'resource-ok')
        assert.equal(arrivals.at(-1)?.proxy, 'A', 'first login request must use its explicit proxy')
      } finally { await login.close() }
    }
    console.log('PASS 200 fresh sessions synchronize proxy configuration before first request')
    const existingWindows = new Set(BaseWindow.getAllWindows())
    const first = await opened(() => portal.openInAppUrl(target, 'Test A', { proxyUrl: a.url() }))
    const rootWindow = BaseWindow.getAllWindows().find(win => !existingWindows.has(win))
    const second = await opened(() => portal.openInAppUrl(target, 'Test B', { proxyUrl: b.url() }))
    assert.notEqual(first.session, second.session)
    assert.equal(first.session.isPersistent(), false)
    assert.equal(await first.session.resolveProxy(target), `PROXY 127.0.0.1:${a.server.address().port}`)
    await until(() => arrivals.some(row => row.proxy === 'A') && arrivals.some(row => row.proxy === 'B'), 'both proxies used')
    await until(() => first.getTitle() === 'Local portal fixture', 'first page loaded')
    // Snapshot captured by the first page script, not a late injected property shim.
    const environment = await first.executeJavaScript('window.firstEnvironment')
    const userAgent = await first.executeJavaScript('navigator.userAgent')
    assert.doesNotMatch(userAgent, /Electron|kiro-account-lite/i)
    assert.match(userAgent, new RegExp(`Chrome/${process.versions.chrome.split('.')[0]}\\.`))
    assert.equal(arrivals.find(row => row.path === '/')?.ua, userAgent, 'HTTP and JS UA match without Electron token')
    assert.equal(environment.zone, 'America/New_York', 'websites must not inherit the system timezone')
    assert.equal(environment.locale, 'en-US')
    assert.equal(environment.language, 'en-US')
    assert.deepEqual(environment.languages, ['en-US', 'en'])
    assert.equal(environment.winterOffset, 300)
    assert.equal(environment.summerOffset, 240)
    assert.match(arrivals.find(row => row.path === '/')?.language || '', /^en-US,en;q=0\.9$/)
    await until(() => first.executeJavaScript(`!!document.querySelector('iframe').contentWindow.firstEnvironment`), 'iframe environment')
    assert.deepEqual(await first.executeJavaScript(`document.querySelector('iframe').contentWindow.firstEnvironment`), environment)
    const crossFrameEnvironment = await first.executeJavaScript(`new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('cross-origin frame timeout')),4000)
      const frame=document.createElement('iframe')
      const listener=event=>{if(event.source===frame.contentWindow && event.data?.kind==='cross-frame-environment'){clearTimeout(timer);removeEventListener('message',listener);frame.remove();resolve(event.data.environment)}}
      addEventListener('message',listener)
      frame.src=${JSON.stringify(`${target.replace('127.0.0.1', 'localhost')}/cross-frame`)}
      document.body.appendChild(frame)
    })`)
    assert.deepEqual(crossFrameEnvironment, environment, 'cross-site iframe first script uses fixed native environment')
    for (const kind of ['dedicated', 'shared', 'service']) {
      const observed = await first.executeJavaScript(`new Promise(async (resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('worker environment timeout')),4000)
        const done=e=>{clearTimeout(timer);resolve(e.data)}
        try {
          if(${JSON.stringify(kind)}==='dedicated') {
            const worker=new Worker('/worker.js');worker.onmessage=e=>{worker.terminate();done(e)};worker.onerror=reject
          } else if(${JSON.stringify(kind)}==='shared') {
            const worker=new SharedWorker('/shared.js');worker.port.onmessage=e=>{worker.port.close();done(e)};worker.onerror=reject;worker.port.start()
          } else {
            await navigator.serviceWorker.register('/sw.js')
            const registration=await navigator.serviceWorker.ready
            const channel=new MessageChannel();channel.port1.onmessage=async e=>{await registration.unregister();done(e)}
            registration.active.postMessage('environment',[channel.port2])
          }
        } catch(error) {clearTimeout(timer);reject(error)}
      })`)
      // Chromium may reduce a shared worker's fallback list to just its primary language.
      assert.equal(observed.language, 'en-US', `${kind} primary language`)
      assert(observed.languages.length > 0 && observed.languages.every(language => ['en-US','en'].includes(language)), `${kind} worker must expose only English language tags`)
      assert.deepEqual({...observed,languages:environment.languages}, environment, `${kind} worker must not expose host timezone or locale`)
    }
    assert.equal(await first.executeJavaScript(`navigator.permissions.query({name:'geolocation'}).then(p=>p.state)`), 'denied')
    assert.equal(await first.executeJavaScript(`new Promise(resolve=>navigator.geolocation.getCurrentPosition(()=>resolve('unexpected location'),error=>resolve(error.code),{timeout:2000}))`), 1, 'OS location denied before lookup')
    console.log('PASS US English, New York timezone with daylight savings and denied OS geolocation')
    // Real toolbar -> preload -> IPC: no new partition and no lost form state.
    await first.executeJavaScript(`document.body.insertAdjacentHTML('beforeend','<input id="draft" value="unfinished">'); document.cookie='ToolbarProgress=fixture; path=/'; localStorage.setItem('draft','in-progress')`)
    portal.setSettings({ portalProxyUrl: b.url() })
    const companion = await opened(() => clickToolbar(first, 'new-window'))
    assert.equal(companion.session, first.session, 'same-environment window inherits the existing session, not the new global proxy')
    assert.equal(await companion.session.resolveProxy(target), `PROXY 127.0.0.1:${a.server.address().port}`)
    await navigateWithToolbar(companion, `${target}/companion`)
    assert.match(await companion.executeJavaScript('document.cookie'), /ToolbarProgress=fixture/)
    assert.equal(await companion.executeJavaScript(`localStorage.getItem('draft')`), 'in-progress')
    await until(() => second.getTitle() === 'Local portal fixture', 'independent page loaded')
    assert.doesNotMatch(await second.executeJavaScript('document.cookie'), /ToolbarProgress/)
    assert.equal(await second.executeJavaScript(`localStorage.getItem('draft')`), null)
    assert.equal(first.getURL(), `${target}/`)
    assert.equal(await first.executeJavaScript(`document.getElementById('draft').value`), 'unfinished')
    assert(arrivals.some(row => row.path === '/companion' && row.proxy === 'A'), 'companion navigation used the initiating proxy')
    console.log('PASS toolbar new window preserves form, session, proxy and same-origin storage; independent environments remain isolated')
    const outlook = await opened(() => clickToolbar(first, 'outlook-signup'))
    await until(() => outlook.getURL() === 'https://signup.live.com/signup' && !outlook.isLoading(), 'official Outlook signup destination (local HTTPS fixture)')
    assert.equal(outlook.session, first.session)
    assert.equal(await outlook.session.resolveProxy(outlook.getURL()), `PROXY 127.0.0.1:${a.server.address().port}`)
    assert.equal(first.getURL(), `${target}/`)
    assert.equal(await first.executeJavaScript(`document.getElementById('draft').value`), 'unfinished')
    console.log('PASS Outlook signup toolbar opens official URL in the same environment without replacing the original page')
    assert.equal(await first.executeJavaScript(`fetch('/resource').then(r => r.text())`), 'resource-ok')
    await until(() => arrivals.some(row => row.path === '/image') && arrivals.some(row => row.path === '/frame'), 'subresources')
    const popup = await opened(() => first.executeJavaScript(`window.open('${target}/popup'); undefined`, true))
    assert.equal(popup.session, first.session, 'popup must inherit opener proxy and cookies')
    await until(() => arrivals.some(row => row.path === '/popup'), 'popup request')
    // Opener-sensitive OAuth-style native popup follows the same route before its first request.
    const oauth = await opened(() => first.executeJavaScript(`window.open('${target}/oauth'); undefined`, true))
    assert.equal(oauth.session, first.session)
    await until(() => arrivals.some(row => row.path === '/oauth'), 'oauth popup request')
    await until(() => oauth.executeJavaScript('!!window.firstEnvironment'), 'native popup first-script environment')
    assert.deepEqual(await oauth.executeJavaScript('window.firstEnvironment'), environment)
    assert.equal(await oauth.executeJavaScript('navigator.userAgent'), userAgent)
    assert.equal(await popup.executeJavaScript('navigator.userAgent'), userAgent)
    assert.equal(await companion.executeJavaScript('navigator.userAgent'), userAgent)
    console.log('PASS native popup first script shares fixed environment; HTTP/page/child UA contain no Electron token')
    const ws = await first.executeJavaScript(`new Promise((resolve, reject) => { const ws = new WebSocket('${target.replace('http:', 'ws:')}/socket'); ws.onmessage = e => { resolve(e.data); ws.close() }; ws.onerror = () => reject(new Error('websocket failed')) })`)
    assert.equal(ws, 'ok')
    assert.equal(arrivals.filter(row => row.proxy === 'DIRECT').length, 0, 'no request may bypass its proxy')
    await first.session.cookies.set({ url: target, name: 'SharedPopup', value: 'still-alive' })
    rootWindow.close()
    assert.equal((await popup.session.cookies.get({name:'SharedPopup'}))[0]?.value, 'still-alive', 'closing parent must preserve live child session')
    await until(() => popup.getTitle() === 'Local portal fixture', 'child remains loaded')
    assert.equal(await popup.executeJavaScript(`fetch('/resource').then(r => r.text())`), 'resource-ok')
    assert.equal(await companion.executeJavaScript(`fetch('/resource').then(r => r.text())`), 'resource-ok', 'toolbar child remains usable after parent close')
    console.log('PASS distinct proxies, pages, subresources, fetch, popups and WebSocket')

    const account = suffix => ({ id: suffix, email: `${suffix}@example.invalid`, idp: 'BuilderId', credentials: { accessToken: `access-${suffix}`, refreshToken: `refresh-${suffix}` } })
    const accountA = await opened(() => portal.openAccountPortal(account('a'), { proxyUrl: a.url() }))
    const accountB = await opened(() => portal.openAccountPortal(account('b'), { proxyUrl: b.url() }))
    const cookie = async (wc, name) => (await wc.session.cookies.get({ url: 'https://app.kiro.dev', name }))[0]?.value
    assert.equal(await cookie(accountA, 'AccessToken'), 'access-a')
    assert.equal(await cookie(accountB, 'AccessToken'), 'access-b')
    assert.equal(await cookie(popup, 'AccessToken'), undefined)
    console.log('PASS account cookies injected without changing existing identities')

    portal.setSettings({ portalProxyUrl: b.url() })
    const globalPage = await opened(() => portal.openInAppUrl(target, 'Global proxy'))
    assert.equal(await globalPage.session.resolveProxy(target), await second.session.resolveProxy(target))
    portal.setSettings({ portalProxyUrl: a.url() })
    const defaultPage = await opened(() => portal.openAccountPortal({ ...account('default'), portalProxyUrl: b.url() }))
    assert.equal(await defaultPage.session.resolveProxy(target), `PROXY 127.0.0.1:${b.server.address().port}`)
    const overridePage = await opened(() => portal.openAccountPortal({ ...account('override'), portalProxyUrl: a.url() }, { proxyUrl: b.url() }))
    assert.equal(await overridePage.session.resolveProxy(target), await second.session.resolveProxy(target))
    assert.notEqual(await popup.session.resolveProxy(target), await second.session.resolveProxy(target), 'global change cannot retarget existing windows')
    console.log('PASS explicit override, account default, global proxy precedence and immutable existing windows')

    const count = contentPages().length
    await assert.rejects(() => portal.openInAppUrl(target, 'No proxy', { proxyUrl: '' }), /代理/)
    for (const invalid of ['direct://host:80', 'http://host:80;DIRECT', 'socks5://user:pass@host:1080']) {
      await assert.rejects(() => portal.openInAppUrl(target, 'Invalid', { proxyUrl: invalid }), /代理/)
    }
    assert.equal(contentPages().length, count, 'invalid proxy must not create a window')
    const failedLogin = await portal.createLoginBrowser(a.url(), () => false)
    await a.stop()
    try {
      await assert.rejects(() => failedLogin.request(`${target}/login-must-not-arrive`))
      assert.equal(arrivals.filter(row => row.path === '/login-must-not-arrive').length, 0)
    } finally { await failedLogin.close() }
    const failed = await popup.executeJavaScript(`fetch('${target}/must-not-arrive').then(() => false, () => true)`)
    assert.equal(failed, true)
    assert.equal(arrivals.filter(row => row.path === '/must-not-arrive' || row.proxy === 'DIRECT').length, 0, 'proxy down must not fall back to direct')
    assert.equal(await second.executeJavaScript(`fetch('/resource').then(r => r.text())`), 'resource-ok')
    console.log('PASS missing/invalid proxy blocked; proxy outage fails closed without affecting another window')

    const authenticated = proxyServer('AUTH', tunnels, 'proxy-user:proxy-pass')
    await listen(authenticated.server)
    try {
      const proxyUrl = authenticated.url().replace('http://', 'http://proxy-user:proxy-pass@')
      const authPage = await opened(() => portal.openInAppUrl(target, 'Authenticated proxy', { proxyUrl }))
      await until(() => arrivals.some(row => row.proxy === 'AUTH'), 'authenticated proxy request')
      await until(() => authPage.getTitle() === 'Local portal fixture', 'authenticated page loaded')
      assert.equal(await authPage.executeJavaScript(`fetch('/resource').then(r => r.text())`), 'resource-ok')
      console.log('PASS HTTP proxy authentication scoped to its own window')
      const login = await portal.createLoginBrowser(proxyUrl, () => false)
      try {
        const response = await login.request(`${target}/resource`)
        assert.equal(response.status, 200)
        assert.equal(await response.text(), 'resource-ok')
        console.log('PASS main-process login transport uses authenticated session proxy')
      } finally { await login.close() }
    } finally { await authenticated.stop() }

    const sessions = new Set(contentPages().map(wc => wc.session))
    portal.closePortalWindow()
    await until(() => contentPages().length === 0, 'all content closed')
    await until(async () => (await Promise.all([...sessions].map(ses => ses.cookies.get({})))).every(cookies => cookies.length === 0), 'cookie cleanup')
    console.log('PASS last-window close cleans private session cookies')
  } finally {
    portal.closePortalWindow()
    if (a.server.listening) await a.stop()
    await b.stop()
    targetServer.closeAllConnections()
    await new Promise(resolve => targetServer.close(resolve))
  }
}
main().then(() => { clearTimeout(timeout); rmSync(userData, { recursive: true, force: true }); app.exit(0) })
  .catch(error => { console.error(error); clearTimeout(timeout); app.exit(1) })
