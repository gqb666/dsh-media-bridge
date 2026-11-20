/**
 * The bridge tools. Each tool forwards one media task to the endpoint in the
 * row config and returns either text or an absolute path to a saved artifact.
 * Registration is conditional on the step's model selection, so a user can keep
 * these tools out of a multimodal model's catalog with `trigger` rules.
 */

import path from 'node:path'

import { exposeFor } from './config.js'
import { authHeaders, joinUrl, fillPath, readJson, send, sleep } from './http.js'
import { completionText, extensionFor, imageReference, readBlob, saveArtifact } from './media.js'

/** Model-facing text block. */
const text = (value) => [{ type: 'text', text: value }]

/** Fail early with the config key the user still has to fill in. */
function requireValue(value, key) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} is not configured; set it in the media-bridge plugin config`)
  }
  return value
}

/**
 * Blob plus file name for a multipart upload from a local path, data URI, or URL.
 * The name carries the extension that many endpoints use to pick a decoder.
 */
async function uploadPart(reference) {
  if (/^data:/iu.test(reference)) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/isu.exec(reference)
    if (match === null) throw new Error('malformed data URI')
    const [, mediaType = 'application/octet-stream', base64, payload] = match
    const buffer = base64 === undefined
      ? Buffer.from(decodeURIComponent(payload), 'utf8')
      : Buffer.from(payload, 'base64')
    const extension = mediaType.split('/')[1]?.replace(/[^a-z0-9]/giu, '') ?? 'bin'
    return { blob: new Blob([buffer], { type: mediaType }), fileName: `upload.${extension}` }
  }
  if (/^https?:\/\//iu.test(reference)) {
    const response = await fetch(reference)
    if (!response.ok) throw new Error(`could not download ${reference}: HTTP ${response.status}`)
    const remoteName = path.basename(new URL(reference).pathname)
    return { blob: await response.blob(), fileName: remoteName.length > 0 ? remoteName : 'upload.bin' }
  }
  return { blob: await readBlob(reference), fileName: path.basename(reference) }
}

/** `media_vision` definition. */
function visionDefinition(config) {
  return {
    name: 'media_vision',
    description:
      'Inspect local image files with a separately configured vision model and return that '
      + "model's written answer. Use it when the current model cannot accept images itself.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          description: 'What to determine about the images: a question, an extraction task, or a description request.',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description:
            'One or more references to the same question: absolute local file paths, http(s) URLs, '
            + 'or data URIs. Local files are encoded and sent inline.',
        },
        model: {
          type: 'string',
          description: 'Vision model id for this call. Defaults to the configured vision model.',
        },
        maxTokens: {
          type: 'integer',
          description: 'Cap on the generated answer length in tokens. Defaults to the configured value.',
        },
      },
      required: ['prompt', 'images'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', description: 'Vision model that answered.' },
          imageCount: { type: 'integer', description: 'Number of images sent.' },
          text: { type: 'string', description: 'Complete answer text.' },
        },
        required: ['model', 'imageCount', 'text'],
      },
      render: (_args, value) => text(`${value.text}\n\n[media_vision · ${value.model} · ${value.imageCount} image(s)]`),
    },
    timeoutMs: config.vision.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const model = requireValue(args.model ?? config.vision.model, 'vision.model')
      const references = Array.isArray(args.images) ? args.images.filter((entry) => typeof entry === 'string') : []
      if (references.length === 0) throw new Error('images must contain at least one reference')
      const content = [{ type: 'text', text: args.prompt }]
      for (const reference of references) {
        content.push({ type: 'image_url', image_url: { url: await imageReference(reference) } })
      }
      const response = await send(config, {
        method: 'POST',
        url: joinUrl(config.vision.endpoint, config.vision.path),
        headers: {},
        json: {
          model,
          max_tokens: args.maxTokens ?? config.vision.maxTokens,
          messages: [{ role: 'user', content }],
        },
        signal: exec.signal,
        timeoutMs: config.vision.timeoutMs,
        label: 'vision request',
      })
      const payload = await readJson(response, 'vision request')
      const answer = completionText(payload)
      if (answer.trim().length === 0) throw new Error('vision request returned no text content')
      return { model, imageCount: references.length, text: answer }
    },
  }
}

/** `media_speech` definition: recognition in, synthesis out. */
function speechDefinition(config) {
  return {
    name: 'media_speech',
    description:
      'Move between audio and text with a separately configured speech model: `transcribe` turns a '
      + 'local audio file into text, `synthesize` turns text into an audio file and returns its path.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation: {
          type: 'string',
          enum: ['transcribe', 'synthesize'],
          description: 'Which direction to run.',
        },
        audioPath: {
          type: 'string',
          description: 'Absolute path of the audio file to transcribe. Required for `transcribe`.',
        },
        text: {
          type: 'string',
          description: 'Text to speak. Required for `synthesize`.',
        },
        voice: {
          type: 'string',
          description: 'Voice id for `synthesize`. Defaults to the configured voice.',
        },
        model: {
          type: 'string',
          description:
            'Model id for this call: the transcription or text-to-speech model. Defaults to the matching configured model.',
        },
        format: {
          type: 'string',
          description: 'Audio container for `synthesize`, such as mp3, wav, or opus. Defaults to the configured format.',
        },
      },
      required: ['operation'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operation: { type: 'string', description: 'Operation that ran.' },
          model: { type: 'string', description: 'Speech model that ran.' },
          text: { type: 'string', description: 'Transcribed text; empty for synthesis.' },
          path: { type: 'string', description: 'Saved audio file path; empty for transcription.' },
        },
        required: ['operation', 'model', 'text', 'path'],
      },
      render: (_args, value) => text(value.operation === 'transcribe'
        ? `${value.text}\n\n[media_speech · transcribe · ${value.model}]`
        : `Saved audio: ${value.path}\n\n[media_speech · synthesize · ${value.model}]`),
    },
    timeoutMs: config.speech.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.operation === 'transcribe') {
        const model = requireValue(args.model ?? config.speech.model, 'speech.model')
        const filePath = requireValue(args.audioPath, 'audioPath')
        const form = new FormData()
        const part = await uploadPart(filePath)
        form.append('file', part.blob, part.fileName)
        form.append('model', model)
        const response = await send(config, {
          method: 'POST',
          url: joinUrl(config.speech.endpoint, config.speech.transcribePath),
          form,
          signal: exec.signal,
          timeoutMs: config.speech.timeoutMs,
          label: 'transcription request',
        })
        const payload = await readJson(response, 'transcription request')
        const transcript = typeof payload?.text === 'string' ? payload.text : ''
        return { operation: 'transcribe', model, text: transcript, path: '' }
      }

      if (args.operation === 'synthesize') {
        const model = requireValue(args.model ?? config.speech.ttsModel, 'speech.ttsModel')
        const input = requireValue(args.text, 'text')
        const format = typeof args.format === 'string' && args.format.length > 0 ? args.format : config.speech.format
        const voice = args.voice ?? (config.speech.voice.length > 0 ? config.speech.voice : undefined)
        const response = await send(config, {
          method: 'POST',
          url: joinUrl(config.speech.endpoint, config.speech.synthesizePath),
          json: { model, input, ...(voice === undefined ? {} : { voice }), response_format: format },
          signal: exec.signal,
          timeoutMs: config.speech.timeoutMs,
          label: 'speech request',
        })
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('json')) {
          // Some gateways answer with a queued task instead of audio bytes.
          const payload = await readJson(response, 'speech request')
          const taskId = payload?.task_id ?? payload?.id
          throw new Error(
            'speech endpoint returned a task document instead of audio'
            + `${typeof taskId === 'string' ? ` (task ${taskId})` : ''}: `
            + 'point speech.synthesizePath at a synchronous audio route, or fetch the task result yourself. '
            + JSON.stringify(payload).slice(0, 200),
          )
        }
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length === 0) throw new Error('speech request returned no audio')
        const extension = extensionFor(contentType, format, '.mp3')
        const saved = await saveArtifact(config.outputDir, bytes, {
          extension,
          sourceName: input.slice(0, 40),
          fallbackName: 'speech',
        })
        return { operation: 'synthesize', model, text: '', path: saved }
      }

      throw new Error('operation must be transcribe or synthesize')
    },
  }
}

/** Whether a polled video job reached a terminal failure state. */
function failedState(status) {
  return status === 'failed' || status === 'error' || status === 'cancelled'
}

/** `media_video` definition: generation and prompt-driven editing. */
function videoDefinition(config) {
  const toolTimeoutMs = config.video.timeoutMs + 30_000
  return {
    name: 'media_video',
    description:
      'Generate a video from a text prompt, or edit one with a prompt, using a separately configured '
      + 'video model. Generation may take minutes; the tool polls the job and saves the finished file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          description: 'What the video should show, or the edit to apply.',
        },
        operation: {
          type: 'string',
          enum: ['generate', 'edit'],
          description: 'Generate a new clip, or edit an existing one. Defaults to generate.',
        },
        imagePath: {
          type: 'string',
          description: 'Reference image for generation: absolute path, URL, or data URI. Optional.',
        },
        videoPath: {
          type: 'string',
          description: 'Source video to edit: absolute path, URL, or data URI. Required for `edit`.',
        },
        model: {
          type: 'string',
          description: 'Video model id for this call. Defaults to the configured video model.',
        },
        seconds: {
          type: 'string',
          description: 'Requested clip length in seconds, when the endpoint accepts a duration.',
        },
        size: {
          type: 'string',
          description: 'Requested frame size, such as 1280x720, when the endpoint accepts one.',
        },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', description: 'Video model that ran.' },
          jobId: { type: 'string', description: 'Upstream job identifier.' },
          path: { type: 'string', description: 'Saved video file path.' },
          elapsedMs: { type: 'integer', description: 'Wall-clock time until the file was saved.' },
        },
        required: ['model', 'jobId', 'path', 'elapsedMs'],
      },
      render: (_args, value) => text(`Saved video: ${value.path}\n\n[media_video · ${value.model} · job ${value.jobId} · ${Math.round(value.elapsedMs / 1000)}s]`),
    },
    timeoutMs: toolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const model = requireValue(args.model ?? config.video.model, 'video.model')
      const startedAt = Date.now()
      const operation = args.operation === 'edit' ? 'edit' : 'generate'
      const source = operation === 'edit' ? requireValue(args.videoPath, 'videoPath') : args.imagePath

      const volc = config.video.style === 'volc'
      let json
      let form
      let headers
      if (volc) {
        // Volcengine-style task body: text plus optional media items as URLs.
        const content = [{ type: 'text', text: args.prompt }]
        if (typeof source === 'string' && source.length > 0) {
          const kind = operation === 'edit' ? 'video_url' : 'image_url'
          content.push({ type: kind, [kind]: { url: await imageReference(source) } })
        }
        json = { model, content }
        if (args.seconds !== undefined) json.duration = Number(args.seconds) || args.seconds
      } else if (typeof source === 'string' && source.length > 0) {
        const part = await uploadPart(source)
        const fields = new FormData()
        fields.append('model', model)
        fields.append('prompt', args.prompt)
        if (args.seconds !== undefined) fields.append('seconds', String(args.seconds))
        if (args.size !== undefined) fields.append('size', String(args.size))
        fields.append(operation === 'edit' ? 'video' : 'input_reference', part.blob, part.fileName)
        form = fields
        // Multipart without a JSON body still answers with the job document.
        headers = { Accept: 'application/json' }
      } else {
        json = { model, prompt: args.prompt }
        if (args.seconds !== undefined) json.seconds = args.seconds
        if (args.size !== undefined) json.size = args.size
      }

      const submitted = await send(config, {
        method: 'POST',
        url: joinUrl(config.video.endpoint, fillPath(config.video.createPath, {})),
        json,
        form,
        headers,
        signal: exec.signal,
        timeoutMs: config.video.timeoutMs,
        label: 'video job submission',
      })
      const job = await readJson(submitted, 'video job submission')
      const jobId = job?.id ?? job?.job_id ?? job?.task_id
      if (typeof jobId !== 'string' || jobId.length === 0) {
        throw new Error(`video job submission returned no job id: ${JSON.stringify(job).slice(0, 300)}`)
      }

      const deadlineAt = Date.now() + config.video.timeoutMs
      let lastStatus = 'queued'
      for (;;) {
        if (Date.now() > deadlineAt) {
          throw new Error(`video job ${jobId} did not finish within ${Math.round(config.video.timeoutMs / 1000)}s (last status: ${lastStatus})`)
        }
        await sleep(config.video.pollIntervalMs, exec.signal)
        const polled = await send(config, {
          method: 'GET',
          url: joinUrl(config.video.endpoint, fillPath(config.video.statusPath, { id: jobId, task_id: jobId })),
          signal: exec.signal,
          timeoutMs: 60_000,
          label: 'video job status',
        })
        const state = await readJson(polled, 'video job status')
        lastStatus = String(state?.status ?? state?.state ?? 'unknown')
        if (failedState(lastStatus)) {
          const reason = state?.error?.message ?? state?.error ?? state?.failure_reason ?? 'no detail'
          throw new Error(`video job ${jobId} failed: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`)
        }
        if (lastStatus === 'completed' || lastStatus === 'succeeded' || lastStatus === 'success') {
          const inline = state?.url ?? state?.video_url ?? state?.output?.url ?? state?.content?.video_url
          const contentUrl = typeof inline === 'string' && inline.length > 0
            ? inline
            : joinUrl(config.video.endpoint, fillPath(config.video.contentPath, { id: jobId, task_id: jobId }))
          const downloaded = await send(config, {
            method: 'GET',
            url: contentUrl,
            headers: authHeaders(config),
            signal: exec.signal,
            timeoutMs: config.video.timeoutMs,
            label: 'video download',
          })
          const mime = downloaded.headers.get('content-type') ?? 'video/mp4'
          if (mime.includes('application/json')) {
            // Some gateways answer with a signed URL instead of the bytes.
            const envelope = await readJson(downloaded, 'video download')
            const signed = envelope?.url ?? envelope?.download_url
            if (typeof signed !== 'string' || signed.length === 0) {
              throw new Error('video download returned JSON without a url')
            }
            const direct = await fetch(signed)
            if (!direct.ok) throw new Error(`video download failed: HTTP ${direct.status}`)
            const directBytes = Buffer.from(await direct.arrayBuffer())
            const directPath = await saveArtifact(config.outputDir, directBytes, {
              extension: extensionFor(direct.headers.get('content-type'), undefined, '.mp4'),
              sourceName: args.prompt,
              fallbackName: 'video',
            })
            return { model, jobId, path: directPath, elapsedMs: Date.now() - startedAt }
          }
          const bytes = Buffer.from(await downloaded.arrayBuffer())
          if (bytes.length === 0) throw new Error('video download returned no bytes')
          const saved = await saveArtifact(config.outputDir, bytes, {
            extension: extensionFor(mime, undefined, '.mp4'),
            sourceName: args.prompt,
            fallbackName: 'video',
          })
          return { model, jobId, path: saved, elapsedMs: Date.now() - startedAt }
        }
      }
    },
  }
}

/** `media_status` definition: what the bridge will do, and whether the endpoint answers. */
function statusDefinition(config) {
  return {
    name: 'media_status',
    description:
      'Report the media bridge configuration: endpoint, selected models, trigger rules, and whether the '
      + 'endpoint answers. Use it to diagnose a failed media call.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ping: {
          type: 'boolean',
          description: 'Also request the endpoint model list to check reachability and credentials.',
        },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string', description: 'Human-readable configuration and reachability summary.' },
          reachable: { type: 'boolean', description: 'Whether the ping request succeeded; false when not attempted.' },
        },
        required: ['report', 'reachable'],
      },
      render: (_args, value) => text(value.report),
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const lines = [
        `vision: ${config.vision.endpoint || '(unset)'} · ${config.vision.model || '(unset)'}`,
        `speech: ${config.speech.endpoint || '(unset)'} · asr ${config.speech.model || '(unset)'} / tts ${config.speech.ttsModel || '(unset)'}`,
        `video: ${config.video.endpoint || '(unset)'} · ${config.video.model || '(unset)'}`,
        `output dir: ${config.outputDir}`,
        `trigger providers: ${config.trigger.providers.join(', ') || '(any)'}`,
        `trigger models: ${config.trigger.models.join(', ') || '(any)'}`,
      ]
      if (args.ping !== true) {
        return { report: `${lines.join('\n')}\nreachable: not checked`, reachable: false }
      }
      // Each capability may live on its own host, so probe every distinct one.
      const endpoints = [...new Set([config.vision.endpoint, config.speech.endpoint, config.video.endpoint].filter((value) => value.length > 0))]
      const results = []
      let reachable = false
      for (const endpoint of endpoints) {
        try {
          const response = await send(config, {
            method: 'GET',
            url: `${endpoint}/models`,
            signal: exec.signal,
            timeoutMs: 15_000,
            label: `model list ${endpoint}`,
          })
          const payload = await readJson(response, `model list ${endpoint}`)
          const ids = Array.isArray(payload?.data)
            ? payload.data.map((entry) => entry?.id).filter((id) => typeof id === 'string')
            : []
          reachable = reachable || ids.length > 0
          results.push(`${endpoint}: ok, ${ids.length} model(s)${ids.length > 0 ? ` — ${ids.slice(0, 6).join(', ')}…` : ''}`)
        } catch (error) {
          results.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return {
        report: `${lines.join('\n')}\n${results.join('\n')}\nreachable: ${reachable ? 'yes' : 'no'}`,
        reachable,
      }
    },
  }
}

/** Register one definition with the step-time visibility rule. */
function register(ctx, config, definition) {
  ctx.tools.register(definition, {
    when: ({ modelSelection }) => exposeFor(config, modelSelection),
  })
}

/** Prompt guidance, present only while the vision tool is visible for the step. */
function registerPromptSection(ctx) {
  ctx.systemPrompt.section({
    name: 'tool:media_vision',
    order: 600,
    text: ({ scope, toolSet }) => ctx.tools.get('media_vision', scope, toolSet) === undefined
      ? ''
      : 'The active model may not accept image input. When the user references an image file, call '
        + 'media_vision with the question and the absolute path instead of guessing its content; '
        + 'media_speech converts audio to text and back, and media_video writes generated files to disk.',
  })
}

/**
 * Register every enabled bridge tool.
 * @param ctx - context whose `tools` registry receives the definitions.
 * @param config - resolved configuration; an unconfigured endpoint registers
 *   nothing so an empty row never advertises unusable tools.
 */
export function registerMediaTools(ctx, config) {
  if (!config.configured) {
    ctx.logger?.warn?.('media-bridge: baseUrl is empty; no tools registered')
    return
  }
  // A tool appears only when its own endpoint and model are configured, so the
  // catalog never advertises a call that would fail on a missing endpoint.
  const visionReady = config.tools.vision && config.vision.endpoint.length > 0 && config.vision.model.length > 0
  if (visionReady) register(ctx, config, visionDefinition(config))
  const speechReady = config.tools.speech
    && config.speech.endpoint.length > 0
    && (config.speech.model.length > 0 || config.speech.ttsModel.length > 0)
  if (speechReady) register(ctx, config, speechDefinition(config))
  if (config.tools.video && config.video.endpoint.length > 0 && config.video.model.length > 0) {
    register(ctx, config, videoDefinition(config))
  }
  if (config.tools.status) register(ctx, config, statusDefinition(config))
  if (visionReady) registerPromptSection(ctx)
}
