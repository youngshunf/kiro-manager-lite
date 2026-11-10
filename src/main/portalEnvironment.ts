import { app, dialog } from 'electron'

/** 固定网页隐私环境；不修改 macOS 的系统语言、时区或持久 defaults。 */
export const PORTAL_TIME_ZONE = 'America/New_York'
export const PORTAL_LANGUAGE = 'en-US'
// Session.setUserAgent 自行生成 q 权重，必须传纯语言列表。
export const PORTAL_ACCEPT_LANGUAGE = 'en-US,en'
const APPLE_LANGUAGES = '(en-US,en)'
const RESTART_MARKER = 'KIRO_PORTAL_ENV_RESTART'
let configured = false

/** 必须在 app ready、单例锁与创建网页/Worker 之前调用。 */
export function configurePortalEnvironment(): void {
  if (app.isReady()) throw new Error('浏览器隐私环境必须在应用启动阶段配置')

  // Electron macOS 会把 NSLocale preferredLanguages 加到 navigator.languages 中。
  // --lang 或网络请求头不能覆盖它。NSArgumentDomain 仅对本应用进程生效。
  const args = process.argv.slice(1)
  // Accept only one canonical argument; normalize duplicate / alternate spellings on restart.
  const languageArgs = args.filter(arg => /^-{1,2}AppleLanguages(?:=|$)/.test(arg))
  const languagesIndex = args.indexOf('-AppleLanguages')
  const englishArguments = languageArgs.length === 1 && languagesIndex >= 0 && args[languagesIndex + 1] === APPLE_LANGUAGES
  const hasStartupEnvironment = process.env.TZ === PORTAL_TIME_ZONE && englishArguments

  if (process.platform === 'darwin' && !hasStartupEnvironment) {
    if (process.env[RESTART_MARKER] === '1') {
      dialog.showErrorBox('浏览器隐私环境未能初始化', '无法在启动时固定英语与纽约时区，应用已停止启动，不会退回系统地区。')
      app.exit(1)
      return
    }
    // TZ 必须在目标进程 exec 前存在，避免 browser/utility 中 ICU 已缓存系统时区。
    process.env.TZ = PORTAL_TIME_ZONE
    process.env[RESTART_MARKER] = '1'
    const restartArgs: string[] = []
    for (let index = 0; index < args.length; index++) {
      if (/^-{1,2}AppleLanguages$/.test(args[index])) { index++; continue }
      if (/^-{1,2}AppleLanguages=/.test(args[index])) continue
      restartArgs.push(args[index])
    }
    // Electron relauncher 继承当前环境，等待旧进程退出后再启动，避免单例锁竞争。
    app.relaunch({ args: [...restartArgs, '-AppleLanguages', APPLE_LANGUAGES] })
    app.exit(0)
    return
  }

  // 该原生偏好隔离方案仅在 macOS 上验证；其他平台不声称拥有相同保证。
  configured = process.platform === 'darwin' && hasStartupEnvironment
  delete process.env[RESTART_MARKER]
  app.commandLine.appendSwitch('lang', PORTAL_LANGUAGE)
}

export function assertPortalEnvironment(): void {
  if (!configured) {
    throw new Error('当前平台尚未验证固定英语与纽约时区的隐私环境，已禁止打开网页；目前仅支持 macOS')
  }
}
