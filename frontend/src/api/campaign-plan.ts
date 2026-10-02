import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 防火宣传的专属业务：村组覆盖计划文件导入、存量编号回填、归档打包与值勤台账同步。
// 通用列表/流转仍在 local-service.ts，这里只放宣传活动独有的规则，页面不做业务判断。

const CAMPAIGN_KEY = 'campaign'
const DUTY_KEY = 'duty'
const NUMBER_PREFIX = 'CAMP-'
const DUTY_PREFIX = 'DUTY-'
const ARCHIVE_STATUS = '已归档'
const DONE_STATUS = '已完成'

// 已导入文件的内容指纹台账：同一活动文件重复上传时受众人数只累计一次。
const IMPORT_LOG_KEY = 'forest-fire-patrol:campaign-imports'

// 导入文件支持的列名（含别名），清单固定保留宣传主题、宣传方式、覆盖村组、执行人员。
const PLAN_FIELDS = ['活动编号', '宣传主题', '宣传方式', '覆盖村组', '执行人员', '活动日期', '受众人数'] as const
type PlanField = (typeof PLAN_FIELDS)[number]
type PlanRow = Record<PlanField, string>

const HEADER_ALIASES: Record<string, PlanField> = {
  活动编号: '活动编号',
  编号: '活动编号',
  宣传主题: '宣传主题',
  主题: '宣传主题',
  宣传方式: '宣传方式',
  方式: '宣传方式',
  覆盖村组: '覆盖村组',
  村组: '覆盖村组',
  执行人员: '执行人员',
  人员: '执行人员',
  活动日期: '活动日期',
  日期: '活动日期',
  采集日期: '活动日期',
  受众人数: '受众人数',
  受众: '受众人数',
}

export type CampaignImportResult = ActionResult & {
  added: number
  merged: number
  filled: number
  duplicated: boolean
}

type ImportLogEntry = {
  hash: string
  name: string
  importedAt: string
  added: number
  merged: number
  audience: number
}

type PackageFile = { name: string; content: string }

/** 受众人数可能是历史遗留的非数字文本，解析失败按 0 计，保证旧数据继续可用。 */
export function parseAudience(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** 文件内容指纹（FNV-1a + 长度），用来识别“同一个活动文件”。 */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(16)}-${text.length}`
}

function loadImportLog(): ImportLogEntry[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(IMPORT_LOG_KEY) ?? '[]')
    return Array.isArray(parsed) ? (parsed as ImportLogEntry[]) : []
  } catch {
    return []
  }
}

function saveImportLog(entries: ImportLogEntry[]): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(IMPORT_LOG_KEY, JSON.stringify(entries))
}

function numericSuffix(value: unknown): number | null {
  const matched = String(value ?? '').match(/(\d+)\s*$/)
  return matched ? Number.parseInt(matched[1], 10) : null
}

function nextNumbered(rows: EntryRow[], field: string, prefix: string): string {
  let max = 0
  for (const row of rows) {
    const suffix = numericSuffix(row[field])
    if (suffix !== null) {
      max = Math.max(max, suffix)
    }
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

function dateSortKey(row: EntryRow): number {
  const timestamp = Date.parse(String(row['活动日期'] ?? ''))
  return Number.isNaN(timestamp) ? Number.MAX_SAFE_INTEGER : timestamp
}

/** 按采集日期（活动日期）升序给缺编号的存量活动回填编号；没有缺号时原样返回。 */
export function backfillCampaignNumbers(rows: EntryRow[]): { rows: EntryRow[]; filled: number } {
  let max = 0
  for (const row of rows) {
    const suffix = numericSuffix(row['活动编号'])
    if (suffix !== null) {
      max = Math.max(max, suffix)
    }
  }
  const missing = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => String(row['活动编号'] ?? '').trim() === '')
    .sort((a, b) => dateSortKey(a.row) - dateSortKey(b.row) || a.index - b.index)
  if (missing.length === 0) {
    return { rows, filled: 0 }
  }
  const next = [...rows]
  missing.forEach(({ index }, offset) => {
    next[index] = { ...next[index], 活动编号: `${NUMBER_PREFIX}${String(max + 1 + offset).padStart(4, '0')}` }
  })
  return { rows: next, filled: missing.length }
}

/** 页面打开时调用：把存量活动里缺编号的按采集日期补齐并落库，返回回填条数。 */
export function ensureCampaignNumbers(): number {
  const { rows, filled } = backfillCampaignNumbers(listRows(CAMPAIGN_KEY))
  if (filled > 0) {
    saveRows(CAMPAIGN_KEY, rows)
  }
  return filled
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      cells.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  cells.push(current)
  return cells.map((cell) => cell.trim())
}

/** 解析村组覆盖计划 CSV：首行表头，宣传主题与覆盖村组必填，其余可空。 */
export function parsePlanCsv(text: string): { plans: PlanRow[]; skipped: number } {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim() !== '')
  if (lines.length < 2) {
    return { plans: [], skipped: 0 }
  }
  const header = splitCsvLine(lines[0]).map((cell) => HEADER_ALIASES[cell] ?? '')
  if (!header.includes('宣传主题') || !header.includes('覆盖村组')) {
    return { plans: [], skipped: lines.length - 1 }
  }
  const plans: PlanRow[] = []
  let skipped = 0
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line)
    const plan = Object.fromEntries(PLAN_FIELDS.map((field) => [field, ''])) as PlanRow
    header.forEach((field, index) => {
      if (field) {
        plan[field] = cells[index] ?? ''
      }
    })
    if (plan['宣传主题'] === '' || plan['覆盖村组'] === '') {
      skipped++
      continue
    }
    plans.push(plan)
  }
  return { plans, skipped }
}

/**
 * 导入村组覆盖计划文件。
 * - 同一文件（内容指纹相同）重复上传直接拒绝，受众人数只累计一次；
 * - 新旧计划冲突时按 活动编号 → 覆盖村组＋活动日期 → 宣传主题＋活动日期 归并，
 *   即覆盖村组优先于宣传主题；归并只更新字段，不重复累计受众；
 * - 导入后统一按采集日期回填缺编号的活动。
 */
export function importCampaignPlan(filename: string, text: string): CampaignImportResult {
  const hash = fingerprint(text)
  const log = loadImportLog()
  if (log.some((entry) => entry.hash === hash)) {
    return {
      ok: false,
      added: 0,
      merged: 0,
      filled: 0,
      duplicated: true,
      message: `文件「${filename}」与已导入的活动文件内容相同，受众人数只累计一次，本次不再重复导入`,
    }
  }
  const { plans, skipped } = parsePlanCsv(text)
  if (plans.length === 0) {
    return {
      ok: false,
      added: 0,
      merged: 0,
      filled: 0,
      duplicated: false,
      message:
        skipped > 0
          ? `文件「${filename}」缺少有效计划行（宣传主题、覆盖村组必填），已跳过 ${skipped} 行`
          : `文件「${filename}」没有可导入的村组覆盖计划，请先下载导入模板`,
    }
  }

  const rows = [...listRows(CAMPAIGN_KEY)]
  const byNumber = new Map<string, EntryRow>()
  const byVillage = new Map<string, EntryRow>()
  const byTheme = new Map<string, EntryRow>()
  const register = (row: EntryRow) => {
    const number = String(row['活动编号'] ?? '').trim()
    const date = String(row['活动日期'] ?? '').trim()
    const village = String(row['覆盖村组'] ?? '').trim()
    const theme = String(row['宣传主题'] ?? '').trim()
    if (number) byNumber.set(number, row)
    if (village) byVillage.set(`${village}|${date}`, row)
    if (theme) byTheme.set(`${theme}|${date}`, row)
  }
  rows.forEach(register)

  let added = 0
  let merged = 0
  let nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  for (const plan of plans) {
    const number = plan['活动编号']
    const date = plan['活动日期']
    // 冲突归并：覆盖村组优先于宣传主题
    const hit =
      (number ? byNumber.get(number) : undefined) ??
      byVillage.get(`${plan['覆盖村组']}|${date}`) ??
      byTheme.get(`${plan['宣传主题']}|${date}`)
    if (hit) {
      const index = rows.findIndex((row) => Number(row.id) === Number(hit.id))
      const mergedRow = { ...rows[index] }
      for (const field of PLAN_FIELDS) {
        const value = plan[field].trim()
        if (value === '') continue
        // 已有编号的活动保留原编号，避免归并时撞号
        if (field === '活动编号' && String(mergedRow['活动编号'] ?? '').trim() !== '') continue
        mergedRow[field] = value
      }
      rows[index] = mergedRow
      register(mergedRow)
      merged++
    } else {
      const created: EntryRow = {
        id: nextId++,
        status: '待开展',
        pending: true,
        abnormal: false,
        活动编号: number,
        宣传主题: plan['宣传主题'],
        宣传方式: plan['宣传方式'],
        覆盖村组: plan['覆盖村组'],
        执行人员: plan['执行人员'],
        活动日期: date,
        受众人数: plan['受众人数'],
        活动状态: '待开展',
      }
      rows.push(created)
      register(created)
      added++
    }
  }

  const backfilled = backfillCampaignNumbers(rows)
  saveRows(CAMPAIGN_KEY, backfilled.rows)
  const audience = plans.reduce((sum, plan) => sum + parseAudience(plan['受众人数']), 0)
  saveImportLog([
    ...log,
    { hash, name: filename, importedAt: new Date().toISOString(), added, merged, audience },
  ])
  return {
    ok: true,
    added,
    merged,
    filled: backfilled.filled,
    duplicated: false,
    message: `已导入「${filename}」：新增 ${added} 条、归并 ${merged} 条、回填编号 ${backfilled.filled} 个${
      skipped > 0 ? `，跳过无效行 ${skipped} 行` : ''
    }；受众人数按本文件只累计一次`,
  }
}

/** 归档时向往值勤排班台账同步一条“宣传协办”记录；按活动编号去重，重复归档不会重复同步。 */
function syncDutyLedger(campaign: EntryRow): { synced: boolean; code: string } {
  const number = String(campaign['活动编号'] ?? '')
  const rows = listRows(DUTY_KEY)
  if (number && rows.some((row) => String(row['交接记录'] ?? '').includes(number))) {
    return { synced: false, code: '' }
  }
  const code = nextNumbered(rows, '排班编号', DUTY_PREFIX)
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const synced: EntryRow = {
    id,
    status: '待确认',
    pending: true,
    abnormal: false,
    排班编号: code,
    值勤日期: String(campaign['活动日期'] ?? ''),
    值勤时段: '全天',
    值勤岗位: '宣传协办',
    值勤人员: String(campaign['执行人员'] ?? ''),
    接班人员: '—',
    交接记录: `协办防火宣传《${String(campaign['宣传主题'] ?? '')}》（${number}）`,
    排班状态: '待确认',
  }
  saveRows(DUTY_KEY, [...rows, synced])
  return { synced: true, code }
}

/**
 * 归档宣传活动：仅限已完成的活动。
 * 归档后打包下载活动成果（ZIP：成果清单.csv＋汇总说明.txt），
 * 并同步一条值勤协办台账，其它入口（值勤排班、运营概览）立即可见。
 */
export function archiveCampaign(id: number): ActionResult {
  ensureCampaignNumbers()
  const rows = listRows(CAMPAIGN_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的防火宣传活动` }
  }
  const current = String(rows[index].status)
  if (current === ARCHIVE_STATUS) {
    return { ok: false, message: '该活动已归档，成果包不重复生成' }
  }
  if (current !== DONE_STATUS) {
    return { ok: false, message: '活动尚未完成，请先「确认完成」再归档打包' }
  }
  const archived: EntryRow = { ...rows[index], status: ARCHIVE_STATUS, 活动状态: ARCHIVE_STATUS, pending: false }
  const next = [...rows]
  next[index] = archived
  saveRows(CAMPAIGN_KEY, next)
  const duty = syncDutyLedger(archived)
  downloadCampaignPackage([archived], `防火宣传成果包-${String(archived['活动编号'])}.zip`)
  return {
    ok: true,
    message: `活动已归档，成果包已打包下载${
      duty.synced ? `，值勤协办台账已同步 ${duty.code}` : '，值勤协办台账已有对应记录，未重复同步'
    }`,
  }
}

/** 打包下载全部已完成/已归档活动的成果。 */
export function downloadCampaignResults(): ActionResult {
  ensureCampaignNumbers()
  const done = listRows(CAMPAIGN_KEY).filter((row) =>
    [DONE_STATUS, ARCHIVE_STATUS].includes(String(row.status)),
  )
  if (done.length === 0) {
    return { ok: false, message: '还没有已完成或已归档的宣传活动，暂无可打包的成果' }
  }
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}`
  downloadCampaignPackage(done, `防火宣传成果包-${stamp}.zip`)
  return { ok: true, message: `已打包下载 ${done.length} 条活动成果（成果清单＋汇总说明）` }
}

function downloadCampaignPackage(rows: EntryRow[], filename: string): void {
  downloadBlob(filename, buildZip(buildCampaignPackageFiles(rows)))
}

function buildCampaignPackageFiles(rows: EntryRow[]): PackageFile[] {
  const header = ['编号', '活动编号', '宣传主题', '宣传方式', '覆盖村组', '执行人员', '活动日期', '受众人数', '当前状态']
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row['活动编号'] ?? '',
        row['宣传主题'] ?? '',
        row['宣传方式'] ?? '',
        row['覆盖村组'] ?? '',
        row['执行人员'] ?? '',
        row['活动日期'] ?? '',
        row['受众人数'] ?? '',
        row.status,
      ].join(','),
    )
  }
  const audience = rows.reduce((sum, row) => sum + parseAudience(row['受众人数']), 0)
  const summary = [
    '防火宣传活动成果汇总',
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `活动条数：${rows.length}`,
    `覆盖人次：${audience}`,
    '清单字段：宣传主题、宣传方式、覆盖村组、执行人员、活动日期、受众人数',
    '说明：同一活动文件重复导入只累计一次受众；归档活动已同步值勤协办台账。',
  ].join('\r\n')
  return [
    { name: '成果清单.csv', content: `\uFEFF${lines.join('\r\n')}` },
    { name: '汇总说明.txt', content: summary },
  ]
}

/** 导入模板：列出全部支持列，活动编号可留空（导入后按采集日期自动回填）。 */
export function downloadPlanTemplate(): void {
  const content = `\uFEFF${PLAN_FIELDS.join(',')}\r\n,清明文明祭扫宣传,入户宣讲,青山村一组,王立群,2026-10-04,80\r\n`
  downloadBlob('村组覆盖计划导入模板.csv', new Blob([content], { type: 'text/csv;charset=utf-8' }))
}

function downloadBlob(filename: string, blob: Blob): void {
  if (typeof document === 'undefined') {
    return
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// ---- 简易 ZIP（stored，不压缩）：成果包只装文本，直接 store 即可，无需引入依赖 ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(now: Date): { time: number; date: number } {
  return {
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
    date: (((now.getFullYear() - 1980) & 0x7f) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
  }
}

export function buildZip(files: PackageFile[]): Blob {
  const encoder = new TextEncoder()
  const stamp = dosDateTime(new Date())
  const chunks: Uint8Array<ArrayBuffer>[] = []
  const central: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  for (const file of files) {
    const nameBytes = encoder.encode(file.name)
    const data = encoder.encode(file.content)
    const crc = crc32(data)

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true) // 文件名按 UTF-8 处理
    local.setUint16(8, 0, true) // stored，不压缩
    local.setUint16(10, stamp.time, true)
    local.setUint16(12, stamp.date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, nameBytes.length, true)
    local.setUint16(28, 0, true)
    chunks.push(new Uint8Array(local.buffer), nameBytes, data)

    const entry = new DataView(new ArrayBuffer(46))
    entry.setUint32(0, 0x02014b50, true)
    entry.setUint16(4, 20, true)
    entry.setUint16(6, 20, true)
    entry.setUint16(8, 0x0800, true)
    entry.setUint16(10, 0, true)
    entry.setUint16(12, stamp.time, true)
    entry.setUint16(14, stamp.date, true)
    entry.setUint32(16, crc, true)
    entry.setUint32(20, data.length, true)
    entry.setUint32(24, data.length, true)
    entry.setUint16(28, nameBytes.length, true)
    entry.setUint32(42, offset, true)
    central.push(new Uint8Array(entry.buffer), nameBytes)

    offset += 30 + nameBytes.length + data.length
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(8, files.length, true)
  eocd.setUint16(10, files.length, true)
  eocd.setUint32(12, centralSize, true)
  eocd.setUint32(16, offset, true)
  return new Blob([...chunks, ...central, new Uint8Array(eocd.buffer)], { type: 'application/zip' })
}
