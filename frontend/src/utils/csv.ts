// 最小 CSV 工具：支持带引号字段、转义引号、\r\n 换行，与导出的带 BOM UTF-8 文件互通。

const BOM = String.fromCharCode(0xfeff)

export function parseCsv(text: string): string[][] {
  const source = text.startsWith(BOM) ? text.slice(BOM.length) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      pushField()
    } else if (char === '\n') {
      pushRow()
    } else if (char !== '\r') {
      field += char
    }
  }
  // 收尾：最后一行没有换行也收进来，纯空文件不产生行。
  if (field.length > 0 || row.length > 0) {
    pushRow()
  }
  return rows
}

function escapeCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function toCsv(rows: (string | number)[][]): string {
  return rows
    .map((cells) => cells.map((cell) => escapeCell(String(cell ?? ''))).join(','))
    .join('\r\n')
}
