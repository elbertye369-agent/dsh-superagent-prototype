/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
import { join } from 'node:path'
import type { Ticket, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Localized, VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；执行器 Session 在其中工作', en: 'This ticket\'s directory; the executor Session works in it' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，也是执行目录的名字', en: 'The ticket\'s short name, also its directory\'s name' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_SOURCE', ticket: true, description: { zh: '工单来源；github、gitee 或其他来源。飞书工单默认使用 GitHub 仓库', en: 'Ticket Source: github, gitee or another kind; Feishu tickets use the GitHub repository by default' } },
  { key: 'DSH_SUPERAGENT_REPOSITORY', ticket: true, description: { zh: '这个工单要管理的仓库，owner/name；按来源选择 GitHub 或 Gitee', en: 'Repository this ticket manages, as owner/name, selected from GitHub or Gitee by its Source' } },
  { key: 'DSH_SUPERAGENT_GIT_URL', ticket: true, description: { zh: '这个工单独立拉取和推送的 HTTPS Git 地址', en: 'HTTPS Git URL from which this ticket independently pulls and pushes' } },
  { key: 'DSH_SUPERAGENT_PR_HEAD', ticket: true, description: { zh: '来源 PR 的 head 引用；不是 PR 工单时为空', en: 'Head ref of the source PR; empty when the ticket did not start from a PR' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
]
export interface Variable { key: string; value: string; description: Localized; owner: string }

export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    ...sources.declarations().map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket?: { id: string; name: string; directory: string }; trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, trigger } = input
  const fromGitee = trigger?.source === 'gitee'
  const giteeRepository = typeof trigger?.meta.repository === 'string' && trigger.meta.repository.trim() ? trigger.meta.repository : deployment.gitee?.repository
  const repository = fromGitee ? giteeRepository ?? '' : deployment.repository
  const number = trigger && (trigger.source === 'github' || fromGitee) ? String(trigger.meta.number ?? '') : ''
  const prHead = number && trigger?.meta.isPr === true ? `refs/pull/${number}/head` : ''
  const executor: Record<string, string> = { DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '), ...ticket ? {
    DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id,
    DSH_SUPERAGENT_SOURCE: trigger?.source ?? 'github', DSH_SUPERAGENT_REPOSITORY: repository,
    DSH_SUPERAGENT_GIT_URL: repository ? `https://${fromGitee ? 'gitee.com' : 'github.com'}/${repository}.git` : '', DSH_SUPERAGENT_PR_HEAD: prHead,
  } : {} }
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => !spec.ticket || ticket).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  for (const { kind, environment, config } of sources.environments(settings)) {
    const values = environment.values({ deployment, config, ...trigger ? { trigger } : {} })
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: kind.kind })
  }
  return result
}

/** Combines a ticket's fixed directory, name, and origin trigger with the deployment's current settings. */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }) {
  const { ticket, trigger, ...rest } = input
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '' }
  return environmentOf({ ...rest, ticket: values, ...trigger ? { trigger } : {} })
}
export function environmentLines(variables: Variable[]): string {
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
