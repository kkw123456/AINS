import { pino, type Logger } from 'pino'
import type { LogLevel } from './config.js'

/**
 * 结构化日志：stdout 直接是 **JSON 行**（每行一个对象）。
 *
 * 刻意**不引 pino-pretty** —— 组合项目的容器日志是被采集/转发的，
 * JSON 才是它们要的形态；可爱的彩色输出反而要额外依赖、还得在运行时装/配置。
 * 想要人读的漂亮日志时，本地用 `node dist/server.js | pino-pretty`（自备）即可。
 */
export function createLogger(options: { LOG_LEVEL?: LogLevel } = {}): Logger {
  return pino({
    level: options.LOG_LEVEL ?? 'info',
    base: { service: 'webgen-backend-node' },
    timestamp: pino.stdTimeFunctions.isoTime,
  })
}
