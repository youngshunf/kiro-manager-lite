import { app } from 'electron'

interface PortalProxy {
  rule: string
  host: string
  port: number
  username: string
  password: string
}

const proxies = new Map<Electron.Session, PortalProxy>()
let authBound = false

/** Only a single explicit proxy is accepted: never PAC, bypass lists or DIRECT. */
function parseProxy(input: string): PortalProxy {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('请设置全局浏览器代理或指定本次窗口代理；私密窗口禁止直连')
  }
  const text = input.trim()
  let url: URL
  try {
    url = new URL(text.includes('://') ? text : `http://${text}`)
  } catch {
    throw new Error('浏览器代理地址无效，请填写 http(s)://host:port 或 socks5://host:port')
  }
  if (
    !['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname ||
    (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || /[\s;,]/.test(text)
  ) {
    throw new Error('浏览器代理仅支持单个 HTTP、HTTPS 或 SOCKS5 地址，不支持路径、规则或直连回退')
  }
  if (url.protocol === 'socks5:' && (url.username || url.password)) {
    throw new Error('Chromium 不支持带用户名密码的 SOCKS5 代理，请使用 HTTP 认证代理或无认证 SOCKS5 代理')
  }
  let username: string, password: string
  try {
    username = decodeURIComponent(url.username)
    password = decodeURIComponent(url.password)
  } catch {
    throw new Error('代理用户名或密码的 URL 编码无效')
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : url.protocol === 'socks5:' ? 1080 : 80))
  if (port < 1 || port > 65535) throw new Error('代理端口必须在 1–65535 之间')
  return {
    rule: `${url.protocol}//${url.hostname}:${port}`,
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port, username, password
  }
}

function bindProxyAuth(): void {
  if (authBound) return
  authBound = true
  app.on('login', (event, contents, _details, auth, callback) => {
    const proxy = contents && proxies.get(contents.session)
    if (!proxy) return
    event.preventDefault()
    if (auth.isProxy && auth.host.replace(/^\[|\]$/g, '') === proxy.host && auth.port === proxy.port) {
      callback(proxy.username, proxy.password)
    } else {
      // Never send proxy credentials to a destination website's authentication challenge.
      callback()
    }
  })
}

/** Must finish before creating any website WebContents or making account-related requests. */
export async function configurePortalProxy(ses: Electron.Session, input: string): Promise<void> {
  const proxy = parseProxy(input)
  bindProxyAuth()
  await ses.setProxy({
    mode: 'fixed_servers',
    proxyRules: proxy.rule,
    // Chromium otherwise bypasses proxies implicitly for localhost / loopback.
    proxyBypassRules: '<-loopback>'
  })
  proxies.set(ses, proxy)
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'fullscreen')
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'fullscreen'))
}

export function forgetPortalProxy(ses: Electron.Session): void {
  proxies.delete(ses)
}
