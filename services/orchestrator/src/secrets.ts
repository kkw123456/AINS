import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * 项目密钥的加解密（§7 的 `project_env.value_encrypted`）。
 *
 * 连接串里带 MySQL 密码，落库不能明文（哪怕是自用）。用 AES-256-GCM：
 * 密钥来自 `WEBGEN_SECRET_KEY`（任意字符串，sha256 成 32 字节）。
 *
 * ⚠️ **没设 `WEBGEN_SECRET_KEY` 时退化成明文**（前缀 `plain:`），并在启动时打一条 warning ——
 * 这是给本机 dev 用的方便；一旦设了 key，旧的明文行仍能读（按前缀分派），新写的都是密文。
 * 生产必须设 key，否则等于没加密。
 */

const ENV = 'WEBGEN_SECRET_KEY'

function key(): Buffer | null {
  const raw = process.env[ENV]?.trim()
  if (!raw) return null
  return createHash('sha256').update(raw).digest()
}

export function hasSecretKey(): boolean {
  return key() !== null
}

export function encryptSecret(plain: string): string {
  const k = key()
  if (!k) return `plain:${plain}`
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', k, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
}

export function decryptSecret(stored: string): string {
  if (stored.startsWith('plain:')) return stored.slice('plain:'.length)
  const k = key()
  if (!k) throw new Error(`project_env 是密文，但没设 ${ENV}，解不开`)
  const parts = stored.split(':')
  if (parts[0] !== 'enc' || parts.length !== 4) throw new Error('project_env 密文格式不对')
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string]
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * 脱敏：`mysql://p_x:secret@mysql:3306/p_x` → 只留结构，密码段变 `****`。
 * 连接串的密码在 `//user:pass@` 里；非连接串就整体打码（只留末 4 位，短的就全码）。
 */
export function maskSecret(value: string): string {
  const urlLike = /^([a-z]+:\/\/[^:@/]+:)([^@/]+)(@.*)$/i.exec(value)
  if (urlLike) return `${urlLike[1]}****${urlLike[3]}`
  if (value.length <= 4) return '****'
  return `${value.slice(0, 2)}****${value.slice(-2)}`
}
