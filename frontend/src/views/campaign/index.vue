<template>
  <section class="page" data-module="campaign">
    <header class="page-head">
      <div>
        <h2>防火宣传管理</h2>
        <p class="page-desc">维护防火宣传活动，围绕活动编号、宣传主题、宣传方式、覆盖村组做登记、筛选与状态流转，支持村组覆盖计划文件导入与成果归档打包。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火宣传活动</button>
        <button class="btn" type="button" @click="pickPlanFile">导入村组覆盖计划</button>
        <button class="btn ghost" type="button" @click="downloadTemplate">下载导入模板</button>
        <button class="btn" type="button" @click="exportRows">导出防火宣传清单</button>
        <button class="btn" type="button" @click="packageResults">打包下载活动成果</button>
        <input ref="planFileInput" type="file" accept=".csv,text/csv" hidden @change="onPlanFilePicked" />
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无防火宣传数据，可先登记防火宣传活动</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条防火宣传记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  archiveCampaign,
  downloadCampaignResults,
  downloadEntries,
  downloadPlanTemplate,
  ensureCampaignNumbers,
  importCampaignPlan,
  listEntries,
  moduleMeta,
  parseAudience,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('campaign')
const columns = ["活动编号", "宣传主题", "宣传方式", "覆盖村组", "执行人员", "活动日期", "受众人数", "活动状态"]
const actions = ["开展活动", "确认完成", "归档成果", "取消活动"]
const statuses = ["待开展", "进行中", "已完成", "已归档", "已取消"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const planFileInput = ref<HTMLInputElement | null>(null)

const stats = computed(() => {
  const now = new Date()
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  return [
    {
      label: '本月活动数',
      value: rows.value.filter((row) => String(row['活动日期'] ?? '').startsWith(monthPrefix)).length,
    },
    {
      label: '已完成数',
      value: rows.value.filter((row) => ['已完成', '已归档'].includes(String(row.status))).length,
    },
    {
      label: '覆盖人次',
      value: rows.value.reduce((sum, row) => sum + parseAudience(row['受众人数']), 0),
    },
  ]
})
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '防火宣传活动登记入口尚未接入审批流'
}

function pickPlanFile() {
  planFileInput.value?.click()
}

async function onPlanFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) {
    return
  }
  const result = importCampaignPlan(file.name, await file.text())
  reload()
  showResult(result.ok, result.message)
}

function downloadTemplate() {
  downloadPlanTemplate()
  showResult(true, '导入模板已下载：活动编号可留空，导入后按采集日期自动回填')
}

function packageResults() {
  const result = downloadCampaignResults()
  reload()
  showResult(result.ok, result.message)
}

function runAction(action: string, row: EntryRow) {
  if (action === '归档成果') {
    const result = archiveCampaign(Number(row.id))
    reload()
    showResult(result.ok, result.message)
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    noticeMessage.value = ''
    return
  }
  reload()
}

function showResult(ok: boolean, message: string) {
  noticeMessage.value = ok ? message : ''
  errorMessage.value = ok ? '' : message
}

function reload() {
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '防火宣传列表读取失败'
  }
}

onMounted(() => {
  // 存量活动缺编号的按采集日期回填，旧数据继续兼容
  const filled = ensureCampaignNumbers()
  reload()
  if (filled > 0) {
    noticeMessage.value = `已按采集日期为 ${filled} 条存量活动回填活动编号`
  }
})
</script>
