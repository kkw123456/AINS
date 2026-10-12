import { useCallback, useEffect, useState } from 'react'
import { getProject } from '../api/client.ts'
import type { InstanceRow, ProjectRow, TemplateSpec } from '../api/types.ts'

export interface ProjectDetail {
  project: ProjectRow
  instances: InstanceRow[]
  spec: TemplateSpec | null
  previewUrl: string
  /** 编辑容器的地址（`d-<id>`），和预览分开 */
  devUrl?: string
  /** 线上状态：没发布过就是 null */
  live: { version: number; url: string; kind: 'static' | 'service' } | null
  /** 这个项目的线上地址（不管发没发布，地址本身是确定的） */
  liveUrl: string
}

export function useProject(id: string | undefined) {
  const [data, setData] = useState<ProjectDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!id) return
    try {
      const r = await getProject(id)
      setData({
        project: r.project,
        instances: r.instances,
        spec: r.spec ?? null,
        previewUrl: r.previewUrl,
        devUrl: r.devUrl,
        live: r.live ?? null,
        liveUrl: r.liveUrl,
      })
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    setLoading(true)
    void reload()
  }, [reload])

  return { data, error, loading, reload }
}
