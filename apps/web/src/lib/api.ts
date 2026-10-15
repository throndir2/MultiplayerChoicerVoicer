import type { SessionResponse } from '@mcv/shared'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string | null; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.token) headers.authorization = `Bearer ${options.token}`
  const init: RequestInit = { method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'), headers }
  if (options.body !== undefined) init.body = JSON.stringify(options.body)
  if (options.signal) init.signal = options.signal
  const response = await fetch(path, init)
  const text = await response.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!response.ok) {
    const message = (data as { error?: string } | null)?.error ?? `Request failed (${response.status})`
    throw new ApiError(message, response.status)
  }
  return data as T
}

export async function uploadBinary<T>(path: string, body: Blob, token: string, contentType: string): Promise<T> {
  const response = await fetch(path, {
    method: path.includes('/chunk') ? 'PUT' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
    body,
  })
  const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null
  if (!response.ok) throw new ApiError(data?.error ?? `Upload failed (${response.status})`, response.status)
  return data as T
}

const SESSION_PREFIX = 'mcv:room:'
const NAME_KEY = 'mcv:name'

export function saveSession(session: SessionResponse): void {
  window.sessionStorage.setItem(SESSION_PREFIX + session.code, JSON.stringify(session))
}

export function loadSession(code: string): SessionResponse | null {
  const raw = window.sessionStorage.getItem(SESSION_PREFIX + code.toUpperCase())
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as SessionResponse
    return parsed.token && parsed.playerId ? parsed : null
  } catch {
    return null
  }
}

export function clearSession(code: string): void {
  window.sessionStorage.removeItem(SESSION_PREFIX + code.toUpperCase())
}

export function loadName(): string {
  return window.localStorage.getItem(NAME_KEY) ?? ''
}

export function saveName(name: string): void {
  window.localStorage.setItem(NAME_KEY, name)
}
