/**
 * WebUI 指令沙箱：创建一个只存在于内存中的假 Bot，
 * 把指令注入 TRSS 的事件总线，捕获插件回复并返回给 WebUI 渲染。
 * 不会连接 QQ，也不会把消息发送到真实群/好友。
 */
import { randomUUID } from "node:crypto"

const PREFIX = "WebUI.sandbox."
const SANDBOX_GROUP = "sandbox.group"
const SANDBOX_USER = "sandbox.user"

function imageUrl(file) {
  if (Buffer.isBuffer(file)) return `data:image/jpeg;base64,${file.toString("base64")}`
  if (file && typeof file === "object" && Buffer.isBuffer(file.data))
    return `data:image/jpeg;base64,${file.data.toString("base64")}`
  return String(file ?? "")
}

/**
 * 模拟官方适配器 raw markdown 模式的出站转换：
 * 插件通常只发 image + button；官方 QQBot 会把它们组合成 Markdown 图片 + 内嵌键盘。
 * 沙箱直接捕获插件原始 segment，若不转换就会看起来像普通机器人纯图片。
 */
function adaptToOfficialMarkdown(content) {
  const list = Array.isArray(content) ? content : []
  if (!list.length) return list
  if (list.some(i => ["card", "raw", "record", "video", "file"].includes(i.type))) return list
  const markdown = []
  const keyboard = []
  const rest = []
  for (const item of list) {
    if (item.type === "text" || item.type === "markdown") markdown.push(item.text || "")
    else if (item.type === "image") {
      if (item.url) markdown.push(`![图片](${item.url})`)
    } else if (item.type === "at") markdown.push(item.text || "")
    else if (item.type === "face") markdown.push(item.text || "")
    else if (item.type === "keyboard") keyboard.push(...(item.rows || []))
    else rest.push(item)
  }
  const out = []
  if (markdown.length || keyboard.length) out.push({ type: "markdown", text: markdown.join("\n") || " " })
  if (keyboard.length) out.push({ type: "keyboard", rows: keyboard })
  out.push(...rest)
  return out
}

export function normalizeSandboxContent(msg) {
  const list = Array.isArray(msg) ? msg : [msg]
  const out = []
  for (const raw of list) {
    let i = raw
    if (typeof i === "string") { out.push({ type: "text", text: i }); continue }
    if (!i || typeof i !== "object") continue
    switch (i.type) {
      case "text": out.push({ type: "text", text: String(i.text ?? "") }); break
      case "at": out.push({ type: "at", text: `@${i.qq || i.user_id || "成员"}` }); break
      case "face": out.push({ type: "face", text: i.id != null ? `[表情 ${i.id}]` : `[${i.text || i.name || "表情"}]` }); break
      case "reply": out.push({ type: "reply", text: "引用消息" }); break
      case "image":
      case "record":
      case "video":
      case "file":
        out.push({
          type: i.type,
          url: imageUrl(i.url || i.file),
          name: i.name || i.file_name || "",
          size: Number(i.size) || 0,
          width: Number(i.width) || 0,
          height: Number(i.height) || 0,
        })
        break
      case "markdown":
        out.push({
          type: "markdown",
          text: String(i.data?.content ?? i.content ?? i.data?.text ?? i.data ?? ""),
        })
        break
      case "card": {
        const c = i.data?.content || i.content || {}
        out.push({
          type: "card",
          title: String(c.title || "图文卡片"),
          description: String(c.description || ""),
          url: String(c.url || ""),
          pic_url: String(c.pic_url || ""),
        })
        break
      }
      case "button": {
        // TRSS segment.button(...rows) 的 data 直接是 row 数组；
        // 官方 SDK 的 raw keyboard 才是 data.content.rows。
        const rows = Array.isArray(i.data)
          ? i.data
          : (i.data?.content?.rows || i.data?.rows || i.buttons || [])
        out.push({ type: "keyboard", rows })
        break
      }
      case "raw": {
        const d = i.data
        if (d?.type === "keyboard") {
          out.push({ type: "keyboard", rows: d.content?.rows || d.rows || [] })
        } else if (d?.type === "markdown") {
          out.push({ type: "markdown", text: String(d.content || "") })
        } else if (d) {
          out.push({ type: "raw", data: d })
        }
        break
      }
      case "node":
        out.push(...normalizeSandboxContent(i.data?.map?.(x => x.message) || []))
        break
      default:
        if (i.text) out.push({ type: "text", text: String(i.text) })
        break
    }
  }
  return adaptToOfficialMarkdown(out)
}

function fakeGroup(bot, groupId) {
  return {
    group_id: groupId,
    group_name: groupId,
    sendMsg: msg => bot.sendGroupMsg(groupId, msg),
    recallMsg: async () => true,
    getInfo: async () => ({ group_openid: groupId, group_name: groupId }),
    getMemberInfo: async userId => ({ member_openid: userId, username: userId, member_role: "member" }),
    muteMember: async () => true,
    kickMember: async () => true,
  }
}

function fakeFriend(bot, userId) {
  return {
    user_id: userId,
    sendMsg: msg => bot.sendPrivateMsg(userId, msg),
    getInfo: async () => ({ user_openid: userId, username: userId }),
    recallMsg: async () => true,
  }
}

export function createSandboxBot(Bot, id = randomUUID()) {
  const uin = PREFIX + id
  const bot = {
    uin,
    self_id: uin,
    nickname: "WebUI 沙箱",
    avatar: "",
    adapter: { id: "QQBot", name: "WebUI 沙箱" },
    version: { id: "sandbox", name: "WebUI Sandbox", version: "1.0.0" },
    stat: { start_time: Date.now() / 1000 },
    captured: [],
    fl: new Map(),
    gl: new Map([[SANDBOX_GROUP, { group_id: SANDBOX_GROUP, group_name: SANDBOX_GROUP }]]),
    gml: new Map([[SANDBOX_GROUP, new Map()]]),
    pickFriend: userId => fakeFriend(bot, userId),
    pickUser: userId => fakeFriend(bot, userId),
    pickGroup: groupId => fakeGroup(bot, groupId),
    pickMember: (groupId, userId) => ({ ...fakeFriend(bot, userId), ...fakeGroup(bot, groupId), user_id: userId, group_id: groupId }),
    getFriendList: () => bot.fl,
    getGroupList: () => bot.gl,
    getGroupMemberList: groupId => bot.gml.get(groupId) || new Map(),
    sendPrivateMsg(userId, msg) {
      bot.captured.push({ id: ++bot._seq || (bot._seq = 1), time: Date.now(), target: "private", target_id: userId, content: normalizeSandboxContent(msg) })
      return Promise.resolve({ message_id: `${userId}.${randomUUID()}` })
    },
    sendGroupMsg(groupId, msg) {
      bot.captured.push({ id: ++bot._seq || (bot._seq = 1), time: Date.now(), target: "group", target_id: groupId, content: normalizeSandboxContent(msg) })
      return Promise.resolve({ message_id: `${groupId}.${randomUUID()}` })
    },
  }
  Bot[uin] = bot
  if (!Bot.uin.includes(uin)) Bot.uin.push(uin)
  return bot
}

export function removeSandboxBot(Bot, bot) {
  if (!bot) return
  delete Bot[bot.uin]
  const i = Bot.uin.indexOf(bot.uin)
  if (i >= 0) Bot.uin.splice(i, 1)
}

export function createSandboxEvent(bot, { command, scene = "group", groupId = SANDBOX_GROUP, userId = SANDBOX_USER, isMaster = true } = {}) {
  const group = scene === "group" ? fakeGroup(bot, groupId) : undefined
  const friend = fakeFriend(bot, userId)
  const e = {
    bot,
    adapter: bot.version,
    adapter_id: "QQBot",
    message_id: `sandbox_${randomUUID()}`,
    sender: { user_id: userId, nickname: "沙箱用户", role: "member" },
    nickname: "沙箱用户",
    user_id: userId,
    self_id: bot.uin,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: "text", text: String(command) }],
    raw_message: String(command),
    isMaster: !!isMaster,
    post_type: "message",
    ...(scene === "group"
      ? { message_type: "group", sub_type: "normal", group_id: groupId, group_name: groupId }
      : { message_type: "private", sub_type: "friend" }),
    friend,
    group,
    member: scene === "group" ? bot.pickMember(groupId, userId) : undefined,
  }
  e.reply = msg => (scene === "group" ? bot.sendGroupMsg(groupId, msg) : bot.sendPrivateMsg(userId, msg))
  return e
}

export function startSandbox(Bot, opts = {}) {
  const bot = createSandboxBot(Bot, opts.id)
  const e = createSandboxEvent(bot, opts)
  const event = e.message_type === "group" ? "message.group.normal" : "message.private.friend"
  let error = ""
  try {
    Bot.em(event, e)
  } catch (err) {
    error = String(err?.message || err)
  }
  return { bot, error }
}

export async function runSandbox(Bot, opts = {}) {
  const { bot, error: startError } = startSandbox(Bot, opts)
  let error = startError
  try {
    const maxWait = Math.min(15000, Math.max(500, Number(opts.wait) || 8000))
    const started = Date.now()
    let lastCount = 0
    let lastChange = Date.now()
    while (!error && Date.now() - started < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100))
      if (bot.captured.length !== lastCount) {
        lastCount = bot.captured.length
        lastChange = Date.now()
      }
      if (lastCount > 0 && Date.now() - lastChange >= 700) break
    }
  } catch (err) {
    error = String(err?.message || err)
  } finally {
    setTimeout(() => removeSandboxBot(Bot, bot), 15000).unref?.()
  }
  return { messages: bot.captured, error }
}
