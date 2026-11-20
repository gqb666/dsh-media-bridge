/**
 * Host half of the media bridge: no runtime dependencies. The bundle registers
 * tools that forward image, audio, and video work to whatever OpenAI-compatible
 * endpoint the user configures, plus the configuration route the browser form
 * on this plugin's page writes through.
 */

import { resolveConfig } from './lib/config.js'
import { registerConfigRoutes } from './lib/config-api.js'
import { registerMediaTools } from './lib/tools.js'

/** Loader diagnostics name. */
export const name = 'media-bridge'

/** Registries this plugin writes to. */
export const inject = ['tools', 'systemPrompt']

/**
 * @param ctx - plugin context; tool, prompt, and route registrations are effect-scoped.
 * @param config - the row's `config` object from the profile patch.
 */
export function apply(ctx, config) {
  registerMediaTools(ctx, resolveConfig(config ?? {}))
  registerConfigRoutes(ctx)
}
