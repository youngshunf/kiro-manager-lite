import { Alert, Button, Form, Input, Modal, Radio } from 'ant-design-vue'
import { computed, defineComponent, h, ref } from 'vue'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { toPlain } from '@/utils/ipc'
import type { Account, IpcResult, PortalOpenOptions } from '@shared/types'

type BrowserOpenResult = IpcResult<{ url: string }> | null

/** 每次打开都重新确认；本次自定义代理不写回账号或全局设置。 */
function confirmPortalProxy(account: Account): Promise<PortalOpenOptions | null> {
  const settingsStore = useSettingsStore()
  const customProxy = ref(account.portalProxyUrl?.trim() ?? '')
  const mode = ref<'global' | 'custom'>(customProxy.value ? 'custom' : 'global')
  const globalProxy = computed(() => settingsStore.settings.portalProxyUrl?.trim() ?? '')
  const effectiveProxy = computed(() =>
    mode.value === 'global' ? globalProxy.value : customProxy.value.trim()
  )

  return new Promise((resolve) => {
    let settled = false
    let instance: { destroy: () => void } | undefined
    function finish(options: PortalOpenOptions | null): void {
      if (settled) return
      settled = true
      resolve(options)
      instance?.destroy()
    }

    const Content = defineComponent({
      setup() {
        return () => h('div', [
          h(Alert, {
            type: 'info',
            showIcon: true,
            message: '每次打开都会新建独立的 Chromium 私密会话，不复用已有窗口的登录状态。代理不可用时不会回退直连。',
            style: 'margin-bottom:16px'
          }),
          h(Form, { layout: 'vertical' }, {
            default: () => [
              h(Form.Item, { label: '本次使用的浏览器代理' }, {
                default: () => h(Radio.Group, {
                  value: mode.value,
                  'onUpdate:value': (value: 'global' | 'custom') => (mode.value = value)
                }, {
                  default: () => [
                    h(Radio, { value: 'global' }, {
                      default: () => `使用全局代理（${globalProxy.value ? '已配置' : '未配置'}）`
                    }),
                    h(Radio, { value: 'custom' }, { default: () => '本次自定义' })
                  ]
                })
              }),
              mode.value === 'custom'
                ? h(Form.Item, {
                    label: '本次代理地址',
                    validateStatus: effectiveProxy.value ? undefined : 'error',
                    help: effectiveProxy.value ? undefined : '请填写代理地址，不能留空或直连。',
                    extra: account.portalProxyUrl?.trim()
                      ? '已预填账号默认代理；修改只用于本次打开，不会保存。'
                      : '只用于本次打开，不会修改账号默认代理或全局代理。'
                  }, {
                    default: () => h(Input.Password, {
                      value: customProxy.value,
                      'onUpdate:value': (value: string) => (customProxy.value = value),
                      placeholder: 'http://host:port 或 socks5://host:port',
                      autocomplete: 'off',
                      allowClear: true,
                      onPressEnter: () => {
                        if (effectiveProxy.value) finish({ proxyUrl: effectiveProxy.value })
                      }
                    })
                  })
                : null,
              !effectiveProxy.value
                ? h(Alert, {
                    type: 'warning',
                    showIcon: true,
                    message: mode.value === 'global'
                      ? '尚未配置全局浏览器代理。请前往「设置 → 内置浏览器」配置，或选择「本次自定义」填写代理后再打开。'
                      : '必须配置全局或本次自定义代理后才能打开，不支持直连。'
                  })
                : null
            ]
          }),
          h('p', { style: 'margin:12px 0 0;color:var(--kal-muted);font-size:12px' },
            '浏览器代理独立于 API 代理。HTTP 代理支持用户名/密码（user:pass）；SOCKS 代理不支持用户名/密码。全局修改只影响之后新开的窗口。')
        ])
      }
    })

    const Footer = defineComponent({
      setup() {
        return () => h('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:24px' }, [
          h(Button, { onClick: () => finish(null) }, { default: () => '取消' }),
          h(Button, {
            type: 'primary',
            disabled: !effectiveProxy.value,
            onClick: () => {
              if (effectiveProxy.value) finish({ proxyUrl: effectiveProxy.value })
            }
          }, { default: () => '打开私密窗口' })
        ])
      }
    })

    instance = Modal.confirm({
      title: '打开独立私密窗口',
      width: 560,
      centered: true,
      // 从抽屉、订阅弹窗或卡片菜单发起时，确认框始终位于最上层。
      zIndex: 1200,
      icon: null,
      content: () => h(Content),
      footer: () => h(Footer),
      onCancel: () => finish(null),
      afterClose: () => finish(null)
    })
  })
}

/** 官网入口：显式传已确认的代理，使「使用全局」也能覆盖账号默认代理。 */
export async function openAccountPortal(account: Account): Promise<BrowserOpenResult> {
  const target = useAccountsStore().get(account.id) ?? account
  const options = await confirmPortalProxy(target)
  if (!options) return null
  return window.api.openAccountPortal(toPlain(target), options)
}

/** 订阅等 URL 入口同样按当前账号选择代理，不复用任何账号的既有会话。 */
export async function openAccountUrl(
  account: Account,
  url: string,
  title?: string
): Promise<BrowserOpenResult> {
  const target = useAccountsStore().get(account.id) ?? account
  const options = await confirmPortalProxy(target)
  if (!options) return null
  return window.api.openInAppBrowser(url, title, options)
}
