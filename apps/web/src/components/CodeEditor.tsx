import { useEffect, useRef } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'

/**
 * CodeMirror 6 的薄封装。**不引 `@uiw/react-codemirror`**——
 * 它在本仓库这种"linked workspace + 无构建步骤"的解析方式下容易出毛病，
 * 而自己接一个 EditorView 也就这么多代码。
 */
export function CodeEditor({
  value,
  path,
  readOnly,
  onChange,
  onSave,
}: {
  value: string
  path: string
  readOnly: boolean
  onChange: (next: string) => void
  onSave: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // 只读状态是个 Facet，Facet 不能自己 reconfigure——要先用 Compartment 包一层
  const readOnlyCompRef = useRef<Compartment | null>(null)
  // 回调放进 ref：这样下面的 effect 只依赖 path，
  // 不会因为父组件重渲染（比如流里又来了一条 delta）就把编辑器整个重建。
  const cbRef = useRef({ onChange, onSave, readOnly })
  cbRef.current = { onChange, onSave, readOnly }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let view: EditorView | null = null

    void (async () => {
      const lang = await langFor(path)
      if (cancelled) return

      const readOnlyComp = new Compartment()
      readOnlyCompRef.current = readOnlyComp

      const extensions: Extension[] = [
        basicSetup,
        oneDark,
        EditorView.lineWrapping,
        readOnlyComp.of(roExtensions(cbRef.current.readOnly)),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              cbRef.current.onSave()
              return true
            },
          },
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cbRef.current.onChange(u.state.doc.toString())
        }),
      ]
      if (lang) extensions.push(lang)

      view = new EditorView({
        state: EditorState.create({ doc: value, extensions }),
        parent: host,
      })
      viewRef.current = view
    })()

    return () => {
      cancelled = true
      view?.destroy()
      viewRef.current = null
      readOnlyCompRef.current = null
    }
    // value 故意不放进来：外部值变化（切文件）由下面的 effect 处理，
    // 放进来会让编辑器在每次 keystroke 后重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // 外部把内容换掉（切文件、重新拉取）时同步进来，但**不要**打断用户正在输入的内容
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const cur = view.state.doc.toString()
    if (cur !== value) view.dispatch({ changes: { from: 0, to: cur.length, insert: value } })
  }, [value])

  // 只读状态可能变（生成开始时锁编辑），用它自己的 effect 更新
  useEffect(() => {
    const comp = readOnlyCompRef.current
    if (!comp) return
    viewRef.current?.dispatch({ effects: comp.reconfigure(roExtensions(readOnly)) })
  }, [readOnly])

  return <div ref={hostRef} className="h-full min-h-0 overflow-auto text-[12px]" />
}

/** 只读 = 两道锁一起上：状态层禁编辑 + DOM 层不可编辑 */
function roExtensions(readOnly: boolean): Extension[] {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]
}

/**
 * 按扩展名挑语言。**动态 import**：每个语言包几十到 200KB，
 * 打开一个 .css 文件不该把 Go/Java 的解析器也拖下来。
 * 导出给 DiffView 复用 —— 两处必须挑同一种语言，否则 diff 的高亮和编辑时不一致。
 *
 * ⚠️ 这张表要跟着 `templates/` 走：加了新语言的模板（比如 go-web / java-web），
 * 这里不加映射的话，编辑器里就是**纯文本**，用户一眼就看得出来。
 */
export async function langFor(path: string): Promise<Extension | null> {
  const name = path.split('/').pop() ?? ''
  const ext = name.split('.').pop()?.toLowerCase() ?? ''

  // 特例：pom.xml 是 XML，但按扩展名已经能命中；这里处理的是没有扩展名的
  if (!ext) return null

  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return (await import('@codemirror/lang-javascript')).javascript()
    case 'ts':
    case 'mts':
    case 'cts':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true })
    case 'jsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true })
    case 'tsx':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true })
    case 'html':
    case 'htm':
      return (await import('@codemirror/lang-html')).html()
    case 'vue':
      return (await import('@codemirror/lang-vue')).vue()
    case 'css':
      return (await import('@codemirror/lang-css')).css()
    case 'py':
      return (await import('@codemirror/lang-python')).python()
    case 'go':
      return (await import('@codemirror/lang-go')).go()
    case 'java':
      return (await import('@codemirror/lang-java')).java()
    case 'json':
      return (await import('@codemirror/lang-json')).json()
    case 'xml':
    case 'svg':
      return (await import('@codemirror/lang-xml')).xml()
    case 'yml':
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml()
    case 'sql':
      return (await import('@codemirror/lang-sql')).sql()
    case 'md':
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown()
    default:
      return null
  }
}
