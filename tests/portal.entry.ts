// Bundle the real public portal and settings interfaces into one Electron test process.
export { openAccountPortal, openInAppUrl, closePortalWindow, createLoginBrowser } from '../src/main/kiroPortal'
export { getSettings, setSettings } from '../src/main/store'
