import type { Stack } from '@webgen/shared'
import { decryptSecret } from '../secrets.ts'
import * as store from '../store.ts'
import type { ProjectRow } from '../store.ts'

/**
 * 「怎么建这个项目的沙箱」——组合项目发 stack，模板项目发 template。
 *
 * 抽成一处是因为**这个判断有 7 个调用点**（建项目、重启编辑容器、刷预览、verify 重建、
 * 回滚后重建…）。散着写的话，加组合这条路时只要漏掉一处，那一处就会拿
 * `template = "stack-go-vue-none"` 去 executor 找模板目录 —— 找不到，报"模板不存在"，
 * 而且只在"回滚之后"这种少见的路径上才复现。
 *
 * S4 起还顺带带上**项目级运行时环境变量**（连接串等）：从 `project_env` 解出来，
 * 经 `spec.env` 注入容器。所以它变成了 async。
 */
export type SandboxSource = ({ template: string } | { stack: Stack }) & {
  /**
   * 工作区布局版本（S4）。带上它，executor 才能对老项目走扁平布局、新项目走
   * `backend/`+`frontend/`+`deploy/`。缺省由 executor 当 2 处理（见 recipe.ts）。
   */
  layout?: number
  /** 项目级运行时环境变量（连接串等）。会被 executor 合并进 `spec.env`（覆盖组合默认值）。 */
  env?: Record<string, string>
}

/** 读某项目的运行时环境变量（解密后的明文）。解不开的跳过，不让一个坏行拖垮整条注入。 */
export async function projectRuntimeEnv(projectId: string): Promise<Record<string, string>> {
  const rows = await store.listProjectEnv(projectId)
  const out: Record<string, string> = {}
  for (const r of rows) {
    if (r.scope !== 'runtime') continue
    try {
      out[r.key] = decryptSecret(r.valueEncrypted)
    } catch {
      /* 密文解不开（比如换了 SECRET_KEY）就跳过这一条 */
    }
  }
  return out
}

export async function sandboxSource(
  p: Pick<ProjectRow, 'id' | 'template' | 'stack' | 'layoutVersion'>,
): Promise<SandboxSource> {
  const env = await projectRuntimeEnv(p.id)
  const base = p.stack ? { stack: p.stack } : { template: p.template }
  return { ...base, layout: p.layoutVersion, env }
}
