// Actual app + IPC + disk persistence. Only fictional credentials and local proxy fixtures.
const assert = require('node:assert/strict')
const http = require('node:http')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { app, BaseWindow, BrowserWindow, session, webContents } = require('electron')
const userData = mkdtempSync(join(tmpdir(), 'kiro-add-account-test-'))
app.setPath('userData', userData)
app.setAsDefaultProtocolClient = () => false
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, label) {
  for (let n = 0; n < 150; n++) { const result = await predicate(); if (result) return result; await delay(80) }
  throw Error('Timeout: ' + label)
}
const timer = setTimeout(() => { console.error('Add account tests timed out'); app.exit(1) }, 100000)
let main, proxy, sockets = new Set(), requests = [], failVerification = false
let holdVerification = false, pendingReplies = []
let email = 'online@example.invalid'
function fixture(path) {
  if (path.includes('/getUsageLimits')) return {
    userInfo: { email, userId: email }, subscriptionInfo: { subscriptionTitle: 'Free' },
    usageBreakdownList: [{ resourceType: 'CREDIT', currentUsage: 0, usageLimit: 50 }]
  }
  if (path.includes('/client/register')) return { clientId: 'fixture-client', clientSecret: 'fixture-secret' }
  if (path.includes('/device_authorization')) return { deviceCode: 'fixture-device', userCode: 'FIXTURE', verificationUri: 'https://fixture.invalid/authorize', interval: 2 }
  return { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresIn: 3600 }
}
function reply(socket, path) {
  const status = failVerification && (path.includes('/refreshToken') || path==='/token') ? 401 : 200
  const body = JSON.stringify(status === 401 ? { message: 'fixture rejected' } : fixture(path))
  const send = () => socket.write(`HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Unauthorized'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`)
  if (holdVerification && path==='/token') pendingReplies.push(send)
  else send()
}
async function evaluate(code) { return main.webContents.executeJavaScript(code, true) }
async function click(text) {
  await until(()=>evaluate(`(() => { const root=[...document.querySelectorAll('.ant-modal-content')].find(e=>e.getClientRects().length)||document; const el=[...root.querySelectorAll('button')].find(e=>e.getClientRects().length && !e.disabled && e.textContent.includes(${JSON.stringify(text)})); if(!el)return false; el.click(); return true })()`), 'button: ' + text)
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
}
async function input(selector, value) {
  await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw Error('missing input'); const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`)
}
async function accounts() { return (await evaluate('window.api.loadAccounts()')).data.accounts }
function privatePages() { return webContents.getAllWebContents().filter(wc=>wc.session!==session.defaultSession) }
function browserParts(page) {
  const win=BaseWindow.getAllWindows().find(win=>win.contentView.children.some(view=>view.webContents===page))
  assert(win,'private page has a browser window')
  const bar=win.contentView.children.find(view=>view.webContents && view.webContents!==page).webContents
  return {win,bar}
}
async function clickBrowserButton(page,id) {
  const {bar}=browserParts(page)
  await until(()=>bar.executeJavaScript(`!!window.portalBar && document.readyState==='complete'`),'browser toolbar')
  assert.equal(await bar.executeJavaScript(`(() => {const el=document.getElementById(${JSON.stringify(id)});if(!el)return false;el.click();return true})()`),true,`browser button ${id}`)
}
async function captureBrowser(page) {
  const {win,bar}=browserParts(page)
  const directory=process.env.KIRO_BROWSER_SCREENSHOT_DIR
  const original=win.getSize()
  win.show()
  win.focus()
  try {
    for(const [label,width] of [['normal',1000],['narrow',480]]) {
      win.setSize(width,720)
      await Promise.race([
        bar.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'),
        delay(2000).then(()=>{throw Error('Toolbar animation frames paused during resize')})
      ])
      assert.equal(await bar.executeJavaScript(`['new-window','outlook-signup','dots','go'].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.width>0 && r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight})`),true,`toolbar controls visible at ${width}px`)
      if(directory) {
        await delay(200)
        writeFileSync(join(directory,`same-environment-toolbar-${label}.png`),(await bar.capturePage()).toPNG())
      }
    }
  } finally { win.setSize(...original) }
}
async function capture(label) {
  const path = process.env.KIRO_TEST_SCREENSHOT
  if (!path) return
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  await delay(400)
  writeFileSync(path, (await main.webContents.capturePage()).toPNG())
  console.log('SCREENSHOT', label, path)
}
async function run() {
  proxy = http.createServer((req, res) => {
    const path = new URL(req.url).pathname
    requests.push({ path })
    const status = failVerification && (path.includes('/refreshToken') || path==='/token') ? 401 : 200
    const body=JSON.stringify(status === 401 ? { message: 'fixture rejected' } : fixture(path))
    const send=()=>{res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body)}
    if (holdVerification && path==='/token') pendingReplies.push(send)
    else send()
  })
  // Support tunneled fixture traffic as well as ordinary HTTP proxy requests.
  // HTTPS uses session protocol fixtures below: never contact real services.
  proxy.on('connect', (req, socket, head) => {
    requests.push({ connect: req.url })
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    let buffer = head || Buffer.alloc(0)
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes])
      while (true) {
        const split = buffer.indexOf('\r\n\r\n')
        if (split < 0) return
        const header = buffer.subarray(0, split).toString()
        const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] || 0)
        if (buffer.length < split + 4 + length) return
        const path = header.split(' ')[1]
        requests.push({ path })
        buffer = buffer.subarray(split + 4 + length)
        reply(socket, path)
      }
    })
  })
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close',()=>sockets.delete(socket)); socket.on('error',()=>{}) })
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve))
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
  await until(()=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().startsWith('file:')), 'main window')
  main = BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().startsWith('file:'))
  await until(()=>evaluate('!!window.api'), 'preload')
  await evaluate(`window.api.saveSettings({autoRefresh:false,autoRefreshUsage:false,backupEnabled:false,trayEnabled:false,portalProxyUrl:${JSON.stringify(proxyUrl)}})`)
  // Settings changed through IPC must be reloaded into the renderer store, as at app startup.
  main.webContents.reload()
  await until(()=>evaluate(`!!window.api && document.readyState==='complete'`), 'reload settings')
  await evaluate(`location.hash='#/accounts'`)
  await until(()=>evaluate(`document.body.innerText.includes('添加账号')`), 'accounts page')
  await click('添加账号')
  await until(()=>evaluate(`!!document.querySelector('#add-account-proxy')`), 'proxy field')
  assert.equal(await evaluate(`document.querySelector('#add-account-proxy').value`),proxyUrl)
  await capture('add dialog')
  await input('#add-account-proxy','')
  await click('在线登录')
  assert.equal(privatePages().length,0)
  assert.equal(await evaluate(`document.body.innerText.includes('选择登录方式')`),false)
  await input('#add-account-proxy',`  ${proxyUrl}  `)
  await click('在线登录'); await click('Google 账号')
  await until(()=>privatePages().length===1,'proxied login window')
  let page = privatePages()[0]
  await until(()=>page.getURL().includes('/login?'),'social login URL')
  const loginSession = page.session
  await loginSession.cookies.set({url:'https://fixture.invalid',name:'LoginProgress',value:'fixture'})
  BaseWindow.getAllWindows().find(win => win !== main).close()
  await until(()=>privatePages().length===0,'login window closed')
  await click('重新打开浏览器')
  await until(()=>privatePages().length===1 && privatePages()[0].getURL().includes('/login?'),'login window reopened')
  page = privatePages()[0]
  assert.equal(page.session,loginSession,'reopen retains locked proxy session')
  assert.equal((await loginSession.cookies.get({name:'LoginProgress'}))[0]?.value,'fixture')
  assert.equal(await page.session.resolveProxy('https://fixture.invalid'),`PROXY 127.0.0.1:${proxy.address().port}`)
  assert.equal(await evaluate(`document.querySelector('#add-account-proxy').disabled`),true)
  const loginUrl = new URL(page.getURL())
  await page.executeJavaScript(`document.body.insertAdjacentHTML('beforeend','<label>本地测试草稿 <input id="draft" value="unfinished"></label>')`)
  await clickBrowserButton(page,'new-window')
  await until(()=>privatePages().length===2,'same-environment blank window')
  const blank=privatePages().find(wc=>wc!==page)
  await until(()=>blank.getURL()==='about:blank','blank window ready')
  assert.equal(blank.session,loginSession)
  await clickBrowserButton(page,'outlook-signup')
  await until(()=>privatePages().length===3 && privatePages().some(wc=>wc.getURL()==='https://signup.live.com/signup'),'same-environment Outlook signup')
  const outlook=privatePages().find(wc=>wc.getURL()==='https://signup.live.com/signup')
  assert.equal(outlook.session,loginSession)
  assert.equal(await outlook.session.resolveProxy(outlook.getURL()),`PROXY 127.0.0.1:${proxy.address().port}`)
  assert.equal(page.getURL(),loginUrl.toString(),'opening companions must leave authorization page intact')
  assert.equal(await page.executeJavaScript(`document.getElementById('draft').value`),'unfinished')
  await captureBrowser(page)
  console.log('PASS actual login toolbar opens same-session blank/Outlook companions; original form and proxy unchanged')
  // Protocol fixture instead of real network; callback must be intercepted within app.
  await page.executeJavaScript(`location.href='kiro://kiro.kiroAgent/authenticate-success?code=fixture-code&state=${loginUrl.searchParams.get('state')}'`)
  await until(async()=>(await accounts()).length===1,'online saved account')
  let saved = (await accounts())[0]
  assert.equal(saved.portalProxyUrl,proxyUrl)
  assert.equal(saved.email,email)
  assert(requests.some(row=>row.path?.includes('/oauth/token')),'token exchange used local proxy')
  assert(requests.some(row=>row.path?.includes('/refreshToken')),'verification used local proxy')
  assert.equal(requests.filter(row=>row.path?.includes('/oauth/token')).length,1,'callback exchanged exactly once')
  await until(async()=>(await loginSession.cookies.get({})).length===0,'login cookie cleanup')
  await until(()=>[page,blank,outlook].every(wc=>wc.isDestroyed()),'successful login closes every companion')
  console.log('PASS actual Add Account UI -> proxied social callback -> token/verification -> stored account proxy')
  console.log('PASS reopen retains proxy session; completed login closes it and clears cookies')

  // An explicitly selected per-account value must not be replaced by the global default.
  const manualProxyUrl=proxyUrl.replace('http://','http://fixture-user:fixture-pass@')
  email='manual@example.invalid'
  await click('添加账号'); await click('OIDC 凭证')
  await input('#add-account-proxy',`  ${manualProxyUrl}  `)
  await input('textarea','fixture-refresh-manual')
  await input('input[placeholder="请输入 Client ID"]','fixture-client')
  await input('input[placeholder="请输入 Client Secret"]','fixture-secret')
  await click('校验并添加')
  await until(async()=>(await accounts()).length===2,'manual saved account')
  assert.equal((await accounts()).find(account=>account.email===email).portalProxyUrl,manualProxyUrl)
  main.webContents.reload()
  await until(()=>evaluate(`!!window.api && document.body.innerText.includes('manual@example.invalid')`),'reload saved accounts')
  assert.equal((await accounts()).find(account=>account.email==='online@example.invalid').portalProxyUrl,proxyUrl)
  assert.equal((await accounts()).find(account=>account.email===email).portalProxyUrl,manualProxyUrl)
  assert.equal((await evaluate('window.api.getSettings()')).data.portalProxyUrl,proxyUrl)
  console.log('PASS manual credential proxy saved, persisted through reload, global proxy unchanged')

  // Existing account cannot have its proxy overwritten by a failed/duplicate add.
  await click('添加账号'); await click('OIDC 凭证')
  await input('textarea','fixture-refresh-duplicate')
  await input('input[placeholder="请输入 Client ID"]','fixture-client')
  await input('input[placeholder="请输入 Client Secret"]','fixture-secret')
  await click('校验并添加')
  await until(()=>evaluate(`document.body.innerText.includes('已存在')`),'duplicate rejected')
  assert.equal((await accounts()).length,2)
  console.log('PASS duplicate account not modified')

  // A rejected verification never mutates an existing account or adds a new one.
  const originalAccounts = await accounts()
  failVerification = true
  await input('textarea','fixture-rejected')
  await click('校验并添加')
  await until(()=>evaluate(`document.body.innerText.includes('校验凭证失败') || document.body.innerText.includes('fixture rejected')`),'verification rejected')
  assert.deepEqual(await accounts(),originalAccounts)
  failVerification = false
  await evaluate(`document.querySelector('.add-head .close').click()`)
  await until(()=>evaluate(`!document.querySelector('#add-account-proxy')`),'dialog closed')
  console.log('PASS verification failure leaves saved accounts unchanged')

  // Builder ID OIDC registration, device authorization and polling all use the selected proxy.
  email='builder@example.invalid'
  await click('添加账号'); await click('在线登录'); await click('AWS Builder ID')
  await until(async()=>(await accounts()).length===3,'Builder ID saved')
  assert.equal((await accounts()).find(account=>account.email===email).portalProxyUrl,proxyUrl)
  assert(requests.some(row=>row.path==='/client/register'))
  assert(requests.some(row=>row.path==='/device_authorization'))
  assert(requests.some(row=>row.path==='/token'))
  console.log('PASS Builder ID registration, device authorization, polling and saved proxy')

  // Enterprise loopback callback must be intercepted, not sent to a remote proxy.
  email='enterprise@example.invalid'
  await click('添加账号'); await click('在线登录'); await click('Enterprise')
  await input('input[placeholder="https://d-xxxxxxxxxx.awsapps.com/start"]','https://fixture.awsapps.com/start')
  await click('打开代理浏览器授权')
  await until(()=>privatePages().some(wc=>wc.getURL().includes('/authorize?')),'Enterprise page')
  const enterprisePage=privatePages().find(wc=>wc.getURL().includes('/authorize?'))
  const authorizeUrl=new URL(enterprisePage.getURL())
  const callback=new URL(authorizeUrl.searchParams.get('redirect_uri'))
  callback.searchParams.set('code','fixture-enterprise-code')
  callback.searchParams.set('state',authorizeUrl.searchParams.get('state'))
  await enterprisePage.executeJavaScript(`location.href=${JSON.stringify(callback.toString())}`)
  await until(async()=>(await accounts()).length===4,'Enterprise saved')
  assert.equal((await accounts()).find(account=>account.email===email).portalProxyUrl,proxyUrl)
  assert.equal(requests.filter(row=>row.path?.includes('/oauth/callback')).length,0)
  console.log('PASS Enterprise in-app callback and stored proxy without loopback network request')

  // Cancel while validation is in flight: a late result must not add the account.
  email='cancelled@example.invalid'
  const baseline=requests.filter(row=>row.path?.includes('/getUsageLimits')).length
  await click('添加账号'); await click('OIDC 凭证')
  await input('textarea','fixture-cancelled')
  await input('input[placeholder="请输入 Client ID"]','fixture-client')
  await input('input[placeholder="请输入 Client Secret"]','fixture-secret')
  holdVerification = true
  await click('校验并添加')
  await until(()=>pendingReplies.length>0,'verification in flight')
  await evaluate(`document.querySelector('.add-head .close').click()`)
  await until(()=>evaluate(`!document.querySelector('#add-account-proxy')`),'cancelled dialog closed')
  holdVerification = false
  for(const reply of pendingReplies.splice(0))reply()
  await until(()=>requests.filter(row=>row.path?.includes('/getUsageLimits')).length>baseline,'late verification completed')
  await delay(300)
  assert.equal((await accounts()).length,4)
  assert(!(await accounts()).some(account=>account.email===email))
  console.log('PASS cancelled in-flight validation cannot save a late result')

  // Cancelling an online add must also destroy its mailbox companion and private data.
  await click('添加账号'); await click('在线登录'); await click('Google 账号')
  await until(()=>privatePages().some(wc=>wc.getURL().includes('/login?')),'cancellable login page')
  const cancelledPage=privatePages().find(wc=>wc.getURL().includes('/login?'))
  const cancelledSession=cancelledPage.session
  assert.notEqual(cancelledSession,loginSession,'a later add is a fresh environment')
  await cancelledSession.cookies.set({url:'https://signup.live.com',name:'CancelledDraft',value:'fixture'})
  await clickBrowserButton(cancelledPage,'outlook-signup')
  await until(()=>privatePages().some(wc=>wc.getURL()==='https://signup.live.com/signup'),'cancellable Outlook companion')
  const cancelledOutlook=privatePages().find(wc=>wc.getURL()==='https://signup.live.com/signup')
  assert.equal(cancelledOutlook.session,cancelledSession)
  await evaluate(`document.querySelector('.add-head .close').click()`)
  await until(()=>cancelledPage.isDestroyed() && cancelledOutlook.isDestroyed(),'cancel closes all companion windows')
  await until(async()=>(await cancelledSession.cookies.get({})).length===0,'cancel clears mailbox session')
  assert.equal((await accounts()).length,4)
  console.log('PASS cancelled login closes Outlook companion and clears its private session; later add remains isolated')
}
app.on('session-created', ses => {
  if (ses === session.defaultSession) return
  // Custom HTTPS handler forwards app API calls as HTTP through its same proxy;
  // login document is inert and contains no external resources.
  ses.protocol.handle('https', async request => {
    const url=new URL(request.url)
    if (url.pathname==='/login' || url.pathname==='/authorize' || url.hostname==='signup.live.com') return new Response('<title>Local login fixture</title>',{headers:{'Content-Type':'text/html'}})
    const body=request.method==='GET'?undefined:Buffer.from(await request.arrayBuffer())
    return ses.fetch('http://fixture.invalid'+url.pathname+url.search,{method:request.method,headers:{'Content-Type':'application/json'},body})
  })
})
require(process.argv[2])
app.whenReady().then(run).then(()=>{
  clearTimeout(timer)
  for(const socket of sockets)socket.destroy()
  proxy.close()
  console.log('PASS all add-account fixture checks')
  app.quit()
}).catch(async error=>{console.error(error);if(main&&!main.isDestroyed())console.error('UI AT FAILURE',await evaluate('document.body.innerText'));clearTimeout(timer);app.exit(1)})
app.on('will-quit',()=>{try { rmSync(userData,{recursive:true,force:true}) } catch {}})
