import { useEffect, useRef } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, type Extension } from '@codemirror/state'
import { unifiedMergeView } from '@codemirror/merge'
import { oneDark } from '@codemirror/theme-one-dark'
import { langFor } from './CodeEditor.tsx'

/**
 * 「本轮 diff」。
 *
 * `original` 来自后端（写文件那一刻采下的旧内容），`modified` 是当前内容。
 * 用 CodeMirror 的 `unifiedMergeView` 在**单栏**里显示行内改动——
 * 右栏本来就窄，并排两栏会把每栏挤到看不清。
 *
 * 新建文件传 `original: ''` 即可，整篇都会显示成新增，正好是对的语义。
 */
export function DiffView({
  original,
  modified,
  path,
}: {
  original: string
  modified: string
  path: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let view: EditorView | null = null

    void (async () => {
      const lang = await langFor(path)
      if (cancelled) return

      const extensions: Extension[] = [
        basicSetup,
        oneDark,
        EditorView.lineWrapping,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        unifiedMergeView({ original, mergeControls: false, highlightChanges: true }),
      ]
      if (lang) extensions.push(lang)

      view = new EditorView({
        state: EditorState.create({ doc: modified, extensions }),
        parent: host,
      })
    })()

    return () => {
      cancelled = true
      view?.destroy()
    }
  }, [original, modified, path])

  return <div ref={hostRef} className="h-full min-h-0 overflow-auto text-[12px]" />
}
