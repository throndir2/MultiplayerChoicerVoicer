import { describe, expect, it } from 'vitest'
import {
  buildCues,
  cleanCaption,
  packVersionKey,
  parseKeywords,
  recordingOrder,
  roomCodeSchema,
  type DubView,
  type PackManifest,
} from '../src/index.js'

describe('packVersionKey', () => {
  it('groups updates and alternates of one pack', () => {
    const key = packVersionKey('My Pack', ['Ann', 'Bob'])
    expect(packVersionKey('my pack (fixed)', ['bob', 'Ann'])).toBe(key)
    expect(packVersionKey('My Pack v2.1', ['Ann', 'Bob'])).toBe(key)
    expect(packVersionKey('My Pack - Alt', ['Ann', 'Bob'])).toBe(key)
    expect(packVersionKey('Mý Páck', ['Ann', 'Bob'])).toBe(key)
  })

  it('keeps different packs apart', () => {
    expect(packVersionKey('My Pack', ['Ann'])).not.toBe(packVersionKey('My Pack', ['Bob']))
    expect(packVersionKey('Shrek 2', ['Ann'])).not.toBe(packVersionKey('Shrek', ['Ann']))
    expect(packVersionKey('Fixed', [])).toBe('fixed|')
  })
})

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
      gameExport: { status: 'idle', progress: 0 },
    }
    const cues = buildCues(manifest, dub, true)
    expect(cues.map((cue) => cue.time)).toEqual([1, 5])
    expect(cues[0]?.url).toBe('/p1.mp3')
    expect(buildCues(manifest, dub, false)[0]?.url).toBeNull()
  })
})

describe('recordingOrder', () => {
  it('groups the lines by character in order of first appearance', () => {
    const lines = [
      { id: '1', characters: ['SpongeBob'] },
      { id: '2', characters: ['Patrick'] },
      { id: '3', characters: ['SpongeBob', 'Patrick'] },
      { id: '4', characters: ['Patrick'] },
      { id: '5', characters: [] },
      { id: '6', characters: ['SpongeBob'] },
    ]
    expect(recordingOrder(lines).map((line) => line.id)).toEqual(['1', '3', '6', '2', '4', '5'])
  })
})
