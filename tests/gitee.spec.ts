import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, key, type Assessor, type Executor, type Ticket, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { resolveGiteeDeployment, workerProbe } from '../src/deployment.ts'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { ticketEnvironment } from '../src/app/execution-environment.ts'
import { apply as applyGitee, giteeKind, pollRound, pollThreads } from '../src/sources/gitee.ts'
import { giteeAddress, giteeCommentTrigger, giteeIssueTrigger, giteePullTrigger } from '../src/sources/gitee-trigger.ts'
import { claimGiteePull, giteePullEndNotices, observeGiteePull, type GiteePull } from '../src/sources/gitee-pull.ts'
import { claimPull, observePull, type Pull } from '../src/sources/github-pull.ts'
import { issueTrigger } from '../src/sources/github-trigger.ts'
import { githubKind } from '../src/sources/github.ts'
import { readGitee, readGiteeRepositoryPath } from '../src/sources/gitee-read.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'
import { KV } from '../src/kv.ts'

const directories: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function host(overrides: Partial<SourceContextDeps> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'gitee-source-'))
  directories.push(directory)
  const store = new Store(join(directory, 'db.sqlite'))
  stores.push(store)
  store.saveSettings(SettingsSchema.parse({
    sources: { gitee: { enabled: true, config: { repository: 'acme/gadgets', cli: '/bin/gitee-agent' } } },
    policy: { sources: { gitee: { allowed: [{ id: 'alice' }] }, github: { allowed: [{ id: 'alice' }] } } },
  }))
  const board = new HealthBoard()
  const sources = overrides.sources ?? new SourceRegistry(() => store.settings(), board)
  if (!sources.kind('gitee')) sources.register(giteeKind)
  if (!sources.kind('github')) sources.register(githubKind)
  const deployment = testDeployment({ gitee: { cli: '/bin/gitee-agent', login: 'gitee-bot', noreply: '8+gitee-bot@user.noreply.gitee.com', repository: 'acme/gadgets' } })
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() },
    prepareTicket: (ticket, outcome) => {
      const name = outcome.name ?? ticket.id.slice(0, 12)
      return { ...ticket, execution: { name, directory: join(directory, name), assignment: '' } }
    } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: vi.fn() }, commands, sources, deployment, ready: Promise.resolve(),
    configured: () => true, receive, ...overrides }
  return { ...deps, board, receive, engine, store, sources: deps.sources, commands: deps.commands, deployment: deps.deployment, directory,
    context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(deps, kind),
    ctx: sourceContextOf(deps, giteeKind) }
}
const at = () => new Date(Date.now() + 1000).toISOString()
function issue(number = 'IKRYZ3', fields: Record<string, unknown> = {}) {
  const time = at()
  return { id: 100, number, title: 'Fix Gitee widget', body: '@gitee-bot please fix it', state: 'open',
    user: { login: 'alice', type: 'User' }, created_at: time, updated_at: time, html_url: `https://gitee.com/acme/gadgets/issues/${number}`, ...fields }
}
function comment(id = 501, fields: Record<string, unknown> = {}) {
  return { id, body: '@gitee-bot more context', user: { login: 'alice', type: 'User' }, created_at: at(), updated_at: at(),
    html_url: `https://gitee.com/acme/gadgets/issues/IKRYZ3#note_${id}`, ...fields }
}
function giteePull(number: number, ticket: Ticket, fields: Partial<GiteePull> = {}): GiteePull {
  const time = at()
  return { number, title: 'Fix Gitee widget', body: '', state: 'open', html_url: `https://gitee.com/acme/gadgets/pulls/${number}`,
    user: { login: 'gitee-bot', type: 'User' }, created_at: time, updated_at: time,
    head: { sha: 'gitee-head', ref: `agent/${ticket.execution!.name}`, repo: { full_name: 'acme/gadgets' } }, ...fields }
}
function githubPull(number: number, ticket: Ticket): Pull {
  return { number, title: 'Fix GitHub widget', state: 'open', html_url: `https://github.com/acme/widgets/pull/${number}`,
    user: { login: 'agent-bot', type: 'User' }, head: { sha: 'github-head', ref: `agent/${ticket.execution!.name}`, repo: { full_name: 'acme/widgets' } } }
}
/** Stubs `gitee api` against acme/gadgets and returns requested repository-relative paths. */
function api(h: ReturnType<typeof host>, routes: Record<string, unknown>): string[] {
  const reads: string[] = []
  vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
    const target = args[1]!
    const path = target.replace(/^\/repos\/acme\/gadgets\/?/, '')
    reads.push(path)
    const value = routes[path.split('?')[0]!] ?? []
    if (value instanceof Error) throw value
    return JSON.stringify(value)
  })
  return reads
}
function accept(h: ReturnType<typeof host>, trigger: Trigger, name: string): Ticket {
  h.engine.receive(trigger); h.engine.evaluateDue()
  const decided = h.engine.decide(trigger.id, { kind: 'accept', title: name, scope: 'Fix the named widget', reason: 'explicit request', name })
  return h.store.tickets.get(decided.ticketId!)!
}

describe('Gitee triggers and polling', () => {
  it('normalizes string Issue IDs, numeric PRs, mentions, comments, and repository URLs without confusing GitHub', () => {
    const opened = giteeIssueTrigger(issue(), 'gitee-bot')
    expect(opened).toMatchObject({ id: key('gitee-issue', 'IKRYZ3'), source: 'gitee', threads: [{ source: 'gitee', id: 'issue:IKRYZ3' }],
      actor: { source: 'gitee', id: 'alice' }, human: true, addressed: 'mention', channel: { thread: 'gitee:issue:IKRYZ3' } })
    const pull = giteePullTrigger({ number: 7, title: 'Fix', body: '@gitee-bot fix', user: { login: 'alice' }, created_at: at(),
      html_url: 'https://gitee.com/acme/gadgets/pulls/7' }, 'gitee-bot')
    expect(pull).toMatchObject({ id: key('gitee-pull', '7'), threads: [{ id: 'pull:7' }], meta: { isPr: true, number: 7 } })
    const rawComment = comment()
    const reply = giteeCommentTrigger(rawComment, { number: 'IKRYZ3', isPr: false }, 'gitee-bot')
    expect(reply.id).toBe(key('gitee-comment', '501', rawComment.updated_at))
    expect(giteeAddress('https://gitee.com/acme/gadgets/pulls/7#note_1', 'acme/gadgets')).toEqual({ number: '7', pr: true })
    expect(giteeAddress('https://gitee.com/acme/widgets/issues/IABC', 'acme/gadgets')).toBeUndefined()
    expect(giteeIssueTrigger(issue('IOWN', { user: { login: 'Gitee-Bot', type: 'User' } }), 'gitee-bot').human).toBe(false)
  })
  it('takes in mentions once, filters unobserved discussion, counts malformed items, and advances cursors only after intake', async () => {
    const h = host()
    const own = comment(502, { user: { login: 'gitee-bot', type: 'User' } })
    const plain = comment(503, { body: 'ordinary discussion' })
    api(h, { issues: [issue(), { broken: true }], 'issues/IKRYZ3/comments': [comment(), own, plain], pulls: [] })
    await pollRound(h.ctx)
    expect(h.receive).toHaveBeenCalledTimes(3)
    expect(await h.receive.mock.results[0]!.value).toBe('stored')
    expect(await h.receive.mock.results[1]!.value).toBe('stored')
    expect(await h.receive.mock.results[2]!.value).toBe('stored')
    expect(h.engine.candidate(key('gitee-comment', '503', plain.updated_at))).toBeUndefined()
    expect(h.engine.candidate(key('gitee-issue', 'IKRYZ3'))?.strength).toBe('explicit')
    expect(h.store.get(KV.gitee.stream('issues'))?.since).toBeDefined()
    expect(h.store.get(KV.gitee.cursor('gitee:issue:IKRYZ3'))).toBeDefined()
    const calls = h.receive.mock.calls.length
    await pollRound(h.ctx)
    expect(h.receive.mock.calls.length - calls).toBe(3)
    expect(await h.receive.mock.results[calls]!.value).toBe('duplicate')
    expect(h.board.all.gitee?.detail).toContain('1 unreadable items skipped')
  })
  it('keeps the stream cursor when reading its comments fails', async () => {
    const h = host()
    api(h, { issues: [issue()], 'issues/IKRYZ3/comments': new Error('network failed'), pulls: [] })
    await expect(pollRound(h.ctx)).rejects.toThrow('network failed')
    expect(h.store.get(KV.gitee.stream('issues'))).toBeUndefined()
  })
  it('polls a subscribed Issue for new comments even when its repository stream does not list it', async () => {
    const h = host()
    const request = giteeIssueTrigger(issue(), 'gitee-bot')
    accept(h, request, 'gitee-work')
    h.receive.mockClear()
    const followup = comment(504, { body: '@gitee-bot follow up' })
    api(h, { 'issues/IKRYZ3': issue('IKRYZ3', { body: 'original', created_at: '2020-01-01T00:00:00Z', updated_at: at() }),
      'issues/IKRYZ3/comments': [followup] })
    await pollThreads(h.ctx)
    expect(h.receive).toHaveBeenCalledOnce()
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ id: key('gitee-comment', '504', followup.updated_at), text: '@gitee-bot follow up' })
    expect(h.store.get(KV.gitee.cursor('gitee:issue:IKRYZ3'))).toBeDefined()
  })
  it('registers the plugin and reports an unconfigured optional account without affecting GitHub setup', async () => {
    const registry = new SourceRegistry(() => SettingsSchema.parse({}))
    const h = host({ deployment: testDeployment({ gitee: undefined }) })
    const pluginHost = { ...h, sources: registry, context: (kind: { kind: string; health: readonly string[] }) =>
      sourceContextOf({ ...h, sources: registry }, kind) }
    const disposers: (() => unknown)[] = []
    applyGitee({ orchestrator: pluginHost, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(registry.kind('gitee')).toBe(giteeKind))
    await vi.waitFor(() => expect(registry.healthEntries(['gitee']).get('gitee')!.get()?.state).toBe('paused'))
    expect(h.deployment.gitee).toBeUndefined()
    for (const dispose of disposers) await dispose()
    expect(registry.kind('gitee')).toBeUndefined()
  })
})

describe('independent GitHub and Gitee repositories', () => {
  it('resolves the optional Gitee account and push access without probing GitHub', async () => {
    const probe = vi.fn(async (argv: string[]): Promise<string> => argv[1] === 'api' && argv[2] === '/user'
      ? '{"login":"gitee-bot","id":8}' : '{"full_name":"acme/gadgets","owner":{"login":"gitee-bot"},"permissions":null}')
    expect(await resolveGiteeDeployment(testMachine(), {}, probe)).toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
    expect(await resolveGiteeDeployment(testMachine(), { repository: 'acme/gadgets', cli: process.execPath }, probe)).toEqual({
      cli: process.execPath, login: 'gitee-bot', noreply: '8+gitee-bot@user.noreply.gitee.com', repository: 'acme/gadgets',
    })
    expect(probe.mock.calls.map(call => call[0].slice(1))).toEqual([['api', '/user'], ['api', '/repos/acme/gadgets']])
    probe.mockImplementationOnce(async () => '{"login":"gitee-bot","id":8}')
      .mockImplementationOnce(async () => '{"full_name":"acme/gadgets","owner":{"login":"someone-else"},"permissions":null}')
    await expect(resolveGiteeDeployment(testMachine(), { repository: 'acme/gadgets', cli: process.execPath }, probe))
      .rejects.toMatchObject({ place: 'gitee', code: 'giteeRepositoryReadOnly' })
  })
  it('preserves absolute Gitee API paths through the Windows worker probe', async () => {
    const calls: { argv: readonly string[] }[] = []
    const reader = () => ({ readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) })
    const subprocess = { spawn: (spec: { argv: readonly string[] }) => {
      calls.push(spec)
      return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: reader(), stderr: reader() } }
    } } as unknown as SubprocessRuntime
    await workerProbe(subprocess, '/tmp/gitee-state', '/tmp', new AbortController().signal)([process.execPath, 'api', '/user'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv).toContain('MSYS_NO_PATHCONV=1')
    expect(calls[0]!.argv.at(-1)).toBe('/user')
    expect(calls[0]!.argv).not.toContain('D:/Git/user')
  })
  it('runs two Tickets in separate directories with source-specific repositories and PR heads', () => {
    const h = host()
    const githubRequest = issueTrigger({ number: 7, title: 'GitHub work', body: '@agent-bot fix', user: { login: 'alice' },
      created_at: at(), html_url: 'https://github.com/acme/widgets/issues/7' }, 'agent-bot')
    const giteeRequest = giteeIssueTrigger(issue(), 'gitee-bot')
    const githubTicket = accept(h, githubRequest, 'github-work'), giteeTicket = accept(h, giteeRequest, 'gitee-work')
    expect(githubTicket.id).not.toBe(giteeTicket.id)
    expect(githubTicket.execution!.directory).not.toBe(giteeTicket.execution!.directory)
    const environment = (ticket: Ticket, trigger: Trigger) => Object.fromEntries(ticketEnvironment({ deployment: h.deployment,
      sources: h.sources, settings: h.store.settings(), ticket, trigger }).map(variable => [variable.key, variable.value]))
    expect(environment(githubTicket, githubRequest)).toMatchObject({ DSH_SUPERAGENT_SOURCE: 'github', DSH_SUPERAGENT_REPOSITORY: 'acme/widgets',
      DSH_SUPERAGENT_GIT_URL: 'https://github.com/acme/widgets.git', DSH_SUPERAGENT_GITHUB_NUMBER: '7', DSH_SUPERAGENT_GITEE_NUMBER: '' })
    expect(environment(giteeTicket, giteeRequest)).toMatchObject({ DSH_SUPERAGENT_SOURCE: 'gitee', DSH_SUPERAGENT_REPOSITORY: 'acme/gadgets',
      DSH_SUPERAGENT_GIT_URL: 'https://gitee.com/acme/gadgets.git', DSH_SUPERAGENT_GITHUB_NUMBER: '', DSH_SUPERAGENT_GITEE_NUMBER: 'IKRYZ3' })
  })
  it('binds and closes same-numbered PRs independently, ending only the matching repository Ticket', async () => {
    const h = host()
    const githubRequest = issueTrigger({ number: 7, title: 'GitHub work', body: '@agent-bot fix', user: { login: 'alice' },
      created_at: at(), html_url: 'https://github.com/acme/widgets/issues/7' }, 'agent-bot')
    const giteeRequest = giteeIssueTrigger(issue(), 'gitee-bot')
    const githubTicket = accept(h, githubRequest, 'github-work'), giteeTicket = accept(h, giteeRequest, 'gitee-work')
    const gh = githubPull(7, githubTicket), gitee = giteePull(7, giteeTicket)
    expect(claimPull(h.ctx, githubTicket.id, gh)).toBeUndefined()
    expect(claimGiteePull(h.ctx, giteeTicket.id, gitee)).toBeUndefined()
    expect(h.store.tickets.get(githubTicket.id)?.follows).toEqual([{ thread: 'github:7', own: true }])
    expect(h.store.tickets.get(giteeTicket.id)?.follows).toEqual([{ thread: 'gitee:pull:7', own: true }])
    await observeGiteePull(h.ctx, { ...gitee, state: 'closed', merged_at: at() })
    expect(h.store.tickets.get(giteeTicket.id)?.ended?.outcome).toBe('merged')
    expect(h.store.tickets.get(githubTicket.id)?.ended).toBeUndefined()
    await observePull(h.ctx, { ...gh, state: 'closed', merged: true, merged_at: at() })
    expect(h.store.tickets.get(githubTicket.id)?.ended?.outcome).toBe('merged')
    const notices = giteePullEndNotices(h.store.tickets.get(giteeTicket.id)!, giteeRequest.text, 'acme/gadgets')
    expect(notices).toEqual([])
  })
  it('rejects a Gitee PR from a GitHub repository, fork, wrong branch, or another active Ticket', () => {
    const h = host()
    const request = giteeIssueTrigger(issue(), 'gitee-bot')
    const first = accept(h, request, 'gitee-work')
    const other = giteeIssueTrigger(issue('IOTHER', { body: '@gitee-bot other work' }), 'gitee-bot')
    const second = accept(h, other, 'other-work')
    expect(claimGiteePull(h.ctx, first.id, giteePull(8, first, { head: { sha: 'x', ref: `agent/${first.execution!.name}`, repo: { full_name: 'acme/widgets' } } }))).toContain('does not belong')
    expect(claimGiteePull(h.ctx, first.id, giteePull(8, first, { user: { login: 'alice', type: 'User' } }))).toContain('does not belong')
    expect(claimGiteePull(h.ctx, first.id, giteePull(8, first))).toBeUndefined()
    expect(claimGiteePull(h.ctx, second.id, giteePull(8, second))).toContain('another active ticket')
  })
})

describe('Gitee reads', () => {
  it('reads descriptions, paginated comments, and repository files through the Gitee repository', async () => {
    const h = host()
    const reads = api(h, { 'issues/IKRYZ3': issue(), 'issues/IKRYZ3/comments': [comment()], 'contents/src/index.ts': {
      content: Buffer.from('export const answer = 42\n').toString('base64'), encoding: 'base64' } })
    expect(await readGitee(h.commands, 'gitee/issues/IKRYZ3')).toMatchObject({ number: 'IKRYZ3', title: 'Fix Gitee widget', from: 'alice' })
    expect(await readGitee(h.commands, 'gitee/issues/IKRYZ3/comments/1')).toMatchObject({ messages: [{ id: '501', text: '@gitee-bot more context' }] })
    expect(await readGiteeRepositoryPath(h.commands, 'src/index.ts', 'file')).toBe('export const answer = 42\n')
    expect(reads.map(path => path.split('?')[0])).toEqual(['issues/IKRYZ3', 'issues/IKRYZ3/comments', 'contents/src/index.ts'])
    await expect(readGiteeRepositoryPath(h.commands, '../secret', 'file')).rejects.toThrow('Only non-hidden')
  })
})
