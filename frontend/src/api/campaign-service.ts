import { listRows, readJsonStore, saveRows, writeJsonStore } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'
import { parseCsv, toCsv } from '@/utils/csv'
import { downloadBlob } from '@/utils/download'
import { buildZip } from '@/utils/zip'

// 防火宣传的专属规则集中在这里：文件导入、编号回填、归档联动值勤协办、成果打包。
const CAMPAIGN_KEY = 'campaign'
const DUTY_KEY = 'duty'
const LEDGER_KEY = 'forest-fire-patrol:campaign-imports'

// 归档成果清单按要求只保留这四列。
const MANIFEST_FIELDS = ['宣传主题', '宣传方式', '覆盖村组', '执行人员'] as const
// 导入模板表头，括号里的别名在导入时也能识别。
const IMPORT_HEADERS = ['宣传主题', '宣传方式', '覆盖村组', '执行人员', '活动日期', '受众人数'] as const
const HEADER_ALIASES: Record<string, string[]> = {
  宣传主题: ['主题'],
  宣传方式: ['方式'],
  覆盖村组: ['村组'],
  执行人员: ['执行人', '宣传人员'],
  活动日期: ['采集日期', '日期'],
  受众人数: ['受众', '覆盖人次', '受众人次'],
}
const REQUIRED_FIELDS = ['宣传主题', '宣传方式', '覆盖村组', '执行人员']
const ARCHIVED_STATUS = '已归档'
const FINISHED_STATUS = '已完成'
const CSV_BOM = String.fromCharCode(0xfeff)

type ImportLedgerItem = {
  fingerprint: string
  fileName: string
  importedAt: string
  campaignCount: number
}

export type ImportSummary = {
  ok: boolean
  duplicate: boolean
  added: number
  merged: number
  invalid: number
  total: number
  fileName: string
  message: string
  invalidDetails: string[]
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function compactDate(value: string): string {
  const digits = value.replace(/[^\d]/g, '')
  return digits.length >= 8 ? digits.slice(0, 8) : ''
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

// 编号规则：CAMP-采集日期(YYYYMMDD)-同日序号。旧的 CAMP-0001 这类编号原样保留。
function buildCampaignCode(date: string, used: Set<string>, serials: Map<string, number>): string {
  const day = compactDate(date) || 'NODATE'
  const next = (serials.get(day) ?? 0) + 1
  let code = `CAMP-${day}-${pad2(next)}`
  while (used.has(code)) {
    const retry = (serials.get(day) ?? next) + 1
    serials.set(day, retry)
    code = `CAMP-${day}-${pad2(retry)}`
  }
  serials.set(day, (serials.get(day) ?? next))
  used.add(code)
  return code
}

// 已用编号与同日序号都从现存编号里反推，保证回填和后续导入不撞号。
function loadCodeState(rows: EntryRow[]): { used: Set<string>; serials: Map<string, number> } {
  const used = new Set<string>()
  const serials = new Map<string, number>()
  for (const row of rows) {
    const code = String(row['活动编号'] ?? '').trim()
    if (!code) {
      continue
    }
    used.add(code)
    const matched = /^CAMP-(\d{8}|NODATE)-(\d+)$/.exec(code)
    if (matched) {
      serials.set(matched[1], Math.max(serials.get(matched[1]) ?? 0, Number(matched[2])))
    }
  }
  return { used, serials }
}

// 存量活动按采集日期（活动日期）回填缺少的编号；带编号的旧活动一律不动，继续兼容。
export function backfillCampaignCodes(): number {
  const rows = listRows(CAMPAIGN_KEY)
  const { used, serials } = loadCodeState(rows)
  let touched = 0
  const next = rows.map((row) => {
    if (String(row['活动编号'] ?? '').trim()) {
      return row
    }
    const date = String(row['活动日期'] ?? row['采集日期'] ?? '')
    touched += 1
    return { ...row, 活动编号: buildCampaignCode(date, used, serials) }
  })
  if (touched > 0) {
    saveRows(CAMPAIGN_KEY, next)
  }
  return touched
}

function fingerprintContent(text: string): string {
  // 统一掉 BOM 和换行差异后做 FNV-1a，同一文件换机器/换换行保存仍是同一个指纹。
  const normalized = text.startsWith(CSV_BOM)
    ? text.slice(CSV_BOM.length).replace(/\r\n/g, '\n').trim()
    : text.replace(/\r\n/g, '\n').trim()
  let hash = 0x811c9dc5
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function readLedger(): ImportLedgerItem[] {
  return readJsonStore<ImportLedgerItem[]>(LEDGER_KEY, [])
}

function resolveHeader(header: string): string | null {
  const name = header.trim()
  if ((IMPORT_HEADERS as readonly string[]).includes(name)) {
    return name
  }
  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(name)) {
      return canonical
    }
  }
  return null
}

function parseAudience(value: string): string {
  const digits = value.replace(/[^\d]/g, '')
  return digits ? String(Number(digits)) : ''
}

// 文件导入村组覆盖计划：按覆盖村组判重（冲突时覆盖村组优先），同一文件重复导入不重复累计受众。
export async function importCampaignPlan(file: File): Promise<ImportSummary> {
  const text = await file.text()
  const fingerprint = fingerprintContent(text)
  const ledger = readLedger()

  const base: ImportSummary = {
    ok: false,
    duplicate: false,
    added: 0,
    merged: 0,
    invalid: 0,
    total: 0,
    fileName: file.name,
    message: '',
    invalidDetails: [],
  }

  const seen = ledger.find((item) => item.fingerprint === fingerprint)
  if (seen) {
    return {
      ...base,
      ok: true,
      duplicate: true,
      message: `文件「${file.name}」已于 ${seen.importedAt} 导入过，本次跳过，受众不重复累计。`,
    }
  }

  const grid = parseCsv(text).filter((cells) => cells.some((cell) => cell.trim() !== ''))
  if (grid.length < 2) {
    return { ...base, message: '文件里没有可导入的数据行，请按模板填写后再上传。' }
  }

  const headerMap = new Map<number, string>()
  grid[0].forEach((cell, index) => {
    const canonical = resolveHeader(cell)
    if (canonical) {
      headerMap.set(index, canonical)
    }
  })
  const missingHeaders = REQUIRED_FIELDS.filter((field) => ![...headerMap.values()].includes(field))
  if (missingHeaders.length > 0) {
    return {
      ...base,
      message: `表头缺少必填列：${missingHeaders.join('、')}。请使用「下载导入模板」获取标准格式。`,
    }
  }

  const rows = listRows(CAMPAIGN_KEY)
  const { used, serials } = loadCodeState(rows)
  const villageIndex = new Map<string, number>()
  rows.forEach((row, index) => {
    const village = String(row['覆盖村组'] ?? '').trim()
    if (village && !villageIndex.has(village)) {
      villageIndex.set(village, index)
    }
  })

  let added = 0
  let merged = 0
  let invalid = 0
  const invalidDetails: string[] = []
  const touchedVillages = new Set<string>()

  grid.slice(1).forEach((cells, rowNumber) => {
    const record: Record<string, string> = {}
    headerMap.forEach((field, column) => {
      record[field] = (cells[column] ?? '').trim()
    })
    const missing = REQUIRED_FIELDS.filter((field) => !record[field])
    if (missing.length > 0) {
      invalid += 1
      invalidDetails.push(`第 ${rowNumber + 2} 行缺少：${missing.join('、')}`)
      return
    }
    // 同一文件内若重复出现同村组，只算一次，避免一份文件自己把受众刷上去。
    if (touchedVillages.has(record['覆盖村组'])) {
      return
    }
    touchedVillages.add(record['覆盖村组'])

    const audience = parseAudience(record['受众人数'] ?? '')
    const existingIndex = villageIndex.get(record['覆盖村组'])
    if (existingIndex !== undefined) {
      // 新旧计划冲突按覆盖村组优先：同村组视为同一活动，用文件内容更新计划字段。
      const current = rows[existingIndex]
      const currentStatus = String(current.status ?? '待开展')
      const terminal = ['已完成', ARCHIVED_STATUS, '已取消'].includes(currentStatus)
      rows[existingIndex] = {
        ...current,
        宣传主题: record['宣传主题'],
        宣传方式: record['宣传方式'],
        执行人员: record['执行人员'],
        活动日期: record['活动日期'] || String(current['活动日期'] ?? ''),
        受众人数: audience || String(current['受众人数'] ?? ''),
        // 已结束/归档的活动不被导入打回；待开展或进行中的继续沿用原状态。
        status: terminal ? currentStatus : '待开展',
        pending: terminal ? Boolean(current.pending) : true,
        活动状态: terminal ? String(current['活动状态'] ?? currentStatus) : '待开展',
      }
      merged += 1
      return
    }

    const code = buildCampaignCode(record['活动日期'] ?? '', used, serials)
    rows.push({
      id: nextId(rows),
      status: '待开展',
      pending: true,
      abnormal: false,
      活动编号: code,
      宣传主题: record['宣传主题'],
      宣传方式: record['宣传方式'],
      覆盖村组: record['覆盖村组'],
      执行人员: record['执行人员'],
      活动日期: record['活动日期'] ?? '',
      受众人数: audience,
      活动状态: '待开展',
    })
    villageIndex.set(record['覆盖村组'], rows.length - 1)
    added += 1
  })

  saveRows(CAMPAIGN_KEY, rows)
  writeJsonStore(LEDGER_KEY, [
    ...ledger,
    {
      fingerprint,
      fileName: file.name,
      importedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      campaignCount: added + merged,
    },
  ])

  return {
    ok: true,
    duplicate: false,
    added,
    merged,
    invalid,
    total: grid.length - 1,
    fileName: file.name,
    invalidDetails,
    message:
      `文件「${file.name}」导入完成：新增 ${added} 条、按覆盖村组更新 ${merged} 条` +
      (invalid > 0 ? `、无效 ${invalid} 条` : '') +
      '，受众仅按本文件计一次。',
  }
}

export function downloadPlanTemplate(): void {
  const content =
    CSV_BOM +
    toCsv([
      [...IMPORT_HEADERS],
      ['秋冬季森林防火进村宣传', '院坝会+入户宣讲', '青山村一组', '李护林、王宣传', '2026-10-05', '86'],
      ['森林防火人人有责', '广播+宣传车', '青山村二组', '赵巡山', '2026-10-06', '120'],
    ])
  downloadBlob(new Blob([content], { type: 'text/csv;charset=utf-8' }), '村组覆盖计划-导入模板.csv')
}

function pendingOf(status: string): boolean {
  return status !== ARCHIVED_STATUS && status !== '已取消'
}

// 宣传活动动作：归档时联动一条值勤协办台账，重复归档不会重复同步。
export function applyCampaignAction(id: number, action: string): ActionResult {
  const rows = listRows(CAMPAIGN_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的防火宣传活动` }
  }
  const current = rows[index]
  const targetByAction: Record<string, string> = {
    开展活动: '进行中',
    确认完成: FINISHED_STATUS,
    归档活动: ARCHIVED_STATUS,
    取消活动: '已取消',
  }
  const target = targetByAction[action]
  if (!target) {
    return { ok: false, message: `防火宣传活动没有登记「${action}」这个动作` }
  }
  if (String(current.status) === target) {
    return { ok: false, message: `活动已经是「${target}」，不用重复操作` }
  }
  if (action === '归档活动' && String(current.status) !== FINISHED_STATUS) {
    return { ok: false, message: '只有「已完成」的活动才能归档，请先确认完成。' }
  }

  const updated: EntryRow = {
    ...current,
    status: target,
    pending: pendingOf(target),
    abnormal: action === '取消活动',
    活动状态: target,
  }
  if (target === ARCHIVED_STATUS) {
    updated['归档时间'] = new Date().toLocaleString('zh-CN', { hour12: false })
  }

  const next = [...rows]
  next[index] = updated
  saveRows(CAMPAIGN_KEY, next)

  let message = `防火宣传活动已${action}，当前状态「${target}」`
  if (target === ARCHIVED_STATUS) {
    const synced = syncDutyLedger(updated)
    message += synced ? '，值勤协办台账已同步一项。' : '，值勤协办台账此前已同步。'
  }
  return { ok: true, message }
}

// 归档完成后在「值勤排班」入口同步一条协办记录；按活动编号去重，保证只同步一项。
function syncDutyLedger(campaign: EntryRow): boolean {
  const dutyRows = listRows(DUTY_KEY)
  const campaignCode = String(campaign['活动编号'] ?? '')
  const exists = dutyRows.some((row) => String(row['协办活动编号'] ?? '') === campaignCode)
  if (exists) {
    return false
  }

  const seq =
    dutyRows.reduce((max, row) => {
      const matched = /^DUTY-CO-(\d+)$/.exec(String(row['排班编号'] ?? ''))
      return matched ? Math.max(max, Number(matched[1])) : max
    }, 0) + 1
  const theme = String(campaign['宣传主题'] ?? '')
  dutyRows.push({
    id: nextId(dutyRows),
    status: '已交接',
    pending: false,
    abnormal: false,
    排班编号: `DUTY-CO-${String(seq).padStart(4, '0')}`,
    值勤日期: String(campaign['活动日期'] ?? ''),
    值勤时段: '宣传活动协办',
    值勤岗位: theme ? `宣传活动协办（${theme}）` : '宣传活动协办',
    值勤人员: String(campaign['执行人员'] ?? ''),
    接班人员: '—',
    交接记录: `协办防火宣传活动 ${campaignCode}，覆盖村组：${String(campaign['覆盖村组'] ?? '')}`,
    排班状态: '宣传活动协办',
    协办活动编号: campaignCode,
  })
  saveRows(DUTY_KEY, dutyRows)
  return true
}

// 结束后打包下载活动成果：成果清单（只留主题/方式/村组/人员）+ 成果总结 + 受众签到册。
export function downloadCampaignPackage(id: number): ActionResult {
  const rows = listRows(CAMPAIGN_KEY)
  const campaign = rows.find((row) => Number(row.id) === id)
  if (!campaign) {
    return { ok: false, message: `没有找到编号为 ${id} 的防火宣传活动` }
  }
  if (![FINISHED_STATUS, ARCHIVED_STATUS].includes(String(campaign.status))) {
    return { ok: false, message: '活动结束（已完成或已归档）后才能打包下载成果。' }
  }

  const code = String(campaign['活动编号'] ?? id)
  const manifestCsv =
    '﻿' +
    toCsv([
      [...MANIFEST_FIELDS],
      MANIFEST_FIELDS.map((field) => String(campaign[field] ?? '')),
    ])
  const audienceCsv =
    '﻿' +
    toCsv([
      ['活动编号', '覆盖村组', '受众人数'],
      [code, String(campaign['覆盖村组'] ?? ''), String(campaign['受众人数'] ?? '0')],
    ])
  const summary = [
    '防火宣传活动成果总结',
    '======================',
    `活动编号：${code}`,
    `宣传主题：${String(campaign['宣传主题'] ?? '')}`,
    `宣传方式：${String(campaign['宣传方式'] ?? '')}`,
    `覆盖村组：${String(campaign['覆盖村组'] ?? '')}`,
    `执行人员：${String(campaign['执行人员'] ?? '')}`,
    `活动日期：${String(campaign['活动日期'] ?? '')}`,
    `受众人数：${String(campaign['受众人数'] ?? '0')} 人`,
    `活动状态：${String(campaign.status ?? '')}`,
    campaign['归档时间'] ? `归档时间：${String(campaign['归档时间'])}` : '',
  ]
    .filter((line) => line !== '')
    .join('\r\n')

  const blob = buildZip([
    { name: '活动成果清单.csv', content: manifestCsv },
    { name: '活动成果总结.txt', content: summary },
    { name: '受众签到册.csv', content: audienceCsv },
  ])
  downloadBlob(blob, `防火宣传成果-${code}.zip`)
  return { ok: true, message: `活动「${code}」成果已打包下载。` }
}

export function campaignAudienceTotal(): number {
  return listRows(CAMPAIGN_KEY).reduce((sum, row) => {
    const value = Number(String(row['受众人数'] ?? '').replace(/[^\d]/g, ''))
    return sum + (Number.isFinite(value) ? value : 0)
  }, 0)
}
