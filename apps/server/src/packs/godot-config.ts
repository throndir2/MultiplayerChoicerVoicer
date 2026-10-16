export type GodotValue = string | number | boolean | null | GodotValue[] | { [key: string]: GodotValue }

export type GodotConfig = Record<string, Record<string, GodotValue>>

class Scanner {
  pos = 0
  constructor(readonly text: string) {}

  get done(): boolean {
    return this.pos >= this.text.length
  }

  peek(offset = 0): string {
    return this.text.charAt(this.pos + offset)
  }

  skipSpaces(includeNewlines: boolean): void {
    while (!this.done) {
      const ch = this.peek()
      if (ch === ' ' || ch === '\t' || ch === '\uFEFF' || (includeNewlines && (ch === '\n' || ch === '\r'))) {
        this.pos += 1
      } else {
        break
      }
    }
  }

  skipLine(): void {
    while (!this.done && this.peek() !== '\n') this.pos += 1
    if (!this.done) this.pos += 1
  }
}

function parseString(scanner: Scanner): string {
  // The opening quote is at scanner.pos.
  scanner.pos += 1
  let result = ''
  while (!scanner.done) {
    const ch = scanner.peek()
    scanner.pos += 1
    if (ch === '"') return result
    if (ch === '\\') {
      const next = scanner.peek()
      scanner.pos += 1
      switch (next) {
        case 'n':
          result += '\n'
          break
        case 't':
          result += '\t'
          break
        case 'r':
          result += '\r'
          break
        case 'b':
          result += '\b'
          break
        case 'f':
          result += '\f'
          break
        case 'u': {
          const hex = scanner.text.slice(scanner.pos, scanner.pos + 4)
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            result += String.fromCharCode(parseInt(hex, 16))
            scanner.pos += 4
          } else {
            result += 'u'
          }
          break
        }
        default:
          result += next
      }
    } else {
      result += ch
    }
  }
  return result
}

function parseValue(scanner: Scanner): GodotValue {
  scanner.skipSpaces(true)
  const ch = scanner.peek()
  if (ch === '"') return parseString(scanner)
  if ((ch === '&' || ch === '^') && scanner.peek(1) === '"') {
    scanner.pos += 1
    return parseString(scanner)
  }
  if (ch === '[') {
    scanner.pos += 1
    const items: GodotValue[] = []
    for (;;) {
      scanner.skipSpaces(true)
      if (scanner.done) return items
      if (scanner.peek() === ']') {
        scanner.pos += 1
        return items
      }
      if (scanner.peek() === ',') {
        scanner.pos += 1
        continue
      }
      const before = scanner.pos
      items.push(parseValue(scanner))
      if (scanner.pos === before) scanner.pos += 1
    }
  }
  if (ch === '{') {
    scanner.pos += 1
    const result: Record<string, GodotValue> = {}
    for (;;) {
      scanner.skipSpaces(true)
      if (scanner.done) return result
      if (scanner.peek() === '}') {
        scanner.pos += 1
        return result
      }
      if (scanner.peek() === ',') {
        scanner.pos += 1
        continue
      }
      const before = scanner.pos
      const key = parseValue(scanner)
      scanner.skipSpaces(true)
      if (scanner.peek() === ':') scanner.pos += 1
      const value = parseValue(scanner)
      result[String(key)] = value
      if (scanner.pos === before) scanner.pos += 1
    }
  }
  const rest = scanner.text.slice(scanner.pos)
  const number = /^[-+]?(?:\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)/.exec(rest)
  if (number) {
    scanner.pos += number[0].length
    return Number(number[0])
  }
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
  if (identifier) {
    scanner.pos += identifier[0].length
    const word = identifier[0]
    scanner.skipSpaces(false)
    if (scanner.peek() === '(') {
      // Constructors such as PackedStringArray("a", "b") or Vector2(1, 2) become arrays.
      scanner.pos += 1
      const args: GodotValue[] = []
      for (;;) {
        scanner.skipSpaces(true)
        if (scanner.done) return args
        if (scanner.peek() === ')') {
          scanner.pos += 1
          return args
        }
        if (scanner.peek() === ',') {
          scanner.pos += 1
          continue
        }
        const before = scanner.pos
        args.push(parseValue(scanner))
        if (scanner.pos === before) scanner.pos += 1
      }
    }
    if (word === 'true') return true
    if (word === 'false') return false
    if (word === 'null') return null
    if (word === 'inf') return Infinity
    if (word === 'nan') return Number.NaN
    return word
  }
  // Unknown syntax: take the raw text up to the end of the line.
  let raw = ''
  while (!scanner.done && scanner.peek() !== '\n' && scanner.peek() !== '\r') {
    raw += scanner.peek()
    scanner.pos += 1
  }
  return raw.trim()
}

/** Parses Godot `ConfigFile` text, as used by `_pack_info.ini` and the line `.txt` files. */
export function parseGodotConfig(text: string): GodotConfig {
  const scanner = new Scanner(text.replace(/^\uFEFF/, ''))
  const config: GodotConfig = {}
  let section = ''
  config[section] = {}
  while (!scanner.done) {
    scanner.skipSpaces(true)
    if (scanner.done) break
    const ch = scanner.peek()
    if (ch === ';' || ch === '#') {
      scanner.skipLine()
      continue
    }
    if (ch === '[') {
      const end = scanner.text.indexOf(']', scanner.pos)
      const newline = scanner.text.indexOf('\n', scanner.pos)
      if (end !== -1 && (newline === -1 || end < newline)) {
        section = scanner.text.slice(scanner.pos + 1, end).trim()
        config[section] ??= {}
        scanner.pos = end + 1
        scanner.skipLine()
        continue
      }
    }
    let key = ''
    while (!scanner.done && scanner.peek() !== '=' && scanner.peek() !== '\n') {
      key += scanner.peek()
      scanner.pos += 1
    }
    if (scanner.peek() !== '=') {
      scanner.skipLine()
      continue
    }
    scanner.pos += 1
    scanner.skipSpaces(false)
    const value = parseValue(scanner)
    const target = config[section] ?? (config[section] = {})
    target[key.trim()] = value
    // Ignore any trailing text on the same line.
    while (!scanner.done && scanner.peek() !== '\n') scanner.pos += 1
  }
  if (Object.keys(config[''] ?? {}).length === 0) delete config['']
  return config
}

/** The `[data]` section, or the first section when `[data]` is missing. */
export function dataSection(config: GodotConfig): Record<string, GodotValue> {
  return config.data ?? config.Data ?? Object.values(config)[0] ?? {}
}

export function asString(value: GodotValue | undefined): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

export function asStringArray(value: GodotValue | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => asString(item).trim()).filter(Boolean)
  const single = asString(value).trim()
  return single ? [single] : []
}

export function asNumberArray(value: GodotValue | undefined): number[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value]
  return list
    .map((item) => (typeof item === 'number' ? item : Number(item)))
    .filter((item) => Number.isFinite(item) && item >= 0)
}
