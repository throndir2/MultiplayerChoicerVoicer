import { useCallback, useEffect, useRef, useState } from 'react'

const DEVICE_KEY = 'mcv:mic'
const CLEAN_KEY = 'mcv:mic-clean'

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
  const [clean, setCleanState] = useState(() => window.localStorage.getItem(CLEAN_KEY) !== 'false')
  const streamRef = useRef<MediaStream | null>(null)

  const close = useCallback(() => {
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

  const open = useCallback(async () => {
    const current = streamRef.current
    if (current && current.getAudioTracks().some((track) => track.readyState === 'live')) return current
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot use a microphone here. Use HTTPS and a modern browser.')
      return null
    }
    try {
      const constraints: MediaTrackConstraints = {
        // Echo cancellation is always on. "all" (Chrome 141+) also removes other sound that the computer plays,
        // for example a "listen to this microphone" loopback of a voice changer. Older browsers read it as `true`.
        echoCancellation: 'all' as unknown as boolean,
        noiseSuppression: clean,
        autoGainControl: clean,
        channelCount: 1,
      }
      if (deviceId) constraints.deviceId = { exact: deviceId }
      const next = await navigator.mediaDevices.getUserMedia({ audio: constraints })
      streamRef.current = next
      setStream(next)
      setError('')
      void refreshDevices()
      return next
    } catch (caught) {
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
