import { loadConfig } from '../config/manager.js'
import { assertDefaultModelRef, contractModels } from '../config/contract-models.js'

/** New-session defaults and resume degradation must read the same fresh model pool. */
export function resolveSessionDefaults(
  cwd: string,
  startupModel?: string,
  startupDomain = 'qiming',
  readConfig: typeof loadConfig = loadConfig,
): { model?: string; modelRef?: string; domain: string } {
  let model = startupModel
  let modelRef: string | undefined
  let domain = startupDomain
  try {
    const config = readConfig({ cwd })
    domain = config.agent.defaultDomain || domain
    const providerName = config.provider.default
    const provider = config.provider.providers[providerName]
    const first = provider && contractModels(provider)[0]
    if (first) {
      model = first.id
      modelRef = `${providerName}:${first.id}`
    }
    const configured = config.agent.defaultModel
    if (configured) {
      try {
        assertDefaultModelRef(config.provider.providers, configured)
        model = modelRef = configured
      } catch { /* Invalid configured reference: use the default provider's actual pool. */ }
    }
  } catch {
    // Only a failed config read permits the startup snapshot on resume.
    modelRef = startupModel
  }
  return { model, modelRef, domain }
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  const hours = Math.floor(minutes / 60)
  if (hours === 0) return `${minutes}m ${seconds}s`
  return `${hours}h ${minutes % 60}m`
}