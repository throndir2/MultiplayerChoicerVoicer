import { createHash, randomBytes, randomInt } from 'node:crypto'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@mcv/shared'

export function randomId(bytes = 9): string {
  return randomBytes(bytes).toString('base64url')
}

export function createToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

export function createRoomCode(): string {
  let code = ''
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)]
  }
  return code
}

export function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12)
}

export function shuffle<T>(items: T[]): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1)
    const swap = copy[index] as T
    copy[index] = copy[other] as T
    copy[other] = swap
  }
  return copy
}
