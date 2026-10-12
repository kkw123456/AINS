/**
 * 打印一份组合生成的 Dockerfile / nginx 配置 / spec。
 *
 * 用法（在仓库根目录跑）：
 *   pnpm tsx scripts/recipe-preview.mts '{"backend":"go","frontend":"vue","data":"sqlite"}'
 *   pnpm tsx scripts/recipe-preview.mts '{"backend":"java","frontend":null,"data":null}' nginx
 *
 * 它是**决策门那一步的工具**：生成的 Dockerfile 先人眼审一遍、再手动 build 一次量耗时。
 * 以后 `scripts/smoke-stack.sh` 也靠它。
 */
// ⚠️ 用相对路径而不是 `@webgen/shared`：`scripts/` 不是 workspace 包，
// 它下面没有 node_modules 的软链，解析不到那个包名。
// （recipe.ts 自己 import `@webgen/shared` 没问题 —— 它在 executor 包里。）
import { parseStack } from '../packages/shared/src/index.ts'
import {
  dockerfileFor,
  imageTagFor,
  nginxConfFor,
  recipeHash,
  specFor,
} from '../services/executor/src/images/recipe.ts'

const raw = process.argv[2]
if (!raw) {
  console.error('用法：pnpm tsx scripts/recipe-preview.mts \'{"backend":"go","frontend":"vue"}\' [nginx|spec|json]')
  process.exit(1)
}

const stack = parseStack(JSON.parse(raw))
const projectId = process.env.PREVIEW_PROJECT_ID || 'preview000'
const what = process.argv[3] ?? 'dockerfile'

switch (what) {
  case 'dockerfile':
    console.log(dockerfileFor(stack))
    break
  case 'nginx':
    console.log(nginxConfFor(stack))
    break
  case 'spec':
    console.log(JSON.stringify(specFor(stack, imageTagFor(projectId, stack)), null, 2))
    break
  case 'json':
    console.log(
      JSON.stringify(
        {
          stack,
          hash: recipeHash(stack),
          image: imageTagFor(projectId, stack),
          spec: specFor(stack, imageTagFor(projectId, stack)),
        },
        null,
        2,
      ),
    )
    break
  default:
    console.error(`不认识的目标：${what}`)
    process.exit(1)
}
