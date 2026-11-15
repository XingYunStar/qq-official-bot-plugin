/**
 * 发送内容违规拦截：只记录图片。
 * - 40034006 消息内容违规时记录图片指纹（URL / 素材 / Buffer）
 * - 同一个机器人再次发送相同图片时直接跳过
 * 数据文件：data/QQBot/blocked-content.json
 */
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

const DEFAULT_TTL = 30 * 24 * 60 * 60 * 1000
const MAX_ENTRIES = 5000

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function fileToken(file) {
  try {
    if (Buffer.isBuffer(file)) return "buffer:" + hash(file)
    if (file && typeof file === "object" && Buffer.isBuffer(file.data)) return "buffer:" + hash(file.data)
    const text = String(file ?? "").trim()
    // 必须保留完整 URL（包含 GET 参数）；同一路径不同参数可能是不同图片
    if (/^https?:\/\//i.test(text)) return `url:${text}`
    return "str:" + text
  } catch {
    return "str:" + String(file ?? "")
  }
}

function extractMarkdownImages(content, out) {
  const re = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g
  let match
  while ((match = re.exec(String(content || "")))) {
    const file = match[1]?.trim()
    if (file) out.push(fileToken(file))
  }
}

function walk(value, out, depth = 0) {
  if (depth > 8 || value == null) return
  if (Array.isArray(value)) {
    for (const item of value) walk(item, out, depth + 1)
    return
  }
  if (typeof value !== "object") return
  switch (value.type) {
    case "image":
      out.push(fileToken(value.file))
      break
    case "markdown": {
      const content = value.data?.content ?? value.content ?? value.data?.text ?? ""
      extractMarkdownImages(content, out)
      break
    }
    case "text":
      // 有些插件把 Markdown 图片写在 text 里
      extractMarkdownImages(value.text, out)
      break
    case "raw":
    case "node":
      walk(value.data, out, depth + 1)
      break
    default:
      break
  }
}

export function imageTokens(msg) {
  const out = []
  walk(msg, out)
  return [...new Set(out.filter(Boolean))]
}

export function contentKeys(msg) {
  return imageTokens(msg).map(token => "image:" + hash(token))
}

export function contentPreview(msg) {
  const tokens = imageTokens(msg)
  return tokens.join("\n").slice(0, 500)
}

export class ContentGuard {
  constructor(dir = path.join("data", "QQBot")) {
    this.file = path.join(dir, "blocked-content.json")
    this.entries = new Map()
    this.ready = false
    this.saveTimer = null
    this.timer = null
  }

  async init() {
    if (this.ready) return this
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8"))
      const now = Date.now()
      for (const [key, item] of Object.entries(data.entries || {})) {
        if (!item || !item.time || now - item.time > DEFAULT_TTL) continue
        this.entries.set(key, item)
      }
    } catch {}
    this.ready = true
    this.prune()
    this.timer = setInterval(() => this.prune(), 6 * 60 * 60 * 1000)
    this.timer.unref?.()
    return this
  }

  isBlocked(botId, msg) {
    const keys = contentKeys(msg)
    if (!keys.length) return null
    const bot = String(botId || "*")
    for (const key of keys) {
      const item = this.entries.get(`${bot}|${key}`)
      if (item) return item
    }
    return null
  }

  block(botId, msg, { code = "40034006" } = {}) {
    const images = imageTokens(msg)
    const keys = contentKeys(msg)
    if (!keys.length) return null
    const bot = String(botId || "*")
    const now = Date.now()
    const preview = images.join("\n").slice(0, 500)
    const content = JSON.stringify(images.slice(0, 20), null, 2).slice(0, 12000)
    let record = null
    for (const key of keys) {
      const id = `${bot}|${key}`
      const old = this.entries.get(id)
      record = {
        bot,
        key,
        time: now,
        code: String(code),
        preview,
        content,
        images: images.slice(0, 20),
        count: (old?.count || 0) + 1,
      }
      this.entries.set(id, record)
    }
    this.prune()
    this.scheduleSave()
    return record
  }

  prune() {
    const cutoff = Date.now() - DEFAULT_TTL
    for (const [key, item] of this.entries) if (!item?.time || item.time < cutoff) this.entries.delete(key)
    if (this.entries.size > MAX_ENTRIES) {
      const rows = [...this.entries.entries()].sort((a, b) => (a[1].time || 0) - (b[1].time || 0))
      for (const [key] of rows.slice(0, this.entries.size - MAX_ENTRIES)) this.entries.delete(key)
    }
  }

  scheduleSave() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save().catch(() => {})
    }, 2000)
    this.saveTimer.unref?.()
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const entries = Object.fromEntries(this.entries)
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, JSON.stringify({ version: 1, entries }, null, 2), "utf8")
    await fs.rename(tmp, this.file).catch(async () => {
      await fs.rm(this.file, { force: true })
      await fs.rename(tmp, this.file)
    })
  }

  status() {
    return { file: this.file, total: this.entries.size, ttlDays: DEFAULT_TTL / 86400000 }
  }
}
