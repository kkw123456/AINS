import type { FastifyError } from 'fastify'
import { ZodError } from 'zod'
import type { AppInstance } from '../app.js'

/** 对外统一的错误响应体：`{ "error": { "code", "message" } }` */
export interface ErrorBody {
  error: {
    code: string
    message: string
  }
}

/**
 * 统一错误出口。
 *
 * 直接挂到根实例上（而不是 `app.register(...)` 包一层）—— Fastify 的插件默认**封装**，
 * 在子上下文里 setErrorHandler 只对它之后注册的路由生效。我们要的是**全局**兜底。
 *
 * 三类：
 *   - zod 校验失败 → 400 VALIDATION_ERROR（拼出人可读的字段说明）
 *   - 带 statusCode 的框架/业务错误（如 404、400）→ 用它自己的状态码与 message
 *   - 其它 → 500，**对外只说"服务器内部错误"**，细节只进日志（别把堆栈漏给调用方）
 */
export function registerErrorHandler(app: AppInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const body: ErrorBody = {
      error: { code: 'NOT_FOUND', message: `没有这个路由：${request.method} ${request.url}` },
    }
    reply.status(404).send(body)
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      const message = error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')
      const body: ErrorBody = { error: { code: 'VALIDATION_ERROR', message } }
      return reply.status(400).send(body)
    }

    const status =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500
    const code =
      typeof error.code === 'string' ? error.code : status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR'

    if (status >= 500) {
      request.log.error({ err: error }, '请求处理失败')
    }

    const body: ErrorBody = {
      error: { code, message: status >= 500 ? '服务器内部错误' : error.message },
    }
    return reply.status(status).send(body)
  })
}
