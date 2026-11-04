/**
 * 群聊消息缓存：只保留最近 24 小时 / 每群 200 条，落盘到 data/QQBot/group-chat.json。
 * 同时记录收消息和机器人自己发出的消息。
 */
import fs from "node:fs/promises"
import path from "node:path"
const MAX_PER_GROUP = 200
const RETENTION = 24 * 60 * 60 * 1000
const MAX_TOTAL = 2000
const SAVE_DELAY = 2000
let seq = 0

export class GroupChat {
  constructor(limit = MAX_PER_GROUP) {
    if (typeof limit === "object" && limit) {
      this.limit = limit.limit || MAX_PER_GROUP
      this.file = limit.file || null
    } else {
      this.limit = limit
      this.file = null
    }
    this.map = new Map()
    this.saveTimer = null
  }

  async load() {
    if (!this.file) return this
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8"))
      const cutoff = Date.now() - RETENTION
      for (const [key, list] of Object.entries(data.messages || {})) {
        const rows = (Array.isArray(list) ? list : [])
          .filter(i => i && i.time >= cutoff)
          .slice(-this.limit)
        if (!rows.length) continue
        this.map.set(key, rows)
        for (const m of rows) seq = Math.max(seq, Number(m.id) || 0)
      }
      this.pruneAll()
    } catch {}
    return this
  }

  pruneAll() {
    const cutoff = Date.now() - RETENTION
    let total = 0
    for (const [key, list] of this.map) {
      while (list.length && list[0].time < cutoff) list.shift()
      if (list.length > this.limit) list.splice(0, list.length - this.limit)
      if (!list.length) this.map.delete(key)
      else total += list.length
    }
    while (total > MAX_TOTAL) {
      let oldestKey = null
      let oldest = Infinity
      for (const [key, list] of this.map) {
        if (list[0]?.time < oldest) { oldest = list[0].time; oldestKey = key }
      }
      if (!oldestKey) break
      this.map.get(oldestKey).shift()
      total--
      if (!this.map.get(oldestKey).length) this.map.delete(oldestKey)
    }
  }

  scheduleSave() {
    if (!this.file || this.saveTimer) return
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save().catch(() => {}) }, SAVE_DELAY)
    this.saveTimer.unref?.()
  }

  diskMessage(item) {
    const clean = { ...item }
    clean.content = (item.content || []).map(c => {
      if (c.url?.startsWith?.("data:") && c.url.length > 64 * 1024)
        return { ...c, url: "", expired: true }
      return c
    })
    return clean
  }

  async save() {
    if (!this.file) return
    this.pruneAll()
    const messages = {}
    for (const [key, list] of this.map) messages[key] = list.map(i => this.diskMessage(i))
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await fs.writeFile(tmp, JSON.stringify({ savedAt: Date.now(), messages }))
      await fs.rename(tmp, this.file)
    } catch {}
  }

  prune(list) {
    const cutoff = Date.now() - RETENTION
    while (list.length && list[0].time < cutoff) list.shift()
  }

  key(botId, groupId) {
    return `${botId}:${groupId}`
  }

  add(botId, groupId, msg) {
    if (!botId || !groupId || !msg) return null
    const key = this.key(botId, groupId)
    let list = this.map.get(key)
    if (!list) {
      list = []
      this.map.set(key, list)
    }
    const item = {
      id: ++seq,
      time: msg.time || Date.now(),
      bot_id: botId,
      group_id: groupId,
      direction: msg.direction === "out" ? "out" : "in",
      sender: msg.sender || {},
      content: msg.content || [],
      raw: msg.raw || "",
      message_id: msg.message_id || "",
      quoted: msg.quoted || "",
    }
    list.push(item)
    this.prune(list)
    if (list.length > this.limit) list.splice(0, list.length - this.limit)
    this.scheduleSave()
    return item
  }

  list(botId, groupId, limit = 100, since = 0) {
    const list = this.map.get(this.key(botId, groupId)) || []
    this.prune(list)
    const cutoff = Date.now() - RETENTION
    return list.filter(i => i.id > Number(since || 0) && i.time >= cutoff).slice(-Number(limit || 100))
  }

  markRecalled(botId, groupId, messageId) {
    const list = this.map.get(this.key(botId, groupId)) || []
    const hit = list.find(i => i.message_id && String(i.message_id) === String(messageId))
    if (hit) { hit.recalled = true; this.scheduleSave() }
    return hit
  }

  members(botId, groupId) {
    const list = this.map.get(this.key(botId, groupId)) || []
    const map = new Map()
    for (const m of list) {
      if (m.direction !== "in" || !m.sender?.id) continue
      const key = String(m.sender.id)
      const old = map.get(key) || {}
      map.set(key, {
        member_openid: key,
        username: m.sender.name || old.username || key,
        avatar: m.sender.avatar || old.avatar || "",
        member_role: m.sender.role || old.member_role || "",
        last_active: Math.max(old.last_active || 0, m.time || 0),
      })
    }
    return [...map.values()].sort((a, b) => (b.last_active || 0) - (a.last_active || 0))
  }

  clear(botId, groupId) {
    this.map.delete(this.key(botId, groupId))
    this.scheduleSave()
  }

  async flush() {
    await this.save()
  }
}

/** 把 TRSS 消息段归一化为 WebUI 可渲染的结构 */
export function normalizeChatContent(msg) {
  const list = Array.isArray(msg) ? msg : [msg]
  const out = []
  for (const i of list) {
    if (i == null) continue
    if (typeof i === "string") {
      out.push({ type: "text", text: i })
      continue
    }
    if (typeof i !== "object") continue
    switch (i.type) {
      case "text":
        out.push({ type: "text", text: i.text ?? "" })
        break
      case "at":
        out.push({ type: "at", text: `@${i.qq || i.user_id || ""}` })
        break
      case "reply":
        out.push({ type: "reply", text: "引用消息" })
        break
      case "image":
      case "record":
      case "video":
      case "file": {
        let url = i.url || i.file || ""
        if (Buffer.isBuffer(i.file)) {
          const mime = i.type === "image" ? "image/jpeg" : "application/octet-stream"
          url = `data:${mime};base64,${i.file.toString("base64")}`
        }
        out.push({
          type: i.type,
          url,
          name: i.name || i.file_name || "",
          size: Number(i.size) || 0,
          width: Number(i.width) || 0,
          height: Number(i.height) || 0,
        })
        break
      }
      case "face": {
        const id = Number(i.id)
        if (id === 0) break
        out.push({ type: "face", text: i.id != null ? `[表情 ${i.id}]` : `[${i.text || i.name || "表情"}]` })
        break
      }
      case "markdown":
        out.push({ type: "markdown", text: typeof i.data === "object" ? i.data?.content || "" : i.data || "" })
        break
      case "card": {
        const c = i.data?.content || i.content || {}
        out.push({ type: "card", text: c.title || "图文卡片", url: c.url || "" })
        break
      }
      case "button":
        break
      default:
        if (i.text) out.push({ type: "text", text: i.text })
        break
    }
  }
  return out
}
