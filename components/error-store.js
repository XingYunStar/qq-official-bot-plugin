/**
 * QQBot 错误码归档：30 天保留，按错误码检索，默认屏蔽 40034005。
 * 数据文件：data/QQBot/error-log.ndjson
 * 配置文件：data/QQBot/error-log.json
 */
import fs from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"

const DEFAULT_IGNORE = ["40034005"]
const DEFAULT_RETENTION = 30
const MAX_MESSAGE = 1200
const MAX_DETAIL = 6000

function stripAnsi(text) {
  return String(text ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
}
function shortText(value, max) {
  const text = stripAnsi(typeof value === "string" ? value : JSON.stringify(value))
  return text.length > max ? text.slice(0, max) + "…" : text
}
function collectCode(value, seen, depth = 0) {
  if (depth > 5 || value == null) return ""
  if (typeof value === "string") {
    const m = value.match(/code\s*\(\s*(\d{5,})\s*\)/i) || value.match(/\bcode["']?\s*[:=]\s*["']?(\d{5,})/i)
    return m?.[1] || ""
  }
  if (typeof value !== "object" || seen.has(value)) return ""
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const code = collectCode(item, seen, depth + 1)
      if (code) return code
    }
  }
  for (const key of ["code", "err_code", "errCode", "error_code", "errorCode"]) {
    const v = value[key]
    if (typeof v === "string" || typeof v === "number") {
      const text = String(v)
      if (/^\d{5,}$/.test(text)) return text
    }
  }
  for (const key of ["response", "data", "error", "err", "cause"]) {
    const code = collectCode(value[key], seen, depth + 1)
    if (code) return code
  }
  const message = collectCode(value.message, seen, depth + 1)
  if (message) return message
  for (const key of ["message", "reason", "stack"]) {
    const text = typeof value[key] === "string" ? value[key] : ""
    const m = text.match(/code\s*\(\s*(\d{5,})\s*\)/i) || text.match(/\bcode["']?\s*[:=]\s*["']?(\d{5,})/i)
    if (m) return m[1]
  }
  return ""
}
function collectMessage(args) {
  const list = Array.isArray(args) ? args : [args]
  // 优先使用 Error/接口返回的 message，而不是前面的“发送消息错误”标签
  for (const item of list) {
    if (item && typeof item === "object") {
      if (typeof item.message === "string" && item.message.trim()) return shortText(item.message, MAX_MESSAGE)
      if (typeof item.msg === "string" && item.msg.trim()) return shortText(item.msg, MAX_MESSAGE)
    }
  }
  for (const item of list) if (typeof item === "string" && item.trim()) return shortText(item, MAX_MESSAGE)
  return ""
}
function collectDetail(args) {
  const list = Array.isArray(args) ? args : [args]
  for (const item of list) {
    if (item && typeof item === "object") {
      if (item.stack) return shortText(item.stack, MAX_DETAIL)
      if (item.response?.data) return shortText(item.response.data, MAX_DETAIL)
    }
  }
  return shortText(list, MAX_DETAIL)
}

export class ErrorStore {
  constructor(dir = path.join("data", "QQBot")) {
    this.file = path.join(dir, "error-log.ndjson")
    this.configFile = path.join(dir, "error-log.json")
    this.retentionDays = DEFAULT_RETENTION
    this.ignored = new Set(DEFAULT_IGNORE)
    this.queue = Promise.resolve()
    this.ready = false
    this.timer = null
  }

  async init() {
    if (this.ready) return this
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    try {
      const cfg = JSON.parse(await fs.readFile(this.configFile, "utf8"))
      if (Array.isArray(cfg.ignoredCodes)) this.ignored = new Set(cfg.ignoredCodes.map(String).filter(Boolean))
      if (Number.isFinite(+cfg.retentionDays)) this.retentionDays = Math.min(365, Math.max(1, +cfg.retentionDays))
    } catch {}
    this.ready = true
    await this.purge()
    this.timer = setInterval(() => this.purge().catch(() => {}), 6 * 60 * 60 * 1000)
    this.timer.unref?.()
    return this
  }

  async saveConfig() {
    await fs.mkdir(path.dirname(this.configFile), { recursive: true })
    await fs.writeFile(this.configFile, JSON.stringify({
      ignoredCodes: [...this.ignored],
      retentionDays: this.retentionDays,
    }, null, 2), "utf8")
  }

  async setConfig({ ignoredCodes, retentionDays } = {}) {
    if (Array.isArray(ignoredCodes)) {
      this.ignored = new Set(ignoredCodes.map(v => String(v).trim()).filter(v => /^\d{5,}$/.test(v)))
    }
    if (retentionDays != null) this.retentionDays = Math.min(365, Math.max(1, Number(retentionDays) || DEFAULT_RETENTION))
    await this.saveConfig()
    // 被屏蔽的错误码从历史中移除，避免“屏蔽了却还能看到”
    if (Array.isArray(ignoredCodes)) await this.purge(true)
    return this.status()
  }

  async append(record) {
    this.queue = this.queue
      .then(() => fs.appendFile(this.file, JSON.stringify(record) + "\n", "utf8"))
      .catch(() => {})
    return this.queue
  }

  isIgnored(args) {
    try {
      const code = collectCode(args, new Set()) || "unknown"
      return this.ignored.has(code)
    } catch { return false }
  }

  capture(botId, args) {
    try {
      const code = collectCode(args, new Set()) || "unknown"
      if (this.ignored.has(code)) return false
      const record = {
        time: Date.now(),
        bot: String(botId || "").slice(0, 40),
        code,
        message: collectMessage(args),
        detail: collectDetail(args),
      }
      void this.append(record)
      return true
    } catch {
      return false
    }
  }

  async *records() {
    let input
    try {
      input = await fs.open(this.file, "r")
      const stream = input.createReadStream({ encoding: "utf8" })
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
      for await (const line of rl) {
        if (!line.trim()) continue
        try { yield JSON.parse(line) } catch {}
      }
    } catch {
      return
    } finally {
      await input?.close?.()
    }
  }

  async purge(force = false) {
    if (!this.ready && !force) return
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000
    const kept = []
    for await (const item of this.records()) {
      if (!item || !item.time) continue
      if (item.time >= cutoff && !this.ignored.has(String(item.code))) kept.push(item)
    }
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, kept.map(i => JSON.stringify(i)).join("\n") + (kept.length ? "\n" : ""), "utf8")
    await fs.rename(tmp, this.file).catch(async () => {
      await fs.rm(this.file, { force: true })
      await fs.rename(tmp, this.file)
    })
    return kept.length
  }

  async codes() {
    const map = new Map()
    for await (const item of this.records()) {
      if (!item || this.ignored.has(String(item.code))) continue
      const code = String(item.code || "unknown")
      const row = map.get(code) || { code, count: 0, lastAt: 0, message: "" }
      row.count++
      if (item.time > row.lastAt) { row.lastAt = item.time; row.message = item.message || "" }
      map.set(code, row)
    }
    const codes = [...map.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    return { ...this.status(), total: codes.reduce((n, i) => n + i.count, 0), codes }
  }

  async list({ code, limit = 200, offset = 0 } = {}) {
    const max = Math.min(500, Math.max(1, Number(limit) || 200))
    const skip = Math.max(0, Number(offset) || 0)
    const rows = []
    for await (const item of this.records()) {
      if (code && code !== "all" && String(item.code) !== String(code)) continue
      if (this.ignored.has(String(item.code))) continue
      rows.push(item)
    }
    const end = Math.max(0, rows.length - skip)
    const start = Math.max(0, end - max)
    const entries = rows.slice(start, end).reverse()
    return { ...this.status(), total: rows.length, entries, hasMore: start > 0, offset: skip }
  }

  status() {
    return {
      ignoredCodes: [...this.ignored].sort(),
      retentionDays: this.retentionDays,
      file: this.file,
    }
  }
}
