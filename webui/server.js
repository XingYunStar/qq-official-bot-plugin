/**
 * QQBot WebUI
 * 独立 HTTP 服务，默认监听 0.0.0.0:2580。
 * Docker 内需要把宿主机端口反向代理到容器内 IP:2580。
 */
import http from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import os from "node:os"
import { execFile as execFileCb } from "node:child_process"
import { promisify, format as formatUtil } from "node:util"
import YAML from "yaml"
import axios from "axios"
import { startQrLogin, pollQrLogin, selectDeveloper } from "../components/qqlogin.js"
import { fetchStats } from "../model/stats.js"
import { fetchBotQQ } from "../components/token.js"
import { dayKey } from "../components/group-stats.js"

const DATA_DIR = path.join("data", "QQBot")
const AUTH_FILE = path.join(DATA_DIR, "webui.json")
/** 日志读取上限：error.log 可能达到数百 MB，不能整文件读入 */
const LOG_TAIL_BYTES = 16 * 1024 * 1024

/** 从文件尾部读取，避免大日志触发 "Invalid string length" */
async function readLogTail(filePath, maxLines = 200) {
  const stat = await fs.stat(filePath)
  const start = Math.max(0, stat.size - LOG_TAIL_BYTES)
  const handle = await fs.open(filePath, "r")
  let text
  try {
    const buffer = Buffer.alloc(stat.size - start)
    await handle.read(buffer, 0, buffer.length, start)
    text = buffer.toString("utf8")
  } finally {
    await handle.close()
  }
  // 从文件中间开始时，第一行通常是不完整的，丢掉
  if (start > 0) {
    const nl = text.indexOf("\n")
    if (nl !== -1) text = text.slice(nl + 1)
  }
  return {
    lines: text.split("\n").map(humanizeLogLine).slice(-maxLines),
    truncated: start > 0,
    size: stat.size,
  }
}

let running = null
let passwordRevealAt = 0

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
      if (data.length > 25 * 1024 * 1024) reject(new Error("body too large"))
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

export async function isWebUIInitialized() {
  try {
    const data = JSON.parse(await fs.readFile(AUTH_FILE, "utf8"))
    return !!(data.password && data.secret && data.initialized)
  } catch { return false }
}

async function loadAuth() {
  try {
    const data = JSON.parse(await fs.readFile(AUTH_FILE, "utf8"))
    if (data.password && data.secret) {
      if (typeof data.initialized !== "boolean") data.initialized = false
      return data
    }
  } catch {}
  // 首次未登录前不落盘：只有真正登录/设置密码后才创建 webui.json
  return {
    password: process.env.QQBOT_WEBUI_PASSWORD || randomPassword(),
    secret: crypto.randomBytes(24).toString("hex"),
    initialized: false,
    qqCookie: "",
    qqCookieAt: 0,
  }
}

async function saveAuth(auth) {
  await fs.mkdir(DATA_DIR, { recursive: true })
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

const qqGroupCache = new Map()
const chatMediaCache = new Map()
const chatMembersResponseCache = new Map()
let sharpModule
async function chatThumbnail(buffer, type) {
  if (!/^image\/(jpeg|png|webp|bmp)$/i.test(type || "")) return { data: buffer, type }
  if (buffer.length < 180 * 1024) return { data: buffer, type }
  try {
    sharpModule ||= (await import("sharp")).default
    const image = sharpModule(buffer, { failOn: "none" })
    const meta = await image.metadata()
    if ((meta.width || 0) <= 1400 && (meta.height || 0) <= 1400 && buffer.length < 1.2 * 1024 * 1024)
      return { data: buffer, type }
    const data = await image
      .rotate()
      .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer()
    return { data, type: "image/webp" }
  } catch {
    return { data: buffer, type }
  }
}
async function fetchQQGroups(appid, cookie) {
  if (!appid || !cookie) return []
  const key = String(appid)
  const cached = qqGroupCache.get(key)
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.groups
  const groups = []
  let paging = ""
  try {
    for (let page = 0; page < 30; page++) {
      const { data } = await axios.post(
        "https://bot.q.qq.com/cgi-bin/v2/bot_scope_manager/bot_group_list/query",
        { bot_appid: Number(appid), paging_cookie: paging, page_size: 100 },
        { headers: { Cookie: cookie, "Content-Type": "application/json" }, timeout: 15000 },
      )
      if (data?.retcode !== 0) break
      const d = data.data || {}
      for (const g of d.groups || [])
        if (g.group_id) groups.push({ group_id: String(g.group_id), name: g.group_name || "", in_group: !!g.in_group })
      paging = d.next_paging_cookie || ""
      if (!d.has_more || !paging) break
    }
  } catch {}
  qqGroupCache.set(key, { at: Date.now(), groups })
  return groups
}
const groupAvatarFile = path.join("data", "QQBot", "group-avatar-cache.json")
let groupAvatarMatches = null
let groupAvatarSaveTimer = null
async function loadGroupAvatarCache() {
  if (groupAvatarMatches) return groupAvatarMatches
  try { groupAvatarMatches = JSON.parse(await fs.readFile(groupAvatarFile, "utf8")) } catch { groupAvatarMatches = {} }
  return groupAvatarMatches
}
function saveGroupAvatarCache() {
  if (groupAvatarSaveTimer) return
  groupAvatarSaveTimer = setTimeout(async () => {
    groupAvatarSaveTimer = null
    try {
      await fs.mkdir(path.dirname(groupAvatarFile), { recursive: true })
      const tmp = `${groupAvatarFile}.tmp`
      await fs.writeFile(tmp, JSON.stringify(groupAvatarMatches || {}))
      await fs.rename(tmp, groupAvatarFile)
    } catch {}
  }, 1500)
  groupAvatarSaveTimer.unref?.()
}
function oneBotGroupIndex() {
  const found = new Map()
  const ambiguous = new Set()
  for (const bot of Object.values(globalThis.Bot || {})) {
    if (!bot || !bot.gl) continue
    const values = typeof bot.gl.values === "function" ? bot.gl.values() : Object.values(bot.gl)
    for (const g of values) {
      const groupId = String(g?.group_id || "")
      const name = String(g?.group_name || g?.name || "").trim()
      if (!/^\d+$/.test(groupId) || !name) continue
      const old = found.get(name)
      if (old && old.group_id !== groupId) { ambiguous.add(name); continue }
      if (!old) found.set(name, { group_id: groupId, source: "onebot" })
    }
  }
  for (const name of ambiguous) found.delete(name)
  return found
}
async function resolveGroupAvatarMatch(groupKey, name, qqByName, oneBotCache = null) {
  name = String(name || "").trim()
  if (!groupKey) return ""
  const cache = await loadGroupAvatarCache()
  const old = cache[groupKey]
  if (old && Date.now() - (old.at || 0) < 5 * 60 * 1000) return groupAvatar(old.group_id)
  if (name) {
    const oneBot = (oneBotCache || oneBotGroupIndex()).get(name)
    const hit = oneBot || qqByName.get(name)
    if (hit) {
      cache[groupKey] = { group_id: hit.group_id, name, at: Date.now(), source: hit.source || "qq" }
      saveGroupAvatarCache()
      return groupAvatar(hit.group_id)
    }
  }
  // 没有拿到新数据时保留旧缓存，不因为超过 5 分钟就丢弃
  return old ? groupAvatar(old.group_id) : ""
}

const avatarCache = new Map()
function groupAvatar(groupId) {
  return groupId ? `/api/group/avatar?group=${encodeURIComponent(groupId)}` : ""
}

const execFile = promisify(execFileCb)
let sysPrev = { cpu: null, net: null, at: 0 }
function cpuSnapshot() {
  let idle = 0, total = 0
  for (const c of os.cpus()) {
    idle += c.times.idle
    total += Object.values(c.times).reduce((a, b) => a + b, 0)
  }
  return { idle, total }
}
async function systemInfo(Bot) {
  const now = Date.now()
  const cpu = cpuSnapshot()
  let cpuUsage = 0
  if (sysPrev.cpu) {
    const dIdle = cpu.idle - sysPrev.cpu.idle
    const dTotal = cpu.total - sysPrev.cpu.total
    if (dTotal > 0) cpuUsage = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100))
  }
  sysPrev.cpu = cpu
  let swapTotal = 0, swapFree = 0
  try {
    const meminfo = await fs.readFile("/proc/meminfo", "utf8")
    const pick = k => Number((meminfo.match(new RegExp(`^${k}:\\s+(\\d+)`, "m")) || [])[1] || 0) * 1024
    swapTotal = pick("SwapTotal")
    swapFree = pick("SwapFree")
  } catch {}
  let disk = null
  try {
    const st = await fs.statfs("/")
    const total = Number(st.blocks) * Number(st.bsize)
    const free = Number(st.bavail) * Number(st.bsize)
    disk = { total, free, used: Math.max(0, total - free), percent: total ? (1 - free / total) * 100 : 0 }
  } catch {}
  let net = { rx: 0, tx: 0, rxRate: 0, txRate: 0 }
  try {
    const raw = await fs.readFile("/proc/net/dev", "utf8")
    let rx = 0, tx = 0
    for (const line of raw.split("\n").slice(2)) {
      const [name, data] = line.split(":")
      if (!name || !data || name.trim() === "lo") continue
      const parts = data.trim().split(/\s+/).map(Number)
      rx += parts[0] || 0
      tx += parts[8] || 0
    }
    const dt = sysPrev.net ? Math.max(0.2, (now - sysPrev.at) / 1000) : 1
    net = {
      rx, tx,
      rxRate: sysPrev.net ? Math.max(0, (rx - sysPrev.net.rx) / dt) : 0,
      txRate: sysPrev.net ? Math.max(0, (tx - sysPrev.net.tx) / dt) : 0,
    }
    sysPrev.net = { rx, tx }
    sysPrev.at = now
  } catch {}
  const interfaces = []
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const i of list || [])
      if (i.family === "IPv4" && !i.internal) interfaces.push({ name, address: i.address, mac: i.mac })
  let gpu = []
  try {
    const { stdout } = await execFile(
      "nvidia-smi",
      ["--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"],
      { timeout: 2000 },
    )
    gpu = stdout.trim().split("\n").filter(Boolean).map(line => {
      const [name, util, used, total, temp] = line.split(",").map(s => s.trim())
      return { name, util: Number(util) || 0, memoryUsed: Number(used) || 0, memoryTotal: Number(total) || 0, temperature: Number(temp) || 0 }
    })
  } catch {}
  const memTotal = os.totalmem(), memFree = os.freemem()
  const proc = process.memoryUsage()
  const bots = Object.values(Bot).filter(b => b?.adapter && b?.sdk).length
  return {
    host: os.hostname(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    uptime: os.uptime(),
    load: os.loadavg(),
    cpu: { model: os.cpus()[0]?.model || "", cores: os.cpus().length, usage: +cpuUsage.toFixed(1) },
    memory: { total: memTotal, free: memFree, used: memTotal - memFree, percent: memTotal ? (1 - memFree / memTotal) * 100 : 0 },
    swap: { total: swapTotal, free: swapFree, used: swapTotal - swapFree, percent: swapTotal ? (1 - swapFree / swapTotal) * 100 : 0 },
    disk,
    network: { ...net, interfaces },
    gpu,
    node: { version: process.version, rss: proc.rss, heapUsed: proc.heapUsed, heapTotal: proc.heapTotal },
    bots,
  }
}

function lookupGroupName(botId, fullId) {
  try {
    const byStats = adapterGroupStatsName(botId, fullId)
    if (byStats) return byStats
    const bot = globalThis.Bot?.[botId]
    const hit = bot?.gl?.get?.(fullId)
    return hit?.group_name || hit?.name || ""
  } catch { return "" }
}
function lookupMemberName(botId, groupFull, userFull) {
  try {
    const bot = globalThis.Bot?.[botId]
    const m = bot?.gml?.get?.(groupFull)?.get?.(userFull)
    if (m?.nickname || m?.username) return m.nickname || m.username
    const fromChat = globalThis.__qqbotChatMembers?.(botId, groupFull)?.find(x => `${botId}:${x.member_openid}` === userFull)
    return fromChat?.username || fromChat?.nickname || ""
  } catch { return "" }
}
function adapterGroupStatsName(botId, fullId) {
  try {
    const stats = globalThis.__qqbotGroupStats?.(botId)
    return stats?.get?.(botId, fullId)?.name || ""
  } catch { return "" }
}
function humanizeLogLine(line) {
  if (typeof line !== "string") return line
  let out = line.replace(/\[(\d+):([A-Za-z0-9_-]{8,}), (\d+):([A-Za-z0-9_-]{8,})\]/g, (m, b1, g1, b2, u2) => {
    const groupFull = `${b1}:${g1}`
    const userFull = `${b2}:${u2}`
    const gname = lookupGroupName(b1, groupFull)
    const uname = lookupMemberName(b2, groupFull, userFull)
    return `[${g1}${gname ? `(${gname})` : ""}, ${u2}${uname ? `(${uname})` : ""}]`
  })
  out = out.replace(/\b(\d+):([A-Fa-f0-9]{16,})\b/g, (m, botId, id) => {
    if (out.includes(`${id}(`)) return m
    const name = lookupGroupName(botId, `${botId}:${id}`)
    return name ? `${id}(${name})` : m
  })
  return out
}

const liveLog = (globalThis.__qqbotLiveLog ||= { entries: [], clients: new Map(), seq: 0, timer: null })
if (!Array.isArray(liveLog.entries)) liveLog.entries = []
if (!(liveLog.clients instanceof Map)) liveLog.clients = new Map()
if (!liveLog.seq) liveLog.seq = 0
const LIVE_LOG_MAX = 3000
const LIVE_LOG_BATCH = 250
const LOG_RANK = { trace: 0, debug: 1, info: 2, mark: 2, warn: 3, error: 4, fatal: 5 }
const LIVE_LEVEL = { all: 0, debug: 1, info: 2, warn: 3, error: 4 }
function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "")
}
function scheduleLiveFlush() {
  if (liveLog.timer) return
  liveLog.timer = setTimeout(flushLive, 220)
  liveLog.timer.unref?.()
}
function flushLive() {
  liveLog.timer = null
  if (!liveLog.clients.size) return
  for (const client of liveLog.clients.values()) {
    const fresh = liveLog.entries.filter(e => e.id > client.lastId && e.rank >= client.rank)
    const send = fresh.slice(-LIVE_LOG_BATCH)
    const dropped = Math.max(0, fresh.length - send.length)
    const lines = send.map(e => humanizeLogLine(e.line))
    if (dropped) lines.push(`[实时日志] 处理不过来，已省略 ${dropped} 条低优先级/高频日志`)
    if (lines.length) {
      try { if (!client.res.writableEnded) client.res.write(`data: ${JSON.stringify({ lines })}\n\n`) } catch {}
    }
    if (liveLog.entries.length) client.lastId = liveLog.entries[liveLog.entries.length - 1].id
  }
}
function captureLog(level, args) {
  let text
  try { text = args.length ? formatUtil(...args) : "" }
  catch { text = args.map(a => String(a)).join(" ") }
  text = stripAnsi(text)
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false })
  const line = `[${time}][${level.toUpperCase()}] ${text}`
  liveLog.entries.push({ id: ++liveLog.seq, line, rank: LOG_RANK[level] ?? 2 })
  if (liveLog.entries.length > LIVE_LOG_MAX) liveLog.entries.splice(0, liveLog.entries.length - LIVE_LOG_MAX)
  if (liveLog.clients.size) scheduleLiveFlush()
}
function installLiveLog(logger) {
  if (!logger || logger.__qqbotLiveHooked) return
  const levels = ["trace", "debug", "info", "mark", "warn", "error", "fatal"]
  for (const level of levels) {
    if (typeof logger[level] !== "function") continue
    const original = logger[level]
    try {
      logger[level] = function (...args) {
        captureLog(level, args)
        return original.apply(this, args)
      }
    } catch (err) {
      try { console.error("[QQBot] 实时日志 hook 失败", level, err.message) } catch {}
    }
  }
  try { logger.__qqbotLiveHooked = true } catch {}
}

function logPasswordBanner(logger, password) {
  const line = "━".repeat(52)
  logger.info("")
  logger.info(logger.magenta(line))
  logger.info(logger.magenta("  🔐  QQBot WebUI 登录密码"))
  const pass = typeof logger.bold === "function" ? logger.bold(password) : password
  logger.info(logger.magenta(`  ${pass}`))
  logger.info(logger.magenta("  复制上面的密码登录，30 秒内可再次打印"))
  logger.info(logger.magenta(line))
  logger.info("")
}

export function startWebUI({ adapter, config, configSave, Bot, logger }) {
  if (running) return running
  const settings = config.webui || {}
  if (settings.enabled === false) return null
  installLiveLog(logger)
  const port = Number(settings.port) || 2580
  const host = settings.host || "0.0.0.0"

  globalThis.__qqbotGroupStats = id => adapter.groupStats
  globalThis.__qqbotChatMembers = (id, group) => adapter.groupChat?.members?.(id, group) || []
  const auth = loadAuth()
  const htmlFile = path.join(import.meta.dirname, "index.html")

  const configuredAppids = () => {
    const ids = new Set()
    for (const bot of Object.values(Bot)) {
      if (!bot || bot.adapter !== adapter) continue
      if (bot.info?.appid) ids.add(String(bot.info.appid))
    }
    for (const line of config.token || []) {
      const parts = String(line).split(":")
      if (parts[1]) ids.add(parts[1])
    }
    return [...ids]
  }
  let collectTimer = null
  let collecting = false
  const collectStats = async () => {
    if (collecting) return
    collecting = true
    try {
      const authData = await auth
      if (!authData.initialized || !authData.qqCookie) return
      for (const appid of configuredAppids()) {
        try { await fetchStats({ appid, range: "30d", cookie: authData.qqCookie }) } catch {}
      }
    } finally { collecting = false }
  }
  const statsCollectorTimer = setInterval(collectStats, 6 * 60 * 60 * 1000)
  statsCollectorTimer.unref?.()
  const statsCollectorStart = setTimeout(collectStats, 30000)
  statsCollectorStart.unref?.()

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost")
      const pathname = decodeURIComponent(url.pathname)

      if (pathname === "/" || pathname === "/index.html") {
        const html = await fs.readFile(htmlFile)
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        return res.end(html)
      }

      if (pathname.startsWith("/vendor/")) {
        const rel = pathname.slice("/vendor/".length)
        if (!rel || rel.includes("..")) return json(res, 404, { error: "not found" })
        const file = path.resolve(import.meta.dirname, "vendor", rel)
        const root = path.resolve(import.meta.dirname, "vendor")
        if (!file.startsWith(root + path.sep)) return json(res, 404, { error: "not found" })
        try {
          const data = await fs.readFile(file)
          const ext = path.extname(file).toLowerCase()
          const types = { ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" }
          res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "public, max-age=86400" })
          return res.end(data)
        } catch {
          return json(res, 404, { error: "not found" })
        }
      }

      if (pathname === "/assets/qqbot.svg") {
        const svg = await fs.readFile(path.join(import.meta.dirname, "assets", "qqbot.svg"))
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" })
        return res.end(svg)
      }

      if (pathname === "/style.css" || pathname === "/app.js") {
        const file = pathname === "/style.css" ? "style.css" : "app.js"
        const content = await fs.readFile(path.join(import.meta.dirname, file))
        res.writeHead(200, {
          "Content-Type": pathname === "/style.css" ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8",
          "Cache-Control": "no-cache",
        })
        return res.end(content)
      }

      if (pathname === "/api/bootstrap" && req.method === "GET") {
        const authData = await auth
        return json(res, 200, { initialized: !!authData.initialized })
      }

      if (pathname === "/api/password" && req.method === "POST") {
        const authData = await auth
        if (authData.initialized) return json(res, 400, { error: "密码已设置，不再打印初始密码" })
        const now = Date.now()
        if (now < passwordRevealAt)
          return json(res, 429, {
            error: "冷却中",
            wait: Math.ceil((passwordRevealAt - now) / 1000),
          })
        passwordRevealAt = now + 30000
        logPasswordBanner(logger, authData.password)
        logger.info(logger.magenta(`[QQBot WebUI] 密码文件：${path.resolve(AUTH_FILE)}`))
        return json(res, 200, { ok: true, cooldown: 30, message: "密码已打印到 TRSS 日志" })
      }

      if (pathname === "/api/login" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}")
        const authData = await auth
        if (String(body.password || "") !== authData.password)
          return json(res, 401, { error: "密码错误" })
        await saveAuth(authData)
        res.setHeader(
          "Set-Cookie",
          `qqbot_webui=${tokenOf(authData)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        )
        if (authData.initialized) Promise.resolve(adapter.enableWebUIData?.()).catch(() => {})
        return json(res, 200, { ok: true, mustChangePassword: !authData.initialized })
      }

      const authData = await auth
      const token = parseCookies(req).qqbot_webui
      if (!token || token !== tokenOf(authData)) return json(res, 401, { error: "未登录" })

      if (pathname === "/api/change-password" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}")
        const password = String(body.password || "")
        const confirm = String(body.confirm || "")
        if (password.length < 8) return json(res, 400, { error: "密码至少 8 位" })
        if (password.length > 64) return json(res, 400, { error: "密码最多 64 位" })
        if (password !== confirm) return json(res, 400, { error: "两次输入的密码不一致" })
        authData.password = password
        authData.initialized = true
        await saveAuth(authData)
        try { await adapter.enableWebUIData?.() } catch {}
        res.setHeader(
          "Set-Cookie",
          `qqbot_webui=${tokenOf(authData)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        )
        return json(res, 200, { ok: true })
      }

      if (!authData.initialized)
        return json(res, 403, { error: "请先设置 WebUI 密码", code: "PASSWORD_SETUP_REQUIRED" })

      // ---- status ----
      if (pathname === "/api/status") {
        const bots = []
        for (const [id, bot] of Object.entries(Bot)) {
          if (!bot || typeof bot !== "object" || !bot.sdk || bot.adapter !== adapter) continue
          bots.push({
            id,
            appid: bot.info?.appid || "",
            name: bot.info?.username || bot.info?.nickname || bot.nickname || id,
            avatar: bot.info?.avatar || "",
            online: !!bot.sdk,
            webhook: !!adapter.appid[bot.info?.appid],
          })
        }
        return json(res, 200, {
          version: adapter.version,
          port,
          bots,
          authFile: AUTH_FILE,
          initialized: !!authData.initialized,
          configFiles: await configFiles(),
        })
      }

      // ---- config ----
      if (pathname === "/api/bot/resolve" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}")
        const appid = String(body.appid || "").trim()
        const secret = String(body.secret || "").trim()
        if (!/^[A-Za-z0-9_-]+$/.test(appid)) return json(res, 400, { error: "AppID 格式不正确" })
        if (!secret) return json(res, 400, { error: "AppSecret 不能为空" })
        try {
          const bot = await fetchBotQQ({ appid, secret, timeout: 20000 })
          return json(res, 200, { ok: true, qq: bot.id, username: bot.username })
        } catch (err) {
          return json(res, 400, { error: err?.message || String(err) })
        }
      }
      if (pathname === "/api/config/form" && req.method === "GET") {
        const file = url.searchParams.get("file") || "config/QQBot.yaml"
        if (file !== "config/QQBot.yaml") return json(res, 400, { error: "该文件只支持原始 YAML 编辑" })
        try {
          const raw = await fs.readFile(file, "utf8")
          const doc = YAML.parseDocument(raw)
          if (doc.errors?.length) throw doc.errors[0]
          return json(res, 200, { file, data: doc.toJS() || {}, raw })
        } catch (err) {
          return json(res, 400, { error: String(err.message || err) })
        }
      }
      if (pathname === "/api/config/form" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}")
        if (body.file !== "config/QQBot.yaml") return json(res, 400, { error: "该文件只支持原始 YAML 编辑" })
        const values = body.values && typeof body.values === "object" ? body.values : {}
        if (values.webui?.port != null) {
          const port = Number(values.webui.port)
          if (!Number.isInteger(port) || port < 1 || port > 65535) return json(res, 400, { error: "WebUI 端口必须是 1-65535" })
          values.webui.port = port
        }
        if (values.imageLength != null) {
          const size = Number(values.imageLength)
          if (!Number.isFinite(size) || size < 0) return json(res, 400, { error: "图片压缩阈值必须是非负数" })
          values.imageLength = size
        }
        if (values.bot?.maxRetry != null) {
          const rawRetry = String(values.bot.maxRetry).trim()
          values.bot.maxRetry = rawRetry === "" || rawRetry === ".inf" || rawRetry === "Infinity" ? Infinity : Number(rawRetry)
          if (!Number.isFinite(values.bot.maxRetry) && values.bot.maxRetry !== Infinity) return json(res, 400, { error: "bot.maxRetry 必须是数字或 Infinity" })
        }
        if (values.token != null && (!Array.isArray(values.token) || values.token.some(v => typeof v !== "string"))) return json(res, 400, { error: "token 必须是字符串数组" })
        if (Array.isArray(values.token)) {
          for (const line of values.token) {
            const p = String(line).trim().split(":")
            const secret = p.length >= 6 ? p[3] : p.length === 5 && p[4] === "2" ? p[3] : p[2]
            if (!/^[A-Za-z0-9]{32}$/.test(secret || "")) return json(res, 400, { error: `AppSecret 必须是 32 位字母或数字：${p[0] || "未命名账号"}` })
          }
        }
        const allowed = ["permission", "imageLength", "toQRCode", "toCallback", "toBotUpload", "hideGuildRecall", "autoInstallExample", "exampleGuideSent", "groupMemberEvent", "webui", "bot", "reconnect", "markdown", "token"]
        try {
          const file = body.file
          const raw = await fs.readFile(file, "utf8")
          const doc = YAML.parseDocument(raw)
          if (doc.errors?.length) throw doc.errors[0]
          const current = doc.toJS() || {}
          for (const key of allowed) {
            if (!Object.prototype.hasOwnProperty.call(values, key)) continue
            const value = values[key]
            if (value && typeof value === "object" && !Array.isArray(value) && current[key] && typeof current[key] === "object" && !Array.isArray(current[key]))
              doc.set(key, { ...current[key], ...value })
            else doc.set(key, value)
          }
          const parsed = doc.toJS()
          if (!parsed || typeof parsed !== "object") throw new Error("配置内容必须是对象")
          await fs.writeFile(file, doc.toString(), "utf8")
          return json(res, 200, { ok: true, note: "已保存；端口/机器人类配置需要重启 TRSS 后生效" })
        } catch (err) {
          return json(res, 400, { error: `保存失败：${err.message || err}` })
        }
      }
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
          const result = await readLogTail(path.join("logs", file), tail)
          return json(res, 200, { file, lines: result.lines, truncated: result.truncated, size: result.size })
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
            for (const line of text.split("\n")) if (line.trim()) res.write(`data: ${humanizeLogLine(line)}\n`)
          } catch {}
        }, 1500)
        req.on("close", () => clearInterval(timer))
        return
      }

      if (pathname === "/api/logs/live") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        })
        const level = String(url.searchParams.get("level") || "info").toLowerCase()
        const client = {
          res,
          rank: LIVE_LEVEL[level] ?? 2,
          lastId: liveLog.entries.length ? liveLog.entries[liveLog.entries.length - 1].id : 0,
        }
        const initial = liveLog.entries.filter(e => e.rank >= client.rank).slice(-300).map(e => humanizeLogLine(e.line))
        if (initial.length) {
          try { res.write(`data: ${JSON.stringify({ lines: initial })}\n\n`) } catch {}
        }
        liveLog.clients.set(res, client)
        const ping = setInterval(() => {
          try { if (!res.writableEnded) res.write(": ping\n\n") } catch {}
        }, 15000)
        ping.unref?.()
        req.on("close", () => { clearInterval(ping); liveLog.clients.delete(res) })
        return
      }

      if (pathname === "/api/system") {
        try {
          return json(res, 200, await systemInfo(Bot))
        } catch (err) {
          return json(res, 500, { error: String(err.message || err) })
        }
      }

      // ---- materials ----
      if (pathname === "/api/materials" && req.method === "GET") {
        const id = url.searchParams.get("bot") || Object.keys(Bot).find(i => Bot[i]?.adapter === adapter)
        const list = []
        const byId = new Map()
        for (const [imageId, item] of adapter.materials[id] || []) {
          const row = {
            image_id: imageId,
            url: item.url,
            preview_url: item.preview || "",
            uses: item.uses,
            uploadedAt: item.t,
          }
          list.push(row)
          byId.set(imageId, row)
        }
        if (Bot[id]?.sdk?.getMaterialImages)
          try {
            for (const image of await Bot[id].sdk.getMaterialImages()) {
              const old = byId.get(image.image_id)
              if (old) {
                old.preview_url = image.preview_url || old.preview_url
                old.file_name = image.file_name
                old.created_at = image.created_at
                old.expires_at = image.expires_at
              } else {
                const row = {
                  image_id: image.image_id,
                  url: image.url,
                  preview_url: image.preview_url || "",
                  file_name: image.file_name,
                  created_at: image.created_at,
                  expires_at: image.expires_at,
                  uses: 0,
                  remote: true,
                }
                list.push(row)
                byId.set(image.image_id, row)
              }
            }
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
      if (pathname === "/api/qq/groups") {
        const appid = url.searchParams.get("appid")
        try {
          const groups = await fetchQQGroups(appid, authData.qqCookie)
          return json(res, 200, { groups })
        } catch (err) {
          return json(res, 500, { error: String(err.message || err) })
        }
      }
      if (pathname === "/api/groups") {
        const id = url.searchParams.get("bot")
        // 直接用内存里的群映射，避免 WebUI 反复打开 TRSS 的 LevelDB（会触发 LOCK 冲突）
        const liveGl = Bot[id]?.gl
        const map = liveGl instanceof Map ? liveGl : new Map(liveGl && typeof liveGl.entries === "function" ? liveGl : [])
        const stats = adapter.groupStats?.list(id) || []
        let appid = Bot[id]?.info?.appid
        if (!appid) {
          const line = (config.token || []).find(item => String(item).startsWith(`${id}:`))
          appid = line?.split(":")[1]
        }
        const qqGroups = await fetchQQGroups(appid, authData.qqCookie)
        await loadGroupAvatarCache()
        const oneBotIndex = oneBotGroupIndex()
        const byName = new Map()
        const ambiguous = new Set()
        for (const g of qqGroups) {
          const name = String(g.name || "").trim()
          if (!name) continue
          if (byName.has(name)) ambiguous.add(name)
          else byName.set(name, g)
        }
        const avatarOf = async s => {
          const name = String(s.name || "").trim()
          return await resolveGroupAvatarMatch(s.group_id, name, byName, oneBotIndex)
        }
        const seen = new Set()
        const groups = []
        for (const s of stats) {
          const key = s.group_id
          seen.add(key)
          groups.push({
            group: key,
            name: s.name || map.get(key)?.group_name || map.get(key)?.name || "",
            avatar: await avatarOf(s),
            member_count: s.member_count || 0,
            bot_role: s.bot_role || "",
            allow_proactive: !!s.allow_proactive,
            recv_msg_setting: s.recv_msg_setting || "",
            commands: s.commands || 0,
            commands_today: s.days?.[dayKey()]?.commands || 0,
            messages: s.messages || 0,
            last_active: s.last_active || 0,
          })
        }
        for (const [group, info] of map)
          if (!seen.has(group))
            groups.push({
              group,
              name: info?.group_name || info?.name || "",
              avatar: await avatarOf({ group_id: group, name: info?.group_name || info?.name || "" }),
              member_count: 0,
              bot_role: "",
              allow_proactive: false,
              recv_msg_setting: "",
              commands: 0,
              commands_today: 0,
              messages: 0,
              last_active: info?.time || 0,
            })
        return json(res, 200, { groups, summary: adapter.groupStats?.summary(id) || null })
      }
      if (pathname === "/api/group/stats") {
        const id = url.searchParams.get("bot")
        return json(res, 200, adapter.groupStats?.summary(id) || { groups: 0, members: 0, commandsToday: 0, commands7d: 0, activeGroups7d: 0, top: [] })
      }
      if (pathname === "/api/group/members") {
        const id = url.searchParams.get("bot")
        const group = url.searchParams.get("group")
        try {
          const result = await Bot[id].sdk.groupService.getMembers(adapter.rawId ? adapter.rawId(group) : group, { forceRefresh: true })
          return json(res, 200, { members: result?.members || result?.data || result })
        } catch (err) {
          return json(res, 500, { error: String(err.message || err) })
        }
      }
      if (pathname === "/api/group/blacklist" && req.method === "GET") {
        const id = url.searchParams.get("bot")
        const group = url.searchParams.get("group")
        try {
          const result = await Bot[id].sdk.groupService.getMemberBlacklist(adapter.rawId ? adapter.rawId(group) : group)
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

      if (pathname === "/api/group/avatar") {
        const group = String(url.searchParams.get("group") || "").replace(/\D/g, "")
        if (!group) return json(res, 400, { error: "缺少群号" })
        const hit = avatarCache.get(group)
        if (hit && Date.now() - hit.at < 5 * 60 * 1000) {
          res.writeHead(200, { "Content-Type": hit.type, "Cache-Control": "public, max-age=300" })
          return res.end(hit.data)
        }
        try {
          const { data, headers } = await axios.get(
            `https://p.qlogo.cn/gh/${group}/${group}/640/`,
            { responseType: "arraybuffer", timeout: 10000 },
          )
          const type = headers["content-type"] || "image/jpeg"
          avatarCache.set(group, { at: Date.now(), type, data })
          res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=300" })
          return res.end(Buffer.from(data))
        } catch {
          return json(res, 404, { error: "头像获取失败" })
        }
      }

      if (pathname === "/api/chat/media") {
        const raw = url.searchParams.get("url") || ""
        try {
          const u = new URL(raw)
          const host = u.hostname.toLowerCase()
          if (!/\.(qq\.com|qq\.com\.cn|qlogo\.cn|qpic\.cn|myqcloud\.com)$/.test(host))
            return json(res, 400, { error: "不支持的图片域名" })
          const cached = chatMediaCache.get(raw)
          if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
            res.writeHead(200, { "Content-Type": cached.type, "Cache-Control": "public, max-age=600" })
            return res.end(cached.data)
          }
          const { data, headers } = await axios.get(raw, {
            responseType: "arraybuffer",
            timeout: 12000,
            maxContentLength: 12 * 1024 * 1024,
            headers: { Referer: "https://q.qq.com/", "User-Agent": "Mozilla/5.0" },
          })
          const sourceType = String(headers["content-type"] || "image/jpeg").split(";")[0].trim()
          const source = Buffer.from(data)
          const thumb = await chatThumbnail(source, sourceType)
          chatMediaCache.set(raw, { at: Date.now(), type: thumb.type, data: thumb.data })
          if (chatMediaCache.size > 120) chatMediaCache.delete(chatMediaCache.keys().next().value)
          res.writeHead(200, { "Content-Type": thumb.type, "Cache-Control": "public, max-age=600" })
          return res.end(thumb.data)
        } catch (err) {
          return json(res, 404, { error: String(err.message || err) })
        }
      }
      if (pathname === "/api/chat/members") {
        const id = url.searchParams.get("bot")
        const group = url.searchParams.get("group")
        const memberKey = `${id}|${group}`
        const cachedMembers = chatMembersResponseCache.get(memberKey)
        if (!url.searchParams.get("refresh") && cachedMembers && Date.now() - cachedMembers.at < 30000)
          return json(res, 200, cachedMembers.data)
        const local = typeof adapter.groupChat?.members === "function" ? adapter.groupChat.members(id, group) : []
        const cache = adapter.memberCache
        const appid = Bot[id]?.info?.appid
        // 复用适配器的权威实现，避免这里再抄一份前缀正则
        const rawId = value => adapter.rawId(value)
        const decorate = m => {
          const openid = rawId(m.member_openid || m.openid || m.user_id)
          const hit = openid && cache?.get ? cache.get(id, group, openid) : null
          const name = m.username || m.nickname || hit?.name || openid
          const avatar = m.avatar || m.avatar_url || hit?.avatar ||
            (appid && openid ? `https://thirdqq.qlogo.cn/qqapp/${appid}/${openid}/640` : "")
          return {
            ...m,
            member_openid: openid || m.member_openid,
            username: name,
            avatar,
            member_role: m.member_role || m.role || hit?.role || "",
            cachedAt: hit?.updatedAt || 0,
            stale: !!hit?.stale,
          }
        }
        let remote = []
        let localOnly = true
        let warning = ""
        try {
          const result = await Bot[id].sdk.groupService.getMembers(adapter.rawId ? adapter.rawId(group) : group, { forceRefresh: true })
          remote = result?.members || result?.data || result || []
          for (const m of remote) {
            const openid = rawId(m.member_openid || m.openid)
            if (openid) cache?.set?.(id, group, openid, {
              name: m.username || m.nickname,
              avatar: m.avatar || m.avatar_url,
              role: m.member_role,
              bot: m.bot,
              joinedAt: m.joined_at,
            })
          }
          localOnly = false
        } catch (err) {
          warning = String(err.response?.data?.message || err.message || err)
        }
        const botRole = typeof adapter.groupStats?.get === "function" ? adapter.groupStats.get(id, group)?.bot_role || "" : ""
        if (!remote.length && local.length) localOnly = true
        const localMerged = local.map(decorate)
        const seen = new Set(localMerged.map(m => m.member_openid))
        for (const m of cache?.list?.(id, group) || []) {
          if (!m.openid || seen.has(m.openid)) continue
          localMerged.push(decorate({ member_openid: m.openid, username: m.name, avatar: m.avatar, member_role: m.role }))
        }
        const payload = {
          members: remote.length ? remote.map(decorate) : localMerged,
          localOnly,
          local: localMerged,
          bot_role: botRole,
          warning,
          cache_ttl: cache?.ttl || 300000,
        }
        chatMembersResponseCache.set(memberKey, { at: Date.now(), data: payload })
        if (chatMembersResponseCache.size > 80) chatMembersResponseCache.delete(chatMembersResponseCache.keys().next().value)
        return json(res, 200, payload)
      }
      if (pathname === "/api/group/recall" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}")
        if (!Bot[body.bot]) return json(res, 400, { error: "机器人不在线" })
        try {
          const result = await adapter.recallGroupMsg(
            { bot: Bot[body.bot], self_id: body.bot, group_id: body.group },
            body.message_id,
          )
          adapter.groupChat?.markRecalled(body.bot, body.group, body.message_id)
          return json(res, 200, { ok: true, result })
        } catch (err) {
          return json(res, 500, { error: String(err.response?.data?.message || err.message || err) })
        }
      }

      // ---- group chat ----
      if (pathname === "/api/group/messages") {
        const id = url.searchParams.get("bot")
        const group = url.searchParams.get("group")
        const limit = Math.min(200, Number(url.searchParams.get("limit")) || 100)
        const since = Number(url.searchParams.get("since")) || 0
        const messages = adapter.groupChat?.list(id, group, limit, since) || []
        return json(res, 200, { messages })
      }
      if (pathname === "/api/group/stream") {
        const id = url.searchParams.get("bot")
        const group = url.searchParams.get("group")
        let since = Number(url.searchParams.get("since")) || 0
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        })
        res.write(": connected\n\n")
        const push = () => {
          const list = adapter.groupChat?.list(id, group, 100, since) || []
          for (const m of list) {
            since = Math.max(since, m.id)
            res.write(`data: ${JSON.stringify(m)}\n\n`)
          }
        }
        push()
        const timer = setInterval(() => {
          try { push() } catch { clearInterval(timer) }
        }, 1000)
        timer.unref?.()
        req.on("close", () => clearInterval(timer))
        return
      }
      if (pathname === "/api/group/send" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}")
        const id = body.bot
        const group = body.group
        const text = String(body.text || "").trim()
        const images = Array.isArray(body.images) ? body.images.slice(0, 9) : []
        const reply = String(body.reply || "").trim()
        const rawMentions = Array.isArray(body.mentions) ? body.mentions : (body.mention ? [body.mention] : [])
        const mentions = [...new Set(rawMentions.map(v => adapter.rawId(String(v || "").trim())).filter(Boolean))]
        if (!Bot[id]) return json(res, 400, { error: "机器人不在线或未配置" })
        if (!group) return json(res, 400, { error: "请选择群" })
        const msg = []
        if (reply) msg.push({ type: "reply", id: reply })
        for (const mention of mentions) msg.push({ type: "at", user_id: mention })
        if (text) msg.push({ type: "text", text })
        for (const raw of images) {
          const match = String(raw || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/)
          if (!match) continue
          const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64")
          if (!buffer.length || buffer.length > 8 * 1024 * 1024) continue
          msg.push({ type: "image", file: buffer, name: `image.${match[1].split("/")[1] || "png"}` })
        }
        if (!msg.length) return json(res, 400, { error: "消息不能为空" })
        try {
          const data = {
            bot: Bot[id],
            self_id: id,
            post_type: "message",
            message_type: "group",
            sub_type: "normal",
            group_id: group,
          }
          const ret = await adapter.sendGroupMsg(data, msg)
          if (ret === false) throw new Error("消息发送失败")
          if (!ret?.message_id?.length) {
            const err = ret?.error?.[0]
            if (err) throw new Error(String(err?.response?.data?.message || err?.message || "消息发送失败"))
            throw new Error("消息发送失败：没有可用的被动回复，且主动消息不可用")
          }
          const message = adapter.groupChat?.list(id, group, 1).at(-1) || null
          return json(res, 200, { ok: true, message })
        } catch (err) {
          return json(res, 500, { error: String(err.response?.data?.message || err.message || err) })
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
            qqGroupCache.clear()
            await saveAuth(authData)
            setTimeout(collectStats, 1000)
          }
          return json(res, 200, result)
        } catch (err) {
          return json(res, 400, { error: String(err.message || err) })
        }
      }
      if (pathname === "/api/qq/select-developer" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}")
        try {
          const result = await selectDeveloper(body.id, body.developerId)
          if (result.cookie) {
            authData.qqCookie = result.cookie
            authData.qqCookieAt = Date.now()
            authData.qqDeveloper = result.developer || null
            await saveAuth(authData)
          }
          return json(res, 200, {
            ok: true,
            developer: result.developer,
            nickname: result.nickname,
            login: true,
          })
        } catch (err) {
          return json(res, 400, { error: String(err.message || err) })
        }
      }
      if (pathname === "/api/qq/bots") {
        if (!authData.qqCookie) return json(res, 400, { error: "请先登录 QQ 开放平台" })
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
        qqGroupCache.clear()
        await saveAuth(authData)
        setTimeout(collectStats, 1000)
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
        if (!authData.qqCookie) return json(res, 400, { error: "请先在 WebUI 中导入 QQ 开放平台 Cookie" })
        if (!appid) return json(res, 400, { error: "找不到 AppID" })
        try {
          const result = await fetchStats({ appid, range, start, end, cookie: authData.qqCookie })
          return json(res, 200, { appid, range, ...result, updatedAt: Date.now() })
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
    if (!authData.initialized) {
      logPasswordBanner(logger, authData.password)
      logger.info(logger.magenta(`密码也会保存在：${path.resolve(AUTH_FILE)}`))
      logger.info(logger.magenta("首次登录后必须设置新密码，之后不再打印密码"))
    } else {
      logger.info(logger.magenta("WebUI 密码已设置，不再打印初始密码"))
    }
    logger.info(logger.magenta("Docker 部署请把宿主机端口反向代理到容器内 IP:端口"))
    logger.info(logger.magenta("============================================"))
  })
  server.listen(port, host, () => {})

  running = { server, port, auth }
  return running
}
