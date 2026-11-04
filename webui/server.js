/**
 * QQBot WebUI
 * 独立 HTTP 服务，默认监听 0.0.0.0:2580。
 * Docker 内需要把宿主机端口反向代理到容器内 IP:2580。
 */
import http from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import YAML from "yaml"
import axios from "axios"
import { startQrLogin, pollQrLogin } from "./qqlogin.js"

const DATA_DIR = path.join("data", "QQBot")
const AUTH_FILE = path.join(DATA_DIR, "webui.json")
const STATS_API = "https://bot.q.qq.com/cgi-bin/v2/datareport/query"

let running = null

const json = (res, code, data) => {
  const body = JSON.stringify(data)
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" })
  res.end(body)
}

const readBody = req =>
  new Promise((resolve, reject) => {
    let data = ""
    req.on("data", chunk => {
      data += chunk
      if (data.length > 10 * 1024 * 1024) reject(new Error("body too large"))
    })
    req.on("end", () => resolve(data))
    req.on("error", reject)
  })

function randomPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
  let out = ""
  for (const byte of crypto.randomBytes(12)) out += chars[byte % chars.length]
  return out
}

async function loadAuth() {
  try {
    const data = JSON.parse(await fs.readFile(AUTH_FILE, "utf8"))
    if (data.password && data.secret) return data
  } catch {}
  const data = {
    password: process.env.QQBOT_WEBUI_PASSWORD || randomPassword(),
    secret: crypto.randomBytes(24).toString("hex"),
    qqCookie: "",
    qqCookieAt: 0,
  }
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 })
  return data
}

async function saveAuth(auth) {
  await fs.writeFile(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 })
}

function tokenOf(auth) {
  return crypto.createHmac("sha256", auth.secret).update(auth.password).digest("hex")
}

function parseCookies(req) {
  const out = {}
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=")
    if (index > 0) out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

async function configFiles() {
  const files = new Set(["config/QQBot.yaml"])
  for (const dir of ["config", "config/config"]) {
    try {
      for (const name of await fs.readdir(dir))
        if (/\.(ya?ml)$/.test(name)) files.add(`${dir}/${name}`)
    } catch {}
  }
  return [...files]
}

const statsRange = { "7d": 0, "14d": 1, "30d": 2 }

function mapDaily(row) {
  return {
    date: String(row.report_date),
    activeUsers: +(row.active_user_cnt || 0),
    activeGroups: +(row.active_group_cnt || 0),
    activeGuilds: +(row.active_guild_cnt || 0),
    messages: +(row.up_msg?.total || 0),
    c2c: +(row.up_msg?.c2c || 0),
    group: +(row.up_msg?.group || 0),
    friends: +(row.friends?.stock_cnt || 0),
    friendsAdd: +(row.friends?.add_cnt || 0),
    friendsRemove: +(row.friends?.remove_cnt || 0),
    groups: +(row.groups?.stock_cnt || 0),
    groupsAdd: +(row.groups?.add_cnt || 0),
    groupsRemove: +(row.groups?.remove_cnt || 0),
    guilds: +(row.guilds?.stock_cnt || 0),
    newUsers: +(row.new_user_cnt || 0),
    replyCount: +(row.reply_cnt || 0),
    replyRate: +(row.reply_rate || 0),
    avgResponse: +(row.avg_response_time || 0),
  }
}

function summarize(rows) {
  const sum = key => rows.reduce((n, r) => n + (r[key] || 0), 0)
  const last = rows[rows.length - 1] || {}
  return {
    days: rows.length,
    activeUsers: sum("activeUsers"),
    messages: sum("messages"),
    c2c: sum("c2c"),
    group: sum("group"),
    newUsers: sum("newUsers"),
    replyCount: sum("replyCount"),
    friends: last.friends || 0,
    groups: last.groups || 0,
    guilds: last.guilds || 0,
    avgActiveUsers: rows.length ? Math.round(sum("activeUsers") / rows.length) : 0,
    avgMessages: rows.length ? Math.round(sum("messages") / rows.length) : 0,
    replyRate: rows.length ? +(sum("replyCount") / Math.max(1, sum("messages")) * 100).toFixed(2) : 0,
  }
}

export function startWebUI({ adapter, config, configSave, Bot, logger }) {
  if (running) return running
  const settings = config.webui || {}
  if (settings.enabled === false) return null
  const port = Number(settings.port) || 2580
  const host = settings.host || "0.0.0.0"

  const auth = loadAuth()
  const htmlFile = path.join(import.meta.dirname, "index.html")

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost")
      const pathname = decodeURIComponent(url.pathname)

      if (pathname === "/" || pathname === "/index.html") {
        const html = await fs.readFile(htmlFile)
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        return res.end(html)
      }

      if (pathname === "/api/login" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}")
        const authData = await auth
        if (String(body.password || "") !== authData.password)
          return json(res, 401, { error: "密码错误" })
        res.setHeader(
          "Set-Cookie",
          `qqbot_webui=${tokenOf(authData)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        )
        return json(res, 200, { ok: true })
      }

      const authData = await auth
      const token = parseCookies(req).qqbot_webui
      if (!token || token !== tokenOf(authData)) return json(res, 401, { error: "未登录" })

      // ---- status ----
      if (pathname === "/api/status") {
        const bots = []
        for (const [id, bot] of Object.entries(Bot)) {
          if (!bot || typeof bot !== "object" || !bot.sdk || bot.adapter !== adapter) continue
          bots.push({
            id,
            appid: bot.info?.appid || "",
            online: !!bot.sdk,
            webhook: !!adapter.appid[bot.info?.appid],
          })
        }
        return json(res, 200, {
          version: adapter.version,
          port,
          bots,
          authFile: AUTH_FILE,
          configFiles: await configFiles(),
        })
      }

      // ---- config ----
      if (pathname === "/api/config" && req.method === "GET") {
        const file = url.searchParams.get("file") || "config/QQBot.yaml"
        if (!(await configFiles()).includes(file)) return json(res, 400, { error: "不允许的文件" })
        try {
          const content = await fs.readFile(file, "utf8")
          return json(res, 200, { file, content })
        } catch (err) {
          return json(res, 404, { error: String(err.message || err) })
        }
      }
      if (pathname === "/api/config" && req.method === "PUT") {
        const body = JSON.parse((await readBody(req)) || "{}")
        const file = body.file
        if (!(await configFiles()).includes(file)) return json(res, 400, { error: "不允许的文件" })
        let parsed
        try {
          parsed = YAML.parse(body.content || "")
        } catch (err) {
          return json(res, 400, { error: `YAML 格式错误：${err.message || err}` })
        }
        if (!parsed || typeof parsed !== "object") return json(res, 400, { error: "YAML 内容必须为对象" })
        await fs.writeFile(file, body.content, "utf8")
        if (file === "config/QQBot.yaml") {
          for (const key of Object.keys(config)) delete config[key]
          Object.assign(config, parsed)
          try {
            await configSave()
          } catch {}
        }
        return json(res, 200, { ok: true, note: "部分设置需要重启 TRSS 生效" })
      }

      // ---- logs ----
      if (pathname === "/api/logs/files") {
        let files = []
        try {
          files = (await fs.readdir("logs"))
            .filter(f => !f.endsWith(".zst"))
            .sort()
            .reverse()
            .slice(0, 80)
        } catch {}
        return json(res, 200, { files })
      }
      if (pathname === "/api/logs") {
        const file = path.basename(url.searchParams.get("file") || "error.log")
        const tail = Math.min(2000, Math.max(10, Number(url.searchParams.get("tail")) || 200))
        try {
          const text = await fs.readFile(path.join("logs", file), "utf8")
          const lines = text.split("\n")
          return json(res, 200, { file, lines: lines.slice(-tail) })
        } catch (err) {
          return json(res, 404, { error: String(err.message || err) })
        }
      }
      if (pathname === "/api/logs/stream") {
        const file = path.basename(url.searchParams.get("file") || "error.log")
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        })
        let offset = 0
        try {
          const stat = await fs.stat(path.join("logs", file))
          offset = Math.max(0, stat.size - 64 * 1024)
        } catch {}
        const timer = setInterval(async () => {
          try {
            const filePath = path.join("logs", file)
            const stat = await fs.stat(filePath)
            if (stat.size < offset) offset = 0
            if (stat.size === offset) return
            const handle = await fs.open(filePath, "r")
            const length = stat.size - offset
            const buffer = Buffer.alloc(length)
            await handle.read(buffer, 0, length, offset)
            await handle.close()
            offset = stat.size
            const text = buffer.toString("utf8")
            for (const line of text.split("\n")) if (line.trim()) res.write(`data: ${line}\n`)
          } catch {}
        }, 1500)
        req.on("close", () => clearInterval(timer))
        return
      }

      // ---- materials ----
      if (pathname === "/api/materials" && req.method === "GET") {
        const id = url.searchParams.get("bot") || Object.keys(Bot).find(i => Bot[i]?.adapter === adapter)
        const list = []
        for (const [imageId, item] of adapter.materials[id] || [])
          list.push({ image_id: imageId, url: item.url, uses: item.uses, uploadedAt: item.t })
        if (Bot[id]?.sdk?.getMaterialImages)
          try {
            for (const image of await Bot[id].sdk.getMaterialImages())
              if (!list.some(i => i.image_id === image.image_id))
                list.push({ image_id: image.image_id, url: image.url, uses: 0, remote: true })
          } catch (err) {
            return json(res, 200, { list, warning: String(err.message || err) })
          }
        return json(res, 200, { list })
      }
      if (pathname === "/api/materials" && req.method === "DELETE") {
        const id = url.searchParams.get("bot")
        const imageId = url.searchParams.get("id")
        if (!id || !imageId) return json(res, 400, { error: "缺少参数" })
        try {
          await Bot[id].sdk.deleteMaterialImage(imageId)
        } catch (err) {
          return json(res, 500, { error: String(err.message || err) })
        }
        adapter.materials[id]?.delete(imageId)
        return json(res, 200, { ok: true })
      }

      // ---- groups ----
      if (pathname === "/api/groups") {
        const id = url.searchParams.get("bot")
        const groups = []
        for (const [group, info] of (await adapter.getGroupMap?.(id)) || [])
          groups.push({ group, name: info?.group_name || info?.name || "" })
        return json(res, 200, { groups })
      }
      if (pathname === "/api/group/members") {
        const id = url.searchParams.get("bot")
        const group = url.searchParams.get("group")
        try {
          const result = await Bot[id].sdk.groupService.getMembers(group)
          return json(res, 200, { members: result?.members || result?.data || result })
        } catch (err) {
          return json(res, 500, { error: String(err.message || err) })
        }
      }
      if (pathname === "/api/group/blacklist" && req.method === "GET") {
        const id = url.searchParams.get("bot")
        const group = url.searchParams.get("group")
        try {
          const result = await Bot[id].sdk.groupService.getMemberBlacklist(group)
          return json(res, 200, { users: result?.users || [] })
        } catch (err) {
          return json(res, 500, { error: String(err.message || err) })
        }
      }
      if (pathname === "/api/group/blacklist" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}")
        const { bot, group, op, members } = body
        try {
          const result = await Bot[bot].sdk.groupService.updateMemberBlacklist(group, {
            op: op === "add" ? "add" : "del",
            member_openids: members || [],
          })
          return json(res, 200, result || { ok: true })
        } catch (err) {
          return json(res, 500, { error: String(err.message || err) })
        }
      }
      if (pathname === "/api/group/action" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}")
        const { bot, group, action, member, seconds, blacklist } = body
        try {
          if (action === "mute") await adapter.muteMember(bot, group, member, seconds || 600)
          else if (action === "unmute") await adapter.muteMember(bot, group, member, 0)
          else if (action === "kick") await adapter.kickMember(bot, group, member, !!blacklist)
          else return json(res, 400, { error: "未知操作" })
          return json(res, 200, { ok: true })
        } catch (err) {
          return json(res, 500, { error: String(err.message || err) })
        }
      }

      // ---- menu / command panels ----
      if (pathname === "/api/menu" && req.method === "GET") {
        const id = url.searchParams.get("bot")
        try {
          const service = Bot[id].sdk.menuPanelService
          const [menu, panels] = await Promise.all([
            service.getCustomMenu().catch(() => null),
            service.getCommandPanels({}).catch(() => null),
          ])
          return json(res, 200, {
            menu: menu?.menu ?? menu ?? null,
            panels: panels?.panels ?? panels?.list ?? panels ?? [],
          })
        } catch (err) {
          return json(res, 500, { error: String(err.message || err) })
        }
      }
      if (pathname === "/api/menu" && req.method === "PUT") {
        const body = JSON.parse((await readBody(req)) || "{}")
        try {
          const result = await Bot[body.bot].sdk.menuPanelService.updateCustomMenu(body.menu)
          return json(res, 200, result || { ok: true })
        } catch (err) {
          return json(res, 500, { error: String(err.message || err) })
        }
      }
      if (pathname === "/api/panel" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}")
        try {
          const result = await Bot[body.bot].sdk.menuPanelService.createCommandPanel(body.panel)
          return json(res, 200, result || { ok: true })
        } catch (err) {
          return json(res, 500, { error: String(err.message || err) })
        }
      }
      if (pathname === "/api/panel" && req.method === "DELETE") {
        const id = url.searchParams.get("bot")
        const panelId = url.searchParams.get("id")
        try {
          await Bot[id].sdk.menuPanelService.deleteCommandPanel(panelId)
          return json(res, 200, { ok: true })
        } catch (err) {
          return json(res, 500, { error: String(err.message || err) })
        }
      }

      // ---- qq login cookie / stats ----
      if (pathname === "/api/qq/qr" && req.method === "POST") {
        try {
          return json(res, 200, await startQrLogin())
        } catch (err) {
          return json(res, 500, { error: String(err.message || err) })
        }
      }
      if (pathname === "/api/qq/qr/status") {
        try {
          const result = await pollQrLogin(url.searchParams.get("id"))
          if (result.status === "success" && result.cookie) {
            authData.qqCookie = result.cookie
            authData.qqCookieAt = Date.now()
            authData.qqDeveloper = result.developer || null
            await saveAuth(authData)
          }
          return json(res, 200, result)
        } catch (err) {
          return json(res, 400, { error: String(err.message || err) })
        }
      }
      if (pathname === "/api/qq/bots") {
        if (!authData.qqCookie) return json(res, 401, { error: "请先登录 QQ 开放平台" })
        try {
          const { data } = await axios.get("https://bot.q.qq.com/cgi-bin/v2/info/list_bots", {
            headers: { Cookie: authData.qqCookie },
            timeout: 15000,
          })
          if (data?.retcode !== 0) return json(res, 400, { error: data?.msg || "获取机器人列表失败" })
          return json(res, 200, { bots: data.data?.bots || [] })
        } catch (err) {
          return json(res, 500, { error: String(err.response?.data?.msg || err.message || err) })
        }
      }
      if (pathname === "/api/qq/status") {
        return json(res, 200, {
          loggedIn: !!authData.qqCookie,
          at: authData.qqCookieAt || 0,
          file: AUTH_FILE,
        })
      }
      if (pathname === "/api/qq/cookie" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}")
        const cookie = String(body.cookie || "").trim()
        if (!cookie) return json(res, 400, { error: "cookie 为空" })
        authData.qqCookie = cookie
        authData.qqCookieAt = Date.now()
        await saveAuth(authData)
        return json(res, 200, { ok: true })
      }
      if (pathname === "/api/stats") {
        const botId = url.searchParams.get("bot")
        const range = url.searchParams.get("range") || "7d"
        const start = url.searchParams.get("start") || ""
        const end = url.searchParams.get("end") || ""
        let appid = url.searchParams.get("appid")
        if (!appid) {
          const bot = Bot[botId]
          appid = bot?.info?.appid
          if (!appid) {
            const line = (config.token || []).find(item => String(item).startsWith(`${botId}:`))
            appid = line?.split(":")[1]
          }
        }
        if (!authData.qqCookie) return json(res, 401, { error: "请先在 WebUI 中导入 QQ 开放平台 Cookie" })
        if (!appid) return json(res, 400, { error: "找不到 AppID" })
        const dataRange = statsRange[range] ?? 2
        try {
          const { data } = await axios.post(
            STATS_API,
            { bot_appid: Number(appid), data_range: dataRange, data_type: 4 },
            { headers: { Cookie: authData.qqCookie, "Content-Type": "application/json" }, timeout: 15000 },
          )
          if (data?.retcode !== 0) return json(res, 400, { error: data?.msg || "接口返回错误" })
          let rows = (data.data?.developer_metrics_data || []).map(mapDaily).sort((a, b) => a.date.localeCompare(b.date))
          if (start || end)
            rows = rows.filter(r => (!start || r.date >= start.replace(/-/g, "")) && (!end || r.date <= end.replace(/-/g, "")))
          if (range === "month") {
            const month = String(new Date().getFullYear()) + String(new Date().getMonth() + 1).padStart(2, "0")
            rows = rows.filter(r => r.date.startsWith(month))
          }
          if (range === "today") rows = rows.slice(-1)
          else if (range === "yesterday") rows = rows.slice(-2, -1)
          return json(res, 200, {
            appid,
            range,
            daily: rows,
            summary: summarize(rows),
            updatedAt: Date.now(),
            limited: "官方接口仅提供最近 7/14/30 天，月/总览/自定义范围基于 30 天数据计算",
          })
        } catch (err) {
          return json(res, 500, { error: String(err.response?.data?.msg || err.message || err) })
        }
      }

      return json(res, 404, { error: "not found" })
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  })

  server.on("error", err => logger.error(logger.red(`[QQBot WebUI] 启动失败：${err.message || err}`)))

  auth.then(authData => {
    logger.info(logger.magenta("================ QQBot WebUI ================"))
    logger.info(logger.magenta(`地址：http://127.0.0.1:${port}/`))
    logger.info(logger.magenta(`密码：${authData.password}`))
    logger.info(logger.magenta(`密码也会保存在：${path.resolve(AUTH_FILE)}`))
    logger.info(logger.magenta("Docker 部署请把宿主机端口反向代理到容器内 IP:端口"))
    logger.info(logger.magenta("============================================"))
  })
  server.listen(port, host, () => {})

  running = { server, port, auth }
  return running
}
