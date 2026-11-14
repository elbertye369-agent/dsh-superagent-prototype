/** Gitee pull-request binding, lifecycle observation, and terminal chat notices. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type Ticket } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { giteePage, SOURCE, UserSchema } from './gitee-trigger.ts'

export const GiteePullSchema = z.looseObject({
  number: z.number(), title: z.string(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string(), updated_at: z.string(),
  merged_at: z.string().nullish(), closed_at: z.string().nullish(), draft: z.boolean().nullish(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
  base: z.looseObject({ ref: z.string() }).nullish(),
})
export type GiteePull = z.infer<typeof GiteePullSchema>
export const readGiteePull = async (ctx: SourceContext, number: number, signal?: AbortSignal): Promise<GiteePull> =>
  ctx.commands.withSignal(signal).giteeApi(GiteePullSchema, `pulls/${number}`)
const pullNumber = (thread: string): number | undefined => {
  if (!thread.startsWith(`${SOURCE}:pull:`)) return undefined
  const number = Number(thread.slice(`${SOURCE}:pull:`.length))
  return Number.isInteger(number) && number > 0 ? number : undefined
}
export const giteePullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => pullNumber(item.thread) ?? [])
export const giteePullOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => giteePullsOf(ticket, true).at(-1) ?? giteePullsOf(ticket).at(-1)
export const giteeTicketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
/** True when the agent authored the PR from a branch in the configured Gitee repository, not a fork. */
export function agentGiteePull(pr: Pick<GiteePull, 'user' | 'head'>, deployment: SourceContext['deployment']): boolean {
  const gitee = deployment.gitee
  return !!gitee && sameName(pr.user.login, gitee.login) && sameName(pr.head.repo?.full_name ?? '', gitee.repository)
}
/** Validates and binds a Gitee PR to its origin ticket or the unique ticket whose branch and agent account it uses. */
export function claimGiteePull(ctx: SourceContext, ticketId: string, pr: GiteePull): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.isPr === true && Number(source.meta.number) === pr.number
  const opened = agentGiteePull(pr, ctx.deployment) && giteeTicketBranch(ticket, pr.head.ref)
  if (!started && !opened) {
    const login = ctx.deployment.gitee?.login ?? 'the configured Gitee account'
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const owner = ctx.tickets.open().find(item => giteePullsOf(item, true).includes(pr.number))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const thread = `${SOURCE}:pull:${pr.number}`
  const follow = ticket.follows?.find(item => item.thread === thread)
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, pr, opened)
  return undefined
}
/** Reconciles a polled Gitee PR with its tickets, including automatic branch matching and close or merge completion. */
export async function observeGiteePull(ctx: SourceContext, pr: GiteePull): Promise<boolean> {
  const ended = pr.state === 'closed' || pr.state === 'merged' || !!pr.merged_at
  if (ended) closePull(ctx, pr)
  else {
    const candidates = agentGiteePull(pr, ctx.deployment) ? ctx.tickets.open().filter(ticket => giteeTicketBranch(ticket, pr.head.ref)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    const thread = `${SOURCE}:pull:${pr.number}`
    const reopened = ticket?.follows?.some(item => item.thread === thread && item.closed)
    if (ticket && (reopened || giteePullsOf(ticket, true).every(number => number === pr.number))) claimGiteePull(ctx, ticket.id, pr)
  }
  return ended
}
function bind(ctx: SourceContext, ticketId: string, pr: GiteePull, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: `pull:${pr.number}` }, own)
    ctx.threads.patch(`${SOURCE}:pull:${pr.number}`, { number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.user.login })
  })
}
function closePull(ctx: SourceContext, pr: GiteePull): void {
  if (!ctx.tickets.open().some(ticket => giteePullsOf(ticket, true).includes(pr.number))) return
  const at = pr.merged_at ?? pr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: `pull:${pr.number}` }, pr.merged_at || pr.state === 'merged' ? 'merged' : 'closed', at)
}
/** Builds final IM notices for a ticket ended by a Gitee PR, skipping the Gitee thread that already displays the outcome. */
export function giteePullEndNotices(ticket: Ticket, request: string, repository: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && pullNumber(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const number = pullNumber(follow.thread)!
  const url = giteePage(repository, number, true)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[PR !${number}](${url}) 已合并。` : `[PR !${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR !${number}](${url}) has merged.` : `[PR !${number}](${url}) was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('gitee-pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
