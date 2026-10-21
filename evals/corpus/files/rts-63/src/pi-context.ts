import type { Context } from '@earendil-works/pi-ai'

/** pi-ai 0.87 moves the initial prompt and tools into a provider-facing system message. */
interface InitialSystemMessage {
  role: 'system'
  content: string
  toolsAdded?: Context['tools']
  toolsRemoved?: unknown
  sections?: unknown
}

/** Translate the host's initial transcript message for the plugin-owned pi-ai 0.85 provider. */
export function codexProviderContext(context: Context): Context {
  const messages: readonly (Context['messages'][number] | InitialSystemMessage)[] = context.messages
  const [first, ...rest] = messages
  if (!messages.some(message => message.role === 'system')) return context
  if (first?.role !== 'system' || rest.some(message => message.role === 'system')
    || typeof first.content !== 'string' || first.sections !== undefined || first.toolsRemoved !== undefined
    || context.systemPrompt !== undefined || context.tools !== undefined) {
    throw new Error('Codex Connect cannot translate dynamic or ambiguous system messages')
  }
  return {
    systemPrompt: first.content,
    ...(first.toolsAdded === undefined ? {} : { tools: first.toolsAdded }),
    messages: rest as Context['messages'],
  }
}
