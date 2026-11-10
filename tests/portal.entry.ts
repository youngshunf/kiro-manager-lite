// Bundle the real public portal and settings interfaces into one Electron test process.
import { configurePortalEnvironment } from '../src/main/portalEnvironment'
configurePortalEnvironment()
export { openAccountPortal, openInAppUrl, closePortalWindow, createLoginBrowser } from '../src/main/kiroPortal'
export { getSettings, setSettings } from '../src/main/store'
