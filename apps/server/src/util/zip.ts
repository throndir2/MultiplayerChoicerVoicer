import { promises as fs } from 'node:fs'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let value = 0xffffffff
  for (let index = 0; index < data.length; index += 1) {
    value = (CRC_TABLE[(value ^ (data[index] as number)) & 0xff] as number) ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  /** The path in the ZIP, with `/` separators. */
  name: string
  file?: string
  data?: Buffer
}

/** `date` is read with the UTC fields, so pass a date that is already moved to the local time of the player. */
function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107)
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  }
}

/** Writes a ZIP without compression (WAV audio does not compress well). The names are UTF-8. */
export async function writeZip(output: string, entries: ZipEntry[], date: Date): Promise<void> {
  const { time, day } = dosDateTime(date)
  const central: Buffer[] = []
  let offset = 0
  const handle = await fs.open(output, 'w')
  try {
    for (const entry of entries) {
      const data = entry.data ?? (await fs.readFile(entry.file as string))
      const name = Buffer.from(entry.name, 'utf8')
      const crc = crc32(data)
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0x0800, 6) // The names are UTF-8.
      local.writeUInt16LE(0, 8) // Stored.
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(day, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(data.length, 18)
      local.writeUInt32LE(data.length, 22)
      local.writeUInt16LE(name.length, 26)
      await handle.write(local)
      await handle.write(name)
      await handle.write(data)

      const header = Buffer.alloc(46)
      header.writeUInt32LE(0x02014b50, 0)
      header.writeUInt16LE(20, 4)
      header.writeUInt16LE(20, 6)
      header.writeUInt16LE(0x0800, 8)
      header.writeUInt16LE(0, 10)
      header.writeUInt16LE(time, 12)
      header.writeUInt16LE(day, 14)
      header.writeUInt32LE(crc, 16)
      header.writeUInt32LE(data.length, 20)
      header.writeUInt32LE(data.length, 24)
      header.writeUInt16LE(name.length, 28)
      header.writeUInt32LE(offset, 42)
      central.push(header, name)
      offset += local.length + name.length + data.length
      if (offset > 0xffffffff) throw new Error('The ZIP is too large')
    }
    const directory = Buffer.concat(central)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(directory.length, 12)
    end.writeUInt32LE(offset, 16)
    await handle.write(directory)
    await handle.write(end)
  } finally {
    await handle.close()
  }
}
