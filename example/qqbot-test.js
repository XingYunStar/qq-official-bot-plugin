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
/** 去掉 `机器人appid<sep>` 前缀；兼容历史分隔符 ":" / U+F03A 与当前 "_" */
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

/** 9MB 测试图（公网 URL） */
const BIG_IMAGE_URL =
  "https://img.likefirefly.com/image.Firefly?file=illust_116147020_20240428_011746.jpg"

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
        { reg: "^#qqbot(webui|WebUI)$", fnc: "webui" },
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
        "#qqbot9MB —— 发送一张 9MB 测试图片（素材上传/大图测试）",
        "#qqbot图文 —— 发送一条图文卡片消息（群聊/单聊）",
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
        "",
        "进群/退群/入群申请事件会自动提示；群管理接口要求机器人是群管理员。",
      ].join("\n"),
    )
  }

  /** 撤回：优先撤回被引用的消息，否则发一条再撤回 */
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
    await e.reply({
      type: "card",
      content: {
        title: "QQ 官方机器人 · 图文卡片",
        description: "来自 qq-official-bot-plugin 的图文卡片消息测试",
        url: "https://github.com/XingYunStar/qq-official-bot-plugin",
        pic_url:
          "https://img.likefirefly.com/image.Firefly?file=illust_116147020_20240428_011746.jpg",
      },
    })
    return true
  }

  /** 发送一张 9MB 图片（公网 URL），测试素材上传/大图压缩 */
  async bigImage() {
    const e = this.e
    if (!isQQBot(e)) return false
    if (!(await this.checkAdmin(e))) return false
    const image = segment.image(BIG_IMAGE_URL)
    // 大图测试：跳过适配器的压缩（默认会压到 imageLength，3MB）
    image.noCompress = true
    await e.reply(image)
    logger.mark(`[qqbot-test] 已发送 9MB 测试图片（不压缩）：${BIG_IMAGE_URL}`)
    return true
  }

  /** 连续发送 10 条消息，用来验证被动回复消息池（每条消息最多回复 5 次） */
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
      return e.reply(`❌ 踢人失败：${errText(err)}\n（需要机器人是群管理员）`)
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

// 群成员进群
Bot.on("notice.group.increase", async e => {
  if (!isQQBot(e)) return
  try {
    await e.reply(`欢迎 ${e.user_id} 加入本群（notice.group.increase 测试）`)
  } catch (err) {
    logger.error(`[QQBot测试] 进群欢迎失败：${errText(err)}`)
  }
  logger.mark(`[QQBot测试] 群成员进群：${e.group_id} ${e.user_id} 操作人：${e.operator_id || "无"}`)
})

// 群成员退群
Bot.on("notice.group.decrease", e => {
  if (!isQQBot(e)) return
  logger.mark(`[QQBot测试] 群成员退群：${e.group_id} ${e.user_id}`)
})

// 机器人被拉进群
Bot.on("notice.group.bot.increase", async e => {
  if (!isQQBot(e)) return
  logger.mark(`[QQBot测试] 机器人被拉入群：${e.group_id}`)
  try {
    await e.reply("QQBot 已加入本群（notice.group.bot.increase 测试）")
  } catch (err) {
    logger.error(`[QQBot测试] 入群欢迎失败：${errText(err)}`)
  }
})

// 入群申请（需要机器人是管理员才会收到）
Bot.on("notice.group.join_request", e => {
  if (!isQQBot(e)) return
  logger.mark(
    `[QQBot测试] 收到入群申请：${e.username}(${e.user_id}) 群：${e.group_id} join_request_id：${e.join_request_id}`,
  )
})
