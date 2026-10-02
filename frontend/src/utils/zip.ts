// 零依赖 ZIP 打包：纯前端把活动成果里的多个文件打成一个 zip 下载。
// 使用 Store（不压缩）方式写入，只需要实现 CRC32 与 ZIP 的本地文件头/中央目录结构。

type ZipEntry = {
  name: string
  bytes: Uint8Array
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let crc = n
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    table[n] = crc >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const encoder = new TextEncoder()

export function buildZip(files: { name: string; content: string }[]): Blob {
  const entries: ZipEntry[] = files.map((file) => ({
    name: file.name,
    bytes: encoder.encode(file.content),
  }))

  const chunks: BlobPart[] = []
  const central: BlobPart[] = []
  let offset = 0
  // ZIP 时间基准是 1980-01-01，直接用当前时刻。
  const now = new Date()
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    (Math.floor(now.getSeconds() / 2) & 0x1f)
  const dosDate =
    (((now.getFullYear() - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f)

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const crc = crc32(entry.bytes)
    const size = entry.bytes.length

    // 本地文件头（signature 0x04034b50，version 20，flag 0x0800 表示文件名按 UTF-8）。
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true)
    local.setUint16(8, 0, true)
    local.setUint16(10, dosTime, true)
    local.setUint16(12, dosDate, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, size, true)
    local.setUint32(22, size, true)
    local.setUint16(26, nameBytes.length, true)
    local.setUint16(28, 0, true)

    const localHeader = new Uint8Array(local.buffer)
    chunks.push(localHeader as BlobPart, nameBytes as BlobPart, entry.bytes as BlobPart)

    // 中央目录头（signature 0x02014b50）。
    const centralView = new DataView(new ArrayBuffer(46))
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0x0800, true)
    centralView.setUint16(10, 0, true)
    centralView.setUint16(12, dosTime, true)
    centralView.setUint16(14, dosDate, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, size, true)
    centralView.setUint32(24, size, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(42, offset, true)

    central.push(new Uint8Array(centralView.buffer) as BlobPart, nameBytes as BlobPart)
    offset += localHeader.length + nameBytes.length + size
  }

  let centralSize = 0
  for (const part of central) {
    centralSize += (part as Uint8Array).length
  }

  const endView = new DataView(new ArrayBuffer(22))
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)

  return new Blob(
    [
      ...chunks,
      ...central,
      new Uint8Array(endView.buffer) as BlobPart,
    ],
    {
      type: 'application/zip',
    },
  )
}
