/** Qoder source kind: a local file inbox through which the Qoder agent delegates tasks as explicit requests, and the plugin entry that polls it. */
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'

export const SOURCE = 'qoder'

const QoderConfigSchema = z.object({
  inbox: z.string().default(''),
  pollSeconds: z.number().int().min(1).max(60).default(3),
}).strict()
export type QoderConfig = z.infer<typeof QoderConfigSchema>

/** One delegated task as the Qoder bridge writes it into the inbox. */
const TaskSchema = z.looseObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  text: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  at: z.string().optional(),
})
export type QoderTask = z.infer<typeof TaskSchema>

/** The directory layout under the state directory: tasks arrive in `inbox`, are kept in `processed`, and replies land in `outbox`. */
export function qoderPaths(stateDir: string, config: QoderConfig) {
  const root = join(stateDir, SOURCE)
  return { root, inbox: config.inbox || join(root, 'inbox'), processed: join(root, 'processed'), outbox: join(root, 'outbox') }
}

/**
 * The Trigger of one delegated task: an explicit request from the allowed `qoder` sender on its own Thread.
 * The reply address carries the outbox directory so the Channel can deliver without reading the deployment.
 */
export function qoderTrigger(task: QoderTask, outbox: string): Trigger {
  const parsed = task.at ? Date.parse(task.at) : NaN
  const at = Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString()
  return {
    id: key(SOURCE, task.id),
    source: SOURCE,
    threads: [{ source: SOURCE, id: task.id }],
    actor: { source: SOURCE, id: 'qoder' },
    human: true,
    addressed: 'direct',
    at,
    text: task.text,
    channel: { source: SOURCE, thread: `${SOURCE}:${task.id}`, address: { task: task.id, outbox } },
    meta: { task: task.id, ...task.cwd ? { cwd: task.cwd } : {}, ...task.title ? { title: task.title } : {} },
  }
}

export const qoderKind: SourceKind<QoderConfig> = {
  kind: SOURCE,
  title: { zh: 'Qoder', en: 'Qoder' },
  description: { zh: 'Qoder 智能体通过本地收件箱委派的任务；每个任务作为明确请求交给主 Session 路由成工单。', en: 'Tasks the Qoder agent delegates through a local inbox; each task is an explicit request the main Session routes into a ticket.' },
  schema: QoderConfigSchema,
  fields: [
    { key: 'inbox', type: 'text', advanced: true, label: { zh: '收件箱目录', en: 'Inbox directory' },
      hint: { zh: '留空用 <stateDir>/qoder/inbox。Qoder 桥接把任务 JSON 写到这里，来源轮询收取。', en: 'Empty uses <stateDir>/qoder/inbox. The Qoder bridge writes task JSON here; the Source polls it.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 1, max: 60, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: [SOURCE],
  scope: () => ({ listened: true, observed: true, row: 'tasks' }),
  channel: {
    allowed: address => typeof address.task === 'string' && typeof address.outbox === 'string',
    send: async (_host, message: OutboundMessage) => {
      const { task, outbox } = message.channel.address
      if (!task || !outbox) throw new Error('Missing Qoder reply target')
      await mkdir(outbox, { recursive: true })
      const file = join(outbox, `${message.id}.json`)
      await writeFile(file, JSON.stringify({ task, kind: message.kind, text: message.text, ticketId: message.ticketId ?? null, at: new Date().toISOString() }), 'utf8')
      return 'sent'
    },
    link: address => ({ url: '', label: { zh: `Qoder 任务 ${address.task ?? ''}`, en: `Qoder task ${address.task ?? ''}` } }),
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能委派任务的 Qoder 发送者', en: 'Qoder senders that may delegate tasks' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: 'Qoder 智能体直接委派的任务。', en: 'A task delegated directly by the Qoder agent.' },
    rows: () => [{ id: 'tasks', label: { zh: '委派任务', en: 'Delegated tasks' }, note: { zh: '全部', en: 'All' },
      cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } }],
  },
}

export const name = 'dsh-superagent-qoder'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(qoderKind), 'qoder: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, qoderKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<QoderConfig>(SOURCE)
    if (!config) { ctx.report(SOURCE, health('paused', 'sourceOff')); await pause(3000, signal); continue }
    try {
      const count = await pollInbox(ctx, config, signal)
      failures = 0
      ctx.report(SOURCE, { state: 'ready', detail: `${count} tasks ingested`, at: new Date().toISOString() })
    } catch (error) {
      failures += 1
      if (!signal.aborted && failures >= 3) ctx.report(SOURCE, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
    }
    await pause(config.pollSeconds * 1000, signal)
  }
}

/**
 * One polling round: read each task JSON in the inbox, hand it to the Engine, then move it to `processed`.
 * Stable Trigger IDs make a replay a duplicate, so a file left behind by an interrupted round is safe to read again.
 * @returns the number of tasks ingested this round.
 */
export async function pollInbox(ctx: SourceContext, config: QoderConfig, signal: AbortSignal): Promise<number> {
  const { inbox, processed, outbox } = qoderPaths(ctx.deployment.stateDir, config)
  await mkdir(inbox, { recursive: true })
  await mkdir(processed, { recursive: true })
  await mkdir(outbox, { recursive: true })
  const files = (await readdir(inbox)).filter(file => file.endsWith('.json')).sort()
  let count = 0
  for (const file of files) {
    if (signal.aborted) throw new Error('The Qoder Source stopped during the poll')
    const path = join(inbox, file)
    let task: QoderTask
    try { task = TaskSchema.parse(JSON.parse(await readFile(path, 'utf8'))) }
    catch { await rename(path, join(processed, `${file}.invalid`)).catch(() => {}); continue }
    await ctx.receive(qoderTrigger(task, outbox))
    ctx.threads.describe(`${SOURCE}:${task.id}`, { label: task.title ?? `Qoder ${task.id}`, facts: { task: { value: task.id } } })
    await rename(path, join(processed, file)).catch(() => {})
    count += 1
  }
  return count
}