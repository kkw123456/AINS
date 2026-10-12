import { useCallback, useEffect, useState } from 'react'
import { createProject, deleteProject, listNodes, listProjects, listTemplates } from '../api/client.ts'
import type { Stack } from '@webgen/shared'
import type { InstanceRow, NodeRow, ProjectRow, TemplateItem } from '../api/types.ts'

export type ProjectListItem = ProjectRow & { previewUrl: string; instance: InstanceRow | null }

export function useProjects() {
  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [nodes, setNodes] = useState<NodeRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [ps, ts, ns] = await Promise.all([listProjects(), listTemplates(), listNodes()])
      setProjects(ps)
      setTemplates(ts)
      setNodes(ns)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const create = useCallback(
    async (body: { template?: string; stack?: Stack; name?: string; prompt?: string }) => {
      setCreating(true)
      setError(null)
      try {
        const r = await createProject(body)
        return r.project.id
      } catch (e) {
        // 409（项目数上限 / 服务型上限）、502（沙箱起不来，带 logs）都要原样露给用户看：
        // §0 决策 13 —— 超限必须显式失败并说明原因，不许静默降级。
        setError((e as Error).message)
        return null
      } finally {
        setCreating(false)
      }
    },
    [],
  )

  const remove = useCallback(async (id: string) => {
    try {
      await deleteProject(id)
      setProjects((prev) => prev.filter((p) => p.id !== id))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  return { projects, templates, nodes, error, loading, creating, reload, create, remove }
}
