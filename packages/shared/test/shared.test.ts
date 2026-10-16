import { describe, expect, it } from 'vitest'
import { buildCues, cleanCaption, parseKeywords, roomCodeSchema, type DubView, type PackManifest } from '../src/index.js'

describe('parseKeywords', () => {
  it('splits at commas, trims and removes duplicates', () => {
    expect(parseKeywords(' Shrek,  spongebob ;shrek\n\nHazbin   Hotel ,')).toEqual(['Shrek', 'spongebob', 'Hazbin Hotel'])
    expect(parseKeywords(' , ')).toEqual([])
  })
})

describe('cleanCaption', () => {
  it('removes the speaker tag and curly quotes', () => {
    expect(cleanCaption('[Jeremy Clarkson] “I eat a cabbage...”')).toBe('I eat a cabbage...')
    expect(cleanCaption('[Singer] “You could be a Lara or a Daaani ”')).toBe(
      'You could be a Lara or a Daaani',
    )
  })

  it('keeps plain captions', () => {
    expect(cleanCaption('Keep your eyes on me.')).toBe('Keep your eyes on me.')
    expect(cleanCaption('"Quoted"')).toBe('Quoted')
  })
})

describe('roomCodeSchema', () => {
  it('normalises case', () => {
    expect(roomCodeSchema.parse(' abcde ')).toBe('ABCDE')
  })
})

describe('buildCues', () => {
  it('creates one cue per timestamp and falls back to the prompt', () => {
    const manifest = {
      lines: [
        {
          id: 'L001',
          index: 0,
          caption: 'a',
          text: 'a',
          characters: ['A'],
          timestamps: [5, 1],
          promptUrl: '/p1.mp3',
          promptDuration: 2,
          promptBytes: 1,
          imageUrl: null,
          imageBytes: 0,
        },
      ],
    } as unknown as PackManifest
    const dub: DubView = {
      id: 'd',
      name: 'd',
      ownerId: null,
      assignments: { L001: 'p1' },
      recordings: {},
      export: { status: 'idle', progress: 0 },
    }
    const cues = buildCues(manifest, dub, true)
    expect(cues.map((cue) => cue.time)).toEqual([1, 5])
    expect(cues[0]?.url).toBe('/p1.mp3')
    expect(buildCues(manifest, dub, false)[0]?.url).toBeNull()
  })
})
