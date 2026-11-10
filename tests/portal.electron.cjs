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
  await app.whenReady()
  // No real account traffic: HTTPS portal pages are fixtures; HTTP exercises actual Chromium sockets.
  app.on('session-created', ses => {
    ses.protocol.handle('https', () => new Response('<title>Account fixture</title>', { headers: { 'Content-Type': 'text/html' } }))
  })
  const portal = require(process.argv[2])
  const tunnels = new Set(), arrivals = []
  const targetServer = http.createServer((req, res) => {
    arrivals.push({ path: req.url, proxy: req.headers['x-test-proxy'] || (tunnels.has(req.socket.remotePort) ? 'tunnel' : 'DIRECT') })
    res.setHeader('Cache-Control', 'no-store')
    if (req.url === '/resource') { res.end('resource-ok'); return }
    res.setHeader('Content-Type', 'text/html')
    res.end(`<title>Local portal fixture</title><img src="/image"><iframe src="/frame"></iframe>`)
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
    const existingWindows = new Set(BaseWindow.getAllWindows())
    const first = await opened(() => portal.openInAppUrl(target, 'Test A', { proxyUrl: a.url() }))
    const rootWindow = BaseWindow.getAllWindows().find(win => !existingWindows.has(win))
    const second = await opened(() => portal.openInAppUrl(target, 'Test B', { proxyUrl: b.url() }))
    assert.notEqual(first.session, second.session)
    assert.equal(first.session.isPersistent(), false)
    assert.equal(await first.session.resolveProxy(target), `PROXY 127.0.0.1:${a.server.address().port}`)
    await until(() => arrivals.some(row => row.proxy === 'A') && arrivals.some(row => row.proxy === 'B'), 'both proxies used')
    await until(() => first.getTitle() === 'Local portal fixture', 'first page loaded')
    assert.equal(await first.executeJavaScript(`fetch('/resource').then(r => r.text())`), 'resource-ok')
    await until(() => arrivals.some(row => row.path === '/image') && arrivals.some(row => row.path === '/frame'), 'subresources')
    const popup = await opened(() => first.executeJavaScript(`window.open('${target}/popup'); undefined`, true))
    assert.equal(popup.session, first.session, 'popup must inherit opener proxy and cookies')
    await until(() => arrivals.some(row => row.path === '/popup'), 'popup request')
    // Opener-sensitive OAuth-style native popup follows the same route before its first request.
    const oauth = await opened(() => first.executeJavaScript(`window.open('${target}/oauth'); undefined`, true))
    assert.equal(oauth.session, first.session)
    await until(() => arrivals.some(row => row.path === '/oauth'), 'oauth popup request')
    const ws = await first.executeJavaScript(`new Promise((resolve, reject) => { const ws = new WebSocket('${target.replace('http:', 'ws:')}/socket'); ws.onmessage = e => { resolve(e.data); ws.close() }; ws.onerror = () => reject(new Error('websocket failed')) })`)
    assert.equal(ws, 'ok')
    assert.equal(arrivals.filter(row => row.proxy === 'DIRECT').length, 0, 'no request may bypass its proxy')
    await first.session.cookies.set({ url: target, name: 'SharedPopup', value: 'still-alive' })
    rootWindow.close()
    assert.equal((await popup.session.cookies.get({name:'SharedPopup'}))[0]?.value, 'still-alive', 'closing parent must preserve live child session')
    await until(() => popup.getTitle() === 'Local portal fixture', 'child remains loaded')
    assert.equal(await popup.executeJavaScript(`fetch('/resource').then(r => r.text())`), 'resource-ok')
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
