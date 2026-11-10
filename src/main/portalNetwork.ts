import { app, net } from 'electron'
import { recordOutbound } from './outboundLog'
import type { HttpRequestOptions, HttpResponse } from './net'

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

/** 主进程授权 / 校验请求也走同一 Chromium 会话，支持认证且绝不换回全局代理。 */
export function portalRequest(
  ses: Electron.Session,
  url: string,
  options: HttpRequestOptions = {}
): Promise<HttpResponse> {
  const proxy = proxies.get(ses)
  if (!proxy) return Promise.reject(new Error('登录代理会话已关闭，请重新开始'))
  recordOutbound(url)
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: options.method || 'GET', session: ses, useSessionCookies: false })
    const timer = setTimeout(() => { request.abort(); reject(new Error('代理请求超时')) }, options.timeoutMs ?? 30_000)
    request.on('login', (auth, callback) => {
      if (auth.isProxy && auth.host.replace(/^\[|\]$/g, '') === proxy.host && auth.port === proxy.port) {
        callback(proxy.username, proxy.password)
      } else callback()
    })
    request.on('error', error => { clearTimeout(timer); reject(error) })
    request.on('response', response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('error', error => { clearTimeout(timer); reject(error) })
      response.on('end', () => {
        clearTimeout(timer)
        const body = Buffer.concat(chunks)
        const values = response.headers
        const get = (name: string): string | null => {
          const value = values[name.toLowerCase()]
          return Array.isArray(value) ? value.join(', ') : value ?? null
        }
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          url,
          headers: {
            get,
            forEach: callback => Object.keys(values).forEach(name => callback(get(name) || '', name)),
            getSetCookie: () => {
              const value = values['set-cookie']
              return Array.isArray(value) ? value : value ? [value] : []
            }
          },
          text: async () => body.toString('utf8'),
          json: async <T>() => JSON.parse(body.toString('utf8')) as T,
          arrayBuffer: async () => Uint8Array.from(body).buffer
        })
      })
    })
    for (const [name, value] of Object.entries(options.headers ?? {})) request.setHeader(name, value)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}
