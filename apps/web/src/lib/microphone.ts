import { useCallback, useEffect, useRef, useState } from 'react'

const DEVICE_KEY = 'mcv:mic'
const CLEAN_KEY = 'mcv:mic-clean'
const ECHO_KEY = 'mcv:mic-echo'

export interface Microphone {
  stream: MediaStream | null
  error: string
  devices: MediaDeviceInfo[]
  deviceId: string
  clean: boolean
  /** Echo cancellation in the browser. */
  echo: boolean
  open: () => Promise<MediaStream | null>
  setDeviceId: (id: string) => void
  setClean: (value: boolean) => void
  setEcho: (value: boolean) => void
}

export function useMicrophone(): Microphone {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState('')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceIdState] = useState(() => window.localStorage.getItem(DEVICE_KEY) ?? '')
  const [clean, setCleanState] = useState(() => window.localStorage.getItem(CLEAN_KEY) !== 'false')
  const [echo, setEchoState] = useState(() => window.localStorage.getItem(ECHO_KEY) !== 'false')
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
          // Plain echo cancellation. The "all" mode (Chrome 141+) also removed all other sound that the computer
          // plays (for example a voice chat or a voice changer monitor), and that damaged the voice.
          echoCancellation: echo,
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
  }, [clean, echo, deviceId, refreshDevices])

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

  const setEcho = useCallback(
    (value: boolean) => {
      window.localStorage.setItem(ECHO_KEY, String(value))
      setEchoState(value)
      close()
    },
    [close],
  )

  return { stream, error, devices, deviceId, clean, echo, open, setDeviceId, setClean, setEcho }
}
