/**
 * Thin HTTP layer for the bridge: URL joining, credentials, cancellation, and
 * bounded error text. Every request carries the caller's abort signal so a
 * cancelled turn stops the upstream call instead of leaking it.
 */

import { resolveApiKey } from './config.js'

/** Join the configured base URL with one relative path. */
export function joinUrl(baseUrl, suffix) {
  return `${baseUrl}/${suffix.replace(/^\/+/u, '')}`
}

/** Substitute `{id}` and friends in a configured path template. */
export function fillPath(template, values) {
  return template.replace(/\{(\w+)\}/gu, (match, key) => {
    const value = values[key]
    return value === undefined ? match : encodeURIComponent(String(value))
  })
}

/**
 * Authorization and content-type headers for one capability's request.
 * @param config - resolved bridge configuration.
 * @param capability - `vision`, `speech`, or `video`, selecting that group's
 *   credential; omitted falls back to the shared key.
 * @param extra - additional headers.
 */
export function authHeaders(config, capability, extra = {}) {
  const key = resolveApiKey(config, capability)
  const headers = { ...extra }
  if (key.length > 0) headers.Authorization = `Bearer ${key}`
  return headers
}

/**
 * One deadline that also honours the caller's signal.
 * @returns the composed signal plus a disposer; the timer never keeps the
 *   process alive.
 */
function deadline(signal, timeoutMs) {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason ?? new Error('aborted'))
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    },
  }
}

/** Keep upstream error bodies short enough to read inside a tool result. */
async function failureText(response) {
  let body = ''
  try {
    body = await response.text()
  } catch {
    body = ''
  }
  const trimmed = body.trim()
  const snippet = trimmed.length > 800 ? `${trimmed.slice(0, 800)}…` : trimmed
  return snippet.length > 0 ? snippet : '(empty response body)'
}

/**
 * Send one request.
 * @param config - resolved bridge configuration.
 * @param request - method, URL, optional JSON body, form body, or raw headers.
 * @returns the response with `ok` already checked; a non-2xx status throws with
 *   the status and a bounded body excerpt.
 */
export async function send(config, request) {
  const {
    method = 'GET',
    url,
    json,
    form,
    headers = {},
    capability,
    signal,
    timeoutMs = 120_000,
    label = 'request',
  } = request
  const composed = deadline(signal, timeoutMs)
  try {
    const init = { method, headers: authHeaders(config, capability, headers), signal: composed.signal }
    if (json !== undefined) {
      init.headers = { ...init.headers, 'content-type': 'application/json' }
      init.body = JSON.stringify(json)
    } else if (form !== undefined) {
      init.body = form
    }
    const response = await fetch(url, init)
    if (!response.ok) {
      const detail = await failureText(response)
      throw new Error(`${label} failed: HTTP ${response.status} ${response.statusText} — ${detail}`)
    }
    return response
  } catch (error) {
    if (error?.name === 'AbortError') {
      const reason = error.cause instanceof Error ? error.cause.message : composed.signal.reason?.message
      throw new Error(`${label} was cancelled${typeof reason === 'string' ? `: ${reason}` : ''}`)
    }
    throw error
  } finally {
    composed.dispose()
  }
}

/** Read one response as JSON with a readable failure for malformed bodies. */
export async function readJson(response, label) {
  const text = await response.text()
  if (text.trim().length === 0) throw new Error(`${label} returned an empty body`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} returned non-JSON content: ${text.slice(0, 400)}`)
  }
}

/** Wait for one poll interval while staying cancellable. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('cancelled'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
