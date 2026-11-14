/** Read-only Gitee repository, Issue, pull-request, and comment inspection for assessments and workers. */
import { z } from 'zod'
import { validItems, type Commands } from '../infra/commands.ts'
import { CommentSchema, IssueSchema, type GiteeComment } from './gitee-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

function message(item: GiteeComment, text: string, id: string): ContextMessage {
  const line = item.new_line ?? item.old_line
  return { id, from: item.user.login, at: item.created_at ?? item.updated_at ?? '', text,
    ...item.user.type && item.user.type !== 'User' || /\[bot\]$/.test(item.user.login) ? { bot: true as const } : {},
    ...item.html_url ? { url: item.html_url } : {}, ...item.path ? { path: item.path, ...line != null ? { line } : {} } : {} }
}
const DescriptionSchema = IssueSchema.extend({
  labels: z.array(z.looseObject({ name: z.string() })).nullish(), draft: z.boolean().nullish(), merged_at: z.string().nullish(),
  head: z.looseObject({ ref: z.string() }).nullish(), base: z.looseObject({ ref: z.string() }).nullish(),
})
/** Reads a Gitee Issue/PR description or a page of its comments as normalized model-facing messages. */
export async function readGitee(commands: Commands, resource: string, repository = commands.deployment.gitee?.repository ?? ''): Promise<unknown> {
  const match = /^gitee\/(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/)?(issues|pulls)\/([A-Za-z0-9]+)(?:\/(comments)(?:\/([1-9]\d*))?)?$/.exec(resource)
  if (!match) throw new Error('Use gitee/issues/<number> or gitee/pulls/<number>, or gitee/<owner>/<name>/issues/<number> or gitee/<owner>/<name>/pulls/<number>, optionally followed by /comments/<page>')
  const [, qualified, kind, number, comments, page = '1'] = match
  const scoped = commands.giteeIn(qualified ?? repository)
  const path = `${kind}/${encodeURIComponent(number!)}`
  if (!comments) {
    const item = await scoped.api(DescriptionSchema, path)
    const branches = item.head && item.base ? { head: item.head.ref, base: item.base.ref } : {}
    return { number: item.number, title: item.title, state: item.state, ...item.merged_at ? { merged: true } : {},
      ...item.draft ? { draft: true } : {}, ...branches, ...item.labels?.length ? { labels: item.labels.map(label => label.name) } : {},
      ...message(item, item.body ?? '', item.html_url) }
  }
  const listed = await scoped.api(z.array(z.unknown()), `${path}/comments?per_page=20&page=${page}`)
  const tally = { skipped: 0 }
  const items = validItems(CommentSchema, listed, tally)
  return { messages: items.map(item => message(item, item.body ?? '', String(item.id))),
    ...tally.skipped ? { skipped: tally.skipped } : {},
    ...listed.length === 20 ? { next_resource: `gitee/${qualified ? `${qualified}/` : ''}${kind}/${number}/comments/${Number(page) + 1}` } : {} }
}
async function conversationPage(commands: Commands, repository: string, number: string, pull: boolean, page: number) {
  const scoped = commands.giteeIn(repository)
  const messages: ContextMessage[] = []
  const kind = pull ? 'pulls' : 'issues'
  if (page === 1) {
    const item = await scoped.api(IssueSchema, `${kind}/${encodeURIComponent(number)}`)
    messages.push(message(item, `${item.title}\n\n${item.body ?? ''}`, item.html_url))
  }
  const listed = await scoped.api(z.array(z.unknown()), `${kind}/${encodeURIComponent(number)}/comments?per_page=100&page=${page}`)
  const tally = { skipped: 0 }
  const comments = validItems(CommentSchema, listed, tally)
  messages.push(...comments.map(comment => message(comment, comment.body ?? '', comment.html_url ?? String(comment.id))))
  return { messages, next_resource: listed.length === 100 ? String(page + 1) : null, ...tally.skipped ? { skipped: tally.skipped } : {} }
}
/** Context reader for a Gitee Trigger: the Issue/PR description and its conversation, page by page. */
export const giteeThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? '',
  read: async (commands, trigger, _part, cursor) => {
    const number = String(trigger.meta.number ?? '')
    if (!number) throw new Error('The Gitee Trigger has no Issue or PR number')
    const repository = typeof trigger.meta.repository === 'string' && trigger.meta.repository.trim()
      ? trigger.meta.repository : commands.deployment.gitee?.repository ?? ''
    const body = await conversationPage(commands, repository, number, trigger.meta.isPr === true, Number(cursor ?? '1'))
    return { messages: body.messages, next: body.next_resource ?? undefined, body }
  },
}
/** Reads a non-hidden file or directory from the configured Gitee repository's default branch. */
export async function readGiteeRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory', repository = commands.deployment.gitee?.repository ?? ''): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  const scoped = commands.giteeIn(repository)
  const resource = `contents/${parts.map(encodeURIComponent).join('/')}`
  if (kind === 'directory') {
    const entries = await scoped.api(z.union([z.array(z.looseObject({ name: z.string() })), z.looseObject({})]), resource)
    if (!Array.isArray(entries)) throw new Error(`${path} is not a directory`)
    return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
  }
  const file = await scoped.api(z.looseObject({ content: z.string(), encoding: z.string().optional() }), resource)
  return file.encoding === 'base64' ? Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8') : file.content
}
