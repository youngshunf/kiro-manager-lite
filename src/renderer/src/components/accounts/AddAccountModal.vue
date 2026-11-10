<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  ApiOutlined,
  ArrowLeftOutlined,
  CheckCircleFilled,
  CloudDownloadOutlined,
  CopyOutlined,
  FileTextOutlined,
  GlobalOutlined,
  GoogleOutlined,
  GithubOutlined,
  InboxOutlined,
  LoadingOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined
} from '@ant-design/icons-vue'
import RegionSelect from '@/components/common/RegionSelect.vue'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { isSocialIdp } from '@/utils/transfer'
import { copyText } from '@/utils/ui'
import { DEFAULT_REGION } from '@shared/regions'
import type {
  BrowserOpenInfo,
  IdpType,
  IpcResult,
  LoginPollResult,
  OnlineLoginCredentials,
  OnlineLoginMethod
} from '@shared/types'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  'update:open': [boolean]
  /** 转交给导入弹窗：本弹窗会先关掉自己 */
  'open-import': ['file' | 'text']
}>()

const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()

type Step = 'method' | 'online' | 'enterprise' | 'waiting' | 'oidc' | 'local'

const step = ref<Step>('method')
const submitting = ref(false)
const loadingLocal = ref(false)

/** 每次打开只复制一次全局默认值，编辑仅作用于本次单个账号添加。 */
const portalProxyUrl = ref('')

// 在线登录进行中的状态
const waiting = reactive({
  method: 'BuilderId' as OnlineLoginMethod,
  hint: '',
  userCode: '',
  error: '',
  /** 正在启动浏览器，尚未确认是否打开成功 */
  opening: false,
  /** 开始授权时锁定，等待期间不可修改。 */
  proxyUrl: '',
  /** 是否已打开代理内置无痕浏览器。 */
  proxied: false
})

const enterpriseForm = reactive({
  startUrl: settingsStore.settings.enterpriseStartUrl,
  region: settingsStore.settings.enterpriseRegion || DEFAULT_REGION
})

const form = reactive({
  refreshToken: '',
  clientId: '',
  clientSecret: '',
  region: DEFAULT_REGION,
  provider: 'BuilderId' as IdpType,
  nickname: '',
  password: ''
})

const methods = [
  {
    key: 'online' as const,
    title: '在线登录',
    desc: '使用代理内置无痕浏览器授权，自动获取凭证',
    icon: GlobalOutlined,
    recommended: true
  },
  { key: 'oidc' as const, title: 'OIDC 凭证', desc: '手动填写 Refresh Token 等凭证', icon: ApiOutlined },
  {
    key: 'local' as const,
    title: '本地 Kiro 凭证',
    desc: '读取 Kiro IDE 已登录的账号',
    icon: CloudDownloadOutlined
  }
]

/**
 * 批量导入的入口。这两项不在本弹窗里完成，点击后关掉自己、把场子交给对应的导入弹窗，
 * 与工具栏「导入」下拉里的两个入口指向同一处。
 */
const importEntries = [
  {
    key: 'file' as const,
    title: '从文件导入',
    desc: '拖拽或选择 JSON 文件，可一次多选',
    icon: InboxOutlined
  },
  {
    key: 'text' as const,
    title: '输入 JSON 导入',
    desc: '粘贴卡密、JSON、CSV 等文本',
    icon: FileTextOutlined
  }
]

function gotoImport(kind: 'file' | 'text'): void {
  close()
  emit('open-import', kind)
}

const providers: {
  key: OnlineLoginMethod
  title: string
  desc: string
  icon: typeof GoogleOutlined
  color: string
}[] = [
  { key: 'Google', title: 'Google 账号', desc: '使用 Google 账号快捷登录', icon: GoogleOutlined, color: '#ea4335' },
  { key: 'Github', title: 'GitHub 账号', desc: '使用 GitHub 账号快捷登录', icon: GithubOutlined, color: '#24292f' },
  {
    key: 'BuilderId',
    title: 'AWS Builder ID',
    desc: '设备码授权，适用于个人 Builder ID',
    icon: SafetyCertificateOutlined,
    color: '#ff9900'
  },
  {
    key: 'Enterprise',
    title: 'Enterprise',
    desc: 'IAM Identity Center SSO',
    icon: ApiOutlined,
    color: '#0972d3'
  }
]

const isSocial = (): boolean => isSocialIdp(form.provider)

/** 手填凭证时的登录方式选项：social 只要 refreshToken，IdC 还需要 clientId / secret */
const PROVIDER_OPTIONS: { value: IdpType; label: string }[] = [
  { value: 'BuilderId', label: 'Builder ID（IdC，需要 Client ID / Secret）' },
  { value: 'Enterprise', label: 'Enterprise（IdC，需要 Client ID / Secret）' },
  { value: 'Github', label: 'GitHub（社交登录，只需 Refresh Token）' },
  { value: 'Google', label: 'Google（社交登录，只需 Refresh Token）' }
]

/** 各步骤的标题与副标题；waiting 步骤的副标题是实时提示，单独取 */
const STEP_TEXT: Record<Step, { title: string; sub: string }> = {
  method: { title: '添加账号', sub: '设置单个账号的代理，再选择添加方式' },
  online: { title: '选择登录方式', sub: '通过代理内置无痕浏览器授权，完成后自动添加' },
  enterprise: { title: 'Enterprise SSO', sub: '填写组织的 IAM Identity Center 地址' },
  waiting: { title: '等待浏览器授权', sub: '' },
  oidc: { title: '凭证信息', sub: '确认凭证后会联网校验并拉取用量' },
  local: { title: '凭证信息', sub: '确认凭证后会联网校验并拉取用量' }
}

/**
 * 只有停在「选择添加方式」这一步时允许点遮罩关闭。
 *
 * 再往后每一步都带着状态：在线登录已经拉起浏览器、正在等回调，
 * Enterprise 与 OIDC 则有填了一半的表单，误触遮罩就全白做了。
 * 从这些步骤返回到 method 后会自动恢复可关。
 */
const maskClosable = computed(() => step.value === 'method')

const stepTitle = computed(() => STEP_TEXT[step.value].title)
const stepSub = computed(() =>
  step.value === 'waiting' ? waiting.hint : STEP_TEXT[step.value].sub
)

let pollTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribeSocial: (() => void) | null = null
let loginAttempt = 0

function isCurrentLogin(attempt: number): boolean {
  return props.open && step.value === 'waiting' && attempt === loginAttempt
}

function stopPolling(): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

function teardownLogin(): void {
  loginAttempt++
  submitting.value = false
  stopPolling()
  unsubscribeSocial?.()
  unsubscribeSocial = null
  void window.api.cancelLogin()
}

function requireOnlineProxy(): boolean {
  if (portalProxyUrl.value.trim()) return true
  message.warning('在线登录必须填写代理地址，不会回退到直连或外部浏览器')
  return false
}

/** 开始授权时锁定代理，并丢弃前一轮异步结果。 */
function beginWaiting(method: OnlineLoginMethod): number {
  const attempt = ++loginAttempt
  waiting.method = method
  waiting.proxyUrl = portalProxyUrl.value.trim()
  waiting.proxied = false
  waiting.opening = true
  waiting.hint = '正在打开代理内置无痕浏览器，请稍候…'
  waiting.error = ''
  waiting.userCode = ''
  submitting.value = false
  step.value = 'waiting'
  return attempt
}

function resetAll(): void {
  loginAttempt++
  step.value = 'method'
  submitting.value = false
  loadingLocal.value = false
  waiting.hint = ''
  waiting.userCode = ''
  waiting.error = ''
  waiting.opening = false
  waiting.proxyUrl = ''
  waiting.proxied = false
  portalProxyUrl.value = settingsStore.settings.portalProxyUrl.trim()
  enterpriseForm.startUrl = settingsStore.settings.enterpriseStartUrl
  enterpriseForm.region = settingsStore.settings.enterpriseRegion || DEFAULT_REGION
  form.refreshToken = ''
  form.clientId = ''
  form.clientSecret = ''
  form.region = DEFAULT_REGION
  form.provider = 'BuilderId'
  form.nickname = ''
  form.password = ''
}

watch(
  () => props.open,
  (open, previousOpen) => {
    if (open) resetAll()
    else if (previousOpen) teardownLogin()
  },
  { immediate: true }
)

onUnmounted(teardownLogin)

function close(): void {
  loginAttempt++
  emit('update:open', false)
}

// ============ 在线登录 ============

async function finishOnline(credentials: OnlineLoginCredentials, attempt: number): Promise<void> {
  if (!isCurrentLogin(attempt) || submitting.value) return
  stopPolling()
  unsubscribeSocial?.()
  unsubscribeSocial = null
  submitting.value = true
  waiting.hint = '正在通过代理校验凭证并获取账号信息…'
  try {
    const res = await accountsStore.addByOnlineLogin(
      credentials,
      { portalProxyUrl: credentials.portalProxyUrl?.trim() || waiting.proxyUrl },
      () => isCurrentLogin(attempt)
    )
    if (!isCurrentLogin(attempt)) return
    if (!res.ok) {
      waiting.error = res.error || '添加失败'
      return
    }
    message.success(`已添加 ${res.account?.email}`)
    close()
  } catch {
    if (isCurrentLogin(attempt)) waiting.error = '代理校验失败，请重试'
  } finally {
    if (isCurrentLogin(attempt)) submitting.value = false
  }
}

/** Enterprise 授权码回调由本地服务器接收，轮询只是取结果，间隔可以短一些 */
const ENTERPRISE_POLL_MS = 1500
/** 设备码接口回 slow_down 时的间隔增量 */
const SLOW_DOWN_STEP_MS = 5000

/**
 * 轮询授权结果。Builder ID 与 Enterprise 的处理完全一致：
 * 失败就把错误摆到界面上，完成就入库，否则按间隔继续等。
 * 服务端要求放慢（slow_down）时把间隔往上加。
 */
function pollLogin(
  request: () => Promise<IpcResult<LoginPollResult>>,
  intervalMs: number,
  attempt: number
): void {
  pollTimer = setTimeout(async () => {
    if (!isCurrentLogin(attempt)) return
    try {
      const res = await request()
      if (!isCurrentLogin(attempt)) return
      if (!res.success) {
        waiting.error = res.error || '授权失败'
        return
      }
      if (res.data?.completed && res.data.credentials) {
        await finishOnline(res.data.credentials, attempt)
        return
      }
      pollLogin(request, res.data?.slowDown ? intervalMs + SLOW_DOWN_STEP_MS : intervalMs, attempt)
    } catch {
      if (isCurrentLogin(attempt)) waiting.error = '获取授权结果失败，请重试'
    }
  }, intervalMs)
}

async function startSocial(provider: 'Google' | 'Github'): Promise<void> {
  if (!requireOnlineProxy()) return
  const attempt = beginWaiting(provider)

  unsubscribeSocial?.()
  unsubscribeSocial = window.api.onSocialCallback(async (payload) => {
    if (!isCurrentLogin(attempt)) return
    if (payload.error) {
      waiting.error = `授权失败：${payload.error}`
      return
    }
    if (!payload.code || !payload.state) return
    waiting.hint = '正在通过代理交换 Token…'
    try {
      const res = await window.api.completeSocialLogin(payload.code, payload.state)
      if (!isCurrentLogin(attempt)) return
      if (!res.success || !res.data) {
        waiting.error = res.error || 'Token 交换失败'
        return
      }
      await finishOnline(res.data, attempt)
    } catch {
      if (isCurrentLogin(attempt)) waiting.error = 'Token 交换失败，请重试'
    }
  })

  try {
    const res = await window.api.startSocialLogin(provider, true, { proxyUrl: waiting.proxyUrl })
    if (!isCurrentLogin(attempt)) return
    waiting.opening = false
    if (!res.success || !res.data) {
      waiting.error = res.error || '启动登录失败'
      return
    }
    applyOpenInfo(res.data)
  } catch {
    if (isCurrentLogin(attempt)) {
      waiting.opening = false
      waiting.error = '启动代理登录失败，请检查代理后重试'
    }
  }
}

/** 代理登录只使用内置无痕浏览器，不提示外部浏览器回退。 */
function applyOpenInfo(info?: BrowserOpenInfo): void {
  waiting.proxied = !!info?.proxied
  if (!waiting.proxied) {
    waiting.error = '未确认代理浏览器已打开，请返回检查代理后重试'
    return
  }
  waiting.hint = waiting.userCode
    ? '已打开代理内置无痕浏览器，请确认下方验证码后完成授权'
    : '已打开代理内置无痕浏览器，请完成授权后自动返回'
}

async function startBuilderId(): Promise<void> {
  if (!requireOnlineProxy()) return
  const attempt = beginWaiting('BuilderId')

  try {
    const res = await window.api.startBuilderIdLogin(DEFAULT_REGION, true, { proxyUrl: waiting.proxyUrl })
    if (!isCurrentLogin(attempt)) return
    waiting.opening = false
    if (!res.success || !res.data) {
      waiting.error = res.error || '启动登录失败'
      return
    }
    waiting.userCode = res.data.userCode
    applyOpenInfo(res.data)
    if (waiting.error) return
    pollLogin(window.api.pollBuilderIdLogin, Math.max(2, res.data.interval) * 1000, attempt)
  } catch {
    if (isCurrentLogin(attempt)) {
      waiting.opening = false
      waiting.error = '启动代理登录失败，请检查代理后重试'
    }
  }
}

async function startEnterprise(): Promise<void> {
  if (!requireOnlineProxy()) return
  if (!/^https:\/\//i.test(enterpriseForm.startUrl.trim())) {
    return void message.warning('请填写以 https:// 开头的 SSO Start URL')
  }
  const attempt = beginWaiting('Enterprise')

  const startUrl = enterpriseForm.startUrl.trim()
  // 记住本次填写的地址与区域，下次打开自动回填；不改全局代理。
  void settingsStore.update({
    enterpriseStartUrl: startUrl,
    enterpriseRegion: enterpriseForm.region
  })

  try {
    const res = await window.api.startEnterpriseLogin(startUrl, enterpriseForm.region, true, {
      proxyUrl: waiting.proxyUrl
    })
    if (!isCurrentLogin(attempt)) return
    waiting.opening = false
    if (!res.success || !res.data) {
      waiting.error = res.error || '启动登录失败'
      return
    }
    applyOpenInfo(res.data)
    if (waiting.error) return
    pollLogin(window.api.pollEnterpriseLogin, ENTERPRISE_POLL_MS, attempt)
  } catch {
    if (isCurrentLogin(attempt)) {
      waiting.opening = false
      waiting.error = '启动代理登录失败，请检查代理后重试'
    }
  }
}

function pickMethod(key: 'online' | 'oidc' | 'local'): void {
  if (key === 'online' && !requireOnlineProxy()) return
  if (key === 'local') return void loadFromLocalKiro()
  step.value = key
}

function pickProvider(key: OnlineLoginMethod): void {
  if (!requireOnlineProxy()) return
  if (key === 'Google' || key === 'Github') return void startSocial(key)
  if (key === 'BuilderId') return void startBuilderId()
  step.value = 'enterprise'
}

function retryWaiting(): void {
  teardownLogin()
  waiting.error = ''
  if (waiting.method === 'Enterprise') void startEnterprise()
  else if (waiting.method === 'BuilderId') void startBuilderId()
  else void startSocial(waiting.method as 'Google' | 'Github')
}

function backToOnline(): void {
  teardownLogin()
  waiting.error = ''
  step.value = 'online'
}

function goBack(): void {
  if (step.value === 'waiting' || step.value === 'enterprise') backToOnline()
  else {
    loginAttempt++
    submitting.value = false
    step.value = 'method'
  }
}

function copyUserCode(): void {
  if (!waiting.userCode) return
  copyText(waiting.userCode, '验证码已复制')
}

async function reopenBrowser(): Promise<void> {
  if (waiting.opening || submitting.value) return
  const attempt = loginAttempt
  waiting.opening = true
  try {
    const res = await window.api.reopenLoginBrowser()
    if (!isCurrentLogin(attempt)) return
    if (!res.success) {
      waiting.error = res.error || '重新打开代理浏览器失败'
      return
    }
    applyOpenInfo(res.data)
  } catch {
    if (isCurrentLogin(attempt)) waiting.error = '重新打开代理浏览器失败，请重试'
  } finally {
    if (isCurrentLogin(attempt)) waiting.opening = false
  }
}

// ============ 本地凭证 / 手动凭证 ============

async function loadFromLocalKiro(): Promise<void> {
  if (loadingLocal.value) return
  const attempt = loginAttempt
  loadingLocal.value = true
  try {
    const res = await window.api.readLocalKiroCredentials()
    if (!props.open || attempt !== loginAttempt) return
    if (!res.success || !res.data) return void message.error(res.error || '读取失败')
    form.refreshToken = res.data.refreshToken
    form.clientId = res.data.clientId
    form.clientSecret = res.data.clientSecret
    form.region = res.data.region
    form.provider = res.data.provider
    step.value = 'oidc'
    message.success('已读取本地 Kiro 凭证，确认后点击添加')
  } finally {
    if (attempt === loginAttempt) loadingLocal.value = false
  }
}

async function submitCredentials(): Promise<void> {
  if (submitting.value) return
  if (!form.refreshToken.trim()) return void message.warning('请填写 Refresh Token')
  if (!isSocial() && (!form.clientId.trim() || !form.clientSecret.trim())) {
    return void message.warning('IdC 账号需要 Client ID 与 Client Secret')
  }

  const attempt = ++loginAttempt
  const canAdd = (): boolean =>
    props.open && (step.value === 'oidc' || step.value === 'local') && attempt === loginAttempt
  submitting.value = true
  try {
    const res = await accountsStore.addByCredentials(
      {
        refreshToken: form.refreshToken.trim(),
        clientId: form.clientId.trim() || undefined,
        clientSecret: form.clientSecret.trim() || undefined,
        region: form.region.trim() || DEFAULT_REGION,
        provider: form.provider,
        nickname: form.nickname.trim() || undefined,
        password: form.password.trim() || undefined,
        portalProxyUrl: portalProxyUrl.value.trim() || undefined
      },
      canAdd
    )
    if (!canAdd()) return
    if (!res.ok) return void message.error(res.error || '添加失败')
    message.success(`已添加 ${res.account?.email}`)
    close()
  } catch {
    if (canAdd()) message.error('凭证校验失败，请检查代理或网络设置后重试')
  } finally {
    if (attempt === loginAttempt) submitting.value = false
  }
}
</script>

<template>
  <a-modal
    :open="props.open"
    :footer="null"
    :width="step === 'oidc' ? 620 : 480"
    :title="null"
    :closable="false"
    :mask-closable="maskClosable"
    centered
    @cancel="close"
  >
    <div class="add-head">
      <a-button
        v-if="step !== 'method'"
        type="text"
        size="small"
        class="back"
        @click="goBack"
      >
        <ArrowLeftOutlined />
      </a-button>
      <div>
        <h3 class="add-title">{{ stepTitle }}</h3>
        <p class="add-sub">{{ stepSub }}</p>
      </div>
      <a-button type="text" size="small" class="close" @click="close">✕</a-button>
    </div>

    <div class="proxy-field">
      <label class="proxy-label" for="add-account-proxy">单个账号添加代理</label>
      <a-input-password
        id="add-account-proxy"
        v-model:value="portalProxyUrl"
        :disabled="step === 'waiting' || submitting || loadingLocal"
        placeholder="http://user:pass@host:port 或 socks5://host:port"
        autocomplete="off"
        allow-clear
      />
      <p class="add-sub">
        用于在线登录与添加校验，成功后保存为该账号的默认浏览器代理，不修改全局设置。
        支持 HTTP/HTTPS 和无认证 SOCKS5。在线登录必填；凭证添加可留空，沿用现有网络设置。
      </p>
    </div>

    <!-- 方式选择 -->
    <div v-if="step === 'method'" class="option-list">
      <button
        v-for="item in methods"
        :key="item.key"
        class="option"
        @click="pickMethod(item.key)"
      >
        <span class="option-icon"><component :is="item.icon" /></span>
        <span class="option-text">
          <span class="option-title">
            {{ item.title }}
            <a-tag v-if="item.recommended" color="green" :bordered="false">推荐</a-tag>
          </span>
          <span class="option-desc">{{ item.desc }}</span>
        </span>
        <LoadingOutlined v-if="item.key === 'local' && loadingLocal" />
      </button>

      <div class="option-group-label">或批量导入已有账号（不使用上方代理）</div>
      <button
        v-for="item in importEntries"
        :key="item.key"
        class="option"
        @click="gotoImport(item.key)"
      >
        <span class="option-icon"><component :is="item.icon" /></span>
        <span class="option-text">
          <span class="option-title">{{ item.title }}</span>
          <span class="option-desc">{{ item.desc }}</span>
        </span>
      </button>
    </div>

    <!-- 在线登录：选择提供方 -->
    <template v-else-if="step === 'online'">
      <div class="option-list">
        <button
          v-for="item in providers"
          :key="item.key"
          class="option"
          @click="pickProvider(item.key)"
        >
          <span class="option-icon" :style="{ color: item.color }">
            <component :is="item.icon" />
          </span>
          <span class="option-text">
            <span class="option-title">{{ item.title }}</span>
            <span class="option-desc">{{ item.desc }}</span>
          </span>
        </button>
      </div>
      <a-alert
        type="info"
        show-icon
        style="margin-top: 12px"
        message="使用隔离的代理内置无痕浏览器，不复用已登录身份；代理失败时不会回退直连或外部浏览器。"
      />
    </template>

    <!-- Enterprise 表单 -->
    <template v-else-if="step === 'enterprise'">
      <a-form layout="vertical">
        <a-form-item label="SSO Start URL" required>
          <a-input
            v-model:value="enterpriseForm.startUrl"
            placeholder="https://d-xxxxxxxxxx.awsapps.com/start"
          />
        </a-form-item>
        <a-form-item label="SSO 区域">
          <RegionSelect v-model:value="enterpriseForm.region" />
        </a-form-item>
      </a-form>
      <a-button type="primary" block size="large" style="margin-top: 6px" @click="startEnterprise">
        打开代理浏览器授权
      </a-button>
    </template>

    <!-- 等待授权 -->
    <div v-else-if="step === 'waiting'" class="waiting">
      <template v-if="waiting.error">
        <a-result status="error" :title="waiting.error" sub-title="可以重试，或返回选择其它登录方式">
          <template #extra>
            <a-space>
              <a-button @click="backToOnline">返回</a-button>
              <a-button type="primary" @click="retryWaiting">重试</a-button>
            </a-space>
          </template>
        </a-result>
      </template>
      <template v-else>
        <LoadingOutlined class="spinner" />
        <p class="add-sub" style="text-align: center">{{ waiting.hint }}</p>

        <!-- 浏览器打开成功后才展示无痕结果 / 验证码 / 重新打开 -->
        <template v-if="!waiting.opening">
          <div v-if="waiting.proxied" class="private-hint">
            <a-tag color="green" :bordered="false">
              <SafetyCertificateOutlined />
              代理内置无痕浏览器已打开
            </a-tag>
          </div>

          <div v-if="waiting.userCode" class="code-box">
            <span class="code">{{ waiting.userCode }}</span>
            <a-button type="text" size="small" @click="copyUserCode">
              <CopyOutlined />
            </a-button>
          </div>
        </template>

        <a-space :size="12" style="justify-content: center; width: 100%; margin-top: 22px">
          <a-button v-if="!waiting.opening && !submitting" @click="reopenBrowser">
            <template #icon><ReloadOutlined /></template>
            重新打开浏览器
          </a-button>
          <a-button @click="backToOnline">取消</a-button>
        </a-space>
      </template>
    </div>

    <!-- 凭证表单 -->
    <template v-else>
      <a-form layout="vertical">
        <a-form-item label="登录方式" required>
          <a-select v-model:value="form.provider" :options="PROVIDER_OPTIONS" />
        </a-form-item>

        <a-form-item label="Refresh Token" required>
          <a-textarea
            v-model:value="form.refreshToken"
            :rows="3"
            placeholder="请输入 Refresh Token"
            allow-clear
          />
        </a-form-item>

        <a-row :gutter="12">
          <a-col :span="12">
            <a-form-item label="Client ID" :required="!isSocial()">
              <a-input
                v-model:value="form.clientId"
                :disabled="isSocial()"
                :placeholder="isSocial() ? '社交登录无需填写' : '请输入 Client ID'"
                allow-clear
              />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="Client Secret" :required="!isSocial()">
              <a-input-password
                v-model:value="form.clientSecret"
                :disabled="isSocial()"
                :placeholder="isSocial() ? '社交登录无需填写' : '请输入 Client Secret'"
                allow-clear
              />
            </a-form-item>
          </a-col>
        </a-row>

        <!-- 区域内部是「预设下拉 + 自定义输入」两个控件，独占一行才不会被挤变形 -->
        <a-form-item label="区域">
          <RegionSelect v-model:value="form.region" />
        </a-form-item>

        <a-row :gutter="12">
          <a-col :span="12">
            <a-form-item label="昵称（可选）">
              <a-input
                v-model:value="form.nickname"
                placeholder="留空则使用邮箱前缀"
                allow-clear
              />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="注册密码（可选）">
              <a-input
                v-model:value="form.password"
                placeholder="请输入注册密码，仅本地保存备查"
                allow-clear
              />
            </a-form-item>
          </a-col>
        </a-row>
      </a-form>

      <a-space style="width: 100%; justify-content: flex-end">
        <a-button @click="goBack">返回</a-button>
        <a-button type="primary" :loading="submitting" @click="submitCredentials">
          <template #icon><CheckCircleFilled /></template>
          校验并添加
        </a-button>
      </a-space>
    </template>
  </a-modal>
</template>

<style scoped>
.add-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 22px;
}

.add-head > div {
  flex: 1 1 auto;
  min-width: 0;
}

.add-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

/* 无痕状态标签与上方提示文字之间留出呼吸空间 */
.private-hint {
  margin-top: 12px;
  text-align: center;
}

.add-sub {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--kal-muted);
}

.option-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 4px;
}

.back,
.close {
  margin-top: 2px;
}

/* 分组小标题：把「新增一个账号」与「批量导入已有账号」两类入口隔开 */
.option-group-label {
  margin-top: 4px;
  font-size: 12px;
  color: var(--kal-muted);
}

.option {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 13px 14px;
  border: 1px solid var(--kal-border);
  border-radius: 14px;
  background: var(--kal-code-bg);
  cursor: pointer;
  text-align: left;
  transition:
    border-color 0.16s ease,
    transform 0.16s ease,
    background 0.16s ease;
}

.option:hover {
  border-color: var(--kal-primary);
  transform: translateY(-1px);
}

.option-icon {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  background: var(--kal-card-bg);
  font-size: 17px;
}

.option-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1 1 auto;
}

.option-title {
  font-size: 14px;
  font-weight: 600;
}

.option-desc {
  font-size: 12px;
  color: var(--kal-muted);
}

.proxy-field {
  margin-bottom: 18px;
}

.proxy-label {
  display: block;
  margin-bottom: 8px;
  font-size: 14px;
}

.waiting {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 240px;
  padding: 16px 0 12px;
  /* 子项默认按内容撑宽，长错误文本会顶破弹窗；限制成满宽再由内部换行 */
  width: 100%;
  min-width: 0;
}

/*
 * 授权失败时 a-result 的标题直接放上游错误原文，可能是整段 JSON。
 * 这类串没有空格可断行，必须按字符断开，否则会横向溢出弹窗。
 */
.waiting :deep(.ant-result) { width: 100%; max-width: 100%; padding: 24px 16px; }
.waiting :deep(.ant-result-title) {
  font-size: 15px;
  line-height: 1.7;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.waiting :deep(.ant-result-subtitle) { word-break: break-word; overflow-wrap: anywhere; }

.spinner {
  display: block;
  text-align: center;
  font-size: 34px;
  color: var(--kal-primary);
  margin: 6px 0 18px;
}

.code-box {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 14px;
  padding: 12px;
  border-radius: 12px;
  background: var(--kal-code-bg);
}

.code {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 22px;
  letter-spacing: 3px;
  font-weight: 600;
}
</style>
