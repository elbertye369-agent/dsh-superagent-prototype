/** A worker's background work in DSH: waiting for its shell jobs and subagents, and stopping them. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { stopSubagents, untilQuiet } from '../src/executor/background.ts'
import { jobRegistry } from './fixtures/host.ts'

/** A context with DSH's job registry and subagents, and an idle worker agent with one live subagent, `child-1`. */
function setup(waitForChildren: (agent: Agent) => Promise<boolean>, drainChildren: () => Promise<void> = async () => {}) {
  const jobs = jobRegistry()
  const agent = { id: 'worker-t1', status: 'idle', whenIdle: async () => {}, inbox: { nextTurn: [], nextStep: [] }, cancel: vi.fn() } as unknown as
    Agent & { status: string; cancel: ReturnType<typeof vi.fn> }
  const children: { id: string; mode?: string }[] = [{ id: 'child-1' }]
  const subagents = { waitForChildren: vi.fn(waitForChildren), listChildren: async () => children, drainChildren: vi.fn(drainChildren) }
  const services: Record<string, unknown> = { jobs: jobs.service, subagents }
  const listeners = new Set<(info: { id: string }) => void>()
  const ctx = { get: (name: string) => services[name], agents: { get: () => agent },
    on: (_name: string, listener: (info: { id: string }) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } } as unknown as Context
  const end = (id: string) => { for (const listener of listeners) listener({ id }) }
  return { ctx, agent, jobs, subagents, children, end, listeners }
}

it('drains an external Codex execution without a local Agent when its assignment stops', async () => {
  const { ctx, agent, subagents, children, end, listeners } = setup(async () => false, async () => { end('codex-run-1') })
  children.splice(0, children.length, { id: 'codex-run-1', mode: 'external' }, { id: 'old-local-child', mode: 'continuable' })
  ctx.agents.get = (() => undefined) as typeof ctx.agents.get
  await stopSubagents(ctx, agent, true)
  expect(subagents.drainChildren).toHaveBeenCalledWith(agent, ['codex-run-1'])
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
  expect(listeners.size).toBe(0)
})

it('does not abort a worker report when its external Codex run already completed', async () => {
  const { ctx, agent, subagents, children, end, listeners } = setup(async () => false, async () => { end('another-workers-child') })
  children.splice(0, children.length, { id: 'completed-codex-run', mode: 'external' })
  ctx.agents.get = (() => undefined) as typeof ctx.agents.get
  ;(agent as { status: string }).status = 'running'
  await stopSubagents(ctx, agent)
  expect(subagents.drainChildren).toHaveBeenCalledWith(agent, ['completed-codex-run'])
  expect(agent.cancel).not.toHaveBeenCalled()
  expect(listeners.size).toBe(0)
})

it('still cancels the parent when an external child teardown does not finish within the bound', async () => {
  const { ctx, agent, children, listeners } = setup(async () => false, () => new Promise(() => {}))
  children.splice(0, children.length, { id: 'stuck-codex-run', mode: 'external' })
  ctx.agents.get = (() => undefined) as typeof ctx.agents.get
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const stopping = stopSubagents(ctx, agent)
    await vi.advanceTimersByTimeAsync(10_000)
    await stopping
  } finally { vi.useRealTimers() }
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
  expect(listeners.size).toBe(0)
})

it('keeps waiting for an external child without a local Agent until its result arrives', async () => {
  let finish!: () => void
  const completed = new Promise<void>(resolve => { finish = resolve })
  let first = true
  const { ctx, agent, subagents } = setup(async () => {
    if (!first) return false
    first = false
    await completed
    return true
  })
  ctx.agents.get = (() => undefined) as typeof ctx.agents.get
  let settled = false
  const quiet = untilQuiet(ctx, agent, new AbortController().signal).then(value => { settled = true; return value })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(settled).toBe(false)
  finish()
  expect(await quiet).toBe(true)
  expect(subagents.waitForChildren).toHaveBeenCalledTimes(2)
})

it('is not quiet when an end during the subagent check woke the worker, whose own idle looks again', async () => {
  const { ctx, agent, jobs } = setup(async () => {
    // The job settles meanwhile, and its end wakes the worker.
    jobs.end(id); (agent as { status: string }).status = 'running'
    return false
  })
  const id = jobs.run('worker-t1')
  expect(await untilQuiet(ctx, agent, new AbortController().signal)).toBe(false)
})

it('stops waiting for subagents that never settle once the host stops', async () => {
  let joining!: () => void
  const joined = new Promise<void>(resolve => { joining = resolve })
  const { ctx, agent } = setup(() => { joining(); return new Promise(() => {}) })
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  // The host stops while the wait for its subagents runs.
  await joined
  stop.abort()
  expect(await quiet).toBe(false)
})

it('looks at the jobs only when one ends, not at each output of a noisy one', async () => {
  const { ctx, agent, jobs } = setup(async () => false)
  const id = jobs.run('worker-t1')
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  const looked = jobs.service.list.mock.calls.length
  for (let line = 0; line < 100; line++) jobs.output(id)
  expect(jobs.service.list.mock.calls.length).toBe(looked)
  jobs.end(id)
  expect(await quiet).toBe(true)
})

it('joins a worker\'s subagents once for the looks that wait on them, as DSH cannot cancel the join', async () => {
  const { ctx, agent, subagents } = setup(() => new Promise(() => {}))
  for (let look = 0; look < 3; look++) {
    const stop = new AbortController()
    const quiet = untilQuiet(ctx, agent, stop.signal)
    stop.abort()
    expect(await quiet).toBe(false)
  }
  expect(subagents.waitForChildren).toHaveBeenCalledTimes(1)
})

it('gives up a release of subagents that does not end within 10 seconds, and cancels the turn their ends woke', async () => {
  const { ctx, agent } = setup(async () => false, () => new Promise(() => {}))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    let stopped = false
    const stopping = stopSubagents(ctx, agent).then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
  } finally { vi.useRealTimers() }
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
})
