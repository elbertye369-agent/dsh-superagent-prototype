/** Gitee source kind, repository polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { GiteeAccountsSchema } from '../deployment.ts'
import { validItems, type Tally } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { sendGitee, giteeLink } from './gitee-channel.ts'
import { GiteePullSchema, giteePullsOf, giteePullThread, observeGiteePull, readGiteePull, type GiteePull } from './gitee-pull.ts'
import { giteeThreadContext } from './gitee-read.ts'
import { CommentSchema, giteeCommentTrigger, giteeIssueTrigger, giteePullTrigger, giteeThread, giteeUrlRef, IssueSchema, SOURCE, type GiteeIssue, type GiteeRef }
  from './gitee-trigger.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause, pollThreads as pollEach } from './poll.ts'

const GiteeConfigSchema = GiteeAccountsSchema.extend({
  pollSeconds: z.number().int().min(30).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observePulls: z.boolean().default(false), observeComments: z.boolean().default(false),
}).strict()
export type GiteeConfig = z.infer<typeof GiteeConfigSchema>
type Scope = 'issues' | 'pulls' | 'comments'
const observedKey = { issues: 'observeIssues', pulls: 'observePulls', comments: 'observeComments' } as const
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'pull') return 'pulls'
  return meta.kind === 'comment' ? 'comments' : undefined
}
export const giteeKind: SourceKind<GiteeConfig> = {
  kind: SOURCE,
  title: { zh: 'Gitee', en: 'Gitee' },
  description: { zh: '独立管理一个或多个 Gitee 仓库：接收 Issue、PR 和评论，推拉代码并通过 Gitee 提交 PR。', en: 'Independently manages one or more Gitee repositories: receives Issues, PRs and comments, pulls and pushes code, and opens PRs through Gitee.' },
  schema: GiteeConfigSchema,
  fields: [
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '监听的 Gitee 仓库', en: 'Gitee repository' },
      hint: { zh: '写作 owner/name。与 GitHub 仓库互不影响；保存时检查账号能否读取和推送，然后重启 dsh-superagent。', en: 'Written owner/name. Independent of the GitHub repository; saving checks read and push access, then restarts dsh-superagent.' } },
    { key: 'repositories', type: 'rows', label: { zh: '同时监听的其他 Gitee 仓库', en: 'Additional Gitee repositories to watch' },
      hint: { zh: '每行一个 owner/name，与上面的仓库一起轮询；保存时逐个检查读取和推送权限，然后重启 dsh-superagent。', en: 'One owner/name per row, polled together with the repository above; saving checks read and push access for each, then restarts dsh-superagent.' },
      columns: [{ key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '仓库', en: 'Repository' } }] },
    { key: 'cli', type: 'text', label: { zh: '智能体的 Gitee CLI', en: 'Agent Gitee CLI' },
      hint: { zh: '命令名或绝对路径，指向登录智能体账号的 gitee 包装脚本。执行器以 gitee 调用它，git 通过它取得 Gitee 凭据。', en: 'A command name or absolute path of a gitee wrapper signed in as the agent. Executors call it as gitee, and git obtains Gitee credentials through it.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收仓库里的新 Issue', en: 'Receive new Issues in the repository' } },
    { key: 'observePulls', type: 'switch', label: { zh: '接收仓库里的新 PR', en: 'Receive new pull requests in the repository' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收仓库里的评论', en: 'Receive comments in the repository' } },
  ],
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[observedKey[row]], ...row ? { row } : {} }
  },
  health: ['gitee'],
  channel: { send: sendGitee, link: giteeLink },
  threadContext: giteeThreadContext,
  find: (query, config) => {
    const trimmed = query.trim()
    const url = giteeUrlRef(trimmed)
    const repositories = config ? [config.repository, ...config.repositories.map(row => row.repository)].filter(Boolean)
      .filter((repository, index, all) => all.findIndex(other => sameName(repository, other)) === index) : []
    const pr = /^!(\d+)$/.exec(trimmed), issue = /^#([A-Za-z0-9]+)$/.exec(trimmed), plain = /^\d+$/.exec(trimmed)
    const threads = url ? [giteeThread(url.repository, url.number, url.pr)]
      : repositories.flatMap(repository => pr ? [giteeThread(repository, pr[1]!, true)] : issue ? [giteeThread(repository, issue[1]!, false)]
        : plain ? [giteeThread(repository, plain[0], false), giteeThread(repository, plain[0], true)] : [])
    return { threads, terms: [] }
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]+(\[bot\])?$/) }).strict()).optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Gitee 账号', en: 'Gitee accounts that may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_\\-]+' }] },
      { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_\\-]+(\\[bot\\])?' }] },
    ],
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的 Gitee 账号。', en: 'An account on the list mentions the agent\'s Gitee account in an Issue or comment.' },
    rows(stored) {
      const config = GiteeConfigSchema.partial().parse(stored)
      const row = (id: Scope, label: Localized) => {
        const observed = !!config[observedKey[id]]
        return { id, label, note: observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' },
          cells: { listedUnaddressed: observed, unlistedAddressed: true, unlistedUnaddressed: observed } }
      }
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('pulls', { zh: '新 PR', en: 'New pull requests' }),
        row('comments', { zh: '评论', en: 'Comments' })]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITEE_REPOSITORY', description: { zh: '这个工单所属的 Gitee 仓库，owner/name；这里的 PR 用 gitee 创建', en: 'The Gitee repository this ticket belongs to, as owner/name; open its PRs with gitee' } },
      { key: 'DSH_SUPERAGENT_GITEE_REPOSITORIES', description: { zh: '这个来源同时监听的全部 Gitee 仓库，owner/name，以空格分隔', en: 'All Gitee repositories this Source watches simultaneously, as owner/name, separated by spaces' } },
      { key: 'DSH_SUPERAGENT_GITEE_ACCOUNT', description: { zh: '智能体的 Gitee 账号；Gitee API 和 PR 操作使用 gitee，不使用其他账号', en: 'The agent\'s Gitee account; use gitee for Gitee API and PR operations, never another account' } },
      { key: 'DSH_SUPERAGENT_GITEE_COMMIT_EMAIL', description: { zh: 'Gitee 工单未指定作者时使用的提交邮箱', en: 'Commit email for Gitee tickets when no author is specified' } },
      { key: 'DSH_SUPERAGENT_GITEE_NUMBER', description: { zh: '接下工单的 Gitee Issue 或 PR 编号；不是 Gitee 工单时为空', en: 'Gitee Issue or PR that started the ticket; empty for other Sources' } },
      { key: 'DSH_SUPERAGENT_GITEE_PR_HEAD', description: { zh: 'Gitee 来源 PR 的 refs/pull/<编号>/head；不是 PR 时为空', en: 'Head ref refs/pull/<number>/head of the Gitee source PR; empty otherwise' } },
    ],
    values: ({ deployment, trigger }) => {
      const gitee = deployment.gitee
      const number = trigger?.source === SOURCE ? String(trigger.meta.number ?? '') : ''
      const repository = typeof trigger?.meta.repository === 'string' && trigger.meta.repository.trim() ? trigger.meta.repository : gitee?.repository
      return { DSH_SUPERAGENT_GITEE_REPOSITORY: repository ?? '', DSH_SUPERAGENT_GITEE_ACCOUNT: gitee?.login ?? '',
        DSH_SUPERAGENT_GITEE_REPOSITORIES: gitee?.repositories.join(' ') ?? '', DSH_SUPERAGENT_GITEE_COMMIT_EMAIL: gitee?.noreply ?? '', DSH_SUPERAGENT_GITEE_NUMBER: number,
        DSH_SUPERAGENT_GITEE_PR_HEAD: number && trigger?.meta.isPr === true ? `refs/pull/${number}/head` : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitee ? {
    cli: { zh: `当前账号 @${deployment.gitee.login}`, en: `Current account @${deployment.gitee.login}` },
  } : {},
}
export const name = 'dsh-superagent-gitee'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(giteeKind), 'gitee: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, giteeKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('gitee', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gitee', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GiteeConfig>(SOURCE)
    try {
      if (!config) ctx.report('gitee', health('paused', 'sourceOff'))
      else if (ctx.problem) ctx.report('gitee', { state: 'paused', detail: ctx.problem.detail })
      else if (!ctx.deployment.gitee) ctx.report('gitee', health('paused', 'giteeNotConfigured'))
      else await pollRound(ctx, signal)
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitee', failed)
    }
    await pause((config?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round { started: string; signal?: AbortSignal | undefined; read: Set<string>; objects: number; tally: Tally; failures: string[] }
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, read: new Set(), objects: 0, tally: { skipped: 0 }, failures: [] })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
function nameThread(ctx: SourceContext, repository: string, number: string | number, isPr: boolean, title: string, url?: string): void {
  const thread = giteeThread(repository, number, isPr)
  ctx.threads.patch(thread, { repository, number, isPr, title, ...url ? { url } : {} })
  ctx.threads.describe(thread, { label: `${isPr ? '!' : '#'}${number} ${title}`, ...url ? { url } : {},
    facts: { repository: { value: repository }, number: { value: `${isPr ? '!' : '#'}${number}` } } })
}
async function intakeComments(ctx: SourceContext, ref: GiteeRef, since: string, round: Round): Promise<void> {
  const path = `${ref.isPr ? 'pulls' : 'issues'}/${encodeURIComponent(String(ref.number))}/comments?per_page=100`
  const comments = await ctx.commands.withSignal(round.signal).giteeIn(ref.repository).pages(CommentSchema, path, round.tally)
  const agent = ctx.deployment.gitee!.login
  for (const comment of comments) {
    if (stopped(ctx, round)) throw new Error('The Gitee Source stopped during the poll')
    const timestamp = Date.parse(comment.updated_at ?? comment.created_at ?? '')
    if (!Number.isFinite(timestamp) || timestamp < Date.parse(since) || sameName(comment.user.login, agent)) continue
    const trigger = giteeCommentTrigger(comment, ref, agent)
    if (trigger.text) await ctx.receive(trigger)
  }
}
async function readIssue(ctx: SourceContext, repository: string, issue: GiteeIssue, since: string, round: Round): Promise<void> {
  const thread = giteeThread(repository, issue.number, false)
  round.read.add(thread)
  const agent = ctx.deployment.gitee!.login
  if (Date.parse(issue.created_at) >= Date.parse(since) && !sameName(issue.user.login, agent)) await ctx.receive(giteeIssueTrigger(issue, agent, repository))
  const checkpoint = KV.gitee.cursor(thread)
  await intakeComments(ctx, { repository, number: issue.number, isPr: false, url: issue.html_url }, ctx.state.get(checkpoint) ?? since, round)
  nameThread(ctx, repository, issue.number, false, issue.title, issue.html_url)
  ctx.state.set(checkpoint, cursorAt(round.started))
}
async function readPull(ctx: SourceContext, repository: string, pr: GiteePull, since: string, round: Round): Promise<void> {
  const thread = giteeThread(repository, pr.number, true)
  round.read.add(thread)
  const agent = ctx.deployment.gitee!.login
  if (Date.parse(pr.created_at) >= Date.parse(since) && !sameName(pr.user.login, agent)) await ctx.receive(giteePullTrigger(pr, agent, repository))
  const checkpoint = KV.gitee.cursor(thread)
  await intakeComments(ctx, { repository, number: pr.number, isPr: true, url: pr.html_url }, ctx.state.get(checkpoint) ?? since, round)
  ctx.state.set(checkpoint, cursorAt(round.started))
  await observeGiteePull(ctx, pr, repository)
  nameThread(ctx, repository, pr.number, true, pr.title, pr.html_url)
}
async function pollStream(ctx: SourceContext, repository: string, round: Round, pull: boolean): Promise<void> {
  const name = KV.gitee.stream(`${repository}/${pull ? 'pulls' : 'issues'}`)
  const since = ctx.state.get(name)?.since ?? round.started
  const path = `${pull ? 'pulls' : 'issues'}?state=all&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`
  const listed = await ctx.commands.withSignal(round.signal).giteeIn(repository).pages(z.unknown(), path)
  if (pull) {
    for (const item of validItems(GiteePullSchema, listed, round.tally)) {
      if (stopped(ctx, round)) throw new Error('The Gitee Source stopped during the poll')
      if (!Number.isFinite(Date.parse(item.updated_at)) || Date.parse(item.updated_at) < Date.parse(since)) continue
      round.objects += 1
      await readPull(ctx, repository, item, since, round)
    }
  } else {
    for (const item of validItems(IssueSchema, listed, round.tally)) {
      if (stopped(ctx, round)) throw new Error('The Gitee Source stopped during the poll')
      if (!Number.isFinite(Date.parse(item.updated_at)) || Date.parse(item.updated_at) < Date.parse(since)) continue
      round.objects += 1
      await readIssue(ctx, repository, item, since, round)
    }
  }
  ctx.state.set(name, { since: cursorAt(round.started) })
}
/** Polls all open Gitee PRs followed by Tickets so their close and merge states complete the correct Tickets. */
export async function pollTicketPulls(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  const pulls = new Map(ctx.tickets.open().flatMap(ticket => giteePullsOf(ticket, true)).map(ref => [giteePullThread(ref.repository, ref.number), ref]))
  for (const [thread, { repository, number }] of pulls) {
    if (stopped(ctx, round)) return
    try {
      const pr = await readGiteePull(ctx, number, signal, repository)
      nameThread(ctx, repository, number, true, pr.title, pr.html_url)
      round.read.add(thread)
      await observeGiteePull(ctx, pr, repository)
    } catch (error) { if (!stopped(ctx, round)) round.failures.push(`${repository} PR !${number}: ${String(error)}`) }
  }
}
/** Polls subscribed Gitee Issue and PR Threads not already covered by a repository stream in this round. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try {
      const parsed = /^gitee:([^/]+\/[^/]+):(issue|pull):([A-Za-z0-9]+)$/.exec(thread.key)
      const repository = typeof thread.meta.repository === 'string' && thread.meta.repository.trim() ? thread.meta.repository : parsed?.[1]
      if (!repository) throw new Error('The Gitee Thread has no repository')
      const number = String(thread.meta.number ?? parsed?.[3] ?? '')
      const isPr = typeof thread.meta.isPr === 'boolean' ? thread.meta.isPr : parsed?.[2] === 'pull'
      const checkpoint = KV.gitee.cursor(thread.key)
      const since = ctx.state.get(checkpoint) ?? thread.createdAt
      if (isPr) await readGiteePull(ctx, Number(number), signal, repository).then(pr => readPull(ctx, repository, pr, since, round))
      else await ctx.commands.withSignal(signal).giteeIn(repository).api(IssueSchema, `issues/${encodeURIComponent(number)}`)
        .then(issue => readIssue(ctx, repository, issue, since, round))
      ctx.threads.patch(thread.key, { pollError: undefined })
    } catch (error) {
      if (!stopped(ctx, round)) round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => round.read.has(thread.key))
}
/** One Gitee polling round: updated Issues and PRs, open ticket PRs, then remaining subscribed Threads. */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const round = newRound(signal)
  for (const repository of ctx.deployment.gitee?.repositories ?? []) {
    for (const pull of [false, true]) {
      if (stopped(ctx, round)) return
      try { await pollStream(ctx, repository, round, pull) }
      catch (error) { if (!stopped(ctx, round)) round.failures.push(`${repository} ${pull ? 'pulls' : 'issues'}: ${String(error)}`) }
    }
  }
  try { await pollTicketPulls(ctx, signal, round) }
  catch (error) { if (!stopped(ctx, round)) round.failures.push(`ticket PRs: ${String(error)}`) }
  await pollThreads(ctx, signal, round)
  if (round.failures.length) throw new Error(`${round.failures.length} Gitee reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  if (signal?.aborted) return
  ctx.report('gitee', { state: 'ready', detail: `${round.objects} updated Issues/PRs${round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : ''}`, at: round.started })
}
