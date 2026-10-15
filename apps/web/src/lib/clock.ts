import type { Socket } from 'socket.io-client'
import { ClientEvents, type TimeSyncAck } from '@mcv/shared'

/** serverTime = Date.now() + offset */
let offset = 0
let bestRtt = Number.POSITIVE_INFINITY

export function serverNow(): number {
  return Date.now() + offset
}

export function clockOffset(): number {
  return offset
}

function sample(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    const sent = Date.now()
    socket.timeout(4000).emit(ClientEvents.timeSync, {}, (error: unknown, ack: TimeSyncAck | undefined) => {
      const received = Date.now()
      if (!error && ack?.ok) {
        const rtt = received - sent
        // Older samples count less, so that a changed network path is picked up.
        if (rtt <= bestRtt * 1.2 || rtt < 60) {
          bestRtt = Math.min(bestRtt, rtt)
          offset = ack.now - (sent + rtt / 2)
        }
      }
      resolve()
    })
  })
}

/** NTP-style clock sync: keeps the estimate from the lowest round trip. */
export async function syncClock(socket: Socket, samples = 6): Promise<void> {
  bestRtt = Number.POSITIVE_INFINITY
  for (let index = 0; index < samples; index += 1) {
    if (!socket.connected) return
    await sample(socket)
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
}
