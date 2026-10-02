<template>
  <section class="page" data-module="campaign">
    <header class="page-head">
      <div>
        <h2>防火宣传管理</h2>
        <p class="page-desc">通过文件导入村组覆盖计划，活动结束后归档并打包下载成果；清单保留宣传主题、宣传方式、覆盖村组与执行人员。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="triggerImport">导入覆盖计划</button>
        <button class="btn" type="button" @click="downloadTemplate">下载导入模板</button>
        <button class="btn" type="button" @click="exportRows">导出宣传清单</button>
        <input
          ref="fileInput"
          type="file"
          accept=".csv,text/csv"
          hidden
          @change="handleFileChange"
        />
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
              v-for="action in actionsFor(row)"
              :key="action.key"
              class="link"
              type="button"
              @click="runAction(action.key, row)"
            >
              {{ action.label }}
            </button>
            <span v-if="actionsFor(row).length === 0" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无防火宣传数据，可先导入村组覆盖计划</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条防火宣传记录；同一活动文件重复上传只计一次受众</span>
      <span v-if="noticeMessage" :class="noticeOk ? 'ok-text' : 'error-text'">{{ noticeMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  applyCampaignAction,
  backfillCampaignCodes,
  campaignAudienceTotal,
  downloadCampaignPackage,
  downloadPlanTemplate,
  importCampaignPlan,
  type ImportSummary,
} from '@/api/campaign-service'
import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('campaign')
const columns = ['活动编号', '宣传主题', '宣传方式', '覆盖村组', '执行人员', '活动日期', '受众人数', '活动状态']
const statuses = ['待开展', '进行中', '已完成', '已归档', '已取消']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const noticeMessage = ref('')
const noticeOk = ref(true)
const filters = ref<Record<string, string>>({})
// 清单保留的四项，也作为检索入口。
const filterFields = ['宣传主题', '宣传方式', '覆盖村组']
const fileInput = ref<HTMLInputElement | null>(null)
const importing = ref(false)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '本月活动数', value: rows.value.length },
  {
    label: '已完成数',
    value: rows.value.filter((row) => ['已完成', '已归档'].includes(String(row.status))).length,
  },
  { label: '覆盖人次', value: campaignAudienceTotal() },
])

function actionsFor(row: EntryRow): { key: string; label: string }[] {
  switch (String(row.status)) {
    case '待开展':
      return [{ key: '开展活动', label: '开展活动' }]
    case '进行中':
      return [
        { key: '确认完成', label: '确认完成' },
        { key: '取消活动', label: '取消活动' },
      ]
    case '已完成':
      return [
        { key: '归档活动', label: '归档活动' },
        { key: '成果打包', label: '成果打包' },
      ]
    case '已归档':
      return [{ key: '成果打包', label: '成果打包' }]
    default:
      return []
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function downloadTemplate() {
  downloadPlanTemplate()
}

function triggerImport() {
  fileInput.value?.click()
}

function flash(message: string, ok = true) {
  noticeMessage.value = message
  noticeOk.value = ok
}

async function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 允许再次选择同一个文件时 change 事件仍会触发。
  input.value = ''
  if (!file || importing.value) {
    return
  }
  importing.value = true
  flash(`正在导入文件「${file.name}」…`, true)
  try {
    const summary: ImportSummary = await importCampaignPlan(file)
    const parts = [summary.message]
    if (summary.invalidDetails.length > 0) {
      parts.push(...summary.invalidDetails.slice(0, 5))
      if (summary.invalidDetails.length > 5) {
        parts.push(`其余 ${summary.invalidDetails.length - 5} 条无效记录已省略`)
      }
    }
    flash(parts.join('；'), summary.ok)
  } catch (error) {
    flash(error instanceof Error ? error.message : '文件导入失败', false)
  } finally {
    importing.value = false
    reload()
  }
}

function runAction(action: string, row: EntryRow) {
  if (action === '成果打包') {
    const result = downloadCampaignPackage(Number(row.id))
    flash(result.message, result.ok)
    return
  }
  const result = applyCampaignAction(Number(row.id), action)
  flash(result.message, result.ok)
  if (result.ok) {
    reload()
  }
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    flash(error instanceof Error ? error.message : '防火宣传列表读取失败', false)
  }
}

onMounted(() => {
  // 存量活动缺少编号的，按采集日期回填；旧活动与已有编号一律保持兼容不动。
  const backfilled = backfillCampaignCodes()
  if (backfilled > 0) {
    flash(`已按采集日期为 ${backfilled} 条存量活动补全活动编号`, true)
  }
  reload()
})
</script>

<style scoped>
.page-actions {
  display: flex;
  gap: 8px;
}
.muted-text {
  color: var(--muted);
}
.ok-text {
  color: #027a48;
}
</style>
