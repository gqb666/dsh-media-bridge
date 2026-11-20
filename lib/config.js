/**
 * Normalizes the row config into one immutable shape, so every tool reads the
 * same resolved values. No dependency on a Config schema: the bundle stays a
 * plain ES module that the profile can load without installing anything.
 *
 * Each capability may point at its own host and credential: the platform may
 * serve vision from one gateway and video from another, each with its own key.
 */

import os from 'node:os'
import path from 'node:path'

const DEFAULT_OUTPUT_DIR = path.join(os.tmpdir(), 'dsh-media-bridge')

const GROUP_DEFAULTS = {
  vision: {
    baseUrl: '',
    apiKey: '',
    apiKeyEnv: '',
    path: 'chat/completions',
    model: '',
    maxTokens: 1024,
    timeoutMs: 120_000,
  },
  speech: {
    baseUrl: '',
    apiKey: '',
    apiKeyEnv: '',
    model: '',
    ttsModel: '',
    voice: '',
    format: 'mp3',
    transcribePath: 'audio/transcriptions',
    synthesizePath: 'audio/speech',
    timeoutMs: 120_000,
  },
  video: {
    baseUrl: '',
    apiKey: '',
    apiKeyEnv: '',
    model: '',
    // `openai` posts {model, prompt}; `volc` posts {model, content[]} to the
    // Volcengine-style task route (…/api/v3/contents/generations/tasks).
    style: 'openai',
    pollIntervalMs: 5_000,
    timeoutMs: 600_000,
    createPath: 'videos',
    statusPath: 'videos/{id}',
    contentPath: 'videos/{id}/content',
  },
  trigger: { providers: [], models: [] },
  tools: { vision: true, speech: true, video: true, status: true },
}

/** Read a value only when it has the expected primitive type. */
function pick(value, fallback, guard) {
  return guard(value) ? value : fallback
}

const isString = (value) => typeof value === 'string'
const isBoolean = (value) => typeof value === 'boolean'
const isPositiveNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0

/** Keep a string list, trimming entries and dropping blanks. */
function stringList(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/** Merge one nested group over its defaults, ignoring wrongly typed fields. */
function group(raw, defaults) {
  const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const merged = {}
  for (const [key, fallback] of Object.entries(defaults)) {
    const guard = typeof fallback === 'string'
      ? isString
      : typeof fallback === 'boolean'
        ? isBoolean
        : isPositiveNumber
    merged[key] = pick(source[key], fallback, guard)
  }
  return merged
}

/** Strip trailing slashes so path suffixes concatenate predictably. */
function normalizeBaseUrl(value) {
  return value.trim().replace(/\/+$/u, '')
}

/**
 * Resolve the raw row config.
 * @param raw - the `config` object written in the patch row.
 * @returns the resolved configuration; each capability carries its own
 *   `endpoint` (its `baseUrl`, else the shared one) and `configured` is false
 *   while no endpoint is available at all.
 */
export function resolveConfig(raw) {
  const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const baseUrl = normalizeBaseUrl(pick(source.baseUrl, '', isString))
  const apiKey = pick(source.apiKey, '', isString).trim()
  const apiKeyEnv = pick(source.apiKeyEnv, '', isString).trim()
  const outputDir = pick(source.outputDir, '', isString).trim() || DEFAULT_OUTPUT_DIR
  const vision = group(source.vision, GROUP_DEFAULTS.vision)
  const speech = group(source.speech, GROUP_DEFAULTS.speech)
  const video = group(source.video, GROUP_DEFAULTS.video)
  // The Volcengine-shaped route lives at /contents/generations/tasks; keep the
  // default paths in step with the selected body style.
  if (video.style === 'volc') {
    if (video.createPath === GROUP_DEFAULTS.video.createPath) video.createPath = 'contents/generations/tasks'
    if (video.statusPath === GROUP_DEFAULTS.video.statusPath) video.statusPath = 'contents/generations/tasks/{id}'
  }
  for (const target of [vision, speech, video]) {
    const own = normalizeBaseUrl(target.baseUrl)
    target.endpoint = own.length > 0 ? own : baseUrl
  }
  return {
    baseUrl,
    apiKey,
    apiKeyEnv,
    outputDir: path.resolve(outputDir),
    vision,
    speech,
    video,
    trigger: {
      providers: stringList(source.trigger?.providers),
      models: stringList(source.trigger?.models),
    },
    tools: group(source.tools, GROUP_DEFAULTS.tools),
    configured: vision.endpoint.length > 0 || speech.endpoint.length > 0 || video.endpoint.length > 0,
  }
}

/**
 * Resolve the bearer credential for one capability, so each vendor keeps its own
 * key. A capability's own `apiKey` or `apiKeyEnv` wins; the shared one is the
 * fallback when the capability leaves both empty.
 * @param config - resolved bridge configuration.
 * @param capability - `vision`, `speech`, or `video`; omitted reads the shared key.
 * @returns the credential value, or an empty string when none is configured.
 */
export function resolveApiKey(config, capability) {
  const group = capability === undefined ? undefined : config[capability]
  const own = typeof group?.apiKey === 'string' ? group.apiKey.trim() : ''
  if (own.length > 0) return own
  const ownEnv = typeof group?.apiKeyEnv === 'string' ? group.apiKeyEnv.trim() : ''
  if (ownEnv.length > 0) return (process.env[ownEnv] ?? '').trim()
  if (config.apiKey.length > 0) return config.apiKey
  if (config.apiKeyEnv.length === 0) return ''
  return (process.env[config.apiKeyEnv] ?? '').trim()
}

/** Whether one capability has a usable credential, own or shared. */
export function hasApiKey(config, capability) {
  return resolveApiKey(config, capability).length > 0
}

/** Match one selection value against a `*` wildcard pattern. */
function globMatch(pattern, value) {
  if (pattern === '*') return true
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*')
  return new RegExp(`^${escaped}$`, 'u').test(value)
}

/** An empty list gate accepts everything. */
function gate(patterns, values) {
  if (patterns.length === 0) return true
  return values.some((value) => patterns.some((pattern) => globMatch(pattern, value)))
}

/**
 * Whether the tools should be visible for the current step's model.
 * `providers` matches the provider id; `models` matches `provider/model` and
 * the bare model id, so one rule can target either granularity.
 */
export function exposeFor(config, selection) {
  const provider = selection?.provider ?? ''
  const model = selection?.model ?? ''
  return gate(config.trigger.providers, [provider])
    && gate(config.trigger.models, [model, `${provider}/${model}`])
}
