import { useCallback, useEffect, useRef, useState } from 'react'

const DEVICE_KEY = 'mcv:mic'
// A new key: noise suppression is off by default, also for players who saved "on" before.
const CLEAN_KEY = 'mcv:mic-ns'

export interface Microphone {
  stream: MediaStream | null
  error: string
  devices: MediaDeviceInfo[]
  deviceId: string
  clean: boolean
  open: () => Promise<MediaStream | null>
  setDeviceId: (id: string) => void
  setClean: (value: boolean) => void
}

export function useMicrophone(): Microphone {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState('')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceIdState] = useState(() => window.localStorage.getItem(DEVICE_KEY) ?? '')
  // Noise suppression is off by default: the voice-call processing removed frequency bands and parts of the voice.
  const [clean, setCleanState] = useState(() => window.localStorage.getItem(CLEAN_KEY) === 'true')
  const streamRef = useRef<MediaStream | null>(null)
  /** The open request that is running, so that two calls share one microphone. */
  const pending = useRef<Promise<MediaStream | null> | null>(null)
  /** Changes on each close, so a request that finishes after a close does not keep its stream. */
  const generation = useRef(0)

  const close = useCallback(() => {
    generation.current += 1
    pending.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setStream(null)
  }, [])

  useEffect(() => close, [close])

  const refreshDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      setDevices(all.filter((device) => device.kind === 'audioinput'))
    } catch {
      setDevices([])
    }
  }, [])

  const open = useCallback(() => {
    const current = streamRef.current
    if (current && current.getAudioTracks().some((track) => track.readyState === 'live')) {
      return Promise.resolve<MediaStream | null>(current)
    }
    if (pending.current) return pending.current
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot use a microphone here. Use HTTPS and a modern browser.')
      return Promise.resolve(null)
    }
    const request = generation.current
    const promise = (async (): Promise<MediaStream | null> => {
      try {
        const constraints: MediaTrackConstraints = {
          // Never use echo cancellation: it muffled takes and cut parts of the voice.
          echoCancellation: false,
          noiseSuppression: clean,
          autoGainControl: clean,
          channelCount: 1,
        }
        if (deviceId) constraints.deviceId = { exact: deviceId }
        const next = await navigator.mediaDevices.getUserMedia({ audio: constraints })
        if (request !== generation.current) {
          next.getTracks().forEach((track) => track.stop())
          return null
        }
        streamRef.current = next
        setStream(next)
        setError('')
        void refreshDevices()
        return next
      } catch (caught) {
        if (request !== generation.current) return null
        const name = caught instanceof DOMException ? caught.name : ''
        setError(
          name === 'NotAllowedError'
            ? 'The browser blocked the microphone. Allow it in the address bar, then try again.'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'No microphone was found.'
              : 'The microphone could not start.',
        )
        if (deviceId) {
          window.localStorage.removeItem(DEVICE_KEY)
          setDeviceIdState('')
        }
        return null
      }
    })()
    pending.current = promise
    void promise.finally(() => {
      if (pending.current === promise) pending.current = null
    })
    return promise
  }, [clean, deviceId, refreshDevices])

  useEffect(() => {
    void refreshDevices()
  }, [refreshDevices])

  const setDeviceId = useCallback(
    (id: string) => {
      window.localStorage.setItem(DEVICE_KEY, id)
      setDeviceIdState(id)
      close()
    },
    [close],
  )

  const setClean = useCallback(
    (value: boolean) => {
      window.localStorage.setItem(CLEAN_KEY, String(value))
      setCleanState(value)
      close()
    },
    [close],
  )

  return { stream, error, devices, deviceId, clean, open, setDeviceId, setClean }
}
