/** Gitee outbound channel: posts idempotent Issue and pull-request comments under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { CommentSchema, giteePage } from './gitee-trigger.ts'

const gone = (error: unknown): boolean => error instanceof CliError
  && (error.code === 410 || (error.code === 403 && /locked/i.test(error.message)))
/** Posts a comment with an embedded marker, checking first so a retry after an uncertain failure does not duplicate it. */
export async function sendGitee(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const account = commands.deployment.gitee
  if (!account) throw new Error('The Gitee Source has no working CLI')
  const scoped = commands.giteeIn(message.channel.address.repository ?? account.repository)
  const number = message.channel.address.number ?? ''
  const pull = message.channel.address.kind === 'pull'
  if (!number) throw new Error('Missing Gitee reply target')
  const path = `${pull ? 'pulls' : 'issues'}/${encodeURIComponent(number)}/comments`
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    const mine = (comment: z.infer<typeof CommentSchema>) => sameName(comment.user.login, account.login) && (comment.body ?? '').includes(marker)
    if ((await scoped.pages(CommentSchema, path)).some(mine)) return 'sent'
    await scoped.api(z.unknown(), path, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
export function giteeLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const number = address.number ?? '', pull = address.kind === 'pull'
  const repository = address.repository ?? links.giteeRepository
  const label = `Gitee ${address.repository ? `${address.repository} ` : ''}${pull ? '!' : '#'}${number}`
  return { url: address.url ?? (repository ? giteePage(repository, number, pull) : ''), label: { zh: label, en: label } }
}
