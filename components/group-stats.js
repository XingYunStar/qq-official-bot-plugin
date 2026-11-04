/**
 * 本地群统计：群名、成员数、头像、群指令使用数、机器人权限/消息设置。
 * 数据保存在 data/QQBot/group-stats.json，按机器人分组。
 */
import fs from "node:fs/promises"
import path from "node:path"

const FILE = path.join("data", "QQBot", "group-stats.json")
const SAVE_DELAY = 3000

export function isCommandText(text) {
  const t = String(text || "")
    .trim()
    .replace(/^(<@[^>]+>\s*)+/, "")
    .trim()
  return /^[#/!！]/.test(t)
}

export function dayKey(time = Date.now()) {
  const d = new Date(time)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
}

function emptyData() {
  return { bots: {} }
}

export class GroupStats {
  constructor(file = FILE) {
    this.file = file
    this.data = emptyData()
    this.saveTimer = null
  }

  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8"))
      if (data && typeof data === "object" && data.bots) this.data = data
    } catch {}
    return this
  }

  bot(botId) {
    this.data.bots[botId] ||= { groups: {} }
    this.data.bots[botId].groups ||= {}
    return this.data.bots[botId]
  }

  list(botId) {
    const groups = this.bot(botId).groups
    return Object.values(groups).sort((a, b) => (b.last_active || 0) - (a.last_active || 0))
  }

  get(botId, groupId) {
    return this.bot(botId).groups[groupId]
  }

  record(botId, group = {}) {
    if (!botId || !group.group_id) return null
    const groups = this.bot(botId).groups
    const id = String(group.group_id)
    const g = (groups[id] ||= {
      group_id: id,
      name: "",
      avatar: "",
      member_count: 0,
      bot_role: "",
      allow_proactive: false,
      recv_msg_setting: "",
      messages: 0,
      commands: 0,
      days: {},
      last_active: 0,
      last_command: 0,
      info_at: 0,
    })
    if (group.name) g.name = group.name
    if (group.avatar) g.avatar = group.avatar
    if (group.member_count) g.member_count = Number(group.member_count) || g.member_count
    g.last_active = group.time || Date.now()
    g.messages = (g.messages || 0) + 1
    const key = dayKey(g.last_active)
    const day = (g.days[key] ||= { messages: 0, commands: 0 })
    day.messages++
    if (isCommandText(group.text)) {
      g.commands = (g.commands || 0) + 1
      g.last_command = g.last_active
      day.commands++
    }
    this.scheduleSave()
    return g
  }

  updateInfo(botId, groupId, info = {}) {
    const g = this.get(botId, groupId)
    if (!g) return null
    for (const key of ["name", "avatar", "member_count", "bot_role", "allow_proactive", "recv_msg_setting"])
      if (info[key] !== undefined && info[key] !== "" && info[key] !== null) g[key] = info[key]
    g.info_at = Date.now()
    this.scheduleSave()
    return g
  }

  infoNeeded(botId, groupId, ttl = 60 * 60 * 1000) {
    const g = this.get(botId, groupId)
    return !g || !g.info_at || Date.now() - g.info_at > ttl
  }

  summary(botId, days = 7) {
    const groups = this.list(botId)
    const keys = new Set()
    for (let i = 0; i < days; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      keys.add(dayKey(d))
    }
    let commands = 0
    let commands7d = 0
    let members = 0
    let active = 0
    for (const g of groups) {
      members += Number(g.member_count) || 0
      commands += Number(g.days?.[dayKey()]?.commands) || 0
      let has = false
      for (const [k, v] of Object.entries(g.days || {})) {
        if (!keys.has(k)) continue
        commands7d += Number(v.commands) || 0
        if ((v.messages || 0) > 0) has = true
      }
      if (has) active++
    }
    return {
      groups: groups.length,
      members,
      commandsToday: commands,
      commands7d,
      activeGroups7d: active,
      top: groups.slice().sort((a, b) => (b.commands || 0) - (a.commands || 0)).slice(0, 8),
    }
  }

  scheduleSave() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY)
    this.saveTimer.unref?.()
  }

  async save() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await fs.writeFile(this.file, JSON.stringify(this.data, null, 2))
    } catch {}
  }

  async flush() {
    await this.save()
  }
}
