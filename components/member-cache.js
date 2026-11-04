import fs from "node:fs/promises"
import path from "node:path"

/** 去掉 `机器人appid<sep>` 前缀；兼容历史分隔符 ":"、U+F03A 与当前 "_" */
const stripIdPrefix = value => String(value ?? "").replace(/^\d+[:_\uF03A]/, "")

/**
 * 群成员昵称/头像/身份缓存。
 * 官方成员列表不返回头像，头像主要来自消息事件；这里把消息里出现过的人和
 * 成员列表结果持久化，默认 5 分钟视为新鲜，过期后继续展示旧值并等待刷新。
 */
export class MemberCache {
  constructor({ file = "", ttl = 5 * 60 * 1000, keep = Number.POSITIVE_INFINITY } = {}) {
    this.file = file
    this.ttl = ttl
    this.keep = keep
    this.entries = new Map()
    this.timer = null
  }

  key(botId, groupId, userId) {
    return `${botId}|${groupId}|${stripIdPrefix(userId)}`
  }

  async load() {
    if (!this.file) return
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8"))
      for (const [key, value] of Object.entries(data.entries || data || {})) {
        if (value && typeof value === "object") this.entries.set(key, value)
      }
    } catch {}
  }

  get(botId, groupId, userId) {
    const value = this.entries.get(this.key(botId, groupId, userId))
    return value ? { ...value, stale: Date.now() - (value.updatedAt || 0) > this.ttl } : null
  }

  list(botId, groupId) {
    const prefix = `${botId}|${groupId}|`
    const now = Date.now()
    return [...this.entries.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({
        ...value,
        openid: key.slice(prefix.length),
        stale: now - (value.updatedAt || 0) > this.ttl,
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  set(botId, groupId, userId, info = {}) {
    const openid = stripIdPrefix(userId)
    if (!openid) return
    const key = this.key(botId, groupId, openid)
    const old = this.entries.get(key) || {}
    const next = {
      ...old,
      name: info.name || old.name || "",
      avatar: info.avatar || old.avatar || "",
      role: info.role || old.role || "",
      bot: info.bot ?? old.bot,
      joinedAt: info.joinedAt || old.joinedAt || "",
      updatedAt: Date.now(),
    }
    this.entries.set(key, next)
    this.scheduleSave()
  }

  scheduleSave() {
    if (!this.file || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush().catch(() => {})
    }, 1200)
    this.timer.unref?.()
  }

  async flush() {
    if (!this.file) return
    if (Number.isFinite(this.keep)) {
      const cutoff = Date.now() - this.keep
      for (const [key, value] of this.entries) {
        if ((value.updatedAt || 0) < cutoff) this.entries.delete(key)
      }
    }
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, JSON.stringify({ entries: Object.fromEntries(this.entries) }))
    await fs.rename(tmp, this.file)
  }
}
