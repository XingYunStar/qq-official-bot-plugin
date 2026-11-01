logger.info(logger.yellow("- 正在加载 QQBot 适配器插件（qq-official-bot 版）"))

import makeConfig from "../../lib/plugins/config.js"
import cfg from "../../lib/config/config.js"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import QRCode from "qrcode"
import { ulid } from "ulid"
import imageSize from "image-size"
import urlRegexSafe from "url-regex-safe"
import { encode as encodeSilk, isSilk } from "silk-wasm"
import QQBot from "qq-official-bot"
import QQBotEd25519Module from "qq-official-bot/lib/ed25519.js"

const { Bot: QQBotSDK, ReceiverMode, Message: QQBotMessage } = QQBot

/**
 * qq-official-bot 的 MessageBuilder 处理 reply 元素时，会把 msg_id 和
 * message_reference.message_id 都设成同一个值；但群聊接口里：
 *   msg_id                     = 本条（触发）消息 ID，用于被动回复
 *   message_reference.message_id = 被引用消息的引用索引（msg_idx / ref_idx）
 * 这里修正：保留 source.id 提供的 msg_id，reply 元素只负责 message_reference
 */
const QQBotMessageBuilder = QQBot.MessageBuilder
if (QQBotMessageBuilder && !QQBotMessageBuilder.prototype.__qqbotReplyPatched) {
  QQBotMessageBuilder.prototype.__qqbotReplyPatched = true
  const rawHandleReply = QQBotMessageBuilder.prototype.handleReply
  QQBotMessageBuilder.prototype.handleReply = function (elem) {
    rawHandleReply.call(this, elem)
    if (this.source?.id) this.messagePayload.msg_id = this.source.id
  }
}
const { Ed25519: QQBotEd25519 } = QQBotEd25519Module

/**
 * 兼容旧版行为：内容里出现 <@!id> 但 mentions 缺失时，
 * 原实现在 payload.mentions.find 处会抛错，这里统一兜底为空数组。
 * 另外群内全量消息的 content 使用 <@openid> / <@all>，SDK 只认 <@!id> / <@everyone>，
 * 这里先归一化，否则 @ 会退化成纯文本
 */
QQBotMessage.parse = (parse =>
  function (payload = {}) {
    if (!Array.isArray(payload.mentions)) payload.mentions = []
    if (typeof payload.content === "string")
      payload.content = payload.content
        .replace(/<@!?all>/g, "<@everyone>")
        .replace(/<@(?!\!|everyone)([^>]+)>/g, "<@!$1>")
    return parse.call(this, payload)
  })(QQBotMessage.parse)

/** 群被动回复：同一条消息最多回复 5 次，超过 110 秒就不能再作为被动回复 */
const MSG_PASSIVE_TTL = 110 * 1000
const MSG_PASSIVE_LIMIT = 5
const MSG_POOL_MAX = 100

/** 引用索引持久化：收到的消息 24 小时，机器人自己发的消息 7 天 */
const REF_TTL_RECV = 24 * 60 * 60 * 1000
const REF_TTL_SENT = 7 * 24 * 60 * 60 * 1000
const REF_CLEAN_INTERVAL = 10 * 60 * 1000
const REF_COMPACT_INTERVAL = 60 * 60 * 1000

/** 断线重连 / 心跳超时探测默认配置 */
const reconnectDefault = {
  /** 是否启用断线自动重连与心跳超时探测 */
  enable: true,
  /** 首次重连延时（毫秒） */
  interval: 5000,
  /** 重连延时上限（毫秒） */
  maxInterval: 300000,
  /** 快速重连次数上限，0 为不限（超出后按 maxInterval 低频重试） */
  maxRetry: 0,
  /** 无数据超时（毫秒），0 为自动（心跳间隔 × 3，最少 60 秒） */
  heartbeatTimeout: 0,
  /** 单次连接 / 重连等待就绪的超时（毫秒） */
  connectTimeout: 30000,
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 打印延时的可读文本 */
const msText = ms => (ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms)}ms`)

const { config, configSave } = await makeConfig(
  "QQBot",
  {
    tips: "",
    permission: "master",
    toQRCode: true,
    toCallback: true,
    toBotUpload: true,
    hideGuildRecall: false,
    imageLength: 3,
    autoInstallExample: true,
    exampleGuideSent: false,
    markdown: {
      template: "abcdefghij",
    },
    bot: {
      sandbox: false,
      maxRetry: Infinity,
      timeout: 30000,
    },
    reconnect: { ...reconnectDefault },
    token: [],
  },
  {
    tips: [
      "欢迎使用 TRSS-Yunzai QQBot Plugin ! 作者：时雨🌌星空",
      "参考：https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin",
    ],
  },
)

let sharp
if (config.imageLength)
  try {
    sharp = (await import("sharp")).default
  } catch (err) {
    Bot.makeLog("error", ["sharp 导入错误，图片压缩关闭", err], "QQBot-Plugin")
  }

const adapter = new (class QQBotAdapter {
  constructor() {
    this.id = "QQBot"
    this.name = "QQBot"
    this.path = "data/QQBot/"
    this.version = "qq-official-bot v1.3.3"

    // URL 处理方式：qrcode=转二维码（旧行为）、link=转 Markdown 链接、off=原样发送
    this.urlMode = "off"
    this.toQRCodeRegExp = false
    if (config.toQRCode === true) {
      this.urlMode = "qrcode"
      this.toQRCodeRegExp = urlRegexSafe()
    } else if (config.toQRCode === "link") {
      this.urlMode = "link"
      this.toQRCodeRegExp = urlRegexSafe()
    } else if (typeof config.toQRCode === "string" && config.toQRCode) {
      this.urlMode = "qrcode"
      this.toQRCodeRegExp = new RegExp(config.toQRCode, "g")
    } else if (config.toQRCode && typeof config.toQRCode === "object") {
      this.urlMode = "qrcode"
      this.toQRCodeRegExp = urlRegexSafe(config.toQRCode)
    }

    this.sep = ":"
    if (process.platform === "win32") this.sep = ""
    this.bind_user = {}
    this.appid = {}
    this.watcher = {}
    this.token = {}
    this.retryTask = {}
    this.msgSeen = new Map()
    this.msgCache = new Map()
    this.msgPool = new Map()
    this.refStore = {}
    this.refById = {}
    this.refFile = {}
    this.refWrite = {}
    this.refLastCompact = {}
    this.refTimer = {}
    this.sentMsgs = new Map()
  }

  /**
   * 群消息去重
   * 官方文档明确说明：相同 msg_id 可能被重复推送，需要去重
   */
  isDuplicateMessage(id, message_id, ttl = 30000) {
    if (!message_id) return false
    const key = `${id}:${message_id}`
    const now = Date.now()
    const last = this.msgSeen.get(key)
    this.msgSeen.set(key, now)
    if (this.msgSeen.size > 2000)
      for (const [k, t] of this.msgSeen) if (now - t > 60000) this.msgSeen.delete(k)
    return !!last && now - last < ttl
  }

  /**
   * 插件内部沿用旧版 qq-group-bot 的扁平消息元素结构，
   * 发送前统一转换为 qq-official-bot 的 { type, data } 结构
   */
  toSdkMessage(msg, ctx) {
    const list = Array.isArray(msg) ? msg : [msg]
    return list.map(el => {
      if (typeof el === "string") return el
      if (!el || typeof el !== "object") return { type: "text", data: { text: Bot.String(el) } }
      const { type, ...data } = el
      // 已经是 { type, data } 结构（例如 raw 直接传入）时保持原样
      if (data.data && typeof data.data === "object" && Object.keys(data).length === 1)
        return { type, data: data.data }
      switch (type) {
        case "reply": {
          let id = data.id
          if (ctx && this.isGroupChat(ctx)) id = this.toGroupReferenceId(id, ctx)
          return { type, data: { id, event_id: data.event_id } }
        }
        case "at":
          return { type, data: { ...data, user_id: data.user_id ?? data.qq } }
        default:
          return { type, data }
      }
    })
  }

  /** 群聊（非频道/频道私信） */
  isGroupChat(data) {
    return data?.message_type === "group" && !data.channel_id && !data.guild_id
  }

  /**
   * 群聊引用：message_reference.message_id 需要引用索引而不是真实消息 ID
   * - 引用本条消息：用本条消息的 msg_idx（message_scene.ext）
   * - 引用机器人自己发的消息：用发送响应里的 ext_info.ref_idx
   * - 引用收到过的消息：用它的 msg_idx
   */
  toGroupReferenceId(message_id, data) {
    if (!message_id) return message_id
    const id = String(message_id)
    if (id.startsWith("REFIDX")) return id
    if (data?.message_id && id === String(data.message_id)) {
      const scene = this.parseMessageScene(data.raw)
      if (scene.msg_idx) return scene.msg_idx
    }
    const known = this.refOf(data?.self_id, id)
    if (known) return known
    if (data?.self_id)
      Bot.makeLog(
        "warn",
        ["群引用：本条消息没有 msg_idx（message_scene.ext 缺失），引用可能不显示", id],
        data.self_id,
      )
    return id
  }

  /** 将 qq-official-bot 收到的消息元素还原成旧版扁平结构，供现有逻辑继续使用 */
  fromSdkMessage(message) {
    return (Array.isArray(message) ? message : message ? [message] : []).map(el => {
      if (typeof el === "string") return { type: "text", text: el }
      if (!el?.data || typeof el.data !== "object") return el
      if (el.type === "reply") return { type: "reply", id: el.data.id, event_id: el.data.event_id }
      return { type: el.type, ...el.data }
    })
  }

  async makeRecord(file) {
    if (config.toBotUpload)
      for (const i of Bot.uin) {
        if (!Bot[i].uploadRecord) continue
        try {
          const url = await Bot[i].uploadRecord(file)
          if (url) return url
        } catch (err) {
          Bot.makeLog("error", ["Bot", i, "语音上传错误", file, err])
        }
      }
    const buffer = await Bot.Buffer(file)
    if (!Buffer.isBuffer(buffer)) return file
    if (isSilk(buffer)) return buffer

    const convFile = path.join("temp", ulid())
    try {
      await fs.writeFile(convFile, buffer)
      await Bot.exec(`ffmpeg -i "${convFile}" -f s16le -ar 48000 -ac 1 "${convFile}.pcm"`)
      file = Buffer.from((await encodeSilk(await fs.readFile(`${convFile}.pcm`), 48000)).data)
    } catch (err) {
      Bot.makeLog("error", ["silk 转码错误", file, err])
    }
    ;[convFile, `${convFile}.pcm`].map(i => Bot.rm(i))

    return file
  }

  async makeQRCode(data) {
    return (await QRCode.toDataURL(data)).replace("data:image/png;base64,", "base64://")
  }

  /** 把 URL 转成 Markdown 链接：[host](url) */
  makeMarkdownLink(url) {
    try {
      const u = new URL(url)
      const label = `${u.hostname}${u.pathname && u.pathname !== "/" ? u.pathname : ""}`.replace(
        /[()]/g,
        "",
      )
      return `[${label}](${url})`
    } catch (err) {
      return url
    }
  }

  async makeRawMarkdownText(data, text, button) {
    const match = this.toQRCodeRegExp ? text.match(this.toQRCodeRegExp) : null
    if (match)
      for (const url of match) {
        // 链接模式：直接发 Markdown 链接（跳过已经在 [](...) 里的 URL）
        if (this.urlMode === "link") {
          const index = text.indexOf(url)
          if (index > 1 && text.slice(index - 2, index) === "](") continue
          text = text.replace(url, this.makeMarkdownLink(url))
          continue
        }
        // 二维码模式（旧行为）
        if (button) button.push(...this.makeButtons(data, [[{ text: url, link: url }]]))
        const img = await this.makeMarkdownImage(data, await this.makeQRCode(url), "二维码")
        text = text.replace(url, `${img.des}${img.url}`)
      }
    return text.replace(/@/g, "@​").replace(/<qqbot-/g, "<qqbot-​")
  }

  async makeBotImage(file) {
    if (!config.toBotUpload) return
    const buffer = Buffer.isBuffer(file) ? file : await Bot.Buffer(file).catch(() => null)
    // 官方素材管理：上传后拿到 qqbot-media:// 引用，可直接写进 Markdown，不需要公网 URL
    if (Buffer.isBuffer(buffer))
      for (const i of Bot.uin) {
        if (!Bot[i]?.sdk?.uploadMaterialImage) continue
        try {
          const meta = this.getImageMeta(buffer)
          const image = await Bot[i].sdk.uploadMaterialImage(buffer, {
            fileName: meta.fileName,
            contentType: meta.contentType,
          })
          if (image?.url) return image
        } catch (err) {
          Bot.makeLog("error", ["Markdown 图片素材上传失败", err], i)
        }
      }
    // 兼容其他上传接口
    for (const i of Bot.uin) {
      if (!Bot[i].uploadImage) continue
      try {
        const image = await Bot[i].uploadImage(buffer || file)
        if (image.url) return image
      } catch (err) {
        Bot.makeLog("error", ["Bot", i, "图片上传错误", file, err])
      }
    }
  }

  /** 根据文件头判断图片格式（素材上传要求扩展名与 contentType 一致） */
  getImageMeta(buffer) {
    if (
      buffer.length > 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    )
      return { fileName: "image.png", contentType: "image/png" }
    if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
      return { fileName: "image.jpg", contentType: "image/jpeg" }
    if (buffer.slice(0, 3).toString("latin1") === "GIF")
      return { fileName: "image.gif", contentType: "image/gif" }
    if (
      buffer.length > 12 &&
      buffer.slice(0, 4).toString("latin1") === "RIFF" &&
      buffer.slice(8, 12).toString("latin1") === "WEBP"
    )
      return { fileName: "image.webp", contentType: "image/webp" }
    return { fileName: "image.png", contentType: "image/png" }
  }

  async makeMarkdownImage(data, file, summary = "图片") {
    if (sharp) file = await this.compressImage(data, file)
    const buffer = await Bot.Buffer(file)
    const image = (await this.makeBotImage(buffer)) || { url: await Bot.fileToUrl(file) }

    if (!image.width || !image.height)
      try {
        const size = imageSize(buffer)
        image.width = size.width
        image.height = size.height
      } catch (err) {
        Bot.makeLog("error", ["图片分辨率检测错误", file, err], data.self_id)
      }

    return {
      des: `![${summary} #${image.width || 0}px #${image.height || 0}px]`,
      url: `(${image.url})`,
    }
  }

  makeButton(data, button, style) {
    const msg = {
      id: ulid(),
      render_data: {
        label: button.text,
        visited_label: button.clicked_text,
        style,
        ...button.QQBot?.render_data,
      },
    }

    if (button.input)
      msg.action = {
        type: 2,
        permission: { type: 2 },
        data: button.input,
        enter: button.send,
        ...button.QQBot?.action,
      }
    else if (button.callback) {
      if (config.toCallback) {
        msg.action = {
          type: 1,
          permission: { type: 2 },
          ...button.QQBot?.action,
        }
        if (!Array.isArray(data._ret_id)) data._ret_id = []
        data.bot.callback[msg.id] = {
          id: data.message_id,
          user_id: data.user_id,
          group_id: data.group_id,
          message: button.callback,
          message_id: data._ret_id,
        }
        setTimeout(() => delete data.bot.callback[msg.id], 300000)
      } else {
        msg.action = {
          type: 2,
          permission: { type: 2 },
          data: button.callback,
          enter: true,
          ...button.QQBot?.action,
        }
      }
    } else if (button.link)
      msg.action = {
        type: 0,
        permission: { type: 2 },
        data: button.link,
        ...button.QQBot?.action,
      }
    else return false

    if (button.permission) {
      if (button.permission === "admin") {
        msg.action.permission.type = 1
      } else {
        msg.action.permission.type = 0
        msg.action.permission.specify_user_ids = []
        if (!Array.isArray(button.permission)) button.permission = [button.permission]
        for (const id of button.permission)
          msg.action.permission.specify_user_ids.push(id.replace(`${data.self_id}${this.sep}`, ""))
      }
    }
    return msg
  }

  makeButtons(data, button_square) {
    const msgs = [],
      random = Math.floor(Math.random() * 2)
    for (const button_row of button_square) {
      let column = 0
      const buttons = []
      for (let button of button_row) {
        button = this.makeButton(data, button, (random + msgs.length + buttons.length) % 2)
        if (button) buttons.push(button)
      }
      if (buttons.length) msgs.push({ type: "button", buttons })
    }
    return msgs
  }

  makeTextChain(data, button) {
    let msg

    if (button.input) msg = `text="${button.input}"`
    else if (button.callback) msg = `text="${button.callback}"`
    else if (button.link) msg = `text="${button.link}"`
    else return false

    if (button.text) msg += ` show="[${button.text}]"`
    return `<qqbot-cmd-input ${msg} />`
  }

  makeTextChains(data, button_square) {
    const msgs = []
    for (const button_row of button_square) {
      const buttons = []
      for (let button of button_row) {
        button = this.makeTextChain(data, button)
        if (button) buttons.push(button)
      }
      if (buttons.length) msgs.push(buttons.join(" "))
    }
    if (msgs.length) msgs.unshift("")
    return msgs.join("\n")
  }

  async makeRawMarkdownMsg(data, msg, keyboard, source) {
    const messages = [],
      button = []
    let content = "",
      reply

    for (let i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i === "object") i = { ...i }
      else i = { type: "text", text: Bot.String(i) }

      switch (i.type) {
        case "record":
          i.type = "audio"
          i.file = await this.makeRecord(i.file)
        case "video":
        case "face":
        case "ark":
        case "embed":
          messages.push([i])
          break
        case "file":
          if (i.file) i.file = await Bot.fileToUrl(i.file, i)
          content += await this.makeRawMarkdownText(data, `文件：${i.file}`, keyboard && button)
          break
        case "at":
          if (i.qq === "all") content += "<qqbot-at-everyone />"
          else
            content += `<qqbot-at-user id="${i.qq?.replace?.(`${data.self_id}${this.sep}`, "")}" />`
          break
        case "text":
          content += await this.makeRawMarkdownText(data, i.text, keyboard && button)
          break
        case "image": {
          const { des, url } = await this.makeMarkdownImage(data, i.file, i.summary)
          content += `${des}${url}`
          break
        }
        case "markdown":
          if (typeof i.data === "object") messages.push([{ type: "markdown", ...i.data }])
          else content += i.data
          break
        case "button":
          if (keyboard) button.push(...this.makeButtons(data, i.data))
          else content += this.makeTextChains(data, i.data)
          break
        case "reply":
          reply = i
          continue
        case "node":
          for (const { message } of i.data)
            messages.push(...(await this.makeRawMarkdownMsg(data, message, keyboard)))
          continue
        case "raw":
          messages.push(Array.isArray(i.data) ? i.data : [i.data])
          break
        default:
          content += await this.makeRawMarkdownText(data, Bot.String(i), keyboard && button)
      }
    }

    if (content) messages.unshift([{ type: "markdown", content }])

    if (button.length) {
      for (const i of messages) {
        if (i[0].type === "markdown") i.push(...button.splice(0, 5))
        if (!button.length) break
      }
      while (button.length)
        messages.push([{ type: "markdown", content: " " }, ...button.splice(0, 5)])
    }

    if (source) {
      const explicit = reply // 用户显式引用（否则只是被动回复，不显示引用气泡）
      if (!reply && Date.now() / 1000 - data.time < 300) reply = segment.reply(data.message_id)
      if (reply) {
        if (reply.id.startsWith("event_")) {
          reply = { type: "reply", event_id: reply.id.replace(/^event_/, "") }
          for (const i in messages) {
            if (Array.isArray(messages[i])) messages[i].unshift(reply)
            else messages[i] = [reply, messages[i]]
          }
        } else if (explicit && this.isGroupChat(data)) {
          // 群聊引用：保留 reply 元素，发送时转成 message_reference.message_id（msg_idx）
          for (const i of messages) i.unshift({ type: "reply", id: reply.id })
        } else if (!source.id) {
          source.id = reply.id
        }
      }
    }
    return messages
  }

  makeMarkdownText_(data, text) {
    const match = this.toQRCodeRegExp ? text.match(this.toQRCodeRegExp) : null
    if (match)
      for (const url of match)
        text = text.replace(
          url,
          this.urlMode === "link"
            ? this.makeMarkdownLink(url)
            : this.makeTextChain(data, { text: "链接", link: url }),
        )
    return text
      .replace(/\n/g, "\r")
      .replace(/@/g, "@​")
      .replace(/<qqbot-/g, "<qqbot-​")
  }

  makeMarkdownText(data, text, content) {
    const match = text.match(/!?\[.*?\]\s*\(\w+:\/\/.*?\)/g)
    if (match) {
      const temp = []
      let last = ""
      for (const i of match) {
        const match = i.match(/(!?\[.*?\])\s*(\(\w+:\/\/.*?\))/)
        text = text.split(i)
        temp.push([last + this.makeMarkdownText_(data, text.shift()), match[1]])
        text = text.join(i)
        last = match[2]
      }
      temp[0][0] = content + temp[0][0]
      return [last + this.makeMarkdownText_(data, text), temp]
    }
    return [this.makeMarkdownText_(data, text)]
  }

  makeMarkdownTemplate(data, templates) {
    const msgs = []
    for (const template of templates) {
      if (!template.length) continue

      const params = []
      for (const i in template)
        params.push({
          key: config.markdown.template[i],
          values: [template[i]],
        })

      msgs.push([
        {
          type: "markdown",
          custom_template_id: config.markdown[data.self_id],
          params,
        },
      ])
    }
    return msgs
  }

  makeMarkdownTemplatePush(content, template, templates) {
    for (const i of content) {
      if (template.length === config.markdown.template.length - 1) {
        template.push(i.shift())
        template = i
        templates.push(template)
      } else {
        template.push(i.join(""))
      }
    }
    return template
  }

  async makeMarkdownMsg(data, msg, source) {
    const messages = [],
      templates = [[]]
    let content = "",
      reply,
      template = templates[0]

    for (let i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i === "object") i = { ...i }
      else i = { type: "text", text: Bot.String(i) }

      switch (i.type) {
        case "record":
          i.type = "audio"
          i.file = await this.makeRecord(i.file)
        case "video":
        case "face":
        case "ark":
        case "embed":
          messages.push([i])
          break
        case "file":
          if (i.file) i.file = await Bot.fileToUrl(i.file, i)
          content += this.makeTextChain(data, { text: `文件：${i.name || i.file}`, link: i.file })
          break
        case "at":
          if (i.qq === "all") content += "<qqbot-at-everyone />"
          else
            content += `<qqbot-at-user id="${i.qq?.replace?.(`${data.self_id}${this.sep}`, "")}" />`
          break
        case "text": {
          const [text, temp] = this.makeMarkdownText(data, i.text, content)
          if (Array.isArray(temp)) {
            template = this.makeMarkdownTemplatePush(temp, template, templates)
            content = text
          } else {
            content += text
          }
          break
        }
        case "image": {
          const { des, url } = await this.makeMarkdownImage(data, i.file, i.summary)
          template = this.makeMarkdownTemplatePush([[content, des]], template, templates)
          content = url
          break
        }
        case "markdown":
          if (typeof i.data === "object") messages.push([{ type: "markdown", ...i.data }])
          else content += i.data
          break
        case "button":
          content += this.makeTextChains(data, i.data)
          break
        case "reply":
          reply = i
          continue
        case "node":
          for (const { message } of i.data)
            messages.push(...(await this.makeMarkdownMsg(data, message)))
          continue
        case "raw":
          messages.push(Array.isArray(i.data) ? i.data : [i.data])
          break
        default: {
          const [text, temp] = this.makeMarkdownText(data, Bot.String(i), content)
          if (Array.isArray(temp)) {
            template = this.makeMarkdownTemplatePush(temp, template, templates)
            content = text
          } else {
            content += text
          }
        }
      }
    }

    if (content) template.push(content)
    messages.push(...this.makeMarkdownTemplate(data, templates))

    if (source) {
      const explicit = reply
      if (!reply && Date.now() / 1000 - data.time < 300) reply = segment.reply(data.message_id)
      if (reply) {
        if (reply.id.startsWith("event_"))
          for (const i of messages)
            i.unshift({ type: "reply", event_id: reply.id.replace(/^event_/, "") })
        else if (explicit && this.isGroupChat(data))
          for (const i of messages) i.unshift({ type: "reply", id: reply.id })
        else if (!source.id) source.id = reply.id
      }
    }
    return messages
  }

  async compressImage(data, file) {
    try {
      const size = config.imageLength * 1024 * 1024
      const buffer = await Bot.Buffer(file, { http: true })

      if (!Buffer.isBuffer(buffer)) return file

      if (buffer.length <= size) return buffer

      let quality = 105,
        output
      do {
        quality -= 10
        output = await sharp(buffer).jpeg({ quality }).toBuffer()
        Bot.makeLog(
          "debug",
          `图片压缩完成 ${quality}%(${(output.length / 1024).toFixed(2)}KB)`,
          data.self_id,
        )
      } while (output.length > size && quality > 10)

      return output
    } catch (err) {
      Bot.makeLog("error", ["图片压缩错误", err], data.self_id)
      return file
    }
  }

  async makeMsg(data, msg, source) {
    const messages = [],
      button = []
    let message = [],
      reply

    for (let i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i === "object") i = { ...i }
      else i = { type: "text", text: Bot.String(i) }

      switch (i.type) {
        case "at":
          //i.user_id = i.qq?.replace?.(`${data.self_id}${this.sep}`, "")
          continue
        case "text":
          if (!i.text || !i.text.trim()) continue
          break
        case "face":
        case "ark":
        case "embed":
          break
        case "record":
          i.type = "audio"
          i.file = await this.makeRecord(i.file)
        case "video":
        case "image":
          if (message.length) {
            messages.push(message)
            message = []
          }

          if (sharp && i.file) i.file = await this.compressImage(data, i.file)
          break
        case "file":
          if (i.file) i.file = await Bot.fileToUrl(i.file, i)
          i = { type: "text", text: `文件：${i.file}` }
          break
        case "reply":
          reply = i
          continue
        case "markdown":
          if (typeof i.data === "object") i = { type: "markdown", ...i.data }
          else i = { type: "markdown", content: i.data }
          break
        case "button":
          //button.push(...this.makeButtons(data, i.data))
          continue
        case "node":
          for (const { message } of i.data) messages.push(...(await this.makeMsg(data, message)))
          continue
        case "raw":
          if (Array.isArray(i.data)) {
            messages.push(i.data)
            continue
          }
          i = i.data
          break
        default:
          i = { type: "text", text: Bot.String(i) }
      }

      if (i.type === "text" && i.text && this.urlMode === "qrcode" && this.toQRCodeRegExp) {
        const match = i.text.match(this.toQRCodeRegExp)
        if (match)
          for (const url of match) {
            const msg = segment.image(await this.makeQRCode(url))
            if (message.length) {
              messages.push(message)
              message = []
            }
            message.push(msg)
            i.text = i.text.replace(url, "[链接(请扫码查看)]")
          }
      }

      message.push(i)
    }

    if (message.length) messages.push(message)

    while (button.length)
      messages.push([
        {
          type: "keyboard",
          content: { rows: button.splice(0, 5) },
        },
      ])

    if (source) {
      if (reply)
        for (const i of messages)
          i.unshift(
            reply.id.startsWith("event_")
              ? { type: "reply", event_id: reply.id.replace(/^event_/, "") }
              : reply,
          )
      else if (!source.id && Date.now() / 1000 - data.time < 300)
        source.id = data.message_id
    }
    return messages
  }

  async sendMsg(data, send, msg) {
    const rets = { message_id: [], data: [], error: [] },
      source = {}
    // 群聊被动回复：用 110 秒内最旧的消息 ID（每条最多回复 5 次），没有则走主动
    const passiveId = this.pickMsgId(data)
    if (passiveId) source.id = passiveId
    else if (
      !this.isGroupChat(data) &&
      data.message_id &&
      !String(data.message_id).startsWith("event_")
    )
      source.id = String(data.message_id)
    let msgs

    const sendMsg = async () => {
      for (const i of msgs)
        try {
          Bot.makeLog("debug", ["发送消息", i], data.self_id)
          const ret = await send(i, source)
          Bot.makeLog("debug", ["发送消息返回", ret], data.self_id)

          rets.data.push(ret)
          if (ret.id) {
            rets.message_id.push(ret.id)
            // 记录机器人自己发出的消息，供 isOwnMessage 判断能否撤回
            this.sentMsgs.set(ret.id, Date.now() + 2 * 60 * 60 * 1000)
            if (this.sentMsgs.size > 500)
              for (const [k, v] of this.sentMsgs) if (v < Date.now()) this.sentMsgs.delete(k)
          }
        } catch (err) {
          Bot.makeLog("error", ["发送消息错误", i, err], data.self_id)
          rets.error.push(err)
          return false
        }
    }

    if (!config.markdown[data.self_id] || config.markdown[data.self_id] === "raw")
      msgs = await this.makeRawMarkdownMsg(data, msg, true, source)
    else if (config.markdown[data.self_id] === "legacy")
      msgs = await this.makeMsg(data, msg, source)
    else if (config.markdown[data.self_id] === "inline")
      msgs = await this.makeRawMarkdownMsg(data, msg, false, source)
    else msgs = await this.makeMarkdownMsg(data, msg, source)

    if ((await sendMsg()) === false) {
      msgs = await this.makeMsg(data, msg, source)
      await sendMsg()
    }

    if (Array.isArray(data._ret_id)) data._ret_id.push(...rets.message_id)
    return rets
  }

  sendFriendMsg(data, msg) {
    return this.sendMsg(
      data,
      (msg, source) =>
        data.bot.sdk.sendPrivateMessage(data.user_id, this.toSdkMessage(msg, data), source),
      msg,
    )
  }

  sendGroupMsg(data, msg) {
    return this.sendMsg(
      data,
      (msg, source) =>
        data.bot.sdk.sendGroupMessage(data.group_id, this.toSdkMessage(msg, data), source),
      msg,
    )
  }

  async makeGuildMsg(data, msg, nested) {
    const messages = []
    let message = [],
      reply
    for (let i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i === "object") i = { ...i }
      else i = { type: "text", text: Bot.String(i) }

      switch (i.type) {
        case "at":
          i.user_id = i.qq?.replace?.(/^qg_/, "")
        case "text":
        case "face":
        case "ark":
        case "embed":
          break
        case "image":
          if (sharp && i.file) i.file = await this.compressImage(data, i.file)
          // legacy（普通消息）模式：保留本地数据，发送时走 multipart 上传，不需要公网地址
          // 其它模式：频道图片只认公网 URL，先用 TRSS 转存
          if (config.markdown[data.self_id] !== "legacy" && !this.isHttpUrl(i.file))
            try {
              i.file = String(await Bot.fileToUrl(i.file))
            } catch (err) {
              Bot.makeLog("error", ["频道图片转存公网地址失败", err], data.self_id)
            }

          message.push(i)
          messages.push(message)
          message = []
          continue
        case "record":
        case "video":
        case "file":
          if (i.file) i.file = await Bot.fileToUrl(i.file, i)
          i = { type: "text", text: `文件：${i.file}` }
          break
        case "reply":
          reply = i
          continue
        case "markdown":
          if (typeof i.data === "object") i = { type: "markdown", ...i.data }
          else i = { type: "markdown", content: i.data }
          break
        case "button":
          continue
        case "node":
          for (const { message } of i.data)
            messages.push(...(await this.makeGuildMsg(data, message, true)))
          continue
        case "raw":
          if (Array.isArray(i.data)) {
            messages.push(i.data)
            continue
          }
          i = i.data
          break
        default:
          i = { type: "text", text: Bot.String(i) }
      }

      if (i.type === "text" && i.text && this.urlMode === "qrcode" && this.toQRCodeRegExp) {
        const match = i.text.match(this.toQRCodeRegExp)
        if (match)
          for (const url of match) {
            const msg = segment.image(await this.makeQRCode(url))
            message.push(msg)
            messages.push(message)
            message = []
            i.text = i.text.replace(url, "[链接(请扫码查看)]")
          }
      }

      message.push(i)
    }

    if (message.length) messages.push(message)
    if (!reply && !nested && Date.now() / 1000 - data.time < 300)
      reply = segment.reply(data.message_id)
    if (reply)
      for (const i of messages)
        i.unshift(
          reply.id.startsWith("event_")
            ? { type: "reply", event_id: reply.id.replace(/^event_/, "") }
            : reply,
        )
    return messages
  }

  async sendGMsg(data, send, msg) {
    const rets = { message_id: [], data: [], error: [] }
    let msgs

    const sendMsg = async () => {
      for (const i of msgs)
        try {
          Bot.makeLog("debug", ["发送消息", i], data.self_id)
          const ret = await send(i)
          Bot.makeLog("debug", ["发送消息返回", ret], data.self_id)

          rets.data.push(ret)
          if (ret.id) {
            rets.message_id.push(ret.id)
            // 记录机器人自己发出的消息，供 isOwnMessage 判断能否撤回
            this.sentMsgs.set(ret.id, Date.now() + 2 * 60 * 60 * 1000)
            if (this.sentMsgs.size > 500)
              for (const [k, v] of this.sentMsgs) if (v < Date.now()) this.sentMsgs.delete(k)
          }
        } catch (err) {
          Bot.makeLog("error", ["发送消息错误", i, err], data.self_id)
          rets.error.push(err)
          return false
        }
    }

    msgs = await this.makeGuildMsg(data, msg)
    if ((await sendMsg()) === false) {
      msgs = await this.makeGuildMsg(data, msg)
      await sendMsg()
    }
    return rets
  }

  async sendDirectMsg(data, msg) {
    if (!data.guild_id) {
      if (!data.src_guild_id) {
        Bot.makeLog(
          "error",
          [`发送频道私聊消息失败：[${data.user_id}] 不存在来源频道信息`, msg],
          data.self_id,
        )
        return false
      }
      const dms = await data.bot.sdk.createDirectSession(data.src_guild_id, data.user_id)
      data.guild_id = dms.guild_id
      data.channel_id = dms.channel_id
      data.bot.fl.set(`qg_${data.user_id}`, {
        ...data.bot.fl.get(`qg_${data.user_id}`),
        ...dms,
      })
    }
    return this.sendGMsg(data, msg => this.sendGuildElements(data, msg, "direct"), msg)
  }

  sendGuildMsg(data, msg) {
    return this.sendGMsg(data, msg => this.sendGuildElements(data, msg, "guild"), msg)
  }

  isHttpUrl(value) {
    return typeof value === "string" && /^https?:\/\//i.test(value)
  }

  /** 元素里是否有需要上传的本地图片 */
  hasLocalImage(elements) {
    return elements.some(
      el => el.type === "image" && el.data?.file != null && !this.isHttpUrl(el.data.file),
    )
  }

  /** 把 base64 / dataURI / 本地路径 / Buffer 统一读成 Buffer */
  async imageToBuffer(file) {
    if (Buffer.isBuffer(file)) return file
    if (!file || typeof file !== "string") return null
    if (file.startsWith("base64://")) return Buffer.from(file.slice(9), "base64")
    if (/^data:[^;]+;base64,/.test(file))
      return Buffer.from(file.replace(/^data:[^;]+;base64,/, ""), "base64")
    return fs.readFile(file.replace(/^file:\/\//, ""))
  }

  /**
   * 频道/频道私信 legacy 模式发送本地图片：
   * 官方接口支持 multipart/form-data 的 file_image 文件流，
   * 这样可以绕开「必须公网 URL」的限制。
   */
  async sendGuildMultipart(data, elements, endpoint) {
    const form = new FormData()
    let content = ""
    let file = null
    for (const el of elements) {
      switch (el.type) {
        case "text":
          content += el.data?.text ?? ""
          break
        case "at":
          content += el.data?.user_id === "all" ? "<@everyone>" : `<@!${el.data?.user_id}>`
          break
        case "image":
          file = await this.imageToBuffer(el.data?.file)
          break
        case "reply":
          if (el.data?.id) {
            form.append("msg_id", String(el.data.id))
            form.append("message_reference", JSON.stringify({ message_id: String(el.data.id) }))
          } else if (el.data?.event_id) form.append("event_id", String(el.data.event_id))
          break
        default:
          break
      }
    }
    if (content) form.append("content", content)
    if (!file) throw new Error("没有可上传的图片数据")
    form.append("file_image", new Blob([file]), "image.png")
    const res = await data.bot.sdk.request.post(endpoint, form)
    return { id: res.data?.id, timestamp: Date.now() / 1000, brief: content }
  }

  /** multipart 失败时回退：把本地图片转成公网 URL 再走普通发送 */
  async localImagesToUrl(elements, data) {
    for (const el of elements) {
      if (el.type !== "image" || this.isHttpUrl(el.data?.file)) continue
      try {
        el.data = { ...el.data, file: String(await Bot.fileToUrl(el.data.file)) }
      } catch (err) {
        Bot.makeLog("error", ["频道图片转存公网地址失败", err], data.self_id)
      }
    }
    return elements
  }

  /** 频道/频道私信发送：legacy 模式优先走 multipart 上传本地图片 */
  async sendGuildElements(data, msg, kind) {
    const elements = this.toSdkMessage(msg, data)
    const legacy = config.markdown[data.self_id] === "legacy"
    const simple = !elements.some(el =>
      ["markdown", "keyboard", "button", "ark", "embed"].includes(el.type),
    )
    if (legacy && simple && this.hasLocalImage(elements)) {
      const endpoint =
        kind === "guild" ? `/channels/${data.channel_id}/messages` : `/dms/${data.guild_id}/messages`
      try {
        return await this.sendGuildMultipart(data, elements, endpoint)
      } catch (err) {
        Bot.makeLog("warn", ["频道 multipart 发送失败，回退公网 URL", err], data.self_id)
        await this.localImagesToUrl(elements, data)
      }
    }
    return kind === "guild"
      ? data.bot.sdk.sendGuildMessage(data.channel_id, elements)
      : data.bot.sdk.sendDirectMessage(data.guild_id, elements)
  }

  async recallMsg(data, recall, message_id) {
    if (!Array.isArray(message_id)) message_id = [message_id]
    const msgs = []
    for (const i of message_id)
      try {
        msgs.push(await recall(i))
      } catch (err) {
        Bot.makeLog("debug", ["撤回消息错误", i, err], data.self_id)
        msgs.push(false)
      }
    return msgs
  }

  recallFriendMsg(data, message_id) {
    Bot.makeLog("info", `撤回好友消息：[${data.user_id}] ${message_id}`, data.self_id)
    return this.recallMsg(
      data,
      i => data.bot.sdk.recallPrivateMessage(data.user_id, i),
      message_id,
    )
  }

  recallGroupMsg(data, message_id) {
    Bot.makeLog("info", `撤回群消息：[${data.group_id}] ${message_id}`, data.self_id)
    return this.recallMsg(data, i => data.bot.sdk.recallGroupMessage(data.group_id, i), message_id)
  }

  recallDirectMsg(data, message_id, hide = config.hideGuildRecall) {
    Bot.makeLog(
      "info",
      `撤回${hide ? "并隐藏" : ""}频道私聊消息：[${data.guild_id}] ${message_id}`,
      data.self_id,
    )
    return this.recallMsg(
      data,
      i => data.bot.sdk.recallDirectMessage(data.guild_id, i, hide),
      message_id,
    )
  }

  recallGuildMsg(data, message_id, hide = config.hideGuildRecall) {
    Bot.makeLog(
      "info",
      `撤回${hide ? "并隐藏" : ""}频道消息：[${data.channel_id}] ${message_id}`,
      data.self_id,
    )
    return this.recallMsg(
      data,
      i => data.bot.sdk.recallGuildMessage(data.channel_id, i, hide),
      message_id,
    )
  }

  pickFriend(id, user_id) {
    if (typeof user_id !== "string") user_id = String(user_id)
    else if (user_id.startsWith("qg_")) return this.pickGuildFriend(id, user_id)
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(`${id}${this.sep}`, ""),
    }
    return {
      ...i,
      sendMsg: msg => this.sendFriendMsg(i, msg),
      recallMsg: message_id => this.recallFriendMsg(i, message_id),
      getMsg: message_id => this.getCachedMsg("u", i.user_id, message_id),
      isOwnMessage: message_id => this.isOwnMessage(message_id),
      getAvatarUrl: () => `https://q.qlogo.cn/qqapp/${i.bot.info.appid}/${i.user_id}/0`,
    }
  }

  pickMember(id, group_id, user_id) {
    if (typeof group_id !== "string") group_id = String(group_id)
    if (typeof user_id !== "string") user_id = String(user_id)
    else if (user_id.startsWith("qg_")) return this.pickGuildMember(id, group_id, user_id)
    const i = {
      ...Bot[id].fl.get(user_id),
      ...Bot[id].gml.get(group_id)?.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(`${id}${this.sep}`, ""),
      group_id: group_id.replace(`${id}${this.sep}`, ""),
    }
    // 消息事件里的 author/mentions 自带 member_role，优先用缓存，避免受限接口
    const cached = Bot[id].gml.get(group_id)?.get(`${id}${this.sep}${i.user_id}`) || {}
    const role = cached.member_role
    return {
      ...this.pickFriend(id, user_id),
      ...i,
      ...cached,
      is_admin: role === "admin" || role === "owner",
      is_owner: role === "owner",
      getInfo: async () => {
        const local = { ...cached, member_openid: i.user_id }
        // 事件里带 member_role 时直接返回，接口不可用也能拿到身份
        if (cached.member_role) return local
        try {
          return { ...local, ...(await i.bot.sdk.groupService.getMemberInfo(i.group_id, i.user_id)) }
        } catch (err) {
          // 接口无权限（11253）时，至少返回事件里缓存的昵称
          if (cached.nickname) return local
          throw err
        }
      },
      mute: (seconds = 600) => this.muteMember(id, i.group_id, i.user_id, seconds),
      kick: (block = false) => this.kickMember(id, i.group_id, i.user_id, block),
    }
  }

  pickGroup(id, group_id) {
    if (typeof group_id !== "string") group_id = String(group_id)
    else if (group_id.startsWith("qg_")) return this.pickGuild(id, group_id)
    const i = {
      ...Bot[id].gl.get(group_id),
      self_id: id,
      bot: Bot[id],
      group_id: group_id.replace(`${id}${this.sep}`, ""),
    }
    return {
      ...i,
      name: i.group_name,
      sendMsg: msg => this.sendGroupMsg(i, msg),
      recallMsg: message_id => this.recallGroupMsg(i, message_id),
      pickMember: user_id => this.pickMember(id, group_id, user_id),
      getMemberMap: () => i.bot.gml.get(group_id),
      getMsg: message_id => this.getCachedMsg("g", i.group_id, message_id),
      isOwnMessage: message_id => this.isOwnMessage(message_id),
      // 群管理与群信息（qq-official-bot 群聊 API）
      getInfo: () => i.bot.sdk.groupService.getInfo(i.group_id),
      getBotState: () => i.bot.sdk.groupService.getBotState(i.group_id),
      getMemberInfo: async user_id => {
        const raw = this.rawId(user_id)
        const cached = i.bot.gml.get(i.group_id)?.get(`${id}${this.sep}${raw}`)
        const local = { ...cached, member_openid: raw }
        if (cached?.member_role) return local
        try {
          return { ...local, ...(await i.bot.sdk.groupService.getMemberInfo(i.group_id, raw)) }
        } catch (err) {
          if (cached?.nickname) return local
          throw err
        }
      },
      muteMember: (user_id, seconds = 600) => this.muteMember(id, i.group_id, user_id, seconds),
      kickMember: (user_id, block = false) => this.kickMember(id, i.group_id, user_id, block),
    }
  }

  /** 去掉 `机器人QQ号:` 前缀，拿到 QQ 平台的原始 id */
  rawId(id) {
    if (typeof id !== "string") id = String(id)
    return id.replace(/^\d+:/, "").replace(/^qg_/, "")
  }

  /**
   * 记录群消息 ID，供被动回复使用。
   * 官方限制：同一条群消息最多回复 5 条；这里只保留 110 秒内的消息，
   * 发送时优先用最旧的，避免一条消息被回复次数打满后无法再回复。
   */
  recordMsgId(data) {
    if (data?.message_type !== "group" || data.channel_id || data.guild_id) return
    if (!data.message_id || String(data.message_id).startsWith("event_")) return
    const gid = this.rawId(data.group_id || data.group_openid)
    if (!gid) return
    const key = `${data.self_id}:${gid}`
    let list = this.msgPool.get(key)
    if (!list) this.msgPool.set(key, (list = []))
    if (list.some(i => i.id === data.message_id)) return
    list.push({ id: data.message_id, t: Date.now(), used: 0 })
    this.pruneMsgPool(list)
    if (list.length > MSG_POOL_MAX) list.splice(0, list.length - MSG_POOL_MAX)
  }

  pruneMsgPool(list) {
    const now = Date.now()
    while (
      list.length &&
      (list[0].t + MSG_PASSIVE_TTL <= now || list[0].used >= MSG_PASSIVE_LIMIT)
    )
      list.shift()
  }

  /** 取有效期内最旧、且回复次数未满的群消息 ID；没有则返回 null（走主动消息） */
  pickMsgId(data) {
    const gid = this.rawId(data?.group_id || data?.group_openid)
    if (!gid || data.channel_id || data.guild_id) return null
    const list = this.msgPool.get(`${data.self_id}:${gid}`)
    if (!list) return null
    this.pruneMsgPool(list)
    const item = list[0]
    if (!item) return null
    item.used++
    if (item.used >= MSG_PASSIVE_LIMIT) list.shift()
    return item.id
  }

  /**
   * 引用索引持久化（data/QQBot/<机器人QQ号>/refmap.ndjson）
   * 记录 REFIDX(msg_idx/ref_idx) → 真实 message_id：
   * - 收到的消息保留 24 小时（用于引用、撤回）
   * - 机器人自己发的消息保留 7 天
   */
  refFilePath(id) {
    return path.join(this.path, id, "refmap.ndjson")
  }

  /** 串行写文件，避免 append 与 compact 互相穿插 */
  refQueue(id, task) {
    const prev = this.refWrite[id] || Promise.resolve()
    this.refWrite[id] = prev
      .then(task)
      .catch(err => Bot.makeLog("error", ["引用索引写入失败", err], id))
    return this.refWrite[id]
  }

  async initRefStore(id) {
    if (this.refStore[id]) return
    const forward = (this.refStore[id] = new Map())
    const reverse = (this.refById[id] = new Map())
    const file = (this.refFile[id] = this.refFilePath(id))
    this.refLastCompact[id] = 0
    let dropped = 0
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const text = await fs.readFile(file, "utf8").catch(() => "")
      const now = Date.now()
      for (const line of text.split("\n")) {
        if (!line) continue
        try {
          const r = JSON.parse(line)
          if (!r?.i || !r?.m) continue
          if (r.t + (r.s ? REF_TTL_SENT : REF_TTL_RECV) < now) {
            dropped++
            continue
          }
          forward.set(r.i, r)
          reverse.set(r.m, r.i)
        } catch {}
      }
      // 启动时整理一次：清掉过期/损坏行，避免文件无限增长
      await this.compactRefStore(id)
    } catch (err) {
      Bot.makeLog("error", ["引用索引加载失败", err], id)
    }
    if (dropped) Bot.makeLog("debug", [`引用索引：清理 ${dropped} 条过期记录`], id)
    const timer = setInterval(
      () => this.cleanupRefStore(id).catch(() => {}),
      REF_CLEAN_INTERVAL,
    )
    timer.unref?.()
    this.refTimer[id] = timer
  }

  compactRefStore(id) {
    const forward = this.refStore[id]
    const file = this.refFile[id]
    if (!forward || !file) return Promise.resolve()
    return this.refQueue(id, async () => {
      const lines = []
      for (const r of forward.values()) lines.push(JSON.stringify(r))
      const tmp = `${file}.tmp`
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(tmp, lines.length ? `${lines.join("\n")}\n` : "")
      await fs.rename(tmp, file)
      this.refLastCompact[id] = Date.now()
    })
  }

  recordRef(id, refIdx, messageId, sent = false) {
    if (!refIdx || !messageId) return
    const forward = this.refStore[id]
    if (!forward || forward.has(refIdx)) return
    const r = { i: refIdx, m: messageId, t: Date.now() }
    if (sent) r.s = 1
    forward.set(refIdx, r)
    this.refById[id].set(messageId, refIdx)
    const line = JSON.stringify(r) + "\n"
    this.refQueue(id, () => fs.appendFile(this.refFile[id], line))
  }

  lookupRef(id, refIdx) {
    const r = this.refStore[id]?.get(refIdx)
    if (!r) return null
    if (r.t + (r.s ? REF_TTL_SENT : REF_TTL_RECV) < Date.now()) return null
    return r
  }

  refOf(id, messageId) {
    return this.refById[id]?.get(messageId) || null
  }

  async cleanupRefStore(id) {
    const forward = this.refStore[id]
    if (!forward) return
    const now = Date.now()
    let dropped = 0
    for (const [i, r] of forward) {
      if (r.t + (r.s ? REF_TTL_SENT : REF_TTL_RECV) >= now) continue
      forward.delete(i)
      const reverse = this.refById[id]
      if (reverse?.get(r.m) === i) reverse.delete(r.m)
      dropped++
    }
    if (!dropped) return
    const due = now - (this.refLastCompact[id] || 0) > REF_COMPACT_INTERVAL
    if (due || dropped > forward.size * 0.3) await this.compactRefStore(id)
  }

  destroyRefStore(id) {
    clearInterval(this.refTimer?.[id])
    delete this.refTimer[id]
    delete this.refStore[id]
    delete this.refById[id]
    delete this.refFile[id]
    delete this.refWrite[id]
    delete this.refLastCompact[id]
  }

  /** 缓存最近收到的消息，供 getMsg / e.getReply() 使用 */
  cacheMessage(data) {
    if (!data?.message_id) return
    const now = Date.now()
    const entry = {
      message_id: data.message_id,
      message: data.message,
      raw_message: data.raw_message,
      sender: data.sender,
      time: data.time,
      group_id: data.group_id,
      user_id: data.user_id,
      expire: now + 10 * 60 * 1000,
    }
    if (data.group_id) this.msgCache.set(`g:${this.rawId(data.group_id)}:${data.message_id}`, entry)
    if (data.user_id) this.msgCache.set(`u:${this.rawId(data.user_id)}:${data.message_id}`, entry)
    this.recordMsgId(data)
    const scene = this.parseMessageScene(data.raw)
    // 持久化 REFIDX(msg_idx) → 真实消息 ID（24 小时）
    if (scene.msg_idx) this.recordRef(data.self_id, scene.msg_idx, data.message_id)
    if (this.msgCache.size > 500)
      for (const [k, v] of this.msgCache) if (v.expire < now) this.msgCache.delete(k)
  }

  /** 是否为机器人自己发出的消息（用于判断能否撤回） */
  isOwnMessage(message_id) {
    const expire = this.sentMsgs.get(message_id)
    if (!expire) return undefined
    if (expire < Date.now()) {
      this.sentMsgs.delete(message_id)
      return undefined
    }
    return true
  }

  getCachedMsg(type, scope, message_id) {
    const key = `${type}:${this.rawId(scope)}:${message_id}`
    const entry = this.msgCache.get(key)
    if (!entry || entry.expire < Date.now()) {
      this.msgCache.delete(key)
      return null
    }
    return entry
  }

  /** 解析 message_scene.ext（msg_idx / ref_msg_idx / auth_token） */
  parseMessageScene(event) {
    const out = {}
    for (const item of event?.message_scene?.ext || []) {
      const text = String(item)
      const eq = text.indexOf("=")
      if (eq < 0) continue
      out[text.slice(0, eq).replace(/_/g, "").toLowerCase()] = text.slice(eq + 1)
    }
    return { msg_idx: out.msgidx, ref_msg_idx: out.refmsgidx, auth_token: out.authtoken }
  }

  /**
   * 群消息引用：QQ 会把被引用消息放进 msg_elements（message_type=103），
   * 并只在 message_scene.ext 里给索引（ref_msg_idx），没有 message_reference。
   * 这里把它补成 reply 元素，并缓存被引用内容供 e.getReply() 使用。
   */
  appendQuotedMessage(id, data, event) {
    if (data.message_type !== "group") return
    if (data.message.some(i => i.type === "reply")) return
    const elements = event.msg_elements || event.msgElements || []
    const quote = elements.find(i => Number(i?.message_type ?? i?.messageType) === 103)
    if (!quote) return
    const scene = this.parseMessageScene(event)
    const refIdx = quote.msg_idx || quote.msgIdx || scene.ref_msg_idx
    const known = refIdx ? this.lookupRef(id, refIdx) : null
    const quote_id = known?.m || refIdx
    if (!quote_id) return
    const content = typeof quote.content === "string" ? quote.content : ""
    const gid = event.group_id ?? event.group_openid
    const entry = {
      message_id: quote_id,
      raw_message: content,
      message: content ? [{ type: "text", text: content }] : [],
      sender: known?.s ? { user_id: id } : undefined,
      time: Math.floor(Date.now() / 1000),
      group_id: gid ? `${id}${this.sep}${gid}` : undefined,
      expire: Date.now() + 10 * 60 * 1000,
      quoted: true,
    }
    if (gid) this.msgCache.set(`g:${this.rawId(gid)}:${quote_id}`, entry)
    data.quote_content = content
    data.message.unshift({ type: "reply", id: quote_id })
  }

  /** 禁言成员；seconds <= 0 表示解除禁言 */
  async muteMember(id, group_id, user_id, seconds = 600) {
    const member_openid = this.rawId(user_id)
    if (!(seconds > 0))
      return Bot[id].sdk.groupService.setMemberMute(this.rawId(group_id), [
        { op: "del", member_openid },
      ])
    return Bot[id].sdk.groupService.setMemberMute(this.rawId(group_id), [
      {
        op: "add",
        member_openid,
        mute_expire_at: new Date(Date.now() + seconds * 1000).toISOString(),
      },
    ])
  }

  /** 踢出成员；block 为 true 时同时加入群黑名单 */
  async kickMember(id, group_id, user_id, block = false) {
    return Bot[id].sdk.groupService.removeMembers(this.rawId(group_id), {
      member_openids: [this.rawId(user_id)],
      add_to_member_blacklist: !!block,
    })
  }

  pickGuildFriend(id, user_id) {
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(/^qg_/, ""),
    }
    return {
      ...i,
      sendMsg: msg => this.sendDirectMsg(i, msg),
      recallMsg: (message_id, hide) => this.recallDirectMsg(i, message_id, hide),
    }
  }

  pickGuildMember(id, group_id, user_id) {
    const guild_id = group_id.replace(/^qg_/, "").split("-")
    const i = {
      ...Bot[id].fl.get(user_id),
      ...Bot[id].gml.get(group_id)?.get(user_id),
      self_id: id,
      bot: Bot[id],
      src_guild_id: guild_id[0],
      src_channel_id: guild_id[1],
      user_id: user_id.replace(/^qg_/, ""),
    }
    return {
      ...this.pickGuildFriend(id, user_id),
      ...i,
      sendMsg: msg => this.sendDirectMsg(i, msg),
      recallMsg: (message_id, hide) => this.recallDirectMsg(i, message_id, hide),
    }
  }

  pickGuild(id, group_id) {
    const guild_id = group_id.replace(/^qg_/, "").split("-")
    const i = {
      ...Bot[id].gl.get(group_id),
      self_id: id,
      bot: Bot[id],
      guild_id: guild_id[0],
      channel_id: guild_id[1],
    }
    return {
      ...i,
      sendMsg: msg => this.sendGuildMsg(i, msg),
      recallMsg: (message_id, hide) => this.recallGuildMsg(i, message_id, hide),
      pickMember: user_id => this.pickGuildMember(id, group_id, user_id),
      getMemberMap: () => i.bot.gml.get(group_id),
    }
  }

  async makeFriendMessage(data, event) {
    const user_id = `${data.self_id}${this.sep}${event.sender.user_id}`
    data.sender = {
      ...data.bot.fl.get(user_id),
      ...event.sender,
      user_id,
      nickname: event.user_name,
    }
    Bot.makeLog("info", `好友消息：[${data.user_id}] ${data.raw_message}`, data.self_id)

    data.reply = msg =>
      this.sendFriendMsg(
        {
          ...data,
          user_id: event.sender.user_id,
        },
        msg,
      )
    await this.setFriendMap(data)
  }

  async makeGroupMessage(data, event) {
    // 官方文档明确说明相同 msg_id 可能重复推送，这里按消息 ID 去重
    if (this.isDuplicateMessage(data.self_id, event.message_id)) {
      Bot.makeLog("debug", ["忽略重复推送的群消息", event.message_id], data.self_id)
      return false
    }

    const group_id = event.group_id ?? event.group_openid
    if (!group_id) {
      Bot.makeLog("warn", ["群消息缺少 group_id/group_openid，已跳过", event], data.self_id)
      return false
    }

    const user_id = `${data.self_id}${this.sep}${event.sender.user_id}`
    data.sender = {
      ...data.bot.fl.get(user_id),
      ...event.sender,
      user_id,
      nickname: event.user_name,
    }
    data.group_id = `${data.self_id}${this.sep}${group_id}`
    // 部分群事件会带 group_name，顺便缓存下来，省一次群信息接口
    if (event.group_name) data.group_name = event.group_name
    Bot.makeLog(
      "info",
      `群消息：[${data.group_id}, ${data.user_id}] ${data.raw_message}`,
      data.self_id,
    )

    data.reply = msg =>
      this.sendGroupMsg(
        {
          ...data,
          group_id,
        },
        msg,
      )
    // qq-official-bot 把「群内全量消息」和「群聊@消息」都归类到 message.group，
    // 这里兼容旧逻辑：只有确实是 @机器人 的消息才补一个自身 at 元素
    const isAtMessage =
      String(event.event_id || "").split(":")[0] === "GROUP_AT_MESSAGE_CREATE" ||
      event.sub_type === "at" ||
      (event.mentions || []).some(i => String(i.is_you) === "true") ||
      data.message.some(i => i.type === "at" && i.qq === data.self_id)
    if (isAtMessage && !data.message.some(i => i.type === "at" && i.qq === data.self_id))
      data.message.unshift({ type: "at", qq: data.self_id })
    await this.setGroupMap(data)
    this.cacheMemberInfo(data, event)
    return true
  }

  /**
   * 缓存消息事件里携带的成员身份
   * GROUP_*_MESSAGE_CREATE 的 author / mentions 里带 member_role、username、bot，
   * 这样不用调用需要申请权限的「群成员详情」接口也能拿到身份
   */
  cacheMemberInfo(data, event) {
    const gml = data.bot.gml.get(data.group_id)
    if (!gml) return
    const list = []
    if (event.author) list.push(event.author)
    for (const m of event.mentions || []) list.push(m)
    for (const m of list) {
      const openid = m.member_openid || m.id
      if (!openid) continue
      const user_id = `${data.self_id}${this.sep}${openid}`
      const old = gml.get(user_id) || {}
      gml.set(user_id, {
        ...old,
        user_id,
        nickname: m.username || old.nickname,
        member_role: m.member_role || old.member_role,
        bot: m.bot ?? old.bot,
        joined_at: m.joined_at || old.joined_at,
      })
    }
  }

  async makeDirectMessage(data, event) {
    const user_id = `qg_${event.sender.user_id}`
    data.sender = {
      ...data.bot.fl.get(user_id),
      ...event.sender,
      user_id,
      nickname: event.sender.user_name,
      avatar: event.author.avatar,
      guild_id: event.guild_id,
      channel_id: event.channel_id,
      src_guild_id: event.src_guild_id,
    }
    Bot.makeLog(
      "info",
      `频道私聊消息：[${data.sender.nickname}(${data.user_id})] ${data.raw_message}`,
      data.self_id,
    )

    data.reply = msg =>
      this.sendDirectMsg(
        {
          ...data,
          user_id: event.user_id,
          guild_id: event.guild_id,
          channel_id: event.channel_id,
        },
        msg,
      )
    await this.setFriendMap(data)
  }

  async makeGuildMessage(data, event) {
    const user_id = `qg_${event.sender.user_id}`
    data.message_type = "group"
    data.sender = {
      ...data.bot.fl.get(user_id),
      ...event.sender,
      user_id,
      nickname: event.sender.user_name,
      card: event.member.nick,
      avatar: event.author.avatar,
      src_guild_id: event.guild_id,
      src_channel_id: event.channel_id,
    }
    data.group_id = `qg_${event.guild_id}-${event.channel_id}`
    Bot.makeLog(
      "info",
      `频道消息：[${data.group_id}, ${data.sender.nickname}(${data.user_id})] ${data.raw_message}`,
      data.self_id,
    )
    data.reply = msg =>
      this.sendGuildMsg(
        {
          ...data,
          guild_id: event.guild_id,
          channel_id: event.channel_id,
        },
        msg,
      )
    await this.setFriendMap(data)
    await this.setGroupMap(data)
  }

  async setFriendMap(data) {
    if (!data.user_id) return
    await data.bot.fl.set(data.user_id, {
      ...data.bot.fl.get(data.user_id),
      ...data.sender,
      time: data.time,
      message_id: data.message_id,
    })
  }

  async setGroupMap(data) {
    if (!data.group_id) return
    await data.bot.gl.set(data.group_id, {
      ...data.bot.gl.get(data.group_id),
      group_id: data.group_id,
      group_name: data.group_name,
      time: data.time,
      message_id: data.message_id,
    })
    let gml = data.bot.gml.get(data.group_id)
    if (!gml) {
      gml = new Map()
      await data.bot.gml.set(data.group_id, gml)
    }
    await gml.set(data.user_id, {
      ...gml.get(data.user_id),
      ...data.sender,
    })
  }

  async makeMessage(id, event) {
    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: event.post_type,
      message_type: event.message_type,
      sub_type: event.sub_type,
      message_id: event.message_id,
      time: event.timestamp,
      get user_id() {
        return this.sender.user_id
      },
      message: this.fromSdkMessage(event.message),
      raw_message: event.raw_message,
    }

    // 全量模式下 @机器人 会以 <@openid> 形式出现在 content 里，
    // mentions 中对应成员通常带 is_you / bot 标记，这里识别出「自身」的那一个
    let selfAt
    if (data.message_type === "group") {
      const first = data.message.find(i => i.type === "at")
      if (first) {
        const atStart = String(event.content || "").trimStart().startsWith("<@")
        if (String(first.is_you) === "true" || (atStart && String(first.bot) === "true"))
          selfAt = first.user_id
      }
    }

    for (const i of data.message)
      switch (i.type) {
        case "at":
          if (data.message_type === "group") {
            const self =
              (selfAt && i.user_id === selfAt) ||
              String(i.is_you) === "true" ||
              (!i.user_id && !i.qq) ||
              i.user_id === data.self_id
            i.qq = self ? data.self_id : `${data.self_id}${this.sep}${i.user_id}`
          } else i.qq = `qg_${i.user_id}`
          break
      }

    this.appendQuotedMessage(id, data, event)

    switch (data.message_type) {
      case "private":
        if (data.sub_type === "friend") await this.makeFriendMessage(data, event)
        else await this.makeDirectMessage(data, event)
        break
      case "group":
        if ((await this.makeGroupMessage(data, event)) === false) return
        break
      case "guild":
        await this.makeGuildMessage(data, event)
        break
      default:
        Bot.makeLog("warn", ["未知消息", event], id)
        return
    }

    this.cacheMessage(data)
    Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  async makeBotCallback(id, event, callback) {
    const data = {
      raw: event,
      bot: Bot[callback.self_id],
      self_id: callback.self_id,
      post_type: "message",
      message_id: event.event_id ? `event_${event.event_id}` : event.notice_id,
      message_type: callback.group_id ? "group" : "private",
      sub_type: "callback",
      get user_id() {
        return this.sender.user_id
      },
      sender: { user_id: `${id}${this.sep}${event.operator_id}` },
      message: [],
      raw_message: "",
    }

    data.message.push(
      { type: "at", qq: callback.self_id },
      { type: "text", text: callback.message },
    )
    data.raw_message += callback.message

    if (callback.group_id) {
      data.group_id = callback.group_id
      data.group = data.bot.pickGroup(callback.group_id)
      data.group_name = data.group.name
      data.friend = Bot[id].pickFriend(data.user_id)
      if (data.friend.real_id) {
        data.friend = data.bot.pickFriend(data.friend.real_id)
        data.member = data.group.pickMember(data.friend.user_id)
        data.sender = {
          ...((await data.member.getInfo()) || data.member),
        }
      } else {
        if (Bot[id].callback[data.user_id]) return event.reply(3)
        Bot[id].callback[data.user_id] = true

        let msg = `请先发送 #QQBot绑定用户${data.user_id}`
        const real_id = callback.message.replace(/^#[Qq]+[Bb]ot绑定用户确认/, "").trim()
        if (this.bind_user[real_id] === data.user_id) {
          await Bot[id].fl.set(data.user_id, {
            ...Bot[id].fl.get(data.user_id),
            real_id,
          })
          msg = `绑定成功 ${data.user_id} → ${real_id}`
        }

        event.reply(0)
        return data.group.sendMsg(msg)
      }
      Bot.makeLog(
        "info",
        [
          `群按钮点击事件：[${data.group_name}(${data.group_id}), ${data.sender.nickname}(${data.user_id})]`,
          data.raw_message,
        ],
        data.self_id,
      )
    } else {
      await Bot[id].fl.set(data.user_id, {
        ...Bot[id].fl.get(data.user_id),
        real_id: callback.user_id,
      })
      data.friend = data.bot.pickFriend(callback.user_id)
      data.sender = {
        ...((await data.friend.getInfo()) || data.friend),
      }
      Bot.makeLog(
        "info",
        [`好友按钮点击事件：[${data.sender.nickname}(${data.user_id})]`, data.raw_message],
        data.self_id,
      )
    }

    event.reply(0)
    Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  async makeCallback(id, event) {
    const reply = event.reply.bind(event)
    event.reply = async (...args) => {
      try {
        return await reply(...args)
      } catch (err) {
        Bot.makeLog("debug", ["回复按钮点击事件错误", err], data.self_id)
      }
    }

    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: "message",
      message_id: event.event_id ? `event_${event.event_id}` : event.notice_id,
      message_type: event.notice_type,
      sub_type: "callback",
      get user_id() {
        return this.sender.user_id
      },
      sender: { user_id: `${id}${this.sep}${event.operator_id}` },
      message: [],
      raw_message: "",
    }

    const callback = data.bot.callback[event.data?.resolved?.button_id]
    if (callback) {
      if (callback.self_id) return this.makeBotCallback(id, event, callback)
      if (!event.group_id && callback.group_id) event.group_id = callback.group_id
      if (callback.message_id.length) {
        for (const id of callback.message_id) data.message.push({ type: "reply", id })
        data.raw_message += `[回复：${callback.message_id}]`
      }
      data.message.push({ type: "text", text: callback.message })
      data.raw_message += callback.message
    } else {
      if (event.data?.resolved?.button_id) {
        data.message.push({ type: "reply", id: event.data?.resolved?.button_id })
        data.raw_message += `[回复：${event.data?.resolved?.button_id}]`
      }
      if (event.data?.resolved?.button_data) {
        data.message.push({ type: "text", text: event.data?.resolved?.button_data })
        data.raw_message += event.data?.resolved?.button_data
      } else {
        event.reply(1)
      }
    }
    event.reply(0)

    switch (data.message_type) {
      case "friend":
        data.message_type = "private"
        Bot.makeLog("info", [`好友按钮点击事件：[${data.user_id}]`, data.raw_message], data.self_id)

        data.reply = msg => this.sendFriendMsg({ ...data, user_id: event.operator_id }, msg)
        await this.setFriendMap(data)
        break
      case "group":
        data.group_id = `${id}${this.sep}${event.group_id}`
        Bot.makeLog(
          "info",
          [`群按钮点击事件：[${data.group_id}, ${data.user_id}]`, data.raw_message],
          data.self_id,
        )

        data.reply = msg => this.sendGroupMsg({ ...data, group_id: event.group_id }, msg)
        await this.setGroupMap(data)
        break
      case "guild":
        break
      default:
        Bot.makeLog("warn", ["未知按钮点击事件", event], data.self_id)
    }

    Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  makeNotice(id, event) {
    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: event.post_type,
      notice_type: event.notice_type,
      sub_type: event.sub_type,
      notice_id: event.notice_id,
    }

    switch (data.sub_type) {
      case "action":
        return this.makeCallback(id, event)
      // 群成员加入 / 退出
      case "member.increase":
      case "member.decrease":
        return this.makeGroupMemberNotice(id, event, data.sub_type.endsWith("increase") ? "increase" : "decrease")
      // 入群申请
      case "join_request":
        return this.makeJoinRequestNotice(id, event)
      // 机器人被拉入 / 移出群
      case "increase":
      case "decrease": {
        const e = {
          post_type: "notice",
          notice_type: "group",
          sub_type: data.sub_type,
          self_id: id,
          bot: Bot[id],
          group_id: event.group_id ? `${id}${this.sep}${event.group_id}` : undefined,
          operator_id: event.operator_id ? `${id}${this.sep}${event.operator_id}` : undefined,
          time: event.time || Math.floor(Date.now() / 1000),
        }
        Bot.makeLog("mark", `机器人被${data.sub_type === "increase" ? "拉入" : "移出"}群：${e.group_id}`, id)
        return Bot.em(`notice.group.bot.${data.sub_type}`, e)
      }
      case "update":
      case "member.update":
        break
      default:
        Bot.makeLog("debug", ["未处理的通知", event], id)
        return
    }
  }

  /** 群成员进群 / 退群 → TRSS 的 notice.group.increase / decrease */
  makeGroupMemberNotice(id, event, sub_type) {
    const data = {
      post_type: "notice",
      notice_type: "group",
      sub_type,
      self_id: id,
      bot: Bot[id],
      group_id: event.group_id ? `${id}${this.sep}${event.group_id}` : undefined,
      user_id: event.user_id ? `${id}${this.sep}${event.user_id}` : undefined,
      operator_id: event.operator_id ? `${id}${this.sep}${event.operator_id}` : undefined,
      time: event.time || Math.floor(Date.now() / 1000),
    }
    Bot.makeLog(
      "info",
      `群成员${sub_type === "increase" ? "加入" : "退出"}：[${data.group_id}] ${data.user_id}`,
      id,
    )
    return Bot.em(`notice.group.${sub_type}`, data)
  }

  /** 入群申请 → notice.group.join_request */
  makeJoinRequestNotice(id, event) {
    const apply = event.apply_at ? new Date(event.apply_at).getTime() : NaN
    const data = {
      post_type: "notice",
      notice_type: "group",
      sub_type: "join_request",
      self_id: id,
      bot: Bot[id],
      group_id: `${id}${this.sep}${event.group_id}`,
      user_id: `${id}${this.sep}${event.user_id}`,
      username: event.username,
      join_request_id: event.join_request_id,
      apply_at: event.apply_at,
      apply_source: event.apply_source,
      invited_by: event.invited_by,
      is_bot: event.is_bot,
      verify_info: event.verify_info,
      time: Number.isNaN(apply) ? Math.floor(Date.now() / 1000) : Math.floor(apply / 1000),
    }
    Bot.makeLog("info", `入群申请：[${data.group_id}] ${event.username}(${data.user_id})`, id)
    return Bot.em("notice.group.join_request", data)
  }

  getFriendMap(id) {
    return Bot.getMap(`${this.path}${id}/Friend`)
  }

  getGroupMap(id) {
    return Bot.getMap(`${this.path}${id}/Group`)
  }

  getMemberMap(id) {
    return Bot.getMap(`${this.path}${id}/Member`)
  }

  /** 断线重连 / 心跳探测配置 */
  get reconnectOptions() {
    return { ...reconnectDefault, ...config.reconnect }
  }

  /** 心跳超时时间：未配置时取心跳间隔的 3 倍，最少 60 秒 */
  heartbeatTimeout(sdk) {
    const timeout = this.reconnectOptions.heartbeatTimeout
    if (timeout > 0) return timeout
    return Math.max(60000, (sdk?.receiver?.heartbeatInterval || 45000) * 3)
  }

  /** 最近一次连接活动时间（收到事件或心跳回应） */
  lastActive(id) {
    const state = this.watcher[id]
    const sdk = Bot[id]?.sdk
    return Math.max(state?.lastActive || 0, sdk?.receiver?.lastHeartbeatAck || 0)
  }

  /** 连接是否可用：receiver 已就绪且近期有数据往来 */
  isUp(id) {
    const state = this.watcher[id]
    const sdk = Bot[id]?.sdk
    if (!state || state.stop || !sdk) return false
    if (!sdk.receiver?.isReady) return false
    return Date.now() - this.lastActive(id) < this.heartbeatTimeout(sdk)
  }

  /**
   * 接管 access_token 刷新
   * SDK 自带实现重试 3 次后就会永久停止刷新，网络恢复后也不会再获取 token
   */
  installToken(id) {
    const sm = Bot[id].sdk.sessionManager
    const auth = sm.authManager
    // 低版本 Node 无 fetch，保持 SDK 原实现
    if (this.token[id] || typeof fetch !== "function" || !auth) return
    const state = (this.token[id] = { stop: false, timer: null, pending: null, retry: 0 })
    const { appid, secret, timeout = 30000 } = sm.bot.config
    const opt = this.reconnectOptions

    const schedule = ms => {
      clearTimeout(state.timer)
      if (state.stop) return
      state.timer = setTimeout(() => state.refresh().catch(() => {}), ms)
      state.timer.unref?.()
    }

    state.refresh = () => {
      if (state.pending) return state.pending
      state.pending = (async () => {
        const res = await fetch("https://bots.qq.com/app/getAppAccessToken", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appId: appid, clientSecret: secret }),
          signal: AbortSignal.timeout?.(timeout),
        })
        const data = await res.json()
        if (!data?.access_token) throw new Error(`获取 access_token 失败：${JSON.stringify(data)}`)
        const expires_in = +data.expires_in || 7200
        // 写回 SDK 的认证管理器，请求拦截器与 Session.access_token 都从这里取
        auth.setToken({ access_token: data.access_token, expires_in })
        state.retry = 0
        Bot.makeLog(
          "debug",
          `access_token 刷新成功，${Math.round(expires_in)}s 后过期`,
          id,
        )
        schedule(Math.max(60000, expires_in * 1000 - 300000))
        return data.access_token
      })()
        .catch(err => {
          const wait = Math.min(opt.interval * 2 ** Math.min(++state.retry, 6), opt.maxInterval)
          Bot.makeLog(
            "warn",
            [`access_token 刷新失败(${state.retry})，${msText(wait)} 后重试`, err?.message || err],
            id,
          )
          schedule(wait)
          throw err
        })
        .finally(() => {
          state.pending = null
        })
      return state.pending
    }

    // 关掉 SDK 自己的刷新定时器（3 次失败后会永久停摆），统一由上面的 schedule 驱动
    auth.scheduleTokenRefresh = () => {}
    auth.scheduleTokenRefreshRetry = () => {}
    const rawRefresh = auth.refreshAccessToken.bind(auth)
    auth.refreshAccessToken = async () => {
      if (auth.isTokenValid?.()) return auth.getCurrentTokenInfo()
      await state.refresh()
      return auth.getCurrentTokenInfo()
    }

    state.dispose = () => {
      state.stop = true
      clearTimeout(state.timer)
      auth.refreshAccessToken = rawRefresh
      delete this.token[id]
    }
  }

  /**
   * 监视连接：断线后延时重连 + 心跳超时探测
   * qq-official-bot 的 receiver 自带有限次重连，这里做兜底与无限重连
   */
  installWatcher(id) {
    const opt = this.reconnectOptions
    if (!opt.enable || this.watcher[id]) return
    const sdk = Bot[id].sdk
    const receiver = sdk.receiver
    if (!receiver) return
    const state = (this.watcher[id] = { stop: false, loop: null, lastActive: Date.now() })

    // 记录数据往来时间，供心跳超时探测使用
    const onActive = () => (state.lastActive = Date.now())
    const onClosed = (code, reason) => {
      if (state.stop || state.loop) return
      if ([4914, 4915].includes(+code)) {
        Bot.makeLog("error", "机器人已下架或已被封禁，停止自动重连", id)
        return this.stopWatcher(id)
      }
      Bot.makeLog("mark", `连接已断开${code ? ` (${code})` : ""}，准备自动重连`, id)
      this.reconnect(id)
    }

    receiver.on("packet", onActive)
    receiver.on("ready", onActive)
    receiver.on("close", onClosed)
    sdk.sessionManager.on("max_retry_reached", onClosed)

    // 网络静默断开时 ws 不会报错，只能靠超时发现
    const timer = setInterval(
      () => this.checkAlive(id),
      Math.min(10000, Math.max(1000, this.heartbeatTimeout(sdk) / 3)),
    )
    timer.unref?.()

    state.dispose = () => {
      state.stop = true
      clearInterval(timer)
      receiver.off("packet", onActive)
      receiver.off("ready", onActive)
      receiver.off("close", onClosed)
      sdk.sessionManager.off("max_retry_reached", onClosed)
      delete this.watcher[id]
    }
  }

  stopWatcher(id) {
    this.watcher[id]?.dispose()
  }

  /** 心跳超时探测 */
  checkAlive(id) {
    const state = this.watcher[id]
    const sdk = Bot[id]?.sdk
    if (!state || state.stop || state.loop || !sdk) return
    if (this.isUp(id)) return
    const idle = Date.now() - this.lastActive(id)
    Bot.makeLog(
      "warn",
      sdk.receiver?.isReady
        ? `${Math.round(idle / 1000)}s 未收到心跳回应，判定连接失效，强制重连`
        : "连接未建立，强制重连",
      id,
    )
    this.reconnect(id, 0)
  }

  /** 关闭残留连接并重建，等待就绪 */
  async reopen(id) {
    const sdk = Bot[id].sdk
    const sm = sdk.sessionManager
    const state = this.watcher[id]
    if (state?.stop) throw new Error("已停止重连")

    // userClose 阻止 SDK 内部的重连，避免与本次重连并发
    sm.userClose = true
    try {
      await sdk.receiver.stop(sm)
    } catch (err) {
      Bot.makeLog("debug", ["关闭旧连接错误", err], id)
    }
    if (state?.stop) throw new Error("已停止重连")
    sm.userClose = false

    const start = Promise.resolve(sdk.start())
    start.catch(() => {})
    await Promise.race([
      start,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("等待连接就绪超时")),
          this.reconnectOptions.connectTimeout,
        )
        timer.unref?.()
        start.then(
          () => clearTimeout(timer),
          () => clearTimeout(timer),
        )
      }),
    ])
  }

  /** 断线重连：延时 + 退避，直到成功或停止 */
  reconnect(id, delay, force) {
    const state = this.watcher[id]
    if (!state || state.stop) return
    if (state.loop) return state.loop
    const opt = this.reconnectOptions
    state.loop = true // 占位，避免同一轮事件内重复进入

    const run = (async () => {
      let wait = delay ?? opt.interval
      for (let i = 1; !state.stop; i++) {
        if (wait > 0) await sleep(wait)
        if (state.stop) break
        if (!force && this.isUp(id)) {
          Bot.makeLog("debug", "连接已恢复", id)
          break
        }
        force = false
        const quiet = opt.maxRetry > 0 && i > opt.maxRetry
        if (!quiet) Bot.makeLog("mark", `正在进行第 ${i} 次重连...`, id)
        try {
          await this.reopen(id)
          Bot.makeLog("mark", `第 ${i} 次重连成功`, id)
          break
        } catch (err) {
          wait = Math.min(wait > 0 ? wait * 1.6 : opt.interval, opt.maxInterval)
          Bot.makeLog(
            quiet ? "debug" : "warn",
            [`第 ${i} 次重连失败：${err?.message || err}，${msText(wait)} 后重试`],
            id,
          )
        }
      }
    })()
      .catch(err => Bot.makeLog("error", ["自动重连异常", err], id))
      .finally(() => {
        state.loop = null
      })

    state.loop = run
    return run
  }

  /** 包装 login / logout：重连监视与 token 刷新随连接生命周期启停 */
  wrapLifecycle(id, webhook) {
    const login = Bot[id].login.bind(Bot[id])
    const logout = Bot[id].logout.bind(Bot[id])

    Bot[id].login = () => {
      if (!this.token[id]) this.installToken(id)
      if (!webhook && !this.watcher[id]) this.installWatcher(id)
      return login()
    }
    Bot[id].logout = () => {
      this.stopWatcher(id)
      this.token[id]?.dispose()
      return logout()
    }
  }

  /**
   * 启动阶段连接失败后，后台按退避重试整个连接流程
   * 用于开机时网络尚未就绪等情况，避免必须手动重启
   */
  retryConnect(token) {
    const opt = this.reconnectOptions
    const id = token.split(":")[0]
    if (!opt.enable || this.retryTask[id]) return
    const state = (this.retryTask[id] = { stop: false })
    let wait = opt.interval

    const run = async () => {
      for (let i = 1; !state.stop; i++) {
        await sleep(wait)
        if (state.stop) break
        if (await this.connect(token)) {
          Bot.makeLog("mark", `第 ${i} 次重连成功`, id)
          break
        }
        wait = Math.min(wait * 1.6, opt.maxInterval)
      }
    }

    run()
      .catch(err => Bot.makeLog("error", ["重连异常", err], id))
      .finally(() => {
        if (this.retryTask[id] === state) delete this.retryTask[id]
      })
  }

  /** 停止启动阶段的后台重连 */
  stopRetry(id) {
    const state = this.retryTask[id]
    if (!state) return
    state.stop = true
    delete this.retryTask[id]
  }

  async connect(token) {
    if (Bot.adapter.some(i => i !== adapter && i.id === adapter.id))
      return Bot.makeLog(
        "error",
        "检测到已加载其他 QQBot 适配器（QQBot-Plugin），请只保留一个 QQBot 插件后再连接",
      )
    token = token.split(":")
    const id = token[0]
    const webhook = token[4] === "2"

    // 重复连接同一账号时先停掉旧实例，避免出现两条连接
    if (Bot[id]?.sdk) {
      this.stopWatcher(id)
      this.token[id]?.dispose()
      try {
        await Bot[id].sdk.stop()
      } catch (err) {
        Bot.makeLog("debug", ["关闭旧连接失败", err], id)
      }
    }

    const opts = {
      ...config.bot,
      appid: token[1],
      token: token[2],
      secret: token[3],
      // qq-official-bot 必填：连接方式；Webhook 由插件自己挂到 TRSS 的 express 上
      mode: ReceiverMode.WEBSOCKET,
      // 新版默认会移除消息内容中的 @，这里保持旧版行为
      removeAt: false,
      // 不注册进程级异常监听，避免影响 TRSS
      handleProcessErrors: false,
      // 日志统一转发给 TRSS
      logLevel: "off",
      intents: [
        "GUILDS",
        "GUILD_MEMBERS",
        "GUILD_MESSAGE_REACTIONS",
        "DIRECT_MESSAGE",
        "INTERACTION",
        "MESSAGE_AUDIT",
      ],
    }

    if (+token[4]) opts.intents.push("GROUP_AND_C2C_EVENT")

    if (+token[5]) opts.intents.push("GUILD_MESSAGES")
    else opts.intents.push("PUBLIC_GUILD_MESSAGES")

    Bot[id] = {
      adapter: this,
      sdk: new QQBotSDK(opts),
      login() {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("连接超时")),
            adapter.reconnectOptions.connectTimeout,
          )
          timer.unref?.()
          Promise.resolve(this.sdk.start()).then(
            () => {
              clearTimeout(timer)
              resolve()
            },
            err => {
              clearTimeout(timer)
              reject(err)
            },
          )
        })
      },
      logout() {
        return new Promise(resolve => {
          const sdk = this.sdk
          const timer = setTimeout(resolve, 5000)
          timer.unref?.()
          sdk.receiver?.once?.("close", () => {
            clearTimeout(timer)
            resolve()
          })
          Promise.resolve(sdk.stop()).then(
            () => {
              clearTimeout(timer)
              resolve()
            },
            () => {
              clearTimeout(timer)
              resolve()
            },
          )
        })
      },

      uin: id,
      info: {
        id,
        ...opts,
        avatar: `https://q.qlogo.cn/g?b=qq&s=0&nk=${this.uin}`,
      },
      get nickname() {
        return this.info.username
      },
      get avatar() {
        return this.info.avatar
      },

      version: {
        id: this.id,
        name: this.name,
        version: this.version,
      },
      stat: { start_time: Date.now() / 1000 },

      pickFriend: user_id => this.pickFriend(id, user_id),
      get pickUser() {
        return this.pickFriend
      },
      getFriendMap() {
        return this.fl
      },
      fl: await this.getFriendMap(id),

      pickMember: (group_id, user_id) => this.pickMember(id, group_id, user_id),
      pickGroup: group_id => this.pickGroup(id, group_id),
      getGroupMap() {
        return this.gl
      },
      gl: await this.getGroupMap(id),
      gml: await this.getMemberMap(id),

      callback: {},
    }

    await this.initRefStore(id)

    Bot[id].sdk.logger = {}
    for (const i of ["trace", "debug", "info", "mark", "warn", "error", "fatal"])
      Bot[id].sdk.logger[i] = (...args) => {
        if (args[0]?.startsWith?.("recv from")) return
        return Bot.makeLog(i, args, id)
      }

    // 记录机器人自己发出去的消息的引用索引（发送响应 ext_info.ref_idx），
    // 别人引用这条消息时，平台只会给这个 ref_idx，需要能映射回真实消息 ID（撤回用）
    Bot[id].sdk.request.interceptors.response.use(res => {
      const d = res?.data
      const ref_idx = d?.ext_info?.ref_idx
      if (d?.id && ref_idx) this.recordRef(id, ref_idx, d.id, true)
      return res
    })

    this.installToken(id)

    try {
      if (webhook) {
        await Bot[id].sdk.sessionManager.getAccessToken()
        Bot[id].login = () => (this.appid[opts.appid] = Bot[id])
        Bot[id].logout = () => delete this.appid[opts.appid]
      }

      await Bot[id].login()
      Object.assign(Bot[id].info, await Bot[id].sdk.getSelfInfo())
    } catch (err) {
      Bot.makeLog("error", [`${this.name}(${this.id}) ${this.version} 连接失败`, err], id)
      this.token[id]?.dispose()
      try {
        await Bot[id]?.sdk?.stop?.()
      } catch {}
      return false
    }

    Bot[id].sdk.on("message", event => this.makeMessage(id, event))
    Bot[id].sdk.on("notice", event => this.makeNotice(id, event))

    if (!webhook) this.installWatcher(id)
    this.wrapLifecycle(id, webhook)

    Bot.makeLog("mark", `${this.name}(${this.id}) ${this.version} ${Bot[id].nickname} 已连接`, id)
    Bot.em(`connect.${id}`, { self_id: id })
    return true
  }

  async makeWebHookSign(id, req, secret) {
    const { plain_token, event_ts } = req.body.d
    const signature = new QQBotEd25519(secret).sign(`${event_ts}${plain_token}`)
    Bot.makeLog("debug", ["QQBot 签名生成", { plain_token, signature }], id)
    req.res.send({ plain_token, signature })
  }

  makeWebHook(req) {
    const appid = req.headers["x-bot-appid"]
    if (!(appid in this.appid)) return Bot.makeLog("warn", "找不到对应 QQBot", appid)
    if ("plain_token" in req.body?.d)
      return this.makeWebHookSign(this.appid[appid].uin, req, this.appid[appid].info.secret)
    if ("t" in req.body) this.appid[appid].sdk.dispatchEvent(req.body.t, req.body)
    req.res.sendStatus(200)
  }

  async load() {
    if (Bot.adapter.some(i => i !== adapter && i.id === adapter.id))
      return Bot.makeLog(
        "error",
        "检测到已加载其他 QQBot 适配器（QQBot-Plugin），本插件跳过连接；请移除其中一个插件",
      )
    Bot.express.use(`/${this.name}`, this.makeWebHook.bind(this))
    Bot.express.quiet.push(`/${this.name}`)
    for (const token of config.token) {
      const connect = this.connect(token)
      await Bot.sleep(5000, connect)
      // 连接失败（如开机时网络未就绪）时，等本次连接流程结束后在后台重试
      connect.then(ok => !ok && this.retryConnect(token))
    }
    // 测试插件必须等 TRSS 的 online 之后才能复制：
    // plugins/example 的 chokidar add 监听是在 online 时才挂上的，
    // 适配器加载阶段（online 之前）复制进去的文件会被漏掉，只能重启后加载。
    const installExample = () => {
      const timer = setTimeout(async () => {
        try {
          const installed = await this.ensureExamplePlugin()
          if (installed) {
            // 先等 chokidar 的 add 热加载（debounce 5s）；没加载成功再手动补一次
            await sleep(10000)
            const { default: loader } = await import("../../lib/plugins/loader.js")
            const key = "example/qqbot-test.js"
            if (!loader.priority?.some(i => i.key === key)) {
              await loader.importPlugin({
                name: key,
                path: `../../plugins/${key}?${Date.now()}`,
              })
              loader.watch?.("example", "qqbot-test.js")
              Bot.makeLog("mark", "测试插件已热加载", this.id)
            }
          }
          const needGuide = installed || config.exampleGuideSent !== true
          if (!needGuide) return
          if (await this.sendExampleGuide()) {
            config.exampleGuideSent = true
            await configSave()
          }
        } catch (err) {
          Bot.makeLog("error", ["测试插件安装/加载失败", err], this.id)
        }
      }, 3000)
      timer.unref?.()
    }
    if (Bot.stat?.online === 2) installExample()
    else Bot.once("online", installExample)
  }

  /**
   * 首次安装时把测试用 example 插件复制到 plugins/example/
   * （放在插件包 example/ 下，不会被当成适配器加载）
   */
  async ensureExamplePlugin() {
    if (config.autoInstallExample === false) return false
    const target = path.join("plugins", "example", "qqbot-test.js")
    try {
      if (await Bot.fsStat(target)) return false
      await fs.mkdir(path.dirname(target), { recursive: true })
      const baseDir = import.meta.dirname || path.dirname(fileURLToPath(import.meta.url))
      const bundled = path.join(baseDir, "example", "qqbot-test.js")
      if (await Bot.fsStat(bundled)) await fs.copyFile(bundled, target)
      else {
        const url =
          config.exampleUrl ||
          "https://raw.githubusercontent.com/XingYunStar/qq-official-bot-plugin/main/example/qqbot-test.js"
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await fs.writeFile(target, await res.text())
      }
      Bot.makeLog("mark", `测试插件已安装到 ${target}，发送 #qqbot测试 查看用法`, this.id)
      return true
    } catch (err) {
      Bot.makeLog("error", ["测试插件安装失败", err], this.id)
      return false
    }
  }

  /** 向 master 发送测试插件的使用说明（单聊） */
  async sendExampleGuide() {
    let sent = false
    const text = [
      "QQBot 适配器测试插件已安装：plugins/example/qqbot-test.js",
      "发送 #qqbot测试 查看全部命令，常用：",
      "#qqbot昵称 [@某人]  获取昵称",
      "#qqbot群名  获取群名",
      "#qqbot身份 [@某人]  查询群身份（群主/管理员/成员）",
      "#qqbot禁言 @某人 [秒数]  禁言（0 解除，需要机器人是管理员）",
      "#qqbot踢人 @某人 [拉黑]  踢人",
      "#qqbot撤回  撤回测试消息（引用消息则撤回被引用的那条）",
      "#qqbot引用 / #qqbot引用消息  引用回复 / 读取被引用内容",
      "#qqbot进群申请 / #qqbot同意进群 序号 / #qqbot拒绝进群 序号  入群审批",
      "#qqbot原始  调试：输出本条消息的原始事件字段",
      "",
      "详细说明见插件仓库 README。",
    ].join("\n")
    for (const id of Bot.uin) {
      if (Bot[id]?.adapter !== this) continue
      const masters = new Set((cfg.master?.[id] || []).map(String))
      const targets = new Set(masters)
      try {
        for (const [openid, info] of Bot[id].fl || [])
          if (info?.real_id && masters.has(String(info.real_id))) targets.add(this.rawId(openid))
      } catch {}
      if (!targets.size) {
        Bot.makeLog(
          "warn",
          "未配置 master（config/other.yaml: master），测试插件使用说明未发送；可把 master 配成 openid 或先 #QQBot绑定用户",
          id,
        )
        continue
      }
      for (const uid of targets)
        try {
          await Bot[id].sdk.sendPrivateMessage(this.rawId(uid), [
            { type: "text", data: { text } },
          ])
          sent = true
          Bot.makeLog("mark", `已向 master ${uid} 发送测试插件使用说明`, id)
        } catch (err) {
          Bot.makeLog("warn", [`向 master ${uid} 发送说明失败`, err?.message || err], id)
        }
    }
    return sent
  }
})()

if (!Bot.adapter.some(i => i.id === adapter.id)) Bot.adapter.push(adapter)

export class QQBotAdapter extends plugin {
  constructor() {
    super({
      name: "QQBotAdapter",
      dsc: "QQBot 适配器设置",
      event: "message",
      rule: [
        {
          reg: "^#[Qq]+[Bb]ot账号$",
          fnc: "List",
          permission: config.permission,
        },
        {
          reg: "^#[Qq]+[Bb]ot设置[0-9]+:[0-9]+:.+:.+:([01]:[01]|2)$",
          fnc: "Token",
          permission: config.permission,
        },
        {
          reg: "^#[Qq]+[Bb]ot重连",
          fnc: "Reconnect",
          permission: config.permission,
        },
        {
          reg: "^#[Qq]+[Bb]ot[Mm](ark)?[Dd](own)?[0-9]+:",
          fnc: "Markdown",
          permission: config.permission,
        },
        {
          reg: "^#[Qq]+[Bb]ot图片限制.+$",
          fnc: "ImageLength",
          permission: config.permission,
        },
        {
          reg: "^#[Qq]+[Bb]ot绑定用户.+$",
          fnc: "BindUser",
        },
      ],
    })
  }

  List() {
    this.reply(`共${config.token.length}个账号：\n${config.token.join("\n")}`, true)
  }

  async Token() {
    const token = this.e.msg.replace(/^#[Qq]+[Bb]ot设置/, "").trim()
    if (config.token.includes(token)) {
      config.token = config.token.filter(item => item !== token)
      adapter.stopRetry(token.split(":")[0])
      this.reply(`账号已删除，重启后生效，共${config.token.length}个账号`, true)
    } else {
      if (await adapter.connect(token)) {
        config.token.push(token)
        this.reply(`账号已连接，共${config.token.length}个账号`, true)
      } else {
        this.reply(`账号连接失败`, true)
        return false
      }
    }
    return configSave()
  }

  async Reconnect() {
    const id = this.e.msg.replace(/^#[Qq]+[Bb]ot重连/, "").trim()
    const ids = id ? [id] : Bot.uin.filter(i => Bot[i]?.adapter === adapter)
    if (!ids.length) return this.reply("没有已连接的 QQBot 账号", true)

    const msgs = []
    for (const i of ids) {
      if (!Bot[i]) {
        msgs.push(`${i}：账号不存在`)
        continue
      }
      if (adapter.appid[Bot[i].info?.appid] === Bot[i]) {
        msgs.push(`${i}：Webhook 模式无需重连`)
        continue
      }
      if (!adapter.watcher[i]) {
        msgs.push(`${i}：自动重连未启用`)
        continue
      }
      adapter.reconnect(i, 0, true)
      msgs.push(`${i}：正在重连`)
    }
    return this.reply(msgs.join("\n"), true)
  }

  Markdown() {
    let token = this.e.msg
      .replace(/^#[Qq]+[Bb]ot[Mm](ark)?[Dd](own)?/, "")
      .trim()
      .split(":")
    const bot_id = token.shift()
    token = token.join(":")
    this.reply(`Bot ${bot_id} Markdown 模板已设置为 ${token}`, true)
    config.markdown[bot_id] = token
    return configSave()
  }

  ImageLength() {
    const imageLength = +this.e.msg.replace(/^#[Qq]+[Bb]ot图片限制/, "").trim()
    if (!(imageLength > 0)) return this.reply("请输入正确数字", true)
    if (!sharp) return this.reply("请检查 sharp 是否正确安装", true)
    this.reply(`图片大小已限制为 ${imageLength}MB`, true)
    config.imageLength = imageLength
    return configSave()
  }

  BindUser() {
    const id = this.e.msg.replace(/^#[Qq]+[Bb]ot绑定用户(确认)?/, "").trim()
    if (id === this.e.user_id) return this.reply("请切换到对应Bot")

    adapter.bind_user[this.e.user_id] = id
    this.reply([
      `绑定 ${id} → ${this.e.user_id}`,
      segment.button([
        {
          text: "确认绑定",
          callback: `#QQBot绑定用户确认${this.e.user_id}`,
          permission: this.e.user_id,
        },
      ]),
    ])
  }
}

logger.info(logger.green("- QQBot 适配器插件 加载完成"))
