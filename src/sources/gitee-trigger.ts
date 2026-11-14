/** Normalizes Gitee issues, pull requests, and comments into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitee'
export const UserSchema = z.looseObject({ login: z.string(), type: z.string().optional() }).nullable()
  .transform(user => user ?? { login: 'ghost', type: 'User' })
export const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), user: UserSchema, html_url: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), pull_request_url: z.string().nullish(),
  path: z.string().nullish(), new_line: z.number().nullish(), old_line: z.number().nullish(),
})
export type GiteeComment = z.infer<typeof CommentSchema>
export const IssueSchema = CommentSchema.extend({
  number: z.union([z.string(), z.number()]).transform(String), title: z.string(), state: z.string(),
  created_at: z.string(), updated_at: z.string(), html_url: z.string(),
})
export type GiteeIssue = z.infer<typeof IssueSchema>
export interface GiteeRef { repository: string; number: string | number; isPr: boolean; url?: string }

export const giteeThread = (repository: string, number: string | number, isPr: boolean): string => `gitee:${repository}:${isPr ? 'pull' : 'issue'}:${number}`
export const giteeChannel = (repository: string, number: string | number, isPr: boolean, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: giteeThread(repository, number, isPr), address: { repository, number: String(number), kind: isPr ? 'pull' : 'issue', ...(url ? { url } : {}) } })
export const giteePage = (repository: string, number: string | number, isPr = false): string =>
  `https://gitee.com/${repository}/${isPr ? 'pulls' : 'issues'}/${number}`
/** Parses a Gitee Issue or PR URL in `repository`, rejecting other repositories and hosts. */
export function giteeAddress(url: string, repository: string): { number: string; pr: boolean } | undefined {
  const ref = giteeUrlRef(url)
  return ref && sameName(ref.repository, repository) ? { number: ref.number, pr: ref.pr } : undefined
}
/** Parses a Gitee Issue or PR URL with its repository. */
export function giteeUrlRef(url: string): { repository: string; number: string; pr: boolean } | undefined {
  const match = /^https:\/\/gitee\.com\/([^/]+\/[^/]+)\/(issues|pulls)\/([A-Za-z0-9]+)\/?(?:#[\w-]*)?$/i.exec(url)
  if (!match) return undefined
  return { repository: match[1]!, number: match[3]!, pr: match[2]!.toLowerCase() === 'pulls' }
}
export const giteeMentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
const author = (user: { login: string; type?: string }, agent: string) =>
  ({ actor: { source: SOURCE, id: user.login }, human: !/\[bot\]$/.test(user.login) && (!user.type || user.type === 'User') && !sameName(user.login, agent) })
/** Builds a Trigger for a Gitee comment; edits produce a new Trigger, as they do on GitHub. */
export function giteeCommentTrigger(comment: GiteeComment, ref: GiteeRef, agent: string): Trigger {
  const at = comment.updated_at ?? comment.created_at ?? new Date().toISOString()
  const line = comment.new_line ?? comment.old_line
  const place = comment.path ? `${comment.path}${line != null ? `:${line}` : ''}` : ''
  return {
    id: key('gitee-comment', String(comment.id), comment.updated_at ?? ''), source: SOURCE,
    threads: [{ source: SOURCE, id: `${ref.repository}:${ref.isPr ? 'pull' : 'issue'}:${ref.number}` }], ...author(comment.user, agent), at,
    text: [place, comment.body ?? ''].filter(Boolean).join('\n\n'),
    ...(giteeMentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: giteeChannel(ref.repository, ref.number, ref.isPr, comment.html_url ?? undefined),
    ...(comment.html_url ?? ref.url ? { url: comment.html_url ?? ref.url } : {}),
    meta: { repository: ref.repository, number: ref.number, isPr: ref.isPr, commentId: comment.id, kind: 'comment',
      ...comment.path ? { path: comment.path, line: line ?? null } : {} },
  }
}
/** Builds a Trigger for a newly opened Gitee Issue. */
export function giteeIssueTrigger(issue: Pick<GiteeIssue, 'number' | 'title' | 'body' | 'user' | 'created_at' | 'html_url'>, agent: string, repository: string): Trigger {
  const body = issue.body ?? ''
  return {
    id: key('gitee-issue', repository, issue.number), source: SOURCE,
    threads: [{ source: SOURCE, id: `${repository}:issue:${issue.number}` }], ...author(issue.user, agent), at: issue.created_at,
    text: `${issue.title}\n\n${body}`, ...(giteeMentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: giteeChannel(repository, issue.number, false, issue.html_url), url: issue.html_url,
    meta: { repository, number: issue.number, isPr: false, kind: 'issue' },
  }
}
/** Builds a Trigger for a newly opened Gitee pull request. */
export function giteePullTrigger(pull: { number: number; title: string; body?: string | null; user: { login: string; type?: string }; created_at: string; html_url: string }, agent: string, repository: string): Trigger {
  const body = pull.body ?? ''
  return {
    id: key('gitee-pull', repository, String(pull.number)), source: SOURCE,
    threads: [{ source: SOURCE, id: `${repository}:pull:${pull.number}` }], ...author(pull.user, agent), at: pull.created_at,
    text: `${pull.title}\n\n${body}`, ...(giteeMentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: giteeChannel(repository, pull.number, true, pull.html_url), url: pull.html_url,
    meta: { repository, number: pull.number, isPr: true, prAuthor: pull.user.login, kind: 'pull' },
  }
}
