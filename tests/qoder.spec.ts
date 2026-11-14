import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, key, type Assessor, type Executor, type Thread, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { pollInbox, qoderKind, qoderPaths, qoderTrigger, SOURCE } from '../src/sources/qoder.ts'

function host() {
  const stateDir = mkdtempSync(join(tmpdir(), 'qoder-'))
  const store = new Store(join(stateDir, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { [SOURCE]: { enabled: true, config: {} } },
    policy: { sources: { [SOURCE]: { allowed: [{ id: 'qoder', name: 'Qoder' }] } } },
    eval: { mode: 'auto' },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(qoderKind)
  const deployment = testDeployment({ stateDir })
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor, executor, outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment, ready: Promise.resolve(), configured: () => true, receive }
  const ctx = sourceContextOf(parts, qoderKind)
  const config = qoderKind.schema.parse({})
  const paths = qoderPaths(stateDir, config)
  for (const dir of [paths.inbox, paths.processed, paths.outbox]) mkdirSync(dir, { recursive: true })
  return { ctx, store, engine, sources, receive, stateDir, config }
}

const writeTask = (inbox: string, id: string, fields: Record<string, unknown> = {}) =>
  writeFileSync(join(inbox, `${id}.json`), JSON.stringify({ id, text: `Do ${id}`, ...fields }))

describe('qoder source', () => {
  it('translates a task into an explicit request on its own thread', () => {
    const trigger = qoderTrigger({ id: 't1', text: 'Fix the bug', title: 'Bug', cwd: '/repo' }, '/out')
    expect(trigger.id).toBe(key(SOURCE, 't1'))
    expect(trigger.source).toBe(SOURCE)
    expect(trigger.threads).toEqual([{ source: SOURCE, id: 't1' }])
    expect(trigger.actor).toEqual({ source: SOURCE, id: 'qoder' })
    expect(trigger.human).toBe(true)
    expect(trigger.addressed).toBe('direct')
    expect(trigger.channel?.address).toEqual({ task: 't1', outbox: '/out' })
    expect(trigger.meta).toMatchObject({ task: 't1', cwd: '/repo', title: 'Bug' })
  })

  it('ingests each inbox task once, moves it to processed, and replays as a duplicate', async () => {
    const h = host()
    const { inbox, processed } = qoderPaths(h.stateDir, h.config)
    writeTask(inbox, 't1', { title: 'First' })
    writeTask(inbox, 't2')
    expect(await pollInbox(h.ctx, h.config, new AbortController().signal)).toBe(2)
    expect(h.receive).toHaveBeenCalledTimes(2)
    expect(readdirSync(inbox)).toEqual([])
    expect(readdirSync(processed).sort()).toEqual(['t1.json', 't2.json'])
    expect(h.store.threads.get(`${SOURCE}:t1`)?.meta.label).toBe('First')
    // A replayed file is a duplicate Trigger and creates no second ticket.
    writeTask(inbox, 't1')
    expect(await pollInbox(h.ctx, h.config, new AbortController().signal)).toBe(1)
    expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
  })

  it('sets aside a malformed task without failing the round', async () => {
    const h = host()
    const { inbox, processed } = qoderPaths(h.stateDir, h.config)
    writeFileSync(join(inbox, 'bad.json'), '{ not json')
    writeTask(inbox, 'good')
    expect(await pollInbox(h.ctx, h.config, new AbortController().signal)).toBe(1)
    expect(existsSync(join(processed, 'bad.json.invalid'))).toBe(true)
    expect(h.receive).toHaveBeenCalledTimes(1)
  })

  it('writes each reply to the outbox once, idempotently by message id', async () => {
    const h = host()
    const { outbox } = qoderPaths(h.stateDir, h.config)
    const message = { id: 'm1', channel: { source: SOURCE, thread: `${SOURCE}:t1`, address: { task: 't1', outbox } }, text: 'Done', kind: 'reply' as const, ticketId: 'ticket-1' }
    expect(await qoderKind.channel!.send({ commands: h.ctx.commands }, message)).toBe('sent')
    expect(await qoderKind.channel!.send({ commands: h.ctx.commands }, message)).toBe('sent')
    const files = readdirSync(outbox)
    expect(files).toEqual(['m1.json'])
    expect(JSON.parse(readFileSync(join(outbox, 'm1.json'), 'utf8'))).toMatchObject({ task: 't1', text: 'Done', ticketId: 'ticket-1' })
  })

  it('admits a delegated task as an explicit request under the policy gate', () => {
    const h = host()
    const trigger = qoderTrigger({ id: 't1', text: 'Fix the bug' }, '/out')
    const thread: Thread = { key: `${SOURCE}:t1`, ref: { source: SOURCE, id: 't1' }, createdAt: trigger.at, subscriptions: [], correlated: [], pending: [], meta: {} }
    const gate = settingsPolicy(h.store.settings(), h.sources).gate(trigger, thread, [])
    expect(gate).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct' } })
  })
})