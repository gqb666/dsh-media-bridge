/**
 * Configuration channel for the browser form. The form never edits the profile
 * patch by hand: it reads the row's effective config and writes through the
 * config editor, which validates the write and reloads this plugin so the tool
 * catalog matches the new values.
 */

import { hasApiKey, resolveConfig } from './config.js'
import { authHeaders } from './http.js'

/** Route the Client half calls with `fetch`. */
export const CONFIG_PATH = '/api/media-bridge'

/** Top-level fields the browser form owns. */
const SCALAR_FIELDS = ['baseUrl', 'apiKey', 'apiKeyEnv', 'outputDir']

/** Fields per capability group; the rest of a stored group survives a save. */
const GROUPS = {
  vision: ['baseUrl', 'apiKey', 'apiKeyEnv', 'model', 'maxTokens'],
  speech: ['baseUrl', 'apiKey', 'apiKeyEnv', 'model', 'ttsModel', 'voice', 'format'],
  video: ['baseUrl', 'apiKey', 'apiKeyEnv', 'model', 'style', 'pollIntervalMs', 'timeoutMs'],
}

/** One JSON response helper. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Read a nested object without trusting its shape. */
function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

/** Keep only the scalars the form can render, so a `!!js` expression never reaches it. */
function formValues(config) {
  const values = {}
  for (const key of SCALAR_FIELDS) values[key] = typeof config[key] === 'string' ? config[key] : ''
  for (const [group, keys] of Object.entries(GROUPS)) {
    const source = asRecord(config[group])
    values[group] = {}
    for (const key of keys) {
      const value = source[key]
      values[group][key] = typeof value === 'number' ? value : typeof value === 'string' ? value : ''
    }
  }
  values.trigger = {
    providers: Array.isArray(config.trigger?.providers) ? config.trigger.providers.filter((v) => typeof v === 'string') : [],
    models: Array.isArray(config.trigger?.models) ? config.trigger.models.filter((v) => typeof v === 'string') : [],
  }
  values.tools = {
    vision: config.tools?.vision !== false,
    speech: config.tools?.speech !== false,
    video: config.tools?.video !== false,
    status: config.tools?.status !== false,
  }
  return values
}

/** Trim a submitted string, keeping an absent field absent. */
function text(value) {
  return typeof value === 'string' ? value.trim() : undefined
}

/** A positive integer from a form value, which arrives as a number or numeric text. */
function positiveInteger(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** A comma or newline separated list from one text field. */
function list(value) {
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
  }
  if (typeof value !== 'string') return undefined
  return value.split(/[\n,]/u).map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

/** Merge one submitted group over the stored group, dropping blank values. */
function mergeGroup(stored, submitted, keys) {
  const base = { ...asRecord(stored) }
  const next = asRecord(submitted)
  for (const key of keys) {
    if (!(key in next)) continue
    const value = next[key]
    if (typeof value === 'string' && value.trim().length === 0) delete base[key]
    else if (typeof value === 'number') base[key] = value
    else if (typeof value === 'string') base[key] = value.trim()
    else if (typeof value === 'boolean') base[key] = value
  }
  return base
}

/**
 * Build the complete config a save should persist.
 * @param stored - the row's current config object.
 * @param submitted - form values from the browser.
 * @returns the merged config; unknown keys in `stored` survive.
 */
export function mergeSubmitted(stored, submitted) {
  const current = asRecord(stored)
  const form = asRecord(submitted)
  const next = { ...current }

  for (const key of SCALAR_FIELDS) {
    if (!(key in form)) continue
    const value = text(form[key])
    if (value === undefined) continue
    if (value.length === 0) delete next[key]
    else next[key] = value
  }

  for (const [group, keys] of Object.entries(GROUPS)) {
    next[group] = mergeGroup(current[group], form[group], keys)
  }
  for (const [group, field] of [['vision', 'maxTokens'], ['video', 'pollIntervalMs'], ['video', 'timeoutMs']]) {
    const target = next[group]
    if (target === undefined || !(field in target)) continue
    const parsed = positiveInteger(target[field])
    if (parsed === undefined) delete target[field]
    else target[field] = parsed
  }

  const providers = list(form.trigger?.providers)
  const models = list(form.trigger?.models)
  next.trigger = {
    ...asRecord(current.trigger),
    ...(providers === undefined ? {} : { providers }),
    ...(models === undefined ? {} : { models }),
  }

  if (typeof form.tools === 'object' && form.tools !== null) {
    const tools = asRecord(form.tools)
    next.tools = { ...asRecord(current.tools) }
    for (const key of ['vision', 'speech', 'video', 'status']) {
      if (typeof tools[key] === 'boolean') next.tools[key] = tools[key]
    }
  }

  return next
}

/** The row entry this plugin owns, from the live config editor. */
function locate(ctx) {
  const editor = ctx.get('configEditor')
  const entry = ctx.fiber?.entry
  if (editor === undefined || entry === undefined) return undefined
  return { editor, entry }
}

/** Current stored config for this row: the user layer when it exists, else the bundle default. */
function currentConfig(ctx, located) {
  const rows = located?.editor.configuration() ?? []
  const row = rows.find((candidate) => candidate.entry === located.entry)
    ?? rows.find((candidate) => candidate.entry?.id === 'media-bridge')
  return { ...asRecord(row?.inherited), ...asRecord(row?.override) }
}

/** One line describing which speech capability is configured. */
function responsiveSpeech(config) {
  const parts = []
  if (config.speech.model.length > 0) parts.push(`asr:${config.speech.model}`)
  if (config.speech.ttsModel.length > 0) parts.push(`tts:${config.speech.ttsModel}`)
  return parts.join(' ')
}

/** Report shape for the form. */
function describe(ctx, located) {
  const stored = located === undefined ? {} : currentConfig(ctx, located)
  const effective = resolveConfig(stored)
  return {
    ok: true,
    writable: located !== undefined,
    values: formValues(stored),
    effective: {
      configured: effective.configured,
      hasApiKey: hasApiKey(effective, 'vision') || hasApiKey(effective, 'speech') || hasApiKey(effective, 'video'),
      keys: {
        vision: hasApiKey(effective, 'vision'),
        speech: hasApiKey(effective, 'speech'),
        video: hasApiKey(effective, 'video'),
      },
      outputDir: effective.outputDir,
      vision: effective.vision.model,
      speech: responsiveSpeech(effective),
      video: effective.video.model,
      hosts: {
        vision: effective.vision.endpoint,
        speech: effective.speech.endpoint,
        video: effective.video.endpoint,
      },
      exposeFor: {
        providers: effective.trigger.providers,
        models: effective.trigger.models,
      },
    },
  }
}

/** Probe every configured capability with its own credential. */
async function testEndpoints(stored, submitted) {
  const config = resolveConfig(mergeSubmitted(stored, submitted))
  const targets = [
    ['vision', config.vision],
    ['speech', config.speech],
    ['video', config.video],
  ].filter(([, group]) => group.endpoint.length > 0)
  if (targets.length === 0) return { ok: false, message: '未填写任何接口地址' }
  const lines = []
  let anyOk = false
  for (const [capability, group] of targets) {
    try {
      const response = await fetch(`${group.endpoint}/models`, { headers: authHeaders(config, capability) })
      if (!response.ok) {
        lines.push(`${capability} @ ${group.endpoint} → HTTP ${response.status}`)
        continue
      }
      const payload = await response.json().catch(() => ({}))
      const ids = Array.isArray(payload?.data)
        ? payload.data.map((entry) => entry?.id).filter((id) => typeof id === 'string')
        : []
      anyOk = true
      lines.push(`${capability} @ ${group.endpoint} → 可连通，${ids.length} 个模型`)
    } catch (error) {
      lines.push(`${capability} @ ${group.endpoint} → ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { ok: anyOk, message: lines.join('；') }
}

/**
 * Register the configuration route.
 * @param ctx - plugin context; the route registration is effect-scoped.
 */
export function registerConfigRoutes(ctx) {
  const connection = ctx.get('connection')
  if (connection === undefined) return

  ctx.effect(() => {
    const disposer = connection.fetch.register({
      path: CONFIG_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const located = locate(ctx)
        try {
          if (request.method === 'GET') return json(describe(ctx, located))
          const body = await request.json().catch(() => ({}))
          const stored = located === undefined ? {} : currentConfig(ctx, located)
          if (body?.action === 'test') {
            return json({ ok: true, result: await testEndpoints(stored, asRecord(body.values)) })
          }
          if (located === undefined) {
            return json({ ok: false, message: '当前 profile 未提供配置编辑器，无法保存' }, 503)
          }
          const next = mergeSubmitted(stored, asRecord(body.values))
          // Answer before the reload so the browser sees the save land; a
          // rejected write reaches the log and the next GET shows old values.
          void located.editor.edit(located.entry, () => next).catch((error) => {
            ctx.logger?.error?.('media-bridge: configuration write failed', error)
          })
          return json({ ok: true, applying: true })
        } catch (error) {
          return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    })
    return () => { void disposer.then((dispose) => dispose()) }
  }, 'media-bridge: configuration route')
}
