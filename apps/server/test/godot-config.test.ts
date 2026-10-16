import { describe, expect, it } from 'vitest'
import { asNumberArray, asStringArray, dataSection, parseGodotConfig } from '../src/packs/godot-config.js'

describe('parseGodotConfig', () => {
  it('reads a pack info file', () => {
    const config = parseGodotConfig(
      '[data]\r\n\r\ntitle="Top Gear - Richard"\r\nsubtitle="You Ess Bee"\r\nicon="icon.png"\r\nauthors=["a", "b"]\r\n',
    )
    const data = dataSection(config)
    expect(data.title).toBe('Top Gear - Richard')
    expect(asStringArray(data.authors)).toEqual(['a', 'b'])
  })

  it('reads a line file with unicode, escapes and several timestamps', () => {
    const data = dataSection(
      parseGodotConfig(
        '[data]\n\ncaption="[Jeremy] “I eat a \\"cabbage\\"...”"\nimage="02_J.png"\ndub_timestamps=[1.613, 4]\ndub_characters=["Jeremy", "Narrator"]\n',
      ),
    )
    expect(data.caption).toBe('[Jeremy] “I eat a "cabbage"...”')
    expect(asNumberArray(data.dub_timestamps)).toEqual([1.613, 4])
    expect(asStringArray(data.dub_characters)).toEqual(['Jeremy', 'Narrator'])
  })

  it('accepts multi-line strings, comments and Godot constructors', () => {
    const data = dataSection(
      parseGodotConfig(
        '; comment\n[data]\nreadme="line one\nline two"\nauthors=PackedStringArray("x", "y")\nflag=true\n',
      ),
    )
    expect(data.readme).toBe('line one\nline two')
    expect(asStringArray(data.authors)).toEqual(['x', 'y'])
    expect(data.flag).toBe(true)
  })

  it('accepts a single number instead of an array', () => {
    const data = dataSection(parseGodotConfig('[data]\ndub_timestamps=2.5\ndub_characters="Solo"'))
    expect(asNumberArray(data.dub_timestamps)).toEqual([2.5])
    expect(asStringArray(data.dub_characters)).toEqual(['Solo'])
  })
})
