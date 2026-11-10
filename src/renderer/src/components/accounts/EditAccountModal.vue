<script setup lang="ts">
import { reactive, watch } from 'vue'
import { message } from 'ant-design-vue'
import RegionSelect from '@/components/common/RegionSelect.vue'
import { useAccountsStore } from '@/stores/accounts'
import { DEFAULT_REGION } from '@shared/regions'
import type { Account } from '@shared/types'

const props = defineProps<{ account: Account | null }>()
const emit = defineEmits<{ close: [] }>()

const accountsStore = useAccountsStore()

const form = reactive({
  nickname: '',
  note: '',
  password: '',
  portalProxyUrl: '',
  refreshToken: '',
  clientId: '',
  clientSecret: '',
  region: DEFAULT_REGION
})

watch(
  () => props.account,
  (account) => {
    if (!account) return
    form.nickname = account.nickname ?? ''
    form.note = account.note ?? ''
    form.password = account.password ?? ''
    form.portalProxyUrl = account.portalProxyUrl ?? ''
    form.refreshToken = account.credentials.refreshToken ?? ''
    form.clientId = account.credentials.clientId ?? ''
    form.clientSecret = account.credentials.clientSecret ?? ''
    form.region = account.credentials.region ?? DEFAULT_REGION
  },
  { immediate: true }
)

function submit(): void {
  const account = props.account
  if (!account) return
  if (!form.refreshToken.trim()) return void message.warning('Refresh Token 不能为空')

  accountsStore.updateAccount(account.id, {
    nickname: form.nickname.trim() || undefined,
    note: form.note.trim() || undefined,
    password: form.password.trim() || undefined,
    portalProxyUrl: form.portalProxyUrl.trim() || undefined,
    credentials: {
      ...account.credentials,
      refreshToken: form.refreshToken.trim(),
      clientId: form.clientId.trim() || undefined,
      clientSecret: form.clientSecret.trim() || undefined,
      region: form.region.trim() || DEFAULT_REGION
    }
  })
  message.success('已保存')
  emit('close')
}
</script>

<template>
  <a-modal
    :open="!!props.account"
    title="编辑账号"
    width="580px"
    ok-text="保存"
    cancel-text="取消"
    @ok="submit"
    @cancel="emit('close')"
  >
    <a-form layout="vertical">
      <a-form-item label="邮箱">
        <a-input :value="props.account?.email" disabled />
      </a-form-item>
      <a-row :gutter="12">
        <a-col :span="12">
          <a-form-item label="昵称">
            <a-input v-model:value="form.nickname" allow-clear />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="注册密码">
            <a-input v-model:value="form.password" allow-clear />
          </a-form-item>
        </a-col>
      </a-row>
      <a-form-item label="备注">
        <a-textarea v-model:value="form.note" :rows="2" allow-clear />
      </a-form-item>
      <a-form-item
        label="账号默认浏览器代理"
        extra="留空使用全局浏览器代理。打开前可选择全局代理或修改本次代理，不影响 API 请求。"
      >
        <a-input-password
          v-model:value="form.portalProxyUrl"
          placeholder="http://host:port 或 socks5://host:port"
          autocomplete="off"
          allow-clear
        />
      </a-form-item>
      <a-form-item label="Refresh Token">
        <a-textarea v-model:value="form.refreshToken" :rows="3" />
      </a-form-item>
      <a-row :gutter="12">
        <a-col :span="12">
          <a-form-item label="Client ID">
            <a-input v-model:value="form.clientId" allow-clear />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="Client Secret">
            <a-input-password v-model:value="form.clientSecret" allow-clear />
          </a-form-item>
        </a-col>
      </a-row>
      <a-form-item label="区域">
        <RegionSelect v-model:value="form.region" />
      </a-form-item>
    </a-form>
  </a-modal>
</template>
