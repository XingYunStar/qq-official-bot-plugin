/**
 * QQBot 适配器功能测试插件
 *
 * 覆盖：撤回、禁言、踢人、群成员进群、入群申请列表、同意/拒绝进群、
 *       获取群成员身份/昵称/群名、e.at / e.atBot、引用回复、读取被引用消息、
 *       连发 10 条、原始事件调试。
 *
 * 只对 adapter_id === "QQBot"（qq-official-bot 适配器）生效，不影响 ICQQ 等其它适配器。
 * 注意：禁言/踢人/入群审批需要机器人在群内是管理员，部分接口还需开放平台申请权限。
 */
import fs from "node:fs/promises"

const ADAPTER_ID = "QQBot"
/** 测试期如需放开所有群管理权限，改成 true（默认按群主/管理员校验） */
const SKIP_PERMISSION_CHECK = false
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const isQQBot = e => e?.bot?.adapter?.id === ADAPTER_ID || e?.adapter_id === ADAPTER_ID
/** 去掉 `机器人appid<sep>` 前缀；兼容历史分隔符 ":"、U+F03A 与 "_"，新 ID 用 ":" */
const rawId = id => String(id ?? "").replace(/^\d+[:_\uF03A]/, "")
/** 取消息里 @ 的成员（排除 @全体 和频道用户） */
const atMembers = e =>
  (e.message || []).filter(
    i =>
      i.type === "at" &&
      i.qq &&
      i.qq !== "all" &&
      !/[:_\uF03A]all$/.test(String(i.qq)) &&
      !String(i.qq).startsWith("qg_") &&
      String(i.qq) !== String(e.self_id),
  )
const atIds = e => atMembers(e).map(i => rawId(i.qq))
const roleText = role => ({ owner: "群主", admin: "管理员", member: "普通成员" })[role] || role || "未知"
const errText = err => err?.message || err?.toString?.() || "未知错误"

/** 大图测试图（公网 URL） */
const BIG_IMAGE_URL =
  "https://act-upload.mihoyo.com/sr-wiki/2026/02/13/324957497/a47606da012e2ee3e869f0a9b87a01ae_6065535796741131488.png"

const sdkOf = e => e.bot?.sdk
const rawGroup = e => rawId(e.group_id)

/** 从消息事件的 author/mentions 里取成员信息（这些字段自带 member_role，不需要调接口） */
function memberFromEvent(e, openid) {
  const id = String(openid)
  const author = e.raw?.author
  const isAuthor =
    author && [author.id, author.member_openid, author.user_openid].filter(Boolean).includes(id)
  const hit =
    (isAuthor && author) ||
    (e.raw?.mentions || []).find(m =>
      [m.id, m.member_openid, m.user_openid].filter(Boolean).includes(id),
    )
  if (!hit) return null
  return {
    member_openid: hit.member_openid || hit.id || id,
    username: hit.username,
    member_role: hit.member_role,
    bot: hit.bot,
    joined_at: hit.joined_at,
  }
}

/** 群引用：QQ 把被引用的消息放在 msg_elements（message_type=103）里 */
function quotedFromEvent(e) {
  const elements = e.raw?.msg_elements || e.raw?.msgElements || []
  const quote = elements.find(i => Number(i?.message_type ?? i?.messageType) === 103)
  if (!quote) return null
  return {
    content: typeof quote.content === "string" ? quote.content : "",
    idx: quote.msg_idx || quote.msgIdx || null,
  }
}

/** 成员信息：优先用适配器方法，没有则直接走 SDK（兼容未重启的旧适配器） */
async function getMemberInfo(e, uid) {
  if (typeof e.group?.getMemberInfo === "function") return e.group.getMemberInfo(uid)
  const sdk = sdkOf(e)
  if (sdk?.groupService?.getMemberInfo)
    return sdk.groupService.getMemberInfo(rawGroup(e), rawId(uid))
  throw new Error("当前适配器不支持获取成员信息")
}

/** 禁言：优先适配器方法，否则直接用 SDK */
async function muteMember(e, uid, seconds) {
  if (typeof e.group?.muteMember === "function") return e.group.muteMember(uid, seconds)
  const sdk = sdkOf(e)
  if (!sdk?.groupService?.setMemberMute) throw new Error("当前适配器不支持禁言")
  const member_openid = rawId(uid)
  if (!(seconds > 0))
    return sdk.groupService.setMemberMute(rawGroup(e), [{ op: "del", member_openid }])
  return sdk.groupService.setMemberMute(rawGroup(e), [
    {
      op: "add",
      member_openid,
      mute_expire_at: new Date(Date.now() + seconds * 1000).toISOString(),
    },
  ])
}

/** 踢人：优先适配器方法，否则直接用 SDK */
async function kickMember(e, uid, block) {
  if (typeof e.group?.kickMember === "function") return e.group.kickMember(uid, block)
  const sdk = sdkOf(e)
  if (!sdk?.groupService?.removeMembers) throw new Error("当前适配器不支持踢人")
  return sdk.groupService.removeMembers(rawGroup(e), {
    member_openids: [rawId(uid)],
    add_to_member_blacklist: !!block,
  })
}

export class QQBotAdapterTest extends plugin {
  constructor() {
    super({
      name: "QQBot适配器测试",
      dsc: "测试 QQBot 适配器的撤回/禁言/踢人/进群/审批/身份/at/引用",
      event: "message",
      rule: [
        { reg: "^#qqbot测试$", fnc: "help" },
        { reg: "^#qqbot(连发|发送10条)$", fnc: "burst" },
        { reg: "^#qqbot(9[Mm][Bb]?|大图)$", fnc: "bigImage" },
        { reg: "^#qqbot(图文|卡片)$", fnc: "card" },
        { reg: "^#qqbot图文1$", fnc: "imageCardDaily" },
        { reg: "^#qqbot图文2$", fnc: "imageCardGrid" },
        { reg: "^#qqbot图文3$", fnc: "imageCardActions" },
        { reg: "^#qqbot卡片1$", fnc: "tuwenCardOne" },
        { reg: "^#qqbot卡片2$", fnc: "tuwenCardTwo" },
        { reg: "^#qqbot卡片3$", fnc: "tuwenCardThree" },
        { reg: "^#qqbot公式$", fnc: "formulaCard" },
        { reg: "^#qqbot媒体$", fnc: "richMedia" },
        { reg: "^#qqbot(webui|WebUI)$", fnc: "webui" },
        { reg: "^#qqbot流式(?:输出)?$", fnc: "stream" },
        { reg: "^#qqbot登录$", fnc: "qqLogin" },
        { reg: "^#qqbot数据(.*)$", fnc: "stats" },
        { reg: "^#qqbot撤回$", fnc: "recall" },
        { reg: "^#qqbot禁言", fnc: "mute" },
        { reg: "^#qqbot踢人", fnc: "kick" },
        { reg: "^#qqbot身份", fnc: "identity" },
        { reg: "^#qqbot昵称", fnc: "nickname" },
        { reg: "^#qqbot群名$", fnc: "groupName" },
        { reg: "^#qqbot原始$", fnc: "raw" },
        { reg: "^#qqbotat$", fnc: "at" },
        { reg: "^#qqbot引用$", fnc: "quote" },
        { reg: "^#qqbot引用消息$", fnc: "quoted" },
        { reg: "^#qqbot进群申请$", fnc: "joinList" },
        { reg: "^#qqbot同意进群", fnc: "joinApprove" },
        { reg: "^#qqbot拒绝进群", fnc: "joinDecline" },
        { reg: "^#qqbot拉黑拒绝进群(?:\\s*\\d+)?$", fnc: "joinBlacklistDecline" },
        { reg: "^#qqbot测试报错$", fnc: "testError" },
      ],
    })
  }

  /** 群管理操作权限：TRSS 主人，或群主/管理员（身份从 QQ 接口实时查询） */
  async checkAdmin(e) {
    if (SKIP_PERMISSION_CHECK || e.isMaster) return true
    // 优先用消息事件自带的身份，避免调用需要申请权限的接口
    const self = memberFromEvent(e, rawId(e.user_id))
    if (self?.member_role === "owner" || self?.member_role === "admin") return true
    try {
      const info = await getMemberInfo(e, e.user_id)
      if (info?.member_role === "owner" || info?.member_role === "admin") return true
    } catch (err) {
      logger.error(`[QQBot测试] 获取发送者身份失败：${errText(err)}`)
    }
    await e.reply("暂无权限：该操作仅限机器人主人或群主/管理员")
    return false
  }

  async help() {
    const e = this.e
    if (!isQQBot(e)) return false
    return e.reply(
      [
        "QQBot 适配器测试命令：",
        "#qqbot撤回 —— 发送一条测试消息并撤回（引用消息时撤回被引用的那条）",
        "#qqbot连发 —— 连续发送 10 条消息（测试被动回复消息池）",
        "#qqbot大图 —— 发送一张大图（公网 URL，素材上传/大图测试）",
        "#qqbot图文 —— 发送一条 ARK 图文卡片（群聊/单聊）",
        "#qqbot图文1 —— Markdown 图文卡片：图片 + 正文 + 单按钮",
        "#qqbot图文2 —— Markdown 图文卡片：双图 + 信息列表",
        "#qqbot图文3 —— Markdown 图文卡片：图片 + 多按钮操作",
        "#qqbot卡片1/2/3 —— 官方 msg_type=8 图文卡片（tuwen）",
        "#qqbot公式 —— Markdown 公式 + 图片 + 按钮测试",
        "#qqbot媒体 —— 图片 / 语音 / 视频 / 群文件 / 按钮样式测试",
        "#qqbot流式 —— 私聊流式输出测试（仅私聊，Markdown 分片）",
        "#qqbotwebui —— 查看 WebUI 地址和密码位置",
        "#qqbot登录 —— 查看 QQ 开放平台登录方式（WebUI 导入 Cookie）",
        "#qqbot数据 [today/yesterday/7d/14d/30d] —— 查看运营数据",
        "#qqbot禁言 @某人 [秒数] —— 禁言，秒数 0 为解除，默认 600",
        "#qqbot踢人 @某人 [拉黑] —— 踢出群，带「拉黑」同时加入群黑名单",
        "#qqbot身份 [@某人] —— 查询群成员身份（群主/管理员/成员）",
        "#qqbot昵称 [@某人] —— 获取昵称（优先用消息事件字段）",
        "#qqbot群名 —— 获取群名（优先用消息事件/缓存，其次群信息接口）",
        "#qqbot原始 —— 调试：输出本条消息的原始事件字段",
        "#qqbotat —— 查看本条消息的 at / atBot 解析结果",
        "#qqbot引用 —— 发送一条引用回复",
        "#qqbot引用消息 —— 读取被引用消息的内容（本地缓存 10 分钟）",
        "#qqbot进群申请 —— 查看待审批的入群申请",
        "#qqbot同意进群 [序号] / #qqbot拒绝进群 [序号] —— 审批入群申请",
        "#qqbot拉黑拒绝进群 [序号] —— 拒绝入群申请并加入群黑名单",
        "#qqbot测试报错 —— 写入一条带用户/群/指令上下文的测试报错",
        "",
        "进群/退群/入群申请事件会自动提示；群管理接口要求机器人是群管理员。",
      ].join("\n"),
    )
  }

  /** 私聊流式输出：调用官方 /v2/users/{openid}/stream_messages */
  async stream() {
    const e = this.e
    if (!isQQBot(e)) return false
    if (e.message_type !== "private" && e.isPrivate !== true)
      return e.reply("流式输出测试仅支持私聊，请私聊机器人发送 #qqbot流式")
    const sdk = sdkOf(e)
    if (typeof sdk?.createPrivateStream !== "function")
      return e.reply("当前 qq-official-bot 版本不支持 createPrivateStream")
    const userId = e.bot?.adapter?.rawId?.(e.user_id) || rawId(e.user_id)
    if (!userId) return e.reply("没有拿到私聊用户 ID")
    const stream = sdk.createPrivateStream(userId, {
      inputMode: "replace",
      contentType: "markdown",
      msgId: e.message_id,
    })
    try {
      const chunks = [
        "## QQBot 流式输出测试\n\n正在生成第 1 段内容……",
        "\n\n- 第 2 段：流式分片已到达",
        "\n- 第 3 段：同一 stream_msg_id 持续追加",
        "\n\n**流式输出完成。**",
      ]
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await sleep(350)
        if (i === chunks.length - 1) await stream.end(chunks[i])
        else await stream.write(chunks[i])
      }
      logger.mark(`[QQBot测试] 私聊流式输出完成：${userId}`)
    } catch (err) {
      logger.error(`[QQBot测试] 私聊流式输出失败：${errText(err)}`)
      try { await e.reply(`流式输出失败：${errText(err)}`) } catch {}
    }
  }

  /** 查看 WebUI 地址和密码位置 */
  async webui() {
    const e = this.e
    if (!isQQBot(e)) return false
    const port = e.bot?.adapter?.webui?.port || 2580
    return e.reply(
      [
        `QQBot WebUI：http://<服务器IP>:${port}/`,
        "密码：TRSS 启动日志里的 [QQBot WebUI] 密码，或 data/QQBot/webui.json",
        "Docker 部署需要把宿主机端口反向代理到容器内 IP:端口",
      ].join("\n"),
    )
  }

  async qqLogin() {
    const e = this.e
    if (!isQQBot(e)) return false
    try {
      const auth = JSON.parse(await fs.readFile("data/QQBot/webui.json", "utf8"))
      if (auth.qqCookie)
        return e.reply("QQ 开放平台登录态已保存，可直接发送 #qqbot数据 查看运营数据")
    } catch {}
    const port = e.bot?.adapter?.webui?.port || 2580
    return e.reply(
      [
        "QQ 开放平台登录：",
        `1. 打开 WebUI：http://<服务器IP>:${port}/`,
        "2. 进入「QQ 登录」，把浏览器里 q.qq.com 的 Cookie 粘贴进去保存",
        "3. 回到这里发送 #qqbot数据 查看运营数据",
      ].join("\n"),
    )
  }

  async stats() {
    const e = this.e
    if (!isQQBot(e)) return false
    const range = (e.msg.replace(/^#qqbot数据/, "").trim() || "7d").toLowerCase()
    const days = { today: 1, yesterday: 2, "7d": 7, "14d": 14, "30d": 30 }[range] || 7
    const dataRange = days <= 7 ? 0 : days <= 14 ? 1 : 2
    let auth
    try {
      auth = JSON.parse(await fs.readFile("data/QQBot/webui.json", "utf8"))
    } catch {}
    if (!auth?.qqCookie) return e.reply("还没有 QQ 开放平台登录态，请先发送 #qqbot登录 查看步骤")
    const appid = e.bot?.info?.appid
    if (!appid) return e.reply("没有找到 AppID，无法查询运营数据")
    try {
      const res = await fetch("https://bot.q.qq.com/cgi-bin/v2/datareport/query", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: auth.qqCookie },
        body: JSON.stringify({ bot_appid: Number(appid), data_range: dataRange, data_type: 4 }),
      })
      const data = await res.json()
      if (data.retcode !== 0) return e.reply(`查询失败：${data.msg || data.retcode}`)
      const rows = (data.data?.developer_metrics_data || []).slice().sort((a, b) => String(a.report_date).localeCompare(String(b.report_date)))
      const use = days === 1 ? rows.slice(-1) : days === 2 ? rows.slice(-2, -1) : rows.slice(-days)
      const sum = key => use.reduce((n, r) => n + Number(r[key] || 0), 0)
      const messages = use.reduce((n, r) => n + Number(r.up_msg?.total || 0), 0)
      const last = use[use.length - 1] || {}
      return e.reply(
        [
          `运营数据（${range}，${use.length} 天）：`,
          `活跃用户：${sum("active_user_cnt")}`,
          `消息量：${messages}`,
          `新增用户：${sum("new_user_cnt")}`,
          `总好友/总群：${last.friends?.stock_cnt || 0} / ${last.groups?.stock_cnt || 0}`,
        ].join("\n"),
      )
    } catch (err) {
      return e.reply(`查询运营数据失败：${errText(err)}`)
    }
  }

  /** 发送一条图文卡片（群聊/单聊） */
  async card() {
    const e = this.e
    if (!isQQBot(e)) return false
    const card = {
      type: "card",
      content: {
        title: "QQ 官方机器人 · 图文卡片",
        description: "来自 qq-official-bot-plugin 的图文卡片消息测试",
        url: "https://github.com/XingYunStar/qq-official-bot-plugin",
        pic_url:
          "https://act-upload.mihoyo.com/sr-wiki/2026/02/13/324957497/a47606da012e2ee3e869f0a9b87a01ae_6065535796741131488.png",
      },
    }
    const keyboard = segment.button(
      [
        { text: "打开项目", link: "https://github.com/XingYunStar/qq-official-bot-plugin" },
        { text: "再来一张", input: "#qqbot图文" },
      ],
      [{ text: "官方卡片", input: "#qqbot卡片1" }],
    )
    await e.reply([card, keyboard])
    return true
  }

  /** 图文卡片：图片 + Markdown + 可选键盘按钮 */
  async sendImageCard(e, { title, subtitle, image, body = [], buttons = [] }) {
    const lines = [
      `# ${title}`,
      subtitle ? `> ${subtitle}` : "",
      "",
      ...(image ? [`![${title} #800px #420px](${image})`, ""] : []),
      ...body,
    ].filter((line, i, list) => line !== "" || list[i - 1] !== "")
    const parts = [segment.markdown({ content: lines.join("\n") })]
    if (buttons.length) {
      const rows = buttons.map(row => row.map((btn, i) => ({
        id: `qqbot_test_${Date.now().toString(36)}_${row.length}_${i}`.slice(0, 32),
        render_data: {
          label: btn.label,
          visited_label: btn.visited || btn.label,
          style: btn.style ?? 1,
        },
        action: {
          type: 2,
          permission: { type: 2 },
          data: btn.data,
          enter: true,
          unsupport_tips: "当前客户端不支持按钮，请发送命令",
        },
      })))
      parts.push(segment.raw({ type: "keyboard", content: { rows } }))
    }
    return e.reply(parts)
  }

  /**
   * 官方 msg_type=8 图文卡片（tuwen）。
   * 文档：https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html#schema-messagecard
   * 限制：title 1-50，description 1-200，url/pic_url 必须是 https 且不超过 1024 字符。
   */
  async sendTuwenCard(e, content) {
    const card = {
      type: "tuwen",
      content: {
        title: String(content.title || "").slice(0, 50),
        description: String(content.description || "").slice(0, 200),
        url: String(content.url || ""),
        pic_url: String(content.pic_url || ""),
      },
    }
    if (!card.content.url.startsWith("https://") || !card.content.pic_url.startsWith("https://"))
      return e.reply("图文卡片要求 url 和 pic_url 都使用 https")
    return e.reply({ type: "card", content: card.content })
  }

  async formulaCard() {
    const e = this.e
    if (!isQQBot(e)) return false
    const colors = ["#425574", "#508494", "#65866c", "#3c969c", "#71acaf", "#4cc3c6", "#7dc8a4", "#9fd08a", "#dfe482", "#eee89d", "#e8e390", "#f6b65b", "#e77a22", "#d35303"]
    const bar = colors.map(c => `\\colorbox{${c}}{\\hspace{9pt}}`).join("")
    const rainbow = [
      ["点", "#425574"], ["燃", "#508494"], ["星", "#3c969c"], ["海", "#4cc3c6"],
    ].map(([t, c]) => `\\textcolor{${c}}{\\textbf{${t}}}`).join("")
    const firefly = [
      ["F", "#7dc8a4"], ["i", "#9fd08a"], ["r", "#dfe482"], ["e", "#eee89d"],
      ["f", "#e8e390"], ["l", "#f6b65b"], ["y", "#e77a22"],
    ].map(([t, c]) => `\\textcolor{${c}}{\\textbf{${t}}}`).join("")
    const latex = String.raw`$$
\begin{array}{c}
${bar} \\[5pt]
${rainbow} \\[3pt]
${firefly} \\[3pt]
\textcolor{#d35303}{\textbf{AR-26710}} \\[5pt]
\colorbox{#ffb6c1}{\textcolor{white}{\small\ \ 流萤 · 星穹铁道\ \ }} \\[4pt]
${bar}
\end{array}
$$`
    const content = [
      "# 公式与 Markdown 测试",
      "> KaTeX / 渐变色 / 表格 / 键盘按钮",
      "",
      "行内公式：$\\textcolor{#4cc3c6}{a^2+b^2=c^2}$",
      "",
      latex,
      "",
      "| 功能 | 状态 |",
      "| --- | --- |",
      "| Markdown | 正常 |",
      "| KaTeX 颜色 | 正常 |",
      "| 表格 | 正常 |",
      "| 按钮 | 正常 |",
    ].join("\n")
    const keyboard = segment.button(
      [
        { text: "重新渲染", input: "#qqbot公式" },
        { text: "官方卡片", input: "#qqbot卡片1" },
      ],
      [{ text: "打开项目", link: "https://github.com/XingYunStar/qq-official-bot-plugin" }],
    )
    return e.reply([segment.markdown({ content }), keyboard])
  }

  async richMedia() {
    const e = this.e
    if (!isQQBot(e)) return false
    return e.reply([
      segment.text("QQ 消息样式测试：图片 / 语音 / 视频 / 群文件 / 按钮"),
      segment.image("https://act-upload.mihoyo.com/sr-wiki/2026/02/13/324957497/a47606da012e2ee3e869f0a9b87a01ae_6065535796741131488.png"),
      segment.record("https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"),
      segment.video("https://www.w3schools.com/html/mov_bbb.mp4"),
      { ...segment.file("https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", "QQBot 测试文件.pdf"), size: 13264 },
      segment.button([{ text: "播放语音", callback: "qqbot_media_voice" }, { text: "下载文件", link: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf" }]),
    ])
  }

  async tuwenCardOne() {
    const e = this.e
    if (!isQQBot(e)) return false
    return this.sendTuwenCard(e, {
      title: "QQBot Plugin 图文卡片",
      description: "官方 msg_type=8 · tuwen 卡片测试：标题、描述、跳转链接和图片。",
      url: "https://github.com/XingYunStar/qq-official-bot-plugin",
      pic_url: "https://act-upload.mihoyo.com/sr-wiki/2026/02/13/324957497/a47606da012e2ee3e869f0a9b87a01ae_6065535796741131488.png",
    })
  }

  async tuwenCardTwo() {
    const e = this.e
    if (!isQQBot(e)) return false
    return this.sendTuwenCard(e, {
      title: "TRSS-Yunzai QQBot 适配器",
      description: "支持群聊、频道、Markdown、键盘、引用、素材、WebUI 和数据管理。",
      url: "https://github.com/XingYunStar/qq-official-bot-plugin#readme",
      pic_url: "https://act-upload.mihoyo.com/sr-wiki/2026/02/13/324957497/a47606da012e2ee3e869f0a9b87a01ae_6065535796741131488.png",
    })
  }

  async tuwenCardThree() {
    const e = this.e
    if (!isQQBot(e)) return false
    return this.sendTuwenCard(e, {
      title: "流萤日报 · 测试卡片",
      description: "这是一条不会跳转到真实业务的测试图文卡片，用于验证 msg_type=8 发送。",
      url: "https://q.qq.com/qqbot/profile/?robot_uin=3889049339",
      pic_url: "https://act-upload.mihoyo.com/sr-wiki/2026/02/13/324957497/a47606da012e2ee3e869f0a9b87a01ae_6065535796741131488.png",
    })
  }

  /** 单图 + 正文 + 单按钮 */
  async imageCardDaily() {
    const e = this.e
    if (!isQQBot(e)) return false
    return this.sendImageCard(e, {
      title: "流萤日报",
      subtitle: "来自 qq-official-bot-plugin 的 Markdown 图文卡片",
      image: "https://act-upload.mihoyo.com/sr-wiki/2026/02/13/324957497/a47606da012e2ee3e869f0a9b87a01ae_6065535796741131488.png",
      body: [
        "## 今日状态",
        "- 在线：**正常**",
        "- 适配器：qq-official-bot 1.3.4",
        "- 功能：图片、Markdown、按钮、引用回复",
        "",
        "> 这是一张测试卡片，不包含真实业务数据。",
      ],
      buttons: [[{ label: "再来一张", data: "#qqbot图文1", style: 1 }]],
    })
  }

  /** 双图 + 信息列表 */
  async imageCardGrid() {
    const e = this.e
    if (!isQQBot(e)) return false
    const image1 = "https://act-upload.mihoyo.com/sr-wiki/2026/02/13/324957497/a47606da012e2ee3e869f0a9b87a01ae_6065535796741131488.png"
    const image2 = "https://act-upload.mihoyo.com/sr-wiki/2026/02/13/324957497/a47606da012e2ee3e869f0a9b87a01ae_6065535796741131488.png"
    return e.reply([
      segment.markdown({
        content: [
          "# QQBot 功能展示",
          "> 双图卡片 · Markdown 排版",
          "",
          `![流萤 #360px #240px](${image1}) ![星穹 #360px #240px](${image2})`,
          "",
          "| 能力 | 状态 |",
          "| --- | --- |",
          "| 群消息 | 已接入 |",
          "| Markdown | 已支持 |",
          "| 按钮 | 已支持 |",
          "| 素材 | qqbot-media:// |",
        ].join("\n"),
      }),
    ])
  }

  /** 图片 + 多按钮操作 */
  async imageCardActions() {
    const e = this.e
    if (!isQQBot(e)) return false
    return this.sendImageCard(e, {
      title: "操作卡片",
      subtitle: "图文 + 键盘按钮测试",
      image: "https://act-upload.mihoyo.com/sr-wiki/2026/02/13/324957497/a47606da012e2ee3e869f0a9b87a01ae_6065535796741131488.png",
      body: [
        "点击下方按钮可以执行对应命令。",
        "",
        "- **再来一张**：重新发送图文1",
        "- **功能列表**：查看帮助",
        "- **原始事件**：输出本条消息原始字段",
      ],
      buttons: [
        [
          { label: "再来一张", data: "#qqbot图文1", style: 1 },
          { label: "功能列表", data: "#qqbot测试", style: 0 },
        ],
        [
          { label: "原始事件", data: "#qqbot原始", style: 1 },
        ],
      ],
    })
  }

  /** 发送一张大图（公网 URL），测试素材上传/大图压缩 */
  async bigImage() {
    const e = this.e
    if (!isQQBot(e)) return false
    if (!(await this.checkAdmin(e))) return false
    const image = segment.image(BIG_IMAGE_URL)
    // 大图测试：跳过适配器的压缩（默认会压到 imageLength，3MB）
    image.noCompress = true
    await e.reply(image)
    logger.mark(`[qqbot-test] 已发送大图测试（不压缩）：${BIG_IMAGE_URL}`)
    return true
  }

  /** 连续发送 10 条消息，用来验证被动回复消息池 */
  async burst() {
    const e = this.e
    if (!isQQBot(e)) return false
    if (!(await this.checkAdmin(e))) return false
    if (!e.group) return e.reply("该命令仅群聊可用")
    try {
      for (let i = 1; i <= 10; i++) {
        const last = i === 10
        await e.reply(`【连发测试】第 ${i}/10 条${last ? "（全部发送完成）" : ""}`)
        if (!last) await sleep(600)
      }
    } catch (err) {
      return e.reply(`❌ 连发测试失败：${errText(err)}`)
    }
  }

  async recall() {
    const e = this.e
    if (!isQQBot(e)) return false
    if (!(await this.checkAdmin(e))) return false
    try {
      let message_id = e.reply_id || e.raw?.message_reference?.message_id
      let desc = "被引用的消息"
      if (!message_id && quotedFromEvent(e))
        return e.reply(
          "引用消息只有引用索引、没有真实消息 ID，无法撤回。\n可以直接发送 #qqbot撤回 来撤回一条测试消息。",
        )
      if (!message_id) {
        const ret = await e.reply("【撤回测试】这条消息马上会被撤回")
        message_id = ret?.message_id?.[0] || ret?.data?.[0]?.id
        desc = "刚发送的测试消息"
        if (!message_id) return e.reply("❌ 没有拿到消息 ID，无法测试撤回")
        await sleep(1000)
      }
      const ret = await e.group.recallMsg(message_id)
      const ok = Array.isArray(ret) ? ret.every(Boolean) : ret !== false
      if (!ok)
        return e.reply(`❌ 撤回失败：${message_id}\n消息可能已过期，或机器人没有撤回权限`)
      return e.reply(`✅ 已撤回${desc}：${message_id}`)
    } catch (err) {
      return e.reply(`❌ 撤回失败：${errText(err)}`)
    }
  }

  /** 禁言 */
  async mute() {
    const e = this.e
    if (!isQQBot(e)) return false
    if (!(await this.checkAdmin(e))) return false
    const ids = atIds(e)
    if (!ids.length) return e.reply("用法：#qqbot禁言 @某人 [秒数]\n例如：#qqbot禁言 @张三 600")
    const seconds = Number((e.msg.match(/(\d+)\s*(秒|s)?\s*$/) || [])[1] ?? 600)
    try {
      await muteMember(e, ids[0], seconds)
      return e.reply(
        seconds > 0 ? `✅ 已禁言 ${ids[0]} ${seconds} 秒` : `✅ 已解除 ${ids[0]} 的禁言`,
      )
    } catch (err) {
      return e.reply(
        `❌ 禁言失败：${errText(err)}\n（需要机器人是群管理员，接口可能仅对白名单机器人开放）`,
      )
    }
  }

  /** 踢人 */
  async kick() {
    const e = this.e
    if (!isQQBot(e)) return false
    if (!(await this.checkAdmin(e))) return false
    const ids = atIds(e)
    if (!ids.length) return e.reply("用法：#qqbot踢人 @某人 [拉黑]")
    const block = /拉黑|黑名单/.test(e.msg)
    try {
      const ret = await kickMember(e, ids[0], block)
      return e.reply(
        `✅ 已踢出 ${ids[0]}${block ? "（并加入黑名单）" : ""}\n${JSON.stringify(ret ?? {})}`,
      )
    } catch (err) {
      return e.reply(`❌ 踢人失败：${errText(err)}`)
    }
  }

  /** 获取身份：群主 / 管理员 / 普通成员 */
  async identity() {
    const e = this.e
    if (!isQQBot(e)) return false
    const target = atIds(e)[0] || rawId(e.user_id)
    // 消息事件里自带 author/mentions 的 member_role、username
    let info = memberFromEvent(e, target)
    let from = "消息事件"
    if (!info?.member_role) {
      try {
        info = { ...info, ...(await getMemberInfo(e, target)) }
        from = "成员详情接口"
      } catch (err) {
        if (!info)
          return e.reply(
            `❌ 获取身份失败：${errText(err)}
（@某人 的身份需要对方在本条消息里被 @，才能从事件字段读取）`,
          )
        from = "消息事件（成员详情接口无权限，已跳过）"
      }
    }
    return e.reply(
      [
        `成员：${info.username || target}`,
        `OpenID：${info.member_openid || target}`,
        `身份：${roleText(info.member_role)}（${info.member_role || "?"}）`,
        `是否机器人：${info.bot ? "是" : "否"}`,
        `入群时间：${info.joined_at || "未知"}`,
        `数据来源：${from}`,
      ].join("\n"),
    )
  }

  /** 获取昵称 */
  async nickname() {
    const e = this.e
    if (!isQQBot(e)) return false
    const target = atIds(e)[0] || rawId(e.user_id)
    let name = memberFromEvent(e, target)?.username
    let from = "消息事件"
    if (!name) {
      const gml = e.group?.getMemberMap?.()
      const cached = gml?.get?.(`${e.self_id}:${target}`) || gml?.get?.(target)
      if (cached?.nickname) {
        name = cached.nickname
        from = "成员缓存"
      }
    }
    if (!name) {
      try {
        const info = await getMemberInfo(e, target)
        name = info?.username
        from = "成员详情接口"
      } catch (err) {
        return e.reply(`❌ 获取昵称失败：${errText(err)}`)
      }
    }
    return e.reply([`昵称：${name || "(未知)"}`, `OpenID：${target}`, `数据来源：${from}`].join("\n"))
  }

  /** 获取群名 */
  async groupName() {
    const e = this.e
    if (!isQQBot(e)) return false
    let name = e.raw?.group_name || e.group?.group_name || e.group?.name
    let from = "消息事件/缓存"
    if (!name) {
      try {
        const info =
          typeof e.group?.getInfo === "function"
            ? await e.group.getInfo()
            : await e.bot.sdk.groupService.getInfo(rawGroup(e))
        name = info?.group_name || info?.name
        from = "群信息接口"
      } catch (err) {
        return e.reply(
          `❌ 获取群名失败：${errText(err)}\n（该接口可能需要在 QQ 开放平台申请权限）`,
        )
      }
    }
    return e.reply(
      [`群名：${name || "(未知)"}`, `群 OpenID：${rawGroup(e)}`, `数据来源：${from}`].join("\n"),
    )
  }

  /** 调试：输出原始事件字段（用于排查引用等字段） */
  async raw() {
    const e = this.e
    if (!isQQBot(e)) return false
    const raw = e.raw || {}
    const data = {}
    for (const key of [
      "id",
      "content",
      "message_type",
      "timestamp",
      "group_id",
      "group_openid",
      "group_name",
      "message_scene",
      "message_reference",
      "mentions",
      "author",
      "attachments",
      "msg_elements",
    ])
      if (raw[key] !== undefined) data[key] = raw[key]
    data.reply_id = e.reply_id
    data.at = e.at
    data.atBot = e.atBot
    let text = JSON.stringify(data, (k, v) => (k === "auth_token" ? "***" : v), 2)
    if (text.length > 1800) text = text.slice(0, 1800) + "\n...(截断)"
    return e.reply(text)
  }

  /** at / atBot 解析结果 */
  async at() {
    const e = this.e
    if (!isQQBot(e)) return false
    const ats = (e.message || []).filter(i => i.type === "at")
    return e.reply(
      [
        `e.atBot：${e.atBot === true}`,
        `e.at：${e.at ?? "(无)"}`,
        `e.msg：${e.msg || "(空)"}`,
        `at 元素：${
          ats.length
            ? ats
                .map(i => `${i.qq}${i.is_you != null ? `(is_you=${i.is_you})` : ""}`)
                .join("、")
            : "(无)"
        }`,
      ].join("\n"),
    )
  }

  /** 引用回复 */
  async quote() {
    const e = this.e
    if (!isQQBot(e)) return false
    return e.reply([segment.reply(e.message_id), "这是引用回复（segment.reply）"])
  }

  /** 读取被引用消息 */
  async quoted() {
    const e = this.e
    if (!isQQBot(e)) return false
    const reply_id = e.reply_id || e.raw?.message_reference?.message_id
    const quote = quotedFromEvent(e)
    if (!reply_id && !quote) return e.reply("请先引用一条消息，再发送 #qqbot引用消息")
    const lines = []
    if (reply_id) lines.push(`被引用消息 ID：${reply_id}`)
    if (quote?.idx) lines.push(`引用索引：${quote.idx}`)
    try {
      const msg = typeof e.getReply === "function" ? await e.getReply() : null
      if (msg) {
        lines.push(`内容：${msg.raw_message || "(空)"}`)
        lines.push(`发送者：${msg.sender?.nickname || msg.sender?.user_id || msg.user_id || "未知"}`)
        lines.push(`时间：${msg.time ? new Date(msg.time * 1000).toLocaleString() : "未知"}`)
        return e.reply(lines.join("\n"))
      }
    } catch (err) {
      lines.push(`读取缓存失败：${errText(err)}`)
    }
    if (quote) {
      lines.push(`内容：${quote.content || "(空)"}`)
      lines.push("（来自消息事件的引用元素；重启适配器后可结合本地缓存显示发送者/时间）")
      return e.reply(lines.join("\n"))
    }
    lines.push("本地缓存中没有这条消息（只缓存最近 10 分钟）")
    return e.reply(lines.join("\n"))
  }

  async fetchJoinRequests(e) {
    const sdk = e.bot?.sdk
    if (!sdk?.groupService?.getJoinRequests) throw new Error("当前适配器不支持入群申请接口")
    const res = await sdk.groupService.getJoinRequests(rawId(e.group_id), { limit: 20 })
    return res?.list || []
  }

  /** 待审批入群申请 */
  async joinList() {
    const e = this.e
    if (!isQQBot(e)) return false
    if (!(await this.checkAdmin(e))) return false
    try {
      const list = await this.fetchJoinRequests(e)
      if (!list.length) return e.reply("当前没有待审批的入群申请")
      return e.reply(
        [
          `待审批入群申请（${list.length}）：`,
          ...list.map(
            (i, idx) =>
              `${idx + 1}. ${i.username || i.member_openid}（${i.member_openid}） 申请时间：${i.apply_at || "未知"}`,
          ),
          "",
          "使用 #qqbot同意进群 序号 / #qqbot拒绝进群 序号 处理",
        ].join("\n"),
      )
    } catch (err) {
      return e.reply(`❌ 获取入群申请失败：${errText(err)}`)
    }
  }

  async joinApprove() {
    return this.dealJoin("approve")
  }

  async joinDecline() {
    return this.dealJoin("decline")
  }

  /** 拒绝入群并拉黑申请人 */
  async joinBlacklistDecline() {
    const e = this.e
    if (!isQQBot(e)) return false
    if (!(await this.checkAdmin(e))) return false
    try {
      const list = await this.fetchJoinRequests(e)
      if (!list.length) return e.reply("当前没有待审批的入群申请")
      const idx = Number((e.msg.match(/\d+/) || [])[0] || 1)
      const item = list[idx - 1]
      if (!item) return e.reply(`序号超出范围（共 ${list.length} 条）`)
      const rawGroupId = rawId(e.group_id)
      await e.bot.sdk.groupService.approveJoinRequest(rawGroupId, item.member_openid, {
        op: "decline",
        join_request_id: item.join_request_id,
        reject_reason: "管理员拒绝并拉黑",
      })
      await e.bot.sdk.groupService.updateMemberBlacklist(rawGroupId, {
        op: "add",
        member_openids: [item.member_openid],
      })
      return e.reply(`✅ 已拒绝并拉黑 ${item.username || item.member_openid} 的入群申请`)
    } catch (err) {
      return e.reply(`❌ 拉黑拒绝失败：${errText(err)}`)
    }
  }

  /** 写入一条测试报错，用于验证 WebUI 报错页的用户/群/指令上下文 */
  async testError() {
    const e = this.e
    if (!isQQBot(e)) return false
    const adapter = e.bot?.adapter
    if (!adapter?.errorStore?.capture) return e.reply("当前适配器没有报错归档")
    const err = new Error("测试报错 code(99999999): 获取群成员列表失败（测试）")
    try {
      // 故意使用无效群 openid，模拟群成员列表接口失败
      await e.bot.sdk.groupService.getMembers("invalid-group-openid")
    } catch (apiErr) {
      err.cause = apiErr
    }
    adapter.errorStore.capture(e.self_id, ["测试报错", err], adapter.errorContext?.(e) || {})
    return e.reply("✅ 已写入测试报错，请到 WebUI「报错」页查看用户 / 群 / 指令上下文")
  }

  async dealJoin(op) {
    const e = this.e
    if (!isQQBot(e)) return false
    if (!(await this.checkAdmin(e))) return false
    try {
      const list = await this.fetchJoinRequests(e)
      if (!list.length) return e.reply("当前没有待审批的入群申请")
      const idx = Number((e.msg.match(/\d+/) || [])[0] || 1)
      const item = list[idx - 1]
      if (!item) return e.reply(`序号超出范围（共 ${list.length} 条）`)
      await e.bot.sdk.groupService.approveJoinRequest(rawId(e.group_id), item.member_openid, {
        op,
        join_request_id: item.join_request_id,
        ...(op === "decline" ? { reject_reason: "管理员拒绝" } : {}),
      })
      return e.reply(
        `${op === "approve" ? "✅ 已同意" : "✅ 已拒绝"} ${item.username || item.member_openid} 的入群申请`,
      )
    } catch (err) {
      return e.reply(`❌ 审批失败：${errText(err)}`)
    }
  }
}

// ---- 事件测试 ----

// 群成员进群：只记日志，不自动发消息，避免大群刷屏
Bot.on("notice.group.increase", e => {
  if (!isQQBot(e)) return
  logger.mark(`[QQBot测试] 群成员进群：${e.group_id} ${e.user_id} 操作人：${e.operator_id || "无"}`)
})

// 群成员退群：只记日志
Bot.on("notice.group.decrease", e => {
  if (!isQQBot(e)) return
  logger.mark(`[QQBot测试] 群成员退群：${e.group_id} ${e.user_id}`)
})

// 机器人被拉进群：只记日志，不自动发消息
Bot.on("notice.group.bot.increase", e => {
  if (!isQQBot(e)) return
  logger.mark(`[QQBot测试] 机器人被拉入群：${e.group_id}`)
})

// 入群申请（需要机器人是管理员，并且 WebSocket 订阅 GROUP_MEMBER / 1<<24）
Bot.on("notice.group.join_request", e => {
  if (!isQQBot(e)) return
  logger.mark(
    `[QQBot测试] 收到入群申请：${e.username}(${e.user_id}) 群：${e.group_id} join_request_id：${e.join_request_id}`,
  )
})
