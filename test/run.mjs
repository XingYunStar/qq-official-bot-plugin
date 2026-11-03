/**
 * qq-official-bot-plugin 集成测试
 * 用桩替代 TRSS-Yunzai 框架与网络，SDK 本体与插件代码都是真实的：
 * - Bot.prototype.start / getSelfInfo 打桩，避免真实连接
 * - 消息事件通过真实的 sdk.dispatchEvent + EventParserMap 解析
 * - 发送消息时拦截 sdk.sendGroupMessage 等，检查元素结构转换
 */
import * as nodeModule from "node:module"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const logs = []
const events = []
const sends = []
const started = []

const originalCwd = process.cwd()
const testWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-work-"))
process.chdir(testWorkDir)

process.on("unhandledRejection", err => {
  console.log("[unhandledRejection]", err?.stack || err)
  process.exitCode = 1
})

const fmt = v => {
  if (v instanceof Error) return `${v.name}: ${v.message}`
  if (typeof v === "object" && v !== null) {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

globalThis.logger = {
  info: () => {},
  mark: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  yellow: s => s,
  green: s => s,
}
globalThis.segment = {
  reply: id => ({ type: "reply", id }),
  image: file => ({ type: "image", file }),
  button: data => ({ type: "button", data }),
}
globalThis.plugin = class {
  constructor(opts) {
    Object.assign(this, opts)
  }
}
globalThis.Bot = {
  adapter: [],
  uin: [],
  em: (ev, data) => events.push({ ev, data }),
  express: { use: () => {}, quiet: [] },
  sleep: async (ms, promise) => promise,
  getMap: async () => new Map(),
  fsStat: async p => {
    try {
      await fs.access(p)
      return true
    } catch {
      return false
    }
  },
  Buffer: async file => (Buffer.isBuffer(file) ? file : Buffer.from(String(file))),
  String: v => String(v),
  fileToUrl: async file => new URL("https://example.com/File/test.png"),
  makeLog: (level, msg, id) => {
    const text = Array.isArray(msg) ? msg.map(fmt).join(" ") : fmt(msg)
    logs.push({ level, text, id })
    console.log(`  [${level}]${id ? `(${id})` : ""} ${text}`)
  },
}

globalThis.fetch = async (url, opts = {}) => {
  const body = JSON.parse(opts.body || "{}")
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: `token-${body.appId}`, expires_in: 7200 }),
  }
}

// ---- SDK 打桩：只绕过真实的网络连接 ----
const QQBot = (await import("qq-official-bot")).default
const { Bot: SdkBot } = QQBot
SdkBot.prototype.start = async function () {
  started.push(this.config.appid)
  this.receiver._isStarted = true
  this.receiver._isReady = true
  this.receiver.emit("ready")
}
SdkBot.prototype.stop = async function () {
  this.receiver._isStarted = false
  this.receiver._isReady = false
  this.receiver.emit("close", 1000, "stop")
}
SdkBot.prototype.getSelfInfo = async function () {
  return { id: this.config.appid, username: `bot-${this.config.appid}` }
}

nodeModule.register(new URL("./hooks.mjs", import.meta.url).href)
await import("../index.js")

const adapter = Bot.adapter[0]
let pass = 0,
  fail = 0
const assert = (name, cond, extra = "") => {
  if (cond) {
    pass++
    console.log(`✅ ${name}`)
  } else {
    fail++
    console.log(`❌ ${name} ${extra}`)
  }
}
const wait = ms => new Promise(r => setTimeout(r, ms))
const lastEvent = ev => [...events].reverse().find(i => i.ev === ev)
const dispatch = async (t, d, id = t) => {
  Bot["10001"].sdk.dispatchEvent(t, { id: `${t}:${id}`, t, d })
  await wait(10)
}

console.log("\n=== A. 连接与适配器注册 ===")
{
  assert("适配器已注册", adapter?.id === "QQBot")
  assert("版本号为 qq-official-bot", /qq-official-bot v/.test(adapter.version), adapter.version)
  assert("WS 连接成功", await adapter.connect("10001:app-a:tok:sec-a:1:0"))
  const bot = Bot["10001"]
  assert("Bot 已注册", !!bot)
  assert("SDK 使用 qq-official-bot", bot.sdk.constructor.name === "Bot")
  assert("连接模式为 websocket", bot.sdk.config.mode === "websocket")
  assert("removeAt 关闭", bot.sdk.config.removeAt === false)
  assert("intents 含 GROUP_AND_C2C_EVENT", bot.sdk.config.intents.includes("GROUP_AND_C2C_EVENT"))
  assert("重连监视已安装", !!adapter.watcher["10001"])
  assert("info 已填充", bot.info.username === "bot-app-a")
  assert("token 自愈已接管", !!adapter.token["10001"])
}

console.log("\n=== B. 群消息解析（真实 dispatchEvent） ===")
{
  await dispatch("GROUP_AT_MESSAGE_CREATE", {
    id: "msg-1",
    content: "<@!BOT_OPENID> 你好",
    timestamp: new Date().toISOString(),
    group_id: "GROUP_1",
    group_openid: "GROUP_1",
    author: { id: "USER_1", member_openid: "USER_1", username: "张三" },
    mentions: [{ id: "BOT_OPENID", username: "bot", is_you: true }],
  })
  const d = lastEvent("message.group.normal")?.data
  assert("触发 message.group.normal", !!d)
  assert("self_id 正确", d?.self_id === "10001")
  assert("group_id 带前缀", d?.group_id === "10001:GROUP_1", d?.group_id)
  assert("sender.user_id 带前缀", d?.sender?.user_id === "10001:USER_1", d?.sender?.user_id)
  assert("消息元素已扁平化", d?.message?.[0]?.type === "at" && d.message[0].qq === "10001")
  assert("文本元素存在", d?.message?.some(i => i.type === "text" && i.text.includes("你好")))
  assert("未被重复插入自身 at", d?.message?.filter(i => i.type === "at" && i.qq === "10001").length === 1)
  assert("raw_message 非空", typeof d?.raw_message === "string" && d.raw_message.length > 0)
}

console.log("\n=== C. 私聊消息解析 ===")
{
  await dispatch("C2C_MESSAGE_CREATE", {
    id: "msg-2",
    content: "hi",
    timestamp: new Date().toISOString(),
    author: { id: "USER_2", user_openid: "USER_2" },
  })
  const d = lastEvent("message.private.friend")?.data
  assert("触发 message.private.friend", !!d)
  assert("私聊 user_id 带前缀", d?.sender?.user_id === "10001:USER_2", d?.sender?.user_id)
  assert("私聊消息类型", d?.message_type === "private" && d?.sub_type === "friend")
}

console.log("\n=== D. 频道消息解析 ===")
{
  await dispatch("AT_MESSAGE_CREATE", {
    id: "msg-3",
    content: "<@!USER_9> 在吗",
    timestamp: new Date().toISOString(),
    guild_id: "GUILD_1",
    channel_id: "CHANNEL_1",
    author: { id: "USER_3", username: "李四", avatar: "https://example.com/a.png" },
    member: { nick: "小李" },
    mentions: [{ id: "USER_9", username: "王五" }],
  })
  const guild = [...events].reverse().find(i => i.data?.group_id?.startsWith("qg_"))?.data
  assert("触发频道消息", !!guild)
  assert("频道 group_id 格式", guild?.group_id === "qg_GUILD_1-CHANNEL_1", guild?.group_id)
  assert("频道 sender 为 qg_ 前缀", guild?.sender?.user_id === "qg_USER_3", guild?.sender?.user_id)
  assert("频道 at 元素 qg_ 前缀", guild?.message?.some(i => i.type === "at" && i.qq === "qg_USER_9"))
  assert("频道昵称取 member.nick", guild?.sender?.card === "小李")
}

console.log("\n=== D2. 群内全量消息（全量模式） ===")
{
  // 1) 普通群消息（未 @ 机器人）：应正常派发，但不补自身 at
  await dispatch("GROUP_MESSAGE_CREATE", {
    id: "msg-full-1",
    content: "普通群消息",
    timestamp: new Date().toISOString(),
    group_id: "GROUP_1",
    author: { id: "USER_5", member_openid: "USER_5", username: "王五" },
    mentions: [],
  })
  const d = [...events].reverse().find(i => i.data?.message_id === "msg-full-1")?.data
  assert("全量普通消息被处理", !!d)
  assert("非@消息不补自身 at", !d?.message?.some(i => i.type === "at" && i.qq === "10001"))

  // 2) 全量模式下 @机器人：content 带 <@openid>，mentions 带 is_you
  await dispatch("GROUP_MESSAGE_CREATE", {
    id: "msg-full-2",
    content: "<@BOT_OPENID> 菜单",
    timestamp: new Date().toISOString(),
    group_id: "GROUP_1",
    author: { id: "USER_6", member_openid: "USER_6", username: "赵六" },
    mentions: [{ id: "BOT_OPENID", username: "bot", bot: true, is_you: true }],
  })
  const d2 = [...events].reverse().find(i => i.data?.message_id === "msg-full-2")?.data
  assert("全量@消息被处理", !!d2)
  assert("全量@消息带自身 at", d2?.message?.some(i => i.type === "at" && i.qq === "10001"), JSON.stringify(d2?.message))
  assert("全量@消息不重复 at", d2?.message?.filter(i => i.type === "at" && i.qq === "10001").length === 1)

  // 3) 只有 bot 标记、没有 is_you 时，也应按「消息开头 @ 的机器人」识别为自身
  await dispatch("GROUP_MESSAGE_CREATE", {
    id: "msg-full-3",
    content: "<@BOT_OPENID> 菜单",
    timestamp: new Date().toISOString(),
    group_id: "GROUP_1",
    author: { id: "USER_7", member_openid: "USER_7", username: "孙七" },
    mentions: [{ id: "BOT_OPENID", username: "bot", bot: true }],
  })
  const d3 = [...events].reverse().find(i => i.data?.message_id === "msg-full-3")?.data
  assert("无 is_you 时仍识别自身 at", d3?.message?.some(i => i.type === "at" && i.qq === "10001"), JSON.stringify(d3?.message))

  // 4) 只有 group_openid（官方全量消息示例就是这种）时也能正确派发
  await dispatch("GROUP_MESSAGE_CREATE", {
    id: "msg-full-4",
    content: "<@BOT_OPENID> 帮助",
    timestamp: new Date().toISOString(),
    group_openid: "GROUP_2",
    author: { id: "USER_8", member_openid: "USER_8", username: "周八" },
    mentions: [{ id: "BOT_OPENID", username: "bot", bot: true }],
  })
  const d4 = [...events].reverse().find(i => i.data?.message_id === "msg-full-4")?.data
  assert("仅有 group_openid 也能派发", d4?.group_id === "10001:GROUP_2", d4?.group_id)
  assert("仅有 group_openid 时 at 正常", d4?.message?.some(i => i.type === "at" && i.qq === "10001"), JSON.stringify(d4?.message))

  // 4) 相同 msg_id 重复推送只处理一次
  const count = events.filter(i => i.data?.message_id === "msg-full-1").length
  await dispatch("GROUP_MESSAGE_CREATE", {
    id: "msg-full-1",
    content: "普通群消息",
    timestamp: new Date().toISOString(),
    group_id: "GROUP_1",
    author: { id: "USER_5", member_openid: "USER_5", username: "王五" },
    mentions: [],
  })
  const count2 = events.filter(i => i.data?.message_id === "msg-full-1").length
  console.log("DEBUG seen:", [...adapter.msgSeen.entries()].filter(([k]) => k.includes("msg-full")))
  assert("重复推送被去重", count2 === count, `${count} -> ${count2}`)
}

console.log("\n=== E. 发送消息元素转换（legacy 模式） ===")
{
  __config.markdown["10001"] = "legacy"
  const bot = Bot["10001"]
  sends.length = 0
  bot.sdk.sendGroupMessage = async (gid, msg, source) => {
    sends.push({ kind: "group", gid, msg, source })
    return { id: `ret-${sends.length}` }
  }
  const data = {
    self_id: "10001",
    bot,
    group_id: "GROUP_1",
    user_id: "10001:USER_1",
    message_id: "msg-1",
    time: Date.now() / 1000,
    _ret_id: [],
  }
  const buffer = Buffer.from([1, 2, 3])
  const ret = await adapter.sendGroupMsg(data, ["你好", { type: "image", file: buffer }])
  const textSend = sends.find(i => i.msg?.[0]?.type === "text")
  const imageSend = sends.find(i => i.msg?.[0]?.type === "image")
  assert("文本转换为 {type,data}", textSend?.msg?.[0]?.data?.text === "你好", JSON.stringify(sends.map(i => i.msg)))
  assert("图片转换为 {type,data}", Buffer.isBuffer(imageSend?.msg?.[0]?.data?.file))
  assert("被动回复 msg_id 透传", sends.every(i => i.source?.id === "msg-1"), JSON.stringify(sends.map(i => i.source)))
  assert("返回 message_id", ret.message_id.length === sends.length && ret.message_id[0].startsWith("ret-"))
}

console.log("\n=== F. 引用回复 & 按钮转换 ===")
{
  const bot = Bot["10001"]
  const data = {
    self_id: "10001",
    bot,
    group_id: "GROUP_1",
    user_id: "10001:USER_1",
    message_id: "msg-1",
    time: Date.now() / 1000,
    _ret_id: [],
  }

  // 引用回复（legacy 模式）
  __config.markdown["10001"] = "legacy"
  sends.length = 0
  await adapter.sendGroupMsg(data, [{ type: "reply", id: "msg-0" }, "引用回复"])
  const replyMsg = sends.at(-1)?.msg || []
  assert("reply 转换", replyMsg[0]?.type === "reply" && replyMsg[0].data?.id === "msg-0", JSON.stringify(replyMsg))

  // 按钮（raw markdown 模式）
  __config.markdown["10001"] = "raw"
  sends.length = 0
  await adapter.sendGroupMsg(data, [
    "按钮测试",
    { type: "button", data: [[{ text: "点我", callback: "#测试" }]] },
  ])
  const buttonMsg = sends.at(-1)?.msg || []
  const btn = buttonMsg.find(i => i.type === "button")
  assert("button 转换", !!btn?.data?.buttons?.length, JSON.stringify(buttonMsg))
  assert("button 回调已登记", Object.keys(bot.callback).length > 0)
}

console.log("\n=== G. Webhook 模式 ===")
{
  assert("Webhook 连接成功", await adapter.connect("10002:app-b:tok:sec-b:2"))
  const bot = Bot["10002"]
  assert("Webhook 已登记 appid", adapter.appid["app-b"] === bot)
  assert("Webhook 未安装重连监视", !adapter.watcher["10002"])
  assert("Webhook 未连接 ws", started.filter(i => i === "app-b").length === 0)

  let signed
  await adapter.makeWebHookSign(
    "10002",
    { body: { d: { plain_token: "pt", event_ts: "1700000000" } }, res: { send: v => (signed = v) } },
    "sec-b",
  )
  assert("签名返回 plain_token", signed?.plain_token === "pt")
  assert("签名为 128 位 hex", /^[0-9a-f]{128}$/.test(signed?.signature || ""), signed?.signature)

  let status
  const req = {
    headers: { "x-bot-appid": "app-b" },
    body: {
      t: "C2C_MESSAGE_CREATE",
      id: "C2C_MESSAGE_CREATE:evt-4",
      d: {
        id: "msg-4",
        content: "webhook hi",
        timestamp: new Date().toISOString(),
        author: { id: "USER_4", user_openid: "USER_4" },
      },
    },
    res: { sendStatus: code => (status = code) },
  }
  adapter.makeWebHook(req)
  await wait(20)
  const d = lastEvent("message.private.friend")?.data
  assert("Webhook 能分发消息", d?.message_id === "msg-4", JSON.stringify(d?.message_id))
  assert("Webhook 返回 200", status === 200)
}

console.log("\n=== H. 主动重连 ===")
{
  const before = started.filter(i => i === "app-a").length
  await adapter.reconnect("10001", 0, true)
  await wait(50)
  const after = started.filter(i => i === "app-a").length
  assert("重连会重新 start", after > before, `${before} -> ${after}`)
  assert("重连后判定可用", adapter.isUp("10001"))
}

console.log("\n=== J. 群管理 API & 通知事件 ===")
{
  const bot = Bot["10001"]
  const calls = []
  bot.sdk.groupService = {
    handleMemberAdded: async () => {},
    handleMemberRemoved: async () => {},
    getInfo: async gid => ({ group_openid: gid, group_name: "测试群" }),
    getBotState: async gid => ({ member_role: "admin" }),
    getMemberInfo: async (gid, uid) => ({ member_openid: uid, username: "张三", member_role: "owner", joined_at: "2026-01-01T00:00:00Z", bot: false }),
    setMemberMute: async (gid, arr) => calls.push({ api: "mute", gid, arr }),
    removeMembers: async (gid, opts) => calls.push({ api: "kick", gid, opts }),
    getJoinRequests: async gid => ({ list: [{ member_openid: "U1", username: "申请者", join_request_id: "jr1" }], next_cursor: "" }),
    approveJoinRequest: async (gid, uid, opts) => calls.push({ api: "approve", gid, uid, opts }),
  }

  const group = adapter.pickGroup("10001", "10001:GROUP_1")
  assert("群信息可获取", (await group.getInfo()).group_name === "测试群")
  assert("机器人身份可获取", (await group.getBotState()).member_role === "admin")

  await group.muteMember("10001:USER_1", 600)
  assert("禁言调用 setMemberMute", calls[0]?.api === "mute" && calls[0].arr[0].member_openid === "USER_1")
  assert("禁言到期时间为 ISO", /Z$/.test(calls[0].arr[0].mute_expire_at))
  await group.muteMember("10001:USER_1", 0)
  assert("解除禁言使用 op=del", calls[1]?.arr?.[0]?.op === "del")

  await group.kickMember("USER_2", true)
  assert("踢人调用 removeMembers", calls[2]?.api === "kick" && calls[2].opts.member_openids[0] === "USER_2")
  assert("踢人可同时拉黑", calls[2].opts.add_to_member_blacklist === true)

  const member = group.pickMember("10001:USER_1")
  const info = await member.getInfo()
  assert("成员身份可获取", info.member_role === "owner" && info.username === "张三")

  const cached = group.getMsg("msg-1")
  assert("消息缓存可读（供 e.getReply）", cached?.message_id === "msg-1")
  assert("未知消息返回 null", group.getMsg("not-exist") === null)

  const __origNotice = adapter.makeNotice.bind(adapter)
  adapter.makeNotice = (...a) => {
    try { return __origNotice(...a) } catch (err) { console.log("NOTICE ERR", err) }
  }

  // 群成员进群通知
  bot.sdk.dispatchEvent("GROUP_MEMBER_ADD", {
    id: "GROUP_MEMBER_ADD:x",
    t: "GROUP_MEMBER_ADD",
    d: { group_openid: "GROUP_1", member_openid: "USER_NEW", op_member_openid: "USER_OP", timestamp: "2026-10-30T12:00:00+08:00" },
  })
  await wait(20)
  const inc = lastEvent("notice.group.increase")
  assert("进群通知已派发", inc?.data?.user_id === "10001:USER_NEW" && inc?.data?.group_id === "10001:GROUP_1", String(inc?.data?.user_id))

  // 入群申请通知
  bot.sdk.dispatchEvent("GROUP_JOIN_REQUEST", {
    id: "GROUP_JOIN_REQUEST:y",
    t: "GROUP_JOIN_REQUEST",
    d: { group_openid: "GROUP_1", member_openid: "USER_REQ", username: "申请者", join_request_id: "jr1", apply_at: "2026-10-30T12:00:00+08:00" },
  })
  await wait(20)
  const jr = lastEvent("notice.group.join_request")
  assert("入群申请通知已派发", jr?.data?.user_id === "10001:USER_REQ" && jr?.data?.join_request_id === "jr1", String(jr?.data?.user_id))

  // 入群审批 API
  await bot.sdk.groupService.approveJoinRequest("GROUP_1", "USER_REQ", { op: "approve", join_request_id: "jr1" })
  assert("入群审批调用成功", calls.at(-1)?.api === "approve" && calls.at(-1).opts.op === "approve")
}

console.log("\n=== K. 链接模式 / 撤回判断 ===")
{
  const out = adapter.makeMarkdownLink("https://example.com/path?q=1")
  assert("Markdown 链接格式", out === "[example.com/path](https://example.com/path?q=1)", out)

  const oldMode = adapter.urlMode,
    oldRe = adapter.toQRCodeRegExp
  adapter.urlMode = "link"
  adapter.toQRCodeRegExp = /https?:\/\/[^\s]+/g
  const text = await adapter.makeRawMarkdownText({ self_id: "10001" }, "看这个 https://a.com/x 吧")
  assert("raw 模式发链接而不是二维码", text.includes("[a.com/x](https://a.com/x)"), text)
  const text2 = await adapter.makeRawMarkdownText(
    { self_id: "10001" },
    "已有 [a](https://a.com) 和 https://b.com",
  )
  assert(
    "不破坏已有的 Markdown 链接",
    text2.includes("[a](https://a.com)") && text2.includes("[b.com](https://b.com)"),
    text2,
  )
  adapter.urlMode = oldMode
  adapter.toQRCodeRegExp = oldRe

  const bot = Bot["10001"]
  sends.length = 0
  bot.sdk.sendGroupMessage = async () => ({ id: "own-1" })
  await adapter.sendGroupMsg(
    {
      self_id: "10001",
      bot,
      group_id: "GROUP_1",
      user_id: "10001:U1",
      message_id: "m-own",
      time: Date.now() / 1000,
      _ret_id: [],
    },
    ["x"],
  )
  assert("自己发送的消息可识别", adapter.isOwnMessage("own-1") === true)
  assert("未知消息不可判定", adapter.isOwnMessage("nope") === undefined)
}

console.log("\n=== L. 群引用（msg_elements） ===")
{
  const bot = Bot["10001"]
  // 先发一条普通消息（带 msg_idx），供后续引用解析出真实消息 ID
  bot.sdk.dispatchEvent("GROUP_AT_MESSAGE_CREATE", {
    id: "GROUP_AT_MESSAGE_CREATE:q1",
    t: "GROUP_AT_MESSAGE_CREATE",
    d: {
      id: "msg-quoted",
      content: "<@!BOT> 原始消息",
      timestamp: new Date().toISOString(),
      group_id: "GROUP_1",
      author: { id: "USER_Q", member_openid: "USER_Q", username: "被引用者" },
      mentions: [],
      message_scene: { source: "default", ext: ["msg_idx=IDX_QUOTED", "auth_token=t"] },
    },
  })
  await wait(20)

  // 再引用它
  bot.sdk.dispatchEvent("GROUP_AT_MESSAGE_CREATE", {
    id: "GROUP_AT_MESSAGE_CREATE:q2",
    t: "GROUP_AT_MESSAGE_CREATE",
    d: {
      id: "msg-quote",
      content: "<@!BOT> #qqbot引用消息",
      timestamp: new Date().toISOString(),
      group_id: "GROUP_1",
      author: { id: "USER_Q", member_openid: "USER_Q", username: "被引用者", member_role: "member" },
      mentions: [],
      message_scene: {
        source: "default",
        ext: ["ref_msg_idx=IDX_QUOTED", "msg_idx=IDX_QUOTE", "auth_token=t"],
      },
      msg_elements: [{ message_type: 103, content: "原始消息", msg_idx: "IDX_QUOTED" }],
    },
  })
  await wait(20)
  const d = [...events].reverse().find(i => i.data?.message_id === "msg-quote")?.data
  assert(
    "引用元素已补进消息",
    d?.message?.[0]?.type === "reply" && d.message[0].id === "msg-quoted",
    JSON.stringify(d?.message?.[0]),
  )
  const cached = adapter.pickGroup("10001", "10001:GROUP_1").getMsg("msg-quoted")
  assert("被引用消息可读取", String(cached?.raw_message || "").includes("原始消息"), String(cached?.raw_message))

  // 引用一条没有缓存过的消息：用引用索引兜底，也能读内容
  bot.sdk.dispatchEvent("GROUP_AT_MESSAGE_CREATE", {
    id: "GROUP_AT_MESSAGE_CREATE:q3",
    t: "GROUP_AT_MESSAGE_CREATE",
    d: {
      id: "msg-quote-2",
      content: "<@!BOT> #qqbot引用消息",
      timestamp: new Date().toISOString(),
      group_id: "GROUP_1",
      author: { id: "USER_Q", member_openid: "USER_Q", username: "被引用者" },
      mentions: [],
      message_scene: { source: "default", ext: ["ref_msg_idx=IDX_UNKNOWN", "auth_token=t"] },
      msg_elements: [{ message_type: 103, content: "没缓存过的内容", msg_idx: "IDX_UNKNOWN" }],
    },
  })
  await wait(20)
  const d2 = [...events].reverse().find(i => i.data?.message_id === "msg-quote-2")?.data
  assert(
    "未缓存的引用用索引兜底",
    d2?.message?.[0]?.type === "reply" && d2.message[0].id === "IDX_UNKNOWN",
    JSON.stringify(d2?.message?.[0]),
  )
  const q2 = adapter.pickGroup("10001", "10001:GROUP_1").getMsg("IDX_UNKNOWN")
  assert("未缓存的引用内容可读", q2?.raw_message === "没缓存过的内容", JSON.stringify(q2?.raw_message))
}

console.log("\n=== M. 群引用发送 / 引用索引 ===")
{
  // 1) MessageBuilder 补丁：msg_id 用本条消息，message_reference 用引用索引
  const mb = new QQBot.MessageBuilder("appid", false, { id: "ROBOT1.0_current" })
  const built = await mb.build([
    { type: "reply", data: { id: "REFIDX_ref" } },
    { type: "text", data: { text: "hi" } },
  ])
  assert("被动回复 msg_id 使用本条消息", built.messagePayload.msg_id === "ROBOT1.0_current", String(built.messagePayload.msg_id))
  assert(
    "message_reference 使用引用索引",
    built.messagePayload.message_reference?.message_id === "REFIDX_ref",
    JSON.stringify(built.messagePayload.message_reference),
  )

  // 2) 引用本条消息 → 转成本条消息的 msg_idx
  const data = {
    message_type: "group",
    message_id: "m-current",
    group_id: "G1",
    raw: { message_scene: { ext: ["msg_idx=IDX_CURRENT"] } },
  }
  const out = adapter.toSdkMessage([{ type: "reply", id: "m-current" }, { type: "text", text: "x" }], data)
  assert("引用本条消息转换为 msg_idx", out[0]?.data?.id === "IDX_CURRENT", JSON.stringify(out[0]))

  // 3) 引用收到过的消息 → 用 msg_idx
  adapter.recordRef("10001", "IDX_OLD", "ROBOT1.0_old")
  assert(
    "引用历史消息用 msg_idx",
    adapter.toGroupReferenceId("ROBOT1.0_old", { self_id: "10001" }) === "IDX_OLD",
  )

  // 3.5) markdown 模式显式引用：保留 reply 元素并转成 msg_idx
  const dataQ = {
    self_id: "10001",
    bot: Bot["10001"],
    message_type: "group",
    message_id: "m-current",
    group_id: "GROUP_1",
    time: Date.now() / 1000,
    raw: { message_scene: { ext: ["msg_idx=IDX_CUR"] } },
  }
  const source = {}
  const msgs = await adapter.makeRawMarkdownMsg(
    dataQ,
    [{ type: "reply", id: "m-current" }, "引用内容"],
    true,
    source,
  )
  const flat = msgs.flat()
  assert("markdown 模式保留 reply 元素", flat.some(i => i.type === "reply" && i.id === "m-current"), JSON.stringify(flat))
  const conv = adapter.toSdkMessage(msgs[0], dataQ)
  assert("reply 元素转成 msg_idx", conv[0]?.data?.id === "IDX_CUR", JSON.stringify(conv[0]))

  // 3.6) 非显式引用不加 reply 元素（避免每条回复都带引用气泡）
  const source2 = {}
  const msgs2 = await adapter.makeRawMarkdownMsg(dataQ, ["普通回复"], true, source2)
  assert("普通回复不产生引用气泡", !msgs2.flat().some(i => i.type === "reply"), JSON.stringify(msgs2.flat()))

  // 4) 引用机器人自己发的消息 → 用发送响应里的 ref_idx，并能反向解析回真实 ID
  adapter.recordRef("10001", "REFIDX_sent", "ROBOT1.0_sent", true)
  assert(
    "引用自己的消息用 ref_idx",
    adapter.toGroupReferenceId("ROBOT1.0_sent", { self_id: "10001" }) === "REFIDX_sent",
  )

  const bot = Bot["10001"]
  bot.sdk.dispatchEvent("GROUP_AT_MESSAGE_CREATE", {
    id: "GROUP_AT_MESSAGE_CREATE:q-sent",
    t: "GROUP_AT_MESSAGE_CREATE",
    d: {
      id: "msg-quote-own",
      content: "<@!BOT> #撤回",
      timestamp: new Date().toISOString(),
      group_id: "GROUP_1",
      author: { id: "USER_Q", member_openid: "USER_Q", username: "被引用者" },
      mentions: [],
      message_scene: { source: "default", ext: ["ref_msg_idx=REFIDX_sent", "auth_token=t"] },
      msg_elements: [{ message_type: 103, content: "机器人自己发的内容", msg_idx: "REFIDX_sent" }],
    },
  })
  await wait(20)
  const d = [...events].reverse().find(i => i.data?.message_id === "msg-quote-own")?.data
  assert(
    "引用自己的消息可解析回真实 ID",
    d?.message?.[0]?.type === "reply" && d.message[0].id === "ROBOT1.0_sent",
    JSON.stringify(d?.message?.[0]),
  )
  assert("Robot 自己消息的引用内容可读", adapter.pickGroup("10001", "10001:GROUP_1").getMsg("ROBOT1.0_sent")?.raw_message === "机器人自己发的内容")
}

console.log("\n=== N. 测试插件自动安装 ===")
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-example-"))
  const cwd = process.cwd()
  process.chdir(tmp)
  try {
    const first = await adapter.ensureExamplePlugin()
    const target = path.join("plugins", "example", "qqbot-test.js")
    assert("首次启动安装测试插件", first === true && (await Bot.fsStat(target)))
    const content = await fs.readFile(target, "utf8")
    assert("安装内容正确", content.includes("QQBot 适配器功能测试插件"), content.slice(0, 30))
    const second = await adapter.ensureExamplePlugin()
    assert("已安装时不重复安装", second === false)
  } finally {
    process.chdir(cwd)
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

console.log("\n=== O. master 使用说明 ===")
{
  const mainCfg = (await import("./stub-main-config.mjs")).default
  const bot = Bot["10001"]
  const calls = []
  const oldSend = bot.sdk.sendPrivateMessage
  bot.sdk.sendPrivateMessage = async (uid, msg) => calls.push({ uid, msg })
  Bot.uin.push("10001")
  try {
    mainCfg.master["10001"] = ["MASTER_OPENID"]
    const ok = await adapter.sendExampleGuide()
    assert("向 master 发送使用说明", ok === true && calls[0]?.uid === "MASTER_OPENID", JSON.stringify(calls[0]?.uid))
    assert(
      "说明内容包含测试命令",
      JSON.stringify(calls[0]?.msg || "").includes("#qqbot测试"),
      JSON.stringify(calls[0]?.msg || "").slice(0, 80),
    )

    calls.length = 0
    delete mainCfg.master["10001"]
    const none = await adapter.sendExampleGuide()
    assert("没有 master 时不发送", none === false && calls.length === 0)
  } finally {
    bot.sdk.sendPrivateMessage = oldSend
    Bot.uin.pop()
    delete mainCfg.master["10001"]
  }
}

console.log("\n=== P. 频道 legacy multipart ===")
{
  const bot = Bot["10001"]
  const oldMarkdown = __config.markdown["10001"]
  __config.markdown["10001"] = "legacy"
  const guildData = {
    self_id: "10001",
    bot,
    message_type: "group",
    guild_id: "G1",
    channel_id: "CH1",
    message_id: "m1",
    time: Date.now() / 1000,
  }

  const msgs = await adapter.makeGuildMsg(guildData, [{ type: "image", file: Buffer.from([1, 2, 3]) }])
  const imgEl = msgs[0].find(el => el.type === "image")
  assert("legacy 保留本地图片", Buffer.isBuffer(imgEl?.file), JSON.stringify(msgs[0]))

  const posts = []
  const oldPost = bot.sdk.request.post
  const oldSendGuild = bot.sdk.sendGuildMessage
  let normalSent = 0
  let lastGuildElements
  bot.sdk.request.post = async (url, form) => {
    posts.push({ url, form })
    return { data: { id: "gm1" } }
  }
  bot.sdk.sendGuildMessage = async (channelId, elements) => {
    normalSent++
    lastGuildElements = elements
    return { id: "normal" }
  }

  const ret = await adapter.sendGuildElements(
    guildData,
    [{ type: "reply", id: "m0" }, { type: "text", text: "hi" }, { type: "image", file: Buffer.from([1, 2, 3]) }],
    "guild",
  )
  assert("legacy 走 multipart", posts.length === 1 && posts[0].url === "/channels/CH1/messages", String(posts[0]?.url))
  assert(
    "multipart 字段正确",
    posts[0].form.get("content") === "hi" && posts[0].form.get("msg_id") === "m0",
    JSON.stringify([...posts[0].form.keys()]),
  )
  assert("multipart 包含文件", posts[0].form.get("file_image") instanceof Blob)
  assert("multipart 返回消息 ID", ret.id === "gm1")

  __config.markdown["10001"] = "raw"
  posts.length = 0
  await adapter.sendGuildElements(guildData, [{ type: "text", text: "hi" }], "guild")
  assert("非 legacy 不走 multipart", posts.length === 0 && normalSent >= 1)

  __config.markdown["10001"] = "legacy"
  posts.length = 0
  bot.sdk.request.post = async () => {
    throw new Error("boom")
  }
  const msgs2 = await adapter.makeGuildMsg(guildData, [{ type: "image", file: Buffer.from([1, 2, 3]) }])
  const before = normalSent
  const ret2 = await adapter.sendGuildElements(guildData, msgs2[0], "guild")
  const imgEl2 = lastGuildElements?.find(el => el.type === "image")
  assert(
    "multipart 失败回退普通发送",
    ret2.id === "normal" && normalSent === before + 1 && adapter.isHttpUrl(imgEl2?.data?.file),
    JSON.stringify(imgEl2?.data?.file),
  )

  __config.markdown["10001"] = oldMarkdown
  bot.sdk.request.post = oldPost
  bot.sdk.sendGuildMessage = oldSendGuild
}

console.log("\n=== Q. 引用索引持久化（24h / 7d） ===")
{
  const id = "10001"
  const recvIdx = "REFIDX_RECV_TEST"
  const sentIdx = "REFIDX_SENT_TEST"
  adapter.recordRef(id, recvIdx, "ROBOT1.0_recv")
  adapter.recordRef(id, sentIdx, "ROBOT1.0_sent", true)
  await adapter.refWrite[id]
  const file = adapter.refFilePath(id)
  const lines = (await fs.readFile(file, "utf8")).trim().split("\n").filter(Boolean)
  assert("引用索引写入文件", lines.length >= 2, String(lines.length))
  assert("可反查引用索引", adapter.refOf(id, "ROBOT1.0_recv") === recvIdx)

  // 模拟重启：销毁内存后从文件恢复
  adapter.destroyRefStore(id)
  await adapter.initRefStore(id)
  assert("重启后解析收到消息", adapter.lookupRef(id, recvIdx)?.m === "ROBOT1.0_recv")
  assert("重启后解析自己消息", adapter.lookupRef(id, sentIdx)?.m === "ROBOT1.0_sent")
  assert("重启后反向索引可用", adapter.refOf(id, "ROBOT1.0_sent") === sentIdx)

  const store = adapter.refStore[id]
  const now = Date.now()
  store.get(recvIdx).t = now - 25 * 60 * 60 * 1000
  store.get(sentIdx).t = now - 25 * 60 * 60 * 1000
  await adapter.cleanupRefStore(id)
  assert("收到消息 24 小时过期", adapter.lookupRef(id, recvIdx) === null)
  assert("自己发的消息 7 天内保留", adapter.lookupRef(id, sentIdx) !== null)

  store.get(sentIdx).t = now - 8 * 24 * 60 * 60 * 1000
  await adapter.cleanupRefStore(id)
  // 生产环境由「启动时 / 每小时」触发压缩；测试里手动触发一次
  await adapter.compactRefStore(id)
  await adapter.refWrite[id]
  assert("自己发的消息 7 天过期", adapter.lookupRef(id, sentIdx) === null)
  console.log("DEBUG keys", [...store.keys()], "file:", (await fs.readFile(file, "utf8")).slice(0,200))
  const after = await fs.readFile(file, "utf8")
  assert(
    "过期后文件已压缩",
    !after.includes(recvIdx) && !after.includes(sentIdx),
    after.slice(0, 160),
  )
}

console.log("\n=== R. 群被动回复消息池 ===")
{
  adapter.msgPool.clear()
  const data = { self_id: "10001", message_type: "group", group_id: "GROUP_POOL" }
  adapter.recordMsgId({ ...data, message_id: "m1" })
  adapter.recordMsgId({ ...data, message_id: "m2" })
  const picks = []
  for (let i = 0; i < 6; i++) picks.push(adapter.pickMsgId(data))
  assert("优先使用最旧的消息 ID", picks.slice(0, 4).every(i => i === "m1"), JSON.stringify(picks))
  assert("同一消息最多回复 5 次", picks[4] === "m1" && picks[5] === "m2", JSON.stringify(picks))

  const list = adapter.msgPool.get("10001:GROUP_POOL")
  list[0].t = Date.now() - 120 * 1000
  assert("超过 110 秒走主动消息", adapter.pickMsgId(data) === null, JSON.stringify(list))
  adapter.msgPool.clear()
}

console.log("\n=== S. Markdown 素材上传 ===")
{
  const bot = Bot["10001"]
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  )
  const calls = []
  const oldUpload = bot.sdk.uploadMaterialImage
  Bot.uin.push("10001")
  bot.sdk.uploadMaterialImage = async (buffer, opts) => {
    calls.push({ size: buffer.length, ...opts })
    return { url: "qqbot-media://img-1", image_id: "img-1", ttl: 100 }
  }
  const data = { self_id: "10001", bot }
  const image = await adapter.makeMarkdownImage(data, png, "图片")
  assert("Markdown 使用 qqbot-media", image.url.includes("qqbot-media://"), image.url)
  assert(
    "素材上传参数正确",
    calls[0]?.fileName === "image.png" && calls[0]?.contentType === "image/png",
    JSON.stringify(calls[0]),
  )

  adapter.materials["10001"]?.clear()
  adapter.materialMd5["10001"]?.clear()
  bot.sdk.uploadMaterialImage = async () => {
    throw new Error("no permission")
  }
  const fallback = await adapter.makeMarkdownImage(data, png, "图片")
  assert("素材上传失败回退公网 URL", String(fallback.url).startsWith("(http"), fallback.url)
  // noCompress：跳过压缩
  const oldCompress = adapter.compressImage
  let compressed = 0
  adapter.compressImage = async (d, f) => {
    compressed++
    return f
  }
  await adapter.makeMarkdownImage(data, png, "图片", true)
  assert("noCompress 跳过压缩", compressed === 0, String(compressed))
  await adapter.makeMarkdownImage(data, png, "图片")
  assert("默认仍然压缩", compressed === 1, String(compressed))
  adapter.compressImage = oldCompress

  if (oldUpload) bot.sdk.uploadMaterialImage = oldUpload
  else delete bot.sdk.uploadMaterialImage
  Bot.uin.pop()
}

console.log("\n=== T. 素材图生命周期 ===")
{
  const id = "10001"
  const bot = Bot[id]
  Bot.uin.push(id)
  const deleted = []
  const oldDel = bot.sdk.deleteMaterialImage
  const oldGet = bot.sdk.getMaterialImages
  const oldUpload = bot.sdk.uploadMaterialImage
  bot.sdk.deleteMaterialImage = async imageId => deleted.push(imageId)
  bot.sdk.getMaterialImages = async () => [{ image_id: "old-platform" }]

  adapter.materials[id] = new Map()
  for (let i = 0; i < 25; i++)
    adapter.materials[id].set(`old-${i}`, {
      t: Date.now() - 120 * 1000,
      url: `u${i}`,
      md5: `m${i}`,
      uses: i,
    })
  await adapter.cleanupMaterials(id)
  assert(
    "清理 1 分钟前上传的素材（保留复用最高的 20 张）",
    deleted.length === 5 && deleted.includes("old-0") && !deleted.includes("old-24"),
    JSON.stringify(deleted),
  )
  adapter.materials[id].clear()
  deleted.length = 0

  for (let i = 0; i < 100; i++) adapter.materials[id].set(`local-${i}`, { t: Date.now() })
  await adapter.ensureMaterialCapacity(id)
  assert(
    "满 100 张立即清空",
    adapter.materials[id].size === 0 &&
      deleted.includes("old-platform") &&
      deleted.includes("local-0"),
    String(deleted.length),
  )

  deleted.length = 0
  let attempts = 0
  bot.sdk.uploadMaterialImage = async () => {
    attempts++
    if (attempts === 1) {
      const err = new Error("40035007 image limit")
      err.code = 40035007
      throw err
    }
    return { image_id: "new-img", url: "qqbot-media://new", ttl: 1 }
  }
  const image = await adapter.makeBotImage(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
  )
  assert(
    "数量上限清空后重试",
    attempts === 2 && image?.url === "qqbot-media://new",
    JSON.stringify({ attempts, image }),
  )
  assert("上传后记录素材", adapter.materials[id].get("new-img") != null)

  bot.sdk.deleteMaterialImage = oldDel
  bot.sdk.getMaterialImages = oldGet
  if (oldUpload) bot.sdk.uploadMaterialImage = oldUpload
  else delete bot.sdk.uploadMaterialImage
  Bot.uin.pop()
}

console.log("\n=== U. 素材复用缓存 ===")
{
  const id = "10001"
  const bot = Bot[id]
  Bot.uin.push(id)
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  )
  const oldUpload = bot.sdk.uploadMaterialImage
  const oldDel = bot.sdk.deleteMaterialImage
  adapter.materials[id] = new Map()
  adapter.materialMd5[id] = new Map()
  let uploads = 0
  bot.sdk.uploadMaterialImage = async () => {
    uploads++
    return { image_id: "imgA", url: "qqbot-media://a", ttl: 100 }
  }
  const a = await adapter.makeBotImage(png)
  const b = await adapter.makeBotImage(png)
  assert("相同图片复用素材", uploads === 1 && a.url === b.url, JSON.stringify({ uploads, a, b }))
  assert(
    "复用次数累加",
    adapter.materials[id].get("imgA").uses === 2,
    String(adapter.materials[id].get("imgA")?.uses),
  )

  adapter.materials[id] = new Map()
  adapter.materialMd5[id] = new Map()
  for (let i = 0; i < 25; i++)
    adapter.materials[id].set(`img${i}`, {
      t: Date.now() - 120 * 1000,
      url: `u${i}`,
      md5: `m${i}`,
      uses: i,
    })
  const deleted = []
  bot.sdk.deleteMaterialImage = async imageId => deleted.push(imageId)
  await adapter.cleanupMaterials(id)
  assert(
    "复用最高的 20 张保留",
    deleted.length === 5 && !deleted.includes("img24") && deleted.includes("img0"),
    JSON.stringify(deleted),
  )

  bot.sdk.deleteMaterialImage = oldDel
  if (oldUpload) bot.sdk.uploadMaterialImage = oldUpload
  else delete bot.sdk.uploadMaterialImage
  Bot.uin.pop()
}

console.log("\n=== V. 素材记录持久化/按天按周清理 ===")
{
  const id = "10001"
  const bot = Bot[id]
  Bot.uin.push(id)
  const oldDel = bot.sdk.deleteMaterialImage
  const deleted = []
  bot.sdk.deleteMaterialImage = async imageId => deleted.push(imageId)

  adapter.materials[id] = new Map([
    ["pimg", { t: Date.now(), url: "qqbot-media://p", md5: "pmd5", uses: 3, expire: Date.now() + 100000 }],
    ["cold", { t: Date.now(), url: "qqbot-media://c", md5: "cmd5", uses: 1, expire: Date.now() + 100000 }],
  ])
  adapter.materialMd5[id] = new Map([
    ["pmd5", "pimg"],
    ["cmd5", "cold"],
  ])
  adapter.materialMeta[id] = { lastDaily: Date.now(), lastWeekly: Date.now() }
  await adapter.saveMaterialFile(id)
  adapter.materials[id] = new Map()
  adapter.materialMd5[id] = new Map()
  adapter.materialMeta[id] = {}
  await adapter.loadMaterialFile(id)
  assert(
    "素材记录持久化",
    adapter.materialMd5[id].get("pmd5") === "pimg" &&
      adapter.materials[id].get("pimg")?.uses === 3,
    JSON.stringify([...adapter.materialMd5[id]]),
  )

  adapter.materialMeta[id] = {
    lastDaily: Date.now() - 25 * 60 * 60 * 1000,
    lastWeekly: Date.now(),
  }
  deleted.length = 0
  await adapter.checkMaterialRecords(id)
  assert(
    "每天清理复用次数=1",
    !adapter.materials[id].has("cold") &&
      adapter.materials[id].has("pimg") &&
      deleted.includes("cold"),
    JSON.stringify(deleted),
  )

  adapter.materials[id] = new Map()
  adapter.materialMd5[id] = new Map()
  for (let i = 0; i < 25; i++)
    adapter.materials[id].set(`w${i}`, {
      t: Date.now(),
      url: `u${i}`,
      md5: `m${i}`,
      uses: i + 2,
    })
  adapter.materialMeta[id] = {
    lastDaily: Date.now(),
    lastWeekly: Date.now() - 8 * 24 * 60 * 60 * 1000,
  }
  deleted.length = 0
  await adapter.checkMaterialRecords(id)
  assert(
    "每周只保留前 20 张",
    adapter.materials[id].size === 20 &&
      deleted.length === 5 &&
      !deleted.includes("w24"),
    JSON.stringify({ size: adapter.materials[id].size, deleted }),
  )

  bot.sdk.deleteMaterialImage = oldDel
  Bot.uin.pop()
}

console.log("\n=== W. 连接时按时间戳清理 ===")
{
  const id = "10001"
  const bot = Bot[id]
  const deleted = []
  const oldDel = bot.sdk.deleteMaterialImage
  bot.sdk.deleteMaterialImage = async imageId => deleted.push(imageId)

  clearInterval(adapter.materialTimer[id])
  delete adapter.materialTimer[id]
  adapter.materials[id] = new Map([
    ["stale", { t: Date.now(), url: "u", md5: "m", uses: 1, expire: Date.now() + 100000 }],
  ])
  adapter.materialMd5[id] = new Map([["m", "stale"]])
  adapter.materialMeta[id] = {
    lastDaily: Date.now() - 25 * 60 * 60 * 1000,
    lastWeekly: Date.now(),
  }
  adapter.materialReady[id] = false
  await adapter.saveMaterialFile(id)

  adapter.materials[id] = new Map()
  adapter.materialMd5[id] = new Map()
  await adapter.initMaterialManager(id)
  const saved = JSON.parse(await fs.readFile(adapter.materialFilePath(id), "utf8"))
  assert(
    "连接时按时间戳清理并保存",
    deleted.includes("stale") && saved.lastDaily > Date.now() - 60 * 1000,
    JSON.stringify({ deleted, lastDaily: saved.lastDaily }),
  )

  bot.sdk.deleteMaterialImage = oldDel
}

console.log("\n=== X. 素材绑定发送机器人 ===")
{
  const oldUin = [...Bot.uin]
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  )
  const calls = []
  const oldUpload = Bot["10001"].sdk.uploadMaterialImage
  Bot["10001"].sdk.uploadMaterialImage = async () => {
    calls.push("10001")
    return { image_id: "a", url: "qqbot-media://a", ttl: 1 }
  }
  Bot["10002"] = {
    id: "10002",
    sdk: {
      uploadMaterialImage: async () => {
        calls.push("10002")
        return { image_id: "b", url: "qqbot-media://b", ttl: 1 }
      },
      deleteMaterialImage: async () => {},
    },
  }
  Bot.uin.push("10001", "10002")
  adapter.materials["10002"] = new Map()
  adapter.materialMd5["10002"] = new Map()
  const image = await adapter.makeBotImage(png, { self_id: "10002" })
  assert(
    "素材上传使用发送机器人",
    calls.length === 1 && calls[0] === "10002" && image.url === "qqbot-media://b",
    JSON.stringify(calls),
  )
  if (oldUpload) Bot["10001"].sdk.uploadMaterialImage = oldUpload
  else delete Bot["10001"].sdk.uploadMaterialImage
  delete Bot["10002"]
  Bot.uin.length = 0
  Bot.uin.push(...oldUin)
}

console.log("\n=== I. 冲突保护 / 退出 ===")
{
  const conflict = { id: "QQBot", name: "QQBot" }
  Bot.adapter.push(conflict)
  const mark = logs.length
  await adapter.load()
  assert("检测到旧插件时跳过连接", logs.slice(mark).some(l => /已加载其他 QQBot 适配器/.test(l.text)))
  Bot.adapter.pop()

  await Bot["10001"].logout()
  assert("logout 移除监视", !adapter.watcher["10001"])
  assert("logout 停止 token 刷新", !adapter.token["10001"])
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.chdir(originalCwd)
await fs.rm(testWorkDir, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
