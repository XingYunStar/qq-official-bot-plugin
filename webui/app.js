
const $ = s => document.querySelector(s)
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))
function memberDisplayName(raw) {
  const id = String(raw || "").replace(/^\d+[:_\uF03A]/, "")
  if (!id) return ""
  if (id === "all") return "全体成员"
  const botId = String(state.bot || "").replace(/^\d+[:_\uF03A]/, "")
  if (botId && id === botId) {
    const bot = (state.bots || []).find(x => [x.id, x.uin, x.appid].some(v => String(v || "") === botId))
    return bot?.name || state.qqBotName || ""
  }
  const member = (state.chatMembers || []).find(x =>
    String(x.member_openid || x.openid || x.user_id || "").replace(/^\d+[:_\uF03A]/, "") === id
  )
  const name = member?.username || member?.nickname
  if (name && name !== id && String(name).replace(/^\d+[:_\uF03A]/, "") !== id) return name
  for (const m of state.chatMap?.values?.() || []) {
    if (String(m.sender?.id || "").replace(/^\d+[:_\uF03A]/, "") === id) return m.sender?.name || ""
  }
  return ""
}
function resolveAtMentions(text) {
  return String(text || "").replace(/@(?:(\d+)[:_\uF03A])?([A-Fa-f0-9]{8,})/g, (all, bot, id) => {
    const name = memberDisplayName((bot ? bot + "_" : "") + id)
    return name ? "@" + name : all
  })
}

function renderRichText(text) {
  const raw = resolveAtMentions(String(text ?? ""))
    .replace(/<attachmentType=[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (!raw) return ""
  const images = []
  const maths = []
  let prepared = raw.replace(/(!?)\[#(\d+)(?:px)?\s+#(\d+)(?:px)?\]\(([^)\s]+)\)/g, (all, bang, width, height, url) => {
    if (/^(javascript|vbscript|file):/i.test(url)) return all
    images.push({ url, width: Math.max(1, Math.min(2000, Number(width) || 32)), height: Math.max(1, Math.min(2000, Number(height) || 32)) })
    return `@@QQIMG${images.length - 1}@@`
  })
  let protectedText = prepared.replace(
    /\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|\$\$([\s\S]*?)\$\$|\$([^$\n]+?)\$/g,
    (all, block, inline, dollarBlock, dollarInline) => {
      const expr = block ?? inline ?? dollarBlock ?? dollarInline ?? ""
      const display = block != null || dollarBlock != null
      let html
      try {
        html = typeof katex !== "undefined"
          ? katex.renderToString(expr, { displayMode: !!display, throwOnError: false, strict: "ignore" })
          : esc(expr)
      } catch { html = esc(expr) }
      maths.push(html)
      return `@@QQMATH${maths.length - 1}@@`
    },
  )
  let html
  if (typeof marked !== "undefined") {
    try { html = marked.parse(protectedText, { breaks: true, gfm: true }) }
    catch { html = esc(protectedText).replace(/\n/g, "<br>") }
  } else html = esc(protectedText).replace(/\n/g, "<br>")
  if (typeof DOMPurify !== "undefined") html = DOMPurify.sanitize(html, { ADD_ATTR: ["target"] })
  html = html.replace(/<a\s/gi, '<a target="_blank" rel="noreferrer" ')
  html = html.replace(/@@QQMATH(\d+)@@/g, (_, i) => maths[Number(i)] || "")
  return html.replace(/@@QQIMG(\d+)@@/g, (_, i) => {
    const img = images[Number(i)]
    if (!img) return ""
    return `<img class="qq-md-img" src="${CHAT_IMAGE_PLACEHOLDER}" data-src="${esc(mediaUrl(img.url))}" width="${img.width}" height="${img.height}" style="width:${img.width}px;height:${img.height}px" decoding="async" alt="图片">`
  })
}

let state = {
  bots: [], qqBots: [], bot: "", appid: localStorage.getItem("qqbot_appid") || "", qqBotName: localStorage.getItem("qqbot_name") || "", botAvatar: localStorage.getItem("qqbot_avatar") || "",
  tab: "stats", range: "7d", statsRows: [], chartMetric: localStorage.getItem("qqbot_chart") || "messages",
  autoTimer: null, logLines: [], logPaused: false, logES: null, materials: [], members: [], currentGroup: "",
  paletteIndex: 0, paletteActions: [], chatGroup: "", chatES: null, chatLastId: 0, chatImages: [], sysTimer: null,
  chatRefreshTimer: null, chatGroupsSig: "", chatMembersSig: "",
  logLevel: localStorage.getItem("qqbot_log_level") || "info", logRenderTimer: null, logRenderScroll: false,
  logWindowStart: 0, logWindowEnd: 0, logWindowTotal: 0, logWindowMode: "none", logWindowLoading: false,
  logHighlightQuery: "", logFocusLine: -1, logSearching: false,
  errorCode: "all", errorCodes: [], errorLimit: 200, errorEntries: [], errorOffset: 0, errorHasMore: false, errorTotal: 0,
  chatMembers: [], chatMembersLocalOnly: false, chatBotRole: "", chatReply: null, chatMentions: [], chatMap: new Map(),
}
const toast = msg => { const t=$("#toast"); t.textContent=msg; t.classList.add("on"); setTimeout(()=>t.classList.remove("on"),2200) }
async function api(url, opts={}) {
  const res = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...opts })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && data.error === "未登录") { $("#login").style.display = "flex"; throw new Error("未登录") }
  if (res.status === 403 && data.code === "PASSWORD_SETUP_REQUIRED") {
    showSetup()
    throw new Error(data.error || "请先设置密码")
  }
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}
function showSetup() {
  $("#login").style.display = "flex"
  $("#loginView").classList.add("hide")
  $("#setupView").classList.remove("hide")
}
$("#loginBtn").onclick = async () => {
  try {
    const data = await api("/api/login", { method: "POST", body: JSON.stringify({ password: $("#pwd").value }) })
    if (data.mustChangePassword) return showSetup()
    $("#login").style.display = "none"; location.reload()
  } catch (e) { $("#loginErr").textContent = e.message }
}
$("#setupBtn").onclick = async () => {
  const password = $("#newPwd").value
  const confirm = $("#newPwd2").value
  if (password.length < 8) return ($("#setupErr").textContent = "密码至少 8 位")
  if (password !== confirm) return ($("#setupErr").textContent = "两次输入的密码不一致")
  try {
    await api("/api/change-password", { method: "POST", body: JSON.stringify({ password, confirm }) })
    $("#login").style.display = "none"; location.reload()
  } catch (e) { $("#setupErr").textContent = e.message }
}
;(async () => {
  try {
    const b = await fetch("/api/bootstrap", { credentials: "same-origin" }).then(r => r.json())
    $("#showPwd").style.display = b.initialized ? "none" : "block"
    $("#loginHint").textContent = b.initialized ? "输入你设置的 WebUI 密码" : "首次登录密码在 TRSS 日志中（logger.info）"
  } catch {}
})()
$("#showPwd").onclick = async () => {
  const btn = $("#showPwd")
  try {
    const res = await fetch("/api/password", { method: "POST", credentials: "same-origin" })
    const data = await res.json()
    if (!res.ok) {
      $("#pwdTip").textContent = data.error === "冷却中" ? `冷却中，请 ${data.wait} 秒后再试` : (data.error || "获取失败")
      return
    }
    $("#pwdTip").textContent = "密码已打印到 TRSS 日志，请查看控制台"
    btn.disabled = true
    let left = data.cooldown || 30
    btn.textContent = `冷却中 ${left}s`
    const timer = setInterval(() => {
      left--
      if (left <= 0) { clearInterval(timer); btn.disabled = false; btn.textContent = "打印密码到日志（冷却 30 秒）" }
      else btn.textContent = `冷却中 ${left}s`
    }, 1000)
  } catch (e) { $("#pwdTip").textContent = e.message }
}
$("#logout").onclick = async () => { document.cookie = "qqbot_webui=; Max-Age=0; path=/"; location.reload() }

async function loadStatus() {
  const s = await api("/api/status")
  $("#version").textContent = "v" + s.version + " · 端口 " + s.port
  state.bots = s.bots
  $("#botSel").innerHTML = s.bots.map(b => `<option value="${esc(b.id)}">${esc(b.name || b.id)}${b.online ? " · 在线" : " · 离线"}</option>`).join("")
  const savedAppid = localStorage.getItem("qqbot_appid") || ""
  const saved = s.bots.find(b => String(b.appid) === String(savedAppid))
  state.bot = saved?.id || s.bots[0]?.id || ""
  state.appid = saved?.appid || savedAppid || s.bots[0]?.appid || ""
  state.qqBotName = saved?.name || localStorage.getItem("qqbot_name") || ""
  state.botAvatar = saved?.avatar || localStorage.getItem("qqbot_avatar") || ""
  renderBotPicker()
  const online = s.bots.filter(b => b.online).length
  $("#topStatusText").textContent = `${online}/${s.bots.length} 在线`
  $("#login").style.display = "none"
  $("#cfgFile").innerHTML = s.configFiles.map(f => `<option>${esc(f)}</option>`).join("")
  await loadConfig()
  await loadLogs()
}

/* tabs */
document.querySelectorAll("nav button").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b))
  document.querySelectorAll("main > section").forEach(s => s.classList.add("hide"))
  $("#tab-" + b.dataset.tab).classList.remove("hide")
  state.tab = b.dataset.tab
  document.body.dataset.tab = b.dataset.tab
  setPageMeta(b.dataset.tab)
  if (innerWidth <= 900) document.body.classList.remove("nav-open")
  if (b.dataset.tab === "stats") { loadStats(state.range); loadGroupStats() }
  if (b.dataset.tab === "logs") { loadLogs(); startLogLive() }
  if (b.dataset.tab === "errors") loadErrors()
  if (b.dataset.tab === "materials") loadMaterials()
  if (b.dataset.tab === "groups") loadGroups()
  if (b.dataset.tab === "chat") { loadChatGroups(); startChatRefresh() }
  else stopChatRefresh()
  if (b.dataset.tab !== "chat") closeChatStream()
  if (b.dataset.tab === "system") startSystem()
  else stopSystem()
  if (b.dataset.tab === "qq") loadQQ()
  if (b.dataset.tab === "menu") loadMenu()
})
$("#botSel").onchange = () => { state.bot = $("#botSel").value }

/* stats */
function rangeLabel(r){ return ({today:"今天",yesterday:"昨天","7d":"近 7 天","14d":"近 14 天","30d":"近 30 天",month:"本月",total:"总览"})[r] || r }
function fmtStatsDay(d) {
  const s = String(d || "")
  return /^\d{8}$/.test(s) ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : (s || "无")
}
function statsEmptyState(data, range) {
  const reason = data.stale
    ? `数据最后更新于 ${fmtStatsDay(data.lastDate)}，登录状态可能已过期，请重新登录 QQ 开放平台后刷新。`
    : `官方尚未生成${rangeLabel(range)}的数据，请稍后刷新。`
  return `<div class="card empty-state"><div class="empty-ico"><svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></div><div><strong>所选范围没有运营数据</strong><p>${esc(reason)}</p><button class="ghost" id="goQQ">去 QQ 登录</button></div></div>`
}
function wireStatsEmptyButton() {
  const go = $("#goQQ")
  if (go) go.onclick = () => document.querySelector('nav button[data-tab="qq"]')?.click()
}
function fmtPct(v) { return (Number(v || 0) * 100).toFixed(2) + "%" }
function distCard(title, items) {
  const list = (items || []).slice().sort((a, b) => (b.ratio || 0) - (a.ratio || 0)).slice(0, 8)
  if (!list.length) return `<div class="card dist-card"><div class="dist-title">${esc(title)}</div><div class="muted">暂无数据</div></div>`
  return `<div class="card dist-card"><div class="dist-title">${esc(title)}</div>${list.map(i => `
    <div class="dist-row"><span class="dist-key" title="${esc(i.key)}">${esc(i.key)}</span><span class="dist-val">${i.count}</span>
    <div class="dist-bar"><i style="width:${Math.max(1, Math.round((i.ratio || 0) * 100))}%"></i></div></div>`).join("")}</div>`
}
function distType(items, type) { return (items || []).filter(i => i.type === type) }

async function loadStats(range, start, end) {
  state.range = range
  document.querySelectorAll("[data-range]").forEach(b => b.classList.toggle("on", b.dataset.range === range))
  const q = new URLSearchParams({ bot: state.bot, range })
  if (state.appid) q.set("appid", state.appid)
  if (start) q.set("start", start); if (end) q.set("end", end)
  $("#statCards").innerHTML = "<div class='card'>加载中…</div>"
  try {
    const data = await api("/api/stats?" + q)
    const s = data.summary
    const daily = data.daily || []
    const updated = data.stale
      ? `最后数据 ${fmtStatsDay(data.lastDate)}${data.apiError ? " · " + data.apiError : ""}`
      : `更新于 ${new Date(data.updatedAt).toLocaleTimeString()}`
    $("#statsTip").textContent = (data.limited || "") + " · " + rangeLabel(range) + (data.history ? ` · 本地 ${data.history.days || 0} 天` : "") + " · " + updated
    $("#statsTip").classList.toggle("stats-warning", !!data.stale || !daily.length)
    if (!daily.length) {
      $("#statCards").innerHTML = statsEmptyState(data, range)
      $("#metricCards").innerHTML = ""
      $("#profileGrid").innerHTML = ""
      $("#groupDistGrid").innerHTML = ""
      $("#hotCommandsWrap").classList.add("hide")
      $("#extraDataWrap").classList.add("hide")
      $("#statTable").innerHTML = ""
      state.statsRows = []
      state.statsRaw = data
      drawChart()
      wireStatsEmptyButton()
      return
    }
    $("#statCards").innerHTML = [
      ["活跃用户", s.activeUsers, "人次"],
      ["消息量", s.messages, "条"],
      ["单聊 / 群聊", (s.c2c||0)+" / "+(s.group||0), "条"],
      ["新增用户", s.newUsers, "人"],
      ["回复率", s.replyRate + "%", "回复 " + s.replyCount + " 条"],
      ["总好友 / 总群", (s.friends||0)+" / "+(s.groups||0), "库存"],
    ].map(([k,v,x])=>`<div class="card"><div class="k">${k}</div><div class="v">${esc(v)}</div><div class="k">${esc(x)}</div></div>`).join("")
    $("#metricCards").innerHTML = [
      ["活跃群", s.activeGroups, "个"],
      ["活跃频道", s.activeGuilds, "个"],
      ["回流用户", s.returningUsers, "人"],
      ["首次回复率", s.firstReplyRate + "%", "首轮"],
      ["平均响应", (s.avgResponse / 1000).toFixed(1) + "s", "秒"],
      ["平均轮次", s.avgRounds, "轮"],
      ["好友新增", s.friendsAdd, "人"],
      ["好友删除", s.friendsRemove, "人"],
      ["群新增", s.groupsAdd, "个"],
      ["群删除", s.groupsRemove, "个"],
      ["好友总数", s.friends, "库存"],
      ["群总数", s.groups, "库存"],
    ].map(([k, v, x]) => `<div class="card metric"><div class="k">${k}</div><div class="v">${esc(v)}</div><div class="k">${x}</div></div>`).join("")
    const profile = data.profile || []
    $("#profileGrid").innerHTML = ["age", "gender", "region"].map(t => distCard(
      ({ age: "年龄", gender: "性别", region: "地区" })[t] || t,
      distType(profile, t),
    )).join("")
    const groupDist = data.groupDist || []
    $("#groupDistGrid").innerHTML = ["category", "scale"].map(t => distCard(
      ({ category: "群分类", scale: "群规模" })[t] || t,
      distType(groupDist, t),
    )).join("")
    const hot = data.hotCommands || []
    $("#hotCommandsWrap").classList.toggle("hide", !hot.length)
    if (hot.length) $("#hotCommandsTable").innerHTML = "<tr><th>指令</th><th>次数</th><th>占比</th></tr>" +
      hot.slice().sort((a, b) => b.count - a.count).map(i => `<tr><td>${esc(i.key)}</td><td>${i.count}</td><td>${(i.ratio * 100).toFixed(1)}%</td></tr>`).join("")
    const sections = data.sections || {}
    const extra = [
      ["频道数据", sections.guild],
      ["消息数据", sections.message],
      ["群数据", sections.group],
      ["好友数据", sections.friend],
    ].filter(([, v]) => Array.isArray(v) && v.length)
    $("#extraDataWrap").classList.toggle("hide", !extra.length)
    if (extra.length) $("#extraData").innerHTML = extra.map(([name, rows]) => `
      <details class="card extra-card"><summary>${name} <span class="muted">${rows.length} 条</span></summary>
      <pre class="extra-json">${esc(JSON.stringify(rows, null, 2))}</pre></details>`).join("")
    state.statsRows = daily
    state.statsRaw = data
    drawChart()
    const rows = (data.daily || []).slice().reverse()
    $("#statTable").innerHTML = "<tr><th>日期</th><th>活跃用户</th><th>活跃群</th><th>活跃频道</th><th>消息总量</th><th>单聊</th><th>群聊</th><th>新增用户</th><th>回流用户</th><th>回复数</th><th>回复率</th><th>首回率</th><th>平均响应</th><th>平均轮次</th><th>好友</th><th>好友+</th><th>好友-</th><th>群</th><th>群+</th><th>群-</th><th>频道</th><th>频道+</th><th>频道-</th></tr>" +
      rows.map(r => `<tr><td>${esc(r.date)}</td><td>${r.activeUsers}</td><td>${r.activeGroups}</td><td>${r.activeGuilds}</td><td>${r.messages}</td><td>${r.c2c}</td><td>${r.group}</td><td>${r.newUsers}</td><td>${r.returningUsers}</td><td>${r.replyCount}</td><td>${(r.replyRate * 100).toFixed(2)}%</td><td>${(r.firstReplyRate * 100).toFixed(2)}%</td><td>${(r.avgResponse / 1000).toFixed(1)}s</td><td>${r.avgRounds}</td><td>${r.friends}</td><td>${r.friendsAdd}</td><td>${r.friendsRemove}</td><td>${r.groups}</td><td>${r.groupsAdd}</td><td>${r.groupsRemove}</td><td>${r.guilds}</td><td>${r.guildsAdd}</td><td>${r.guildsRemove}</td></tr>`).join("")
  } catch (e) {
    $("#statCards").innerHTML = `<div class="card empty-state"><div class="empty-ico"><svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></div><div><strong>还没有运营数据</strong><p>${esc(e.message)}</p><button class="ghost" id="goQQ">去 QQ 登录</button></div></div>`
    const go = $("#goQQ")
    if (go) go.onclick = () => document.querySelector('nav button[data-tab="qq"]')?.click()
    state.statsRows = []
    drawChart()
  }
}

/* ---------- trend chart ---------- */
const CHART_METRICS = {
  messages: ["消息量", "条", "#8b5cf6", "#22d3ee"],
  activeUsers: ["活跃用户", "人", "#22d3ee", "#34d399"],
  newUsers: ["新增用户", "人", "#f472b6", "#fbbf24"],
}
function drawChart() {
  const canvas = $("#statChart")
  if (!canvas) return
  const wrap = canvas.parentElement
  const cssW = wrap.clientWidth || 600
  const cssH = wrap.clientHeight || 260
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  const ctx = canvas.getContext("2d")
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  const rows = state.statsRows || []
  const empty = $("#chartEmpty")
  if (!rows.length) { empty?.classList.remove("hide"); return }
  empty?.classList.add("hide")
  const key = state.chartMetric
  const meta = CHART_METRICS[key] || CHART_METRICS.messages
  const values = rows.map(r => Number(r[key]) || 0)
  const max = Math.max(1, ...values)
  const pad = { l: 46, r: 18, t: 20, b: 30 }
  const w = cssW - pad.l - pad.r
  const h = cssH - pad.t - pad.b
  const isDark = document.documentElement.dataset.theme !== "light"
  const grid = isDark ? "rgba(148,163,184,.13)" : "rgba(15,23,42,.09)"
  const label = isDark ? "#64748b" : "#94a3b8"
  ctx.font = "11px ui-monospace, Consolas, monospace"
  ctx.textBaseline = "middle"
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + h / 4 * i
    ctx.strokeStyle = grid
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(pad.l, y + .5); ctx.lineTo(pad.l + w, y + .5); ctx.stroke()
    const val = max - max / 4 * i
    ctx.fillStyle = label
    ctx.textAlign = "right"
    ctx.fillText(val >= 1000 ? (val / 1000).toFixed(1) + "k" : String(Math.round(val)), pad.l - 9, y)
  }
  const X = i => pad.l + (values.length === 1 ? w / 2 : i / (values.length - 1) * w)
  const Y = v => pad.t + h - v / max * h
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + h)
  grad.addColorStop(0, meta[2] + "66")
  grad.addColorStop(1, meta[2] + "00")
  ctx.beginPath()
  values.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)))
  ctx.lineTo(X(values.length - 1), pad.t + h)
  ctx.lineTo(X(0), pad.t + h)
  ctx.closePath()
  ctx.fillStyle = grad
  ctx.fill()
  const line = ctx.createLinearGradient(pad.l, 0, pad.l + w, 0)
  line.addColorStop(0, meta[2]); line.addColorStop(1, meta[3])
  ctx.beginPath()
  values.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)))
  ctx.strokeStyle = line
  ctx.lineWidth = 2.4
  ctx.lineJoin = "round"
  ctx.stroke()
  const step = Math.max(1, Math.ceil(values.length / 7))
  ctx.fillStyle = label
  ctx.textAlign = "center"
  values.forEach((_, i) => {
    if (i % step === 0 || i === values.length - 1)
      ctx.fillText(rows[i].date.slice(4, 6) + "/" + rows[i].date.slice(6, 8), X(i), pad.t + h + 17)
  })
  const hover = state.chartHover
  if (hover != null && hover >= 0 && hover < values.length) {
    const hx = X(hover), hy = Y(values[hover])
    ctx.strokeStyle = isDark ? "rgba(255,255,255,.22)" : "rgba(15,23,42,.16)"
    ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(hx, pad.t); ctx.lineTo(hx, pad.t + h); ctx.stroke(); ctx.setLineDash([])
    ctx.fillStyle = meta[2]
    ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2); ctx.fill()
    const text = `${rows[hover].date}  ${values[hover]} ${meta[1]}`
    ctx.font = "11px ui-monospace, Consolas, monospace"
    const tw = ctx.measureText(text).width + 18
    const tx = Math.min(cssW - tw - 6, Math.max(6, hx - tw / 2))
    ctx.fillStyle = isDark ? "rgba(2,6,23,.92)" : "rgba(255,255,255,.96)"
    ctx.strokeStyle = isDark ? "rgba(148,163,184,.25)" : "rgba(15,23,42,.12)"
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.roundRect(tx, Math.max(4, hy - 34), tw, 26, 8); ctx.fill(); ctx.stroke()
    ctx.fillStyle = isDark ? "#e2e8f0" : "#0f172a"
    ctx.textAlign = "center"; ctx.textBaseline = "middle"
    ctx.fillText(text, tx + tw / 2, Math.max(4, hy - 34) + 13)
  }
}
function chartHover(e) {
  const canvas = $("#statChart")
  const rows = state.statsRows || []
  if (!canvas || !rows.length) return
  const rect = canvas.getBoundingClientRect()
  const x = e.clientX - rect.left
  const padL = 46, padR = 18
  const w = rect.width - padL - padR
  const idx = Math.round((x - padL) / Math.max(1, w) * (rows.length - 1))
  state.chartHover = Math.max(0, Math.min(rows.length - 1, idx))
  drawChart()
}
function bindChart() {
  const canvas = $("#statChart")
  if (!canvas) return
  canvas.addEventListener("mousemove", chartHover)
  canvas.addEventListener("mouseleave", () => { state.chartHover = null; drawChart() })
  let t = null
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(drawChart, 120) })
  document.querySelectorAll("[data-metric]").forEach(b => b.classList.toggle("on", b.dataset.metric === state.chartMetric))
}
bindChart()
document.querySelectorAll("[data-metric]").forEach(b => b.onclick = () => {
  state.chartMetric = b.dataset.metric
  localStorage.setItem("qqbot_chart", state.chartMetric)
  document.querySelectorAll("[data-metric]").forEach(x => x.classList.toggle("on", x === b))
  drawChart()
})
document.querySelectorAll("[data-range]").forEach(b => b.onclick = () => loadStats(b.dataset.range))
$("#customRange").onclick = () => loadStats("custom", $("#start").value, $("#end").value)

/* config */
state.cfgMode = "form"
state.cfgData = null
const CONFIG_FORM_FILE = "config/QQBot.yaml"
function configField(label, path, value, type = "text", hint = "", options = null) {
  const full = type === "textarea" ? " full" : ""
  let control
  if (type === "checkbox") {
    control = `<label class="switch"><input type="checkbox" data-path="${esc(path)}" ${value ? "checked" : ""}> ${esc(hint || "启用")}</label>`
  } else if (type === "select") {
    control = `<select data-path="${esc(path)}">${(options || []).map(([v, t]) => `<option value="${esc(v)}" ${String(value) === String(v) ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`
  } else if (type === "textarea") {
    control = `<textarea data-path="${esc(path)}" spellcheck="false">${esc(value ?? "")}</textarea>`
  } else {
    control = `<input type="${type}" data-path="${esc(path)}" value="${esc(value ?? "")}">`
  }
  return `<div class="field${full}"><label>${esc(label)}</label>${control}${hint && type !== "checkbox" ? `<small>${esc(hint)}</small>` : ""}</div>`
}
function renderConfigForm(data) {
  const botIds = (data.token || []).map(line => parseTokenFields(line).id).filter(Boolean)
  const md = data.markdown || {}
  const modeOptions = [["raw", "raw（自动）"], ["inline", "inline（内联）"], ["legacy", "legacy（普通）"]]
  const mdRows = botIds.map(id => `<div class="md-mode-row"><code>${esc(id)}</code><select data-md-bot="${esc(id)}">${modeOptions.map(([v,t]) => `<option value="${v}" ${(md[id] || "raw") === v ? "selected" : ""}>${t}</option>`).join("")}</select></div>`).join("")
  $("#cfgForm").innerHTML = `
    <div class="config-card full">
      <h3>机器人账号</h3>
      <p class="muted" style="font-size:10px;margin:0 0 10px">填写后由 WebUI 拼装成 token 行写入 YAML；表单里只编辑字段，不直接显示最终拼接字符串。</p>
      <div id="tokenRows"></div>
      <button class="ghost" type="button" id="tokenAdd" style="margin-top:4px">+ 添加机器人</button>
    </div>
    <div class="config-card">
      <h3>基础</h3>
      ${configField("权限", "permission", data.permission ?? "master", "select", "", [["master", "master（主人）"], ["all", "all（所有人）"]])}
      ${configField("图片压缩阈值（MB）", "imageLength", data.imageLength ?? 3, "number", "0 表示不压缩")}
      ${configField("二维码模式", "toQRCode", data.toQRCode === "link" ? "link" : (data.toQRCode === true || data.toQRCode === "true") ? "true" : "false", "select", "", [["true", "直接二维码"], ["link", "链接"], ["false", "关闭"]])}
      ${configField("回调按钮", "toCallback", !!data.toCallback, "checkbox")}
      ${configField("上传官方素材", "toBotUpload", !!data.toBotUpload, "checkbox")}
      ${configField("隐藏频道撤回提示", "hideGuildRecall", !!data.hideGuildRecall, "checkbox")}
      ${configField("自动安装测试插件", "autoInstallExample", !!data.autoInstallExample, "checkbox")}
      ${configField("群成员/入群申请事件", "groupMemberEvent", data.groupMemberEvent !== false, "checkbox")}
    </div>
    <div class="config-card">
      <h3>WebUI</h3>
      ${configField("启用", "webui.enabled", data.webui?.enabled !== false, "checkbox")}
      ${configField("监听地址", "webui.host", data.webui?.host || "0.0.0.0", "text", "默认 0.0.0.0")}
      ${configField("端口", "webui.port", data.webui?.port || 2580, "number", "修改后需要重启 TRSS")}
    </div>
    <div class="config-card">
      <h3>机器人</h3>
      ${configField("沙箱模式", "bot.sandbox", !!data.bot?.sandbox, "checkbox")}
      ${configField("最大重试", "bot.maxRetry", data.bot?.maxRetry === Infinity ? "Infinity" : (data.bot?.maxRetry ?? "Infinity"), "text", "数字或 Infinity")}
      ${configField("请求超时（毫秒）", "bot.timeout", data.bot?.timeout ?? 30000, "number")}
    </div>
    <div class="config-card">
      <h3>重连</h3>
      ${configField("启用重连", "reconnect.enable", data.reconnect?.enable !== false, "checkbox")}
      ${configField("初始间隔（毫秒）", "reconnect.interval", data.reconnect?.interval ?? 5000, "number")}
      ${configField("最大间隔（毫秒）", "reconnect.maxInterval", data.reconnect?.maxInterval ?? 300000, "number")}
      ${configField("最大重试次数", "reconnect.maxRetry", data.reconnect?.maxRetry ?? 0, "number", "0 表示不限")}
      ${configField("心跳超时（毫秒）", "reconnect.heartbeatTimeout", data.reconnect?.heartbeatTimeout ?? 0, "number")}
      ${configField("连接超时（毫秒）", "reconnect.connectTimeout", data.reconnect?.connectTimeout ?? 30000, "number")}
    </div>
    <div class="config-card full">
      <h3>Markdown 模板</h3>
      ${configField("模板变量 ID（逗号分隔）", "markdown.template", Array.isArray(md.template) ? md.template.join(", ") : (md.template || ""), "text", "例如：102145537_1767366896；留空则不使用模板")}
      <div class="muted" style="font-size:10px;margin:8px 0">各机器人 Markdown 模式</div>
      ${mdRows || `<div class="muted" style="font-size:11px">暂无机器人 token</div>`}
    </div>
`
  $("#cfgForm").querySelectorAll("input,select,textarea").forEach(el => el.addEventListener("input", () => { $("#cfgDirty").textContent = "未保存" }))
  $("#cfgForm").querySelectorAll("[data-md-bot]").forEach(el => el.addEventListener("change", () => { $("#cfgDirty").textContent = "未保存" }))
  renderTokenRows(data.token)
}
function parseTokenFields(line) {
  const p = String(line || "").split(":").map(x => x.trim())
  if (p.length === 2) return { id: "", appid: p[0], secret: p[1], mode: "ws", group: "1", private: "0" }
  if (p.length === 3 && p[2] === "2") return { id: "", appid: p[0], secret: p[1], mode: "webhook", group: "0", private: "0" }
  if (p.length >= 6) return { id: p[0], appid: p[1], secret: p[3], mode: "ws", group: p[4] || "1", private: p[5] || "0" }
  if (p.length === 5 && p[4] === "2") return { id: p[0], appid: p[1], secret: p[3], mode: "webhook", group: "0", private: "0" }
  if (p.length === 5) return { id: p[0], appid: p[1], secret: p[2], mode: "ws", group: p[3] || "1", private: p[4] || "0" }
  if (p.length === 4 && p[3] === "2") return { id: p[0], appid: p[1], secret: p[2], mode: "webhook", group: "0", private: "0" }
  return { id: p[0] || "", appid: p[1] || "", secret: p[2] || "", mode: "ws", group: "1", private: "0" }
}
function tokenRowHtml(t = {}) {
  return `<div class="token-row" data-token-row data-qq="${esc(t.id || "")}" data-appid="${esc(t.appid || "")}">
    <div class="token-fields">
      <label>AppID<input data-token="appid" value="${esc(t.appid || "")}" placeholder="开放平台 AppID"></label>
      <label>AppSecret<span class="secret-wrap"><input data-token="secret" type="password" value="${esc(t.secret || "")}" placeholder="32 位 AppSecret" minlength="32" maxlength="32" autocomplete="new-password"><button class="secret-toggle" type="button">显示</button></span></label>
      <label>机器人QQ（自动获取）<span class="resolved-wrap"><span class="resolved-qq" data-qq-label>${t.id ? esc(t.id) : "保存时自动获取"}</span><button class="token-resolve" type="button">获取</button></span></label>
      <label>连接方式<select data-token="mode"><option value="ws" ${t.mode !== "webhook" ? "selected" : ""}>WebSocket</option><option value="webhook" ${t.mode === "webhook" ? "selected" : ""}>WebHook</option></select></label>
      <label class="token-flags">群聊<select data-token="group"><option value="1" ${t.group !== "0" ? "selected" : ""}>启用</option><option value="0" ${t.group === "0" ? "selected" : ""}>关闭</option></select></label>
      <label class="token-flags">频道私域<select data-token="private"><option value="0" ${t.private !== "1" ? "selected" : ""}>关闭</option><option value="1" ${t.private === "1" ? "selected" : ""}>启用</option></select></label>
    </div>
    <button class="ghost token-del" type="button" title="删除这个机器人">删除</button>
  </div>`
}
function renderTokenRows(tokens) {
  const rows = Array.isArray(tokens) && tokens.length ? tokens.map(parseTokenFields) : [{}]
  $("#tokenRows").innerHTML = rows.map(tokenRowHtml).join("")
  const updateFlags = row => {
    const webhook = row.querySelector('[data-token="mode"]').value === "webhook"
    row.querySelectorAll(".token-flags").forEach(x => x.style.display = webhook ? "none" : "")
  }
  const setupRow = row => {
    updateFlags(row)
    row.querySelector('[data-token="mode"]').addEventListener("change", () => { updateFlags(row); $("#cfgDirty").textContent = "未保存" })
    const secret = row.querySelector('[data-token="secret"]')
    const toggle = row.querySelector('.secret-toggle')
    if (toggle) toggle.onclick = () => {
      const show = secret.type === "password"
      secret.type = show ? "text" : "password"
      toggle.textContent = show ? "隐藏" : "显示"
      toggle.setAttribute("aria-label", show ? "隐藏 AppSecret" : "显示 AppSecret")
    }
    const label = row.querySelector("[data-qq-label]")
    const resolve = async () => {
      const appid = row.querySelector('[data-token="appid"]').value.trim()
      const pass = secret.value.trim()
      if (!/^[A-Za-z0-9_-]+$/.test(appid)) throw new Error("AppID 格式不正确")
      if (!/^[A-Za-z0-9]{32}$/.test(pass)) throw new Error("AppSecret 必须是 32 位字母或数字")
      const data = await api("/api/bot/resolve", { method: "POST", body: JSON.stringify({ appid, secret: pass }) })
      row.dataset.qq = data.qq
      row.dataset.appid = appid
      label.textContent = data.qq
      $("#cfgDirty").textContent = "未保存"
      return data
    }
    row.querySelector(".token-resolve").onclick = async () => {
      try { const data = await resolve(); toast(`已获取机器人 QQ：${data.qq}`) } catch (e) { toast(e.message) }
    }
    row.querySelector('[data-token="appid"]').addEventListener("input", e => {
      if (row.dataset.appid && e.target.value.trim() !== row.dataset.appid) {
        row.dataset.qq = ""
        label.textContent = "保存时自动获取"
      }
    })
    row.querySelectorAll("input,select").forEach(el => el.addEventListener("input", () => { $("#cfgDirty").textContent = "未保存" }))
  }
  $("#tokenRows").querySelectorAll("[data-token-row]").forEach(setupRow)
  $("#tokenAdd").onclick = () => {
    $("#tokenRows").insertAdjacentHTML("beforeend", tokenRowHtml({ group: "1", private: "0" }))
    const rows = $("#tokenRows").querySelectorAll("[data-token-row]")
    const row = rows[rows.length - 1]
    setupRow(row)
    row.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }
  $("#tokenRows").onclick = e => {
    const btn = e.target.closest(".token-del")
    if (!btn) return
    if ($("#tokenRows").querySelectorAll("[data-token-row]").length <= 1) return toast("至少保留一个机器人账号")
    btn.closest("[data-token-row]").remove()
    $("#cfgDirty").textContent = "未保存"
  }
}

async function collectConfigForm() {
  const out = {}
  const set = (path, value) => {
    const parts = path.split(".")
    let obj = out
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]] ||= {}
    obj[parts.at(-1)] = value
  }
  $("#cfgForm").querySelectorAll("[data-path]").forEach(el => {
    let value
    if (el.type === "checkbox") value = el.checked
    else if (el.type === "number") value = Number(el.value)
    else if (el.dataset.path === "token") value = el.value.split("\n").map(x => x.trim()).filter(Boolean)
    else if (el.dataset.path === "markdown.template") value = el.value.split(",").map(x => x.trim()).filter(Boolean)
    else if (el.dataset.path === "toQRCode") value = el.value === "true" ? true : el.value === "link" ? "link" : false
    else value = el.value
    set(el.dataset.path, value)
  })
  const markdown = out.markdown || {}
  $("#cfgForm").querySelectorAll("[data-md-bot]").forEach(el => { markdown[el.dataset.mdBot] = el.value })
  if (Object.keys(markdown).length) out.markdown = markdown
  const tokens = []
  for (const row of $("#tokenRows").querySelectorAll("[data-token-row]")) {
    const val = key => row.querySelector(`[data-token="${key}"]`)?.value?.trim() || ""
    const appid = val("appid"), secret = val("secret")
    if (!appid && !secret) continue
    if (!/^[A-Za-z0-9_-]+$/.test(appid)) throw new Error("AppID 格式不正确：" + appid)
    if (!/^[A-Za-z0-9]{32}$/.test(secret)) throw new Error("AppSecret 必须是 32 位字母或数字")
    let qq = row.dataset.qq
    if (!qq || row.dataset.appid !== appid) {
      const data = await api("/api/bot/resolve", { method: "POST", body: JSON.stringify({ appid, secret }) })
      qq = data.qq
      row.dataset.qq = qq
      row.dataset.appid = appid
      row.querySelector("[data-qq-label]").textContent = qq
    }
    const mode = val("mode")
    tokens.push(mode === "webhook" ? `${qq}:${appid}:${secret}:2` : `${qq}:${appid}:${secret}:${val("group") || "1"}:${val("private") || "0"}`)
  }
  if (!tokens.length) throw new Error("至少配置一个机器人账号")
  out.token = tokens
  return out
}
function setConfigMode(mode) {
  const isForm = mode === "form" && $("#cfgFile").value === CONFIG_FORM_FILE
  state.cfgMode = isForm ? "form" : "raw"
  $("#cfgForm").classList.toggle("hide", !isForm)
  $("#cfgText").classList.toggle("hide", isForm)
  $("#cfgMode").querySelectorAll("[data-cfg-mode]").forEach(b => b.classList.toggle("on", b.dataset.cfgMode === state.cfgMode))
}
async function loadConfig() {
  const file = $("#cfgFile").value
  const canForm = file === CONFIG_FORM_FILE
  if (!canForm) state.cfgMode = "raw"
  setConfigMode(state.cfgMode)
  if (state.cfgMode === "form" && canForm) {
    try {
      const data = await api("/api/config/form?file=" + encodeURIComponent(file))
      state.cfgData = data
      renderConfigForm(data.data)
      $("#cfgDirty").textContent = ""
      return
    } catch (e) {
      toast(e.message)
      state.cfgMode = "raw"
      setConfigMode("raw")
    }
  }
  try {
    const data = await api("/api/config?file=" + encodeURIComponent(file))
    $("#cfgText").value = data.content
    $("#cfgDirty").textContent = ""
  } catch (e) { $("#cfgText").value = ""; $("#cfgDirty").textContent = ""; toast(e.message) }
}
$("#cfgFile").onchange = () => {
  state.cfgMode = $("#cfgFile").value === CONFIG_FORM_FILE ? "form" : "raw"
  loadConfig()
}
$("#cfgReload").onclick = loadConfig
$("#cfgMode").querySelectorAll("[data-cfg-mode]").forEach(b => b.onclick = () => {
  if (b.dataset.cfgMode === "form" && $("#cfgFile").value !== CONFIG_FORM_FILE) return toast("只有 QQBot.yaml 有可视化配置")
  setConfigMode(b.dataset.cfgMode)
  loadConfig()
})
$("#cfgText").addEventListener("input", () => { $("#cfgDirty").textContent = "未保存" })
$("#cfgForm").addEventListener("input", () => { $("#cfgDirty").textContent = "未保存" })
$("#cfgSave").onclick = async () => {
  try {
    if (state.cfgMode === "form" && $("#cfgFile").value === CONFIG_FORM_FILE) {
      const data = await api("/api/config/form", { method: "POST", body: JSON.stringify({ file: $("#cfgFile").value, values: await collectConfigForm() }) })
      $("#cfgDirty").textContent = ""
      toast(data.note || "已保存")
      loadConfig()
    } else {
      const data = await api("/api/config", { method: "PUT", body: JSON.stringify({ file: $("#cfgFile").value, content: $("#cfgText").value }) })
      $("#cfgDirty").textContent = ""
      toast(data.note || "已保存")
    }
  } catch (e) { toast(e.message) }
}

/* error code archive */
function errTime(ts) {
  try { return new Date(ts).toLocaleString("zh-CN", { hour12: false }) } catch { return "" }
}
function renderErrorList(data) {
  const entries = data.entries || []
  if (!entries.length) {
    $("#errList").innerHTML = `<div class="card empty-state"><div class="empty-ico"><svg viewBox="0 0 24 24"><path d="M10.3 3.8L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg></div><div><strong>没有匹配的报错</strong><p>当前错误码暂无记录，或记录已超过 30 天被清理。</p></div></div>`
    return
  }
  $("#errList").innerHTML = entries.map(e => `
    <article class="error-item">
      <div class="error-head">
        <span class="error-code">${esc(e.code || "unknown")}</span>
        <span class="error-time">${esc(errTime(e.time))}</span>
        <span class="error-bot">${esc(e.bot || "QQBot")}</span>
      </div>
      <div class="error-msg">${esc(e.message || "(无错误消息)")}</div>
      ${e.detail ? `<details><summary>查看堆栈 / 详情</summary><div class="error-detail">${esc(e.detail)}</div></details>` : ""}
    </article>`).join("")
}
async function loadErrorList(append = false) {
  try {
    const code = $("#errCodeSel").value || state.errorCode || "all"
    state.errorCode = code
    const limit = Math.min(500, Math.max(1, Number($("#errLimit").value) || 200))
    state.errorLimit = limit
    const offset = append ? state.errorOffset : 0
    const data = await api(`/api/error-log?code=${encodeURIComponent(code)}&limit=${limit}&offset=${offset}`)
    state.errorEntries = append ? [...state.errorEntries, ...(data.entries || [])] : (data.entries || [])
    state.errorOffset = offset + (data.entries?.length || 0)
    state.errorHasMore = !!data.hasMore
    state.errorTotal = data.total || 0
    renderErrorList({ entries: state.errorEntries })
    $("#errPage").textContent = `显示 ${state.errorEntries.length} / 共 ${state.errorTotal} 条`
    $("#errMore").classList.toggle("hide", !state.errorHasMore)
  } catch (e) {
    if (!append) $("#errList").innerHTML = `<div class="muted" style="padding:16px">${esc(e.message)}</div>`
    toast(e.message)
  }
}
async function loadErrors() {
  try {
    const data = await api("/api/error-log/codes")
    state.errorCodes = data.codes || []
    $("#errIgnored").value = (data.ignoredCodes || []).join(", ")
    $("#errStats").textContent = `${data.total || 0} 条 · ${state.errorCodes.length} 个错误码`
    $("#errRetention").textContent = `保留 ${data.retentionDays || 30} 天`
    const options = [`<option value="all">全部错误码（${data.total || 0}）</option>`]
      .concat(state.errorCodes.map(c => `<option value="${esc(c.code)}">${esc(c.code)}（${c.count}）${c.message ? " · " + esc(c.message.slice(0, 60)) : ""}</option>`))
    const sel = $("#errCodeSel")
    sel.innerHTML = options.join("")
    if (![...sel.options].some(o => o.value === state.errorCode)) state.errorCode = "all"
    sel.value = state.errorCode
    state.errorEntries = []
    state.errorOffset = 0
    await loadErrorList(false)
  } catch (e) {
    $("#errStats").textContent = e.message
    $("#errList").innerHTML = ""
  }
}
$("#errCodeSel").onchange = () => { state.errorCode = $("#errCodeSel").value; state.errorOffset = 0; loadErrorList(false) }
$("#errLoad").onclick = () => loadErrorList(false)
$("#errRefresh").onclick = loadErrors
$("#errLimit").onchange = () => { state.errorOffset = 0; loadErrorList(false) }
$("#errMore").onclick = () => loadErrorList(true)
$("#errIgnoreSave").onclick = async () => {
  try {
    const ignoredCodes = $("#errIgnored").value.split(/[,，\s]+/).map(x => x.trim()).filter(Boolean)
    const bad = ignoredCodes.find(x => !/^\d{5,}$/.test(x))
    if (bad) throw new Error(`错误码格式不正确：${bad}`)
    await api("/api/error-log/config", { method: "POST", body: JSON.stringify({ ignoredCodes }) })
    toast("屏蔽码已保存，历史对应记录已移除")
    await loadErrors()
  } catch (e) { toast(e.message) }
}

/* logs */
async function loadLogs() {
  try {
    const data = await api("/api/logs/files")
    $("#logFile").innerHTML = data.files.map(f => `<option>${esc(f)}</option>`).join("")
  } catch (e) { toast(e.message) }
}
const LOG_LEVELS = { TRACE: 0, DEBU: 1, DEBUG: 1, INFO: 2, MARK: 2, WARN: 3, ERRO: 4, ERROR: 4, FATA: 5, FATAL: 5 }
const LOG_MIN = { all: 0, debug: 1, info: 2, warn: 3, error: 4 }
function logLevelOf(line) {
  const m = String(line).match(/\[(TRACE|DEBU|DEBUG|INFO|MARK|WARN|ERRO|ERROR|FATA|FATAL)\]/)
  return m ? (LOG_LEVELS[m[1]] ?? 2) : 2
}
function logClass(line) {
  const level = logLevelOf(line)
  if (level >= 4) return "log-error"
  if (level === 3) return "log-warn"
  if (level <= 1) return "log-debug"
  return "log-info"
}
const ANSI_FG = {
  30: "#475569", 31: "#f87171", 32: "#4ade80", 33: "#fbbf24", 34: "#60a5fa", 35: "#e879f9", 36: "#22d3ee", 37: "#e5e7eb",
  90: "#64748b", 91: "#fb7185", 92: "#86efac", 93: "#fde047", 94: "#93c5fd", 95: "#f0abfc", 96: "#67e8f9", 97: "#ffffff",
}
const ANSI_BG = {
  40: "#1e293b", 41: "#7f1d1d", 42: "#14532d", 43: "#713f12", 44: "#1e3a8a", 45: "#701a75", 46: "#164e63", 47: "#334155",
  100: "#334155", 101: "#991b1b", 102: "#166534", 103: "#854d0e", 104: "#1e40af", 105: "#86198f", 106: "#155e75", 107: "#64748b",
}
function xtermColor(n) {
  n = Number(n) || 0
  if (n < 16) return ANSI_FG[30 + (n & 7)] || ANSI_FG[30]
  if (n < 232) {
    const v = n - 16
    const r = Math.floor(v / 36), g = Math.floor((v % 36) / 6), b = v % 6
    const c = x => x ? 55 + x * 40 : 0
    return `rgb(${c(r)},${c(g)},${c(b)})`
  }
  const c = 8 + (n - 232) * 10
  return `rgb(${c},${c},${c})`
}
function applyAnsiSgr(state, raw) {
  const codes = String(raw || "0").split(";").map(x => Number(x) || 0)
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    if (c === 0) Object.assign(state, { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false })
    else if (c === 1) state.bold = true
    else if (c === 2) state.dim = true
    else if (c === 3) state.italic = true
    else if (c === 4) state.underline = true
    else if (c === 7) state.inverse = true
    else if (c === 22) { state.bold = false; state.dim = false }
    else if (c === 23) state.italic = false
    else if (c === 24) state.underline = false
    else if (c === 27) state.inverse = false
    else if (c === 39) state.fg = null
    else if (c === 49) state.bg = null
    else if (ANSI_FG[c]) state.fg = ANSI_FG[c]
    else if (ANSI_BG[c]) state.bg = ANSI_BG[c]
    else if (c === 38 || c === 48) {
      const mode = codes[++i]
      let color = null
      if (mode === 5) color = xtermColor(codes[++i])
      else if (mode === 2) {
        const r = codes[++i] || 0, g = codes[++i] || 0, b = codes[++i] || 0
        color = `rgb(${r},${g},${b})`
      }
      if (color) { if (c === 38) state.fg = color; else state.bg = color }
    }
  }
}
function ansiCss(state) {
  let fg = state.fg, bg = state.bg
  if (state.inverse) [fg, bg] = [bg || "#0b1020", fg || "#e8edf7"]
  const css = []
  if (fg) css.push(`color:${fg}`)
  if (bg) css.push(`background:${bg}`)
  if (state.bold) css.push("font-weight:700")
  if (state.dim) css.push("opacity:.72")
  if (state.italic) css.push("font-style:italic")
  if (state.underline) css.push("text-decoration:underline")
  return css.join(";")
}
function ansiToHtml(text, re) {
  const ansi = /\x1b\[([0-9;]*)m/g
  const state = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false }
  let out = ""
  let last = 0
  const push = chunk => {
    if (!chunk) return
    let html = esc(chunk)
    if (re) html = html.replace(re, m => `<mark>${m}</mark>`)
    const css = ansiCss(state)
    out += css ? `<span style="${css}">${html}</span>` : html
  }
  let m
  while ((m = ansi.exec(text))) {
    push(text.slice(last, m.index))
    applyAnsiSgr(state, m[1])
    last = ansi.lastIndex
  }
  push(text.slice(last))
  return out || " "
}
function renderLogs(scroll = false) {
  const el = $("#logText")
  const min = LOG_MIN[state.logLevel] ?? 2
  let items = state.logLines.map((line, index) => ({ line, abs: state.logWindowStart + index }))
    .filter(item => logLevelOf(item.line) >= min || item.abs === state.logFocusLine)
  const q = state.logHighlightQuery
  const re = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig") : null
  el.innerHTML = items.map(({ line, abs }) => {
    return `<span data-log-line="${abs}" class="${logClass(line)}">${ansiToHtml(line, re)}</span>`
  }).join("\n")
  if (scroll) el.scrollTop = el.scrollHeight
}
function scrollToLogLine(abs) {
  const el = $("#logText")
  const span = el.querySelector(`span[data-log-line="${abs}"]`)
  if (!span) return
  const top = span.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
  el.scrollTop = Math.max(0, top - el.clientHeight / 2 + span.offsetHeight / 2)
}
function closeLogSearch(keepQuery = false) {
  $("#logSearchPanel").classList.add("hide")
  if (!keepQuery) {
    state.logHighlightQuery = ""
    state.logFocusLine = -1
    $("#logSearch").value = ""
    renderLogs()
  }
}
function renderLogSearchResults(data) {
  const panel = $("#logSearchPanel")
  panel.classList.remove("hide")
  const q = data.query || ""
  $("#logSearchTitle").textContent = q
    ? `“${q}” · 找到 ${data.found || 0} 条${data.truncated ? `（仅显示前 ${data.matches?.length || 0} 条）` : ""} · 共扫描 ${data.total || 0} 行`
    : "全文件搜索结果"
  const rows = data.matches || []
  if (!rows.length) {
    $("#logSearchResults").innerHTML = `<div class="muted" style="padding:14px">整个文件没有匹配内容</div>`
    return
  }
  $("#logSearchResults").innerHTML = rows.map(m => `<button class="log-search-result" data-log-line="${m.line}"><span class="ln">${m.line}</span><span class="tx">${esc(m.text || "")}</span></button>`).join("")
}
async function searchLogs() {
  const file = $("#logFile").value
  const q = $("#logSearch").value.trim()
  if (!file) return toast("请先选择日志文件")
  if (!q) return toast("请输入要搜索的内容")
  if (state.logSearching) return
  state.logSearching = true
  $("#logSearchBtn").disabled = true
  $("#logSearchPanel").classList.remove("hide")
  $("#logSearchTitle").textContent = `正在扫描整个 ${file}…`
  $("#logSearchResults").innerHTML = `<div class="muted" style="padding:14px">全文件扫描中，10M 行日志可能需要几秒…</div>`
  try {
    const data = await api(`/api/logs/search?file=${encodeURIComponent(file)}&q=${encodeURIComponent(q)}&case=${$("#logSearchCase").checked ? 1 : 0}`)
    renderLogSearchResults(data)
  } catch (e) {
    $("#logSearchTitle").textContent = `搜索失败：${e.message}`
    $("#logSearchResults").innerHTML = ""
  } finally {
    state.logSearching = false
    $("#logSearchBtn").disabled = false
  }
}
async function openLogSearchHit(line, query) {
  stopLogLive()
  const file = $("#logFile").value
  state.logHighlightQuery = query
  state.logFocusLine = line - 1
  $("#logStatus").textContent = `正在打开第 ${line} 行…`
  try {
    const data = await api(`/api/logs/page?file=${encodeURIComponent(file)}&center=${line - 1}&limit=${LOG_WINDOW_MAX}`)
    state.logLines = data.lines || []
    state.logWindowStart = data.start || 0
    state.logWindowEnd = data.end || 0
    state.logWindowTotal = data.total || 0
    state.logWindowMode = "window"
    state.logPaused = false
    $("#logPause").disabled = true
    renderLogs()
    updateLogWindowStatus()
    scrollToLogLine(line - 1)
  } catch (e) {
    $("#logStatus").textContent = `打开失败：${e.message}`
    toast(e.message)
  }
}
function captureLogAnchor() {
  const el = $("#logText")
  const box = el.getBoundingClientRect()
  for (const span of el.querySelectorAll("span[data-log-line]")) {
    const rect = span.getBoundingClientRect()
    const top = rect.top - box.top + el.scrollTop
    if (top + rect.height >= el.scrollTop) {
      return { line: Number(span.dataset.logLine), offset: el.scrollTop - top }
    }
  }
  return null
}
function restoreLogAnchor(anchor, fallback = 0) {
  const el = $("#logText")
  if (anchor) {
    const span = el.querySelector(`span[data-log-line="${anchor.line}"]`)
    if (span) {
      const box = el.getBoundingClientRect()
      const top = span.getBoundingClientRect().top - box.top + el.scrollTop
      el.scrollTop = Math.max(0, top + anchor.offset)
      return
    }
  }
  el.scrollTop = Math.max(0, fallback)
}
$("#logLevel").value = state.logLevel
$("#logLevel").onchange = () => {
  state.logLevel = $("#logLevel").value
  localStorage.setItem("qqbot_log_level", state.logLevel)
  if (state.logES) { stopLogLive(); startLogLive() }
  else renderLogs()
}
const LOG_WINDOW_MAX = 3000
const LOG_WINDOW_STEP = 1000
function updateLogWindowStatus(extra = "") {
  const file = $("#logFile").value || "日志"
  $("#logStatus").textContent = `${file} · 已加载第 ${state.logWindowStart + 1}-${state.logWindowEnd} 行 / 共 ${state.logWindowTotal} 行 · 当前窗口 ${state.logLines.length} 行${extra}`
}
async function loadInitialLog() {
  stopLogLive()
  closeLogSearch()
  state.logWindowMode = "window"
  state.logWindowLoading = true
  const file = $("#logFile").value
  const initial = Math.min(LOG_WINDOW_MAX, Math.max(100, Number($("#logTail").value) || 2000))
  $("#logTail").value = initial
  $("#logStatus").textContent = `正在读取 ${file}…`
  try {
    const data = await api(`/api/logs/page?file=${encodeURIComponent(file)}&offset=0&limit=${initial}`)
    state.logLines = data.lines || []
    state.logWindowStart = data.start || 0
    state.logWindowEnd = data.end || 0
    state.logWindowTotal = data.total || 0
    state.logPaused = false
    $("#logPause").disabled = true
    $("#logPause").classList.remove("on")
    $("#logPause").textContent = "暂停刷新"
    renderLogs(true)
    updateLogWindowStatus()
  } catch (e) {
    $("#logStatus").textContent = `加载失败：${e.message}`
    toast(e.message)
  } finally {
    state.logWindowLoading = false
  }
}
async function loadOlderWindow() {
  if (state.logWindowMode !== "window" || state.logWindowLoading || state.logWindowStart <= 0) return
  state.logWindowLoading = true
  const el = $("#logText")
  const beforeHeight = el.scrollHeight
  const beforeTop = el.scrollTop
  try {
    const limit = Math.min(LOG_WINDOW_STEP, state.logWindowStart)
    const data = await api(`/api/logs/page?file=${encodeURIComponent($("#logFile").value)}&offset=${state.logWindowTotal - state.logWindowStart}&limit=${limit}`)
    let incoming = data.lines || []
    const drop = Math.max(0, (data.end || 0) - state.logWindowStart)
    if (drop) incoming = incoming.slice(0, Math.max(0, incoming.length - drop))
    const anchor = captureLogAnchor()
    state.logLines = [...incoming, ...state.logLines]
    state.logWindowStart = data.start || 0
    state.logWindowTotal = data.total || state.logWindowTotal
    if (state.logLines.length > LOG_WINDOW_MAX) state.logLines.splice(LOG_WINDOW_MAX)
    state.logWindowEnd = state.logWindowStart + state.logLines.length
    renderLogs()
    restoreLogAnchor(anchor, beforeTop)
    updateLogWindowStatus(" · 已自动加载更早范围")
  } catch (e) {
    toast(e.message)
  } finally {
    state.logWindowLoading = false
  }
}
async function loadNewerWindow() {
  if (state.logWindowMode !== "window" || state.logWindowLoading || state.logWindowEnd >= state.logWindowTotal) return
  state.logWindowLoading = true
  const el = $("#logText")
  try {
    const currentEnd = state.logWindowEnd
    const limit = Math.min(LOG_WINDOW_STEP, state.logWindowTotal - currentEnd)
    const offset = Math.max(0, state.logWindowTotal - (currentEnd + limit))
    const data = await api(`/api/logs/page?file=${encodeURIComponent($("#logFile").value)}&offset=${offset}&limit=${limit}`)
    let incoming = data.lines || []
    const overlap = Math.max(0, currentEnd - (data.start || 0))
    if (overlap) incoming = incoming.slice(overlap)
    const anchor = captureLogAnchor()
    state.logLines.push(...incoming)
    state.logWindowEnd = currentEnd + incoming.length
    state.logWindowTotal = data.total || state.logWindowTotal
    if (state.logLines.length > LOG_WINDOW_MAX) {
      const excess = state.logLines.length - LOG_WINDOW_MAX
      state.logLines.splice(0, excess)
      state.logWindowStart += excess
    }
    renderLogs()
    restoreLogAnchor(anchor, el.scrollTop)
    updateLogWindowStatus(" · 已自动加载更新范围")
  } catch (e) {
    toast(e.message)
  } finally {
    state.logWindowLoading = false
  }
}
$("#logText").onscroll = () => {
  if (state.logWindowMode !== "window" || state.logWindowLoading) return
  const el = $("#logText")
  if (el.scrollTop < 60 && state.logWindowStart > 0) loadOlderWindow()
  else if (el.scrollHeight - el.scrollTop - el.clientHeight < 60 && state.logWindowEnd < state.logWindowTotal) loadNewerWindow()
}
$("#logLoad").onclick = loadInitialLog
$("#logFile").onchange = loadInitialLog
$("#logSearchBtn").onclick = searchLogs
$("#logSearch").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); searchLogs() } }
$("#logSearchClear").onclick = () => { closeLogSearch(); $("#logSearchPanel").classList.add("hide") }
$("#logSearchClose").onclick = () => closeLogSearch()
$("#logSearchResults").onclick = e => {
  const row = e.target.closest("[data-log-line]")
  if (!row) return
  openLogSearchHit(Number(row.dataset.logLine), $("#logSearch").value.trim())
}
$("#logPause").onclick = () => {
  state.logPaused = !state.logPaused
  $("#logPause").classList.toggle("on", state.logPaused)
  $("#logPause").textContent = state.logPaused ? "继续刷新" : "暂停刷新"
  if (!state.logPaused) renderLogs(true)
}
$("#logDownload").onclick = () => {
  const blob = new Blob([state.logLines.join("\n")], { type: "text/plain;charset=utf-8" })
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = ($("#logFile").value || "qqbot") + ".log"
  a.click()
  URL.revokeObjectURL(a.href)
}

function stopLogLive() {
  if (state.logES) { state.logES.close(); state.logES = null }
  if (state.logRenderTimer) { clearTimeout(state.logRenderTimer); state.logRenderTimer = null }
  $("#logLive").textContent = "开启实时"
  $("#logPause").disabled = true
  if (state.logPaused) {
    state.logPaused = false
    $("#logPause").classList.remove("on")
    $("#logPause").textContent = "暂停刷新"
  }
}
function scheduleLogRender(scroll = false) {
  state.logRenderScroll = state.logRenderScroll || scroll
  if (state.logRenderTimer) return
  state.logRenderTimer = setTimeout(() => {
    state.logRenderTimer = null
    const doScroll = state.logRenderScroll
    state.logRenderScroll = false
    renderLogs(doScroll)
  }, 380)
}
function pushLogLines(lines) {
  for (const line of lines) if (typeof line === "string") state.logLines.push(line)
  const max = state.logLevel === "all" || state.logLevel === "debug" ? 800 : 2000
  if (state.logLines.length > max) state.logLines.splice(0, state.logLines.length - max)
}
function startLogLive() {
  if (state.logES) return
  state.logLines = []
  closeLogSearch()
  state.logWindowMode = "live"
  renderLogs()
  const es = new EventSource(`/api/logs/live?level=${encodeURIComponent(state.logLevel)}`)
  es.onmessage = ev => {
    let lines
    if (ev.data?.startsWith("{")) {
      try { lines = JSON.parse(ev.data).lines || [] } catch { lines = [ev.data] }
    } else lines = [ev.data]
    pushLogLines(lines)
    if (!state.logPaused) scheduleLogRender(true)
  }
  es.onerror = () => { pushLogLines(["[实时日志连接断开]"]); renderLogs(true); stopLogLive() }
  state.logES = es
  $("#logLive").textContent = "停止实时"
  $("#logPause").disabled = false
  $("#logStatus").textContent = "实时日志已开启 · 仅保留最近渲染的日志"
}
$("#logLive").onclick = () => {
  if (state.logES) stopLogLive()
  else startLogLive()
}

/* materials */
async function loadMaterials() {
  try {
    const data = await api("/api/materials?bot=" + encodeURIComponent(state.bot))
    state.materials = data.list || []
    if (data.warning) toast(data.warning)
    renderMaterials()
  } catch (e) { toast(e.message) }
}
function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => toast("已复制"))
  const ta = document.createElement("textarea")
  ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); toast("已复制")
}
function renderMaterials() {
  const q = ($("#matSearch")?.value || "").trim().toLowerCase()
  const list = state.materials.filter(m => !q || String(m.image_id).toLowerCase().includes(q) || String(m.url).toLowerCase().includes(q))
  $("#matTable").innerHTML = "<tr><th>预览</th><th>image_id</th><th>引用</th><th>复用</th><th>操作</th></tr>" +
    (list.map(m => {
      const src = m.preview_url || (/^https?:\/\//i.test(m.url || "") ? m.url : "")
      const img = src
        ? `<a href="${esc(src)}" target="_blank" rel="noreferrer"><img class="mat-thumb" src="${esc(src)}" loading="lazy" title="点击查看大图" onerror="this.parentElement.innerHTML='<div class=&quot;mat-thumb mat-noimg&quot;>×</div>'"></a>`
        : `<div class="mat-thumb mat-noimg" title="暂无预览地址">×</div>`
      return `<tr><td>${img}</td><td>${esc(m.image_id)}</td><td class="muted" title="${esc(m.url)}">${esc(m.file_name || String(m.url || "").slice(0, 56))}${m.file_name ? "" : "…"}</td><td>${m.uses || 0}</td>
      <td><button class="ghost" data-copy="${esc(m.image_id)}">复制</button> <button class="danger" data-del="${esc(m.image_id)}">删除</button></td></tr>`
    }).join("") || `<tr><td colspan="5" class="table-empty">没有匹配的素材</td></tr>`)
  $("#matTable").querySelectorAll("[data-copy]").forEach(b => b.onclick = () => copyText(b.dataset.copy))
  $("#matTable").querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    if (!confirm("删除素材 " + b.dataset.del + "？")) return
    try { await api("/api/materials?bot=" + encodeURIComponent(state.bot) + "&id=" + encodeURIComponent(b.dataset.del), { method: "DELETE" }); loadMaterials() } catch (e) { toast(e.message) }
  })
}
$("#matReload").onclick = loadMaterials
$("#matSearch").oninput = renderMaterials

/* ---------- bot picker (all bots, not just connected) ---------- */
function botListMerged() {
  const map = new Map()
  const put = (key, data) => {
    const old = map.get(key) || {}
    map.set(key, { ...old, ...data, connected: !!(old.connected || data.connected) })
  }
  for (const b of state.bots || [])
    put(b.appid ? `appid:${b.appid}` : `id:${b.id}`, {
      appid: b.appid || "",
      botId: b.id,
      name: b.name || b.id,
      avatar: b.avatar || "",
      online: !!b.online,
      connected: true,
      uin: b.id,
    })
  for (const b of state.qqBots || [])
    put(`appid:${b.bot_appid}`, {
      appid: String(b.bot_appid),
      name: b.bot_name || String(b.bot_appid),
      avatar: b.bot_avatar || "",
      online: b.bot_status === 1,
      connected: false,
      uin: b.bot_uin || "",
      groups: b.statistics_data?.existing_groups || 0,
      friends: b.statistics_data?.stock_added_friends || 0,
    })
  return [...map.values()]
}
function nickAvatar(name, src) {
  return src ? mediaUrl(src) : `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="16" fill="#3b2a6b"/><text x="32" y="43" font-size="30" text-anchor="middle" fill="#c4b5fd" font-family="sans-serif">${(name || "Q")[0]}</text></svg>`)}`
}
document.addEventListener("error", e => {
  const img = e.target
  if (!(img instanceof HTMLImageElement)) return
  if (!img.classList.contains("msg-avatar") && !img.classList.contains("bot-avatar") && !img.classList.contains("grp-avatar")) return
  if (img.dataset.fallback) return
  img.dataset.fallback = "1"
  img.src = nickAvatar(img.alt || "", "")
}, true)

function selectBot(bot) {
  state.appid = bot.appid || ""
  state.qqBotName = bot.name || ""
  state.botAvatar = bot.avatar || ""
  state.bot = bot.botId || state.bots.find(b => String(b.appid) === String(bot.appid))?.id || ""
  localStorage.setItem("qqbot_appid", state.appid)
  localStorage.setItem("qqbot_name", state.qqBotName)
  localStorage.setItem("qqbot_avatar", state.botAvatar)
  $("#botSel").value = state.bot
  renderBotPicker()
  $("#botPicker").classList.remove("open")
  $("#botMenu").classList.add("hide")
  if (state.tab === "stats") { loadStats(state.range); loadGroupStats() }
  if (state.tab === "groups") loadGroups()
  if (state.tab === "chat") { state.chatGroup = ""; state.chatGroupsSig = ""; state.chatMembersSig = ""; loadChatGroups() }
  if (state.tab === "materials") loadMaterials()
}
function renderBotPicker() {
  const list = botListMerged()
  const current = list.find(b => String(b.appid) === String(state.appid) && state.appid) ||
    list.find(b => b.botId === state.bot) || list[0]
  if (current) {
    state.appid = current.appid || state.appid
    state.bot = current.botId || ""
    state.qqBotName = current.name
    state.botAvatar = current.avatar
  }
  $("#botCurrentAvatar").src = nickAvatar(current?.name, current?.avatar)
  $("#botCurrentName").textContent = current?.name || "未选择机器人"
  $("#botCurrentMeta").textContent = current
    ? `${current.uin || current.appid || ""}${current.online ? " · 在线" : " · 离线"}${current.connected === false ? " · 未接入 TRSS" : ""}`
    : "点击选择"
  if (!list.length) {
    $("#botMenu").innerHTML = `<div class="bot-item"><div class="bi-text"><strong>暂无机器人</strong><small>配置 token 或登录 QQ 开放平台</small></div></div>`
    return
  }
  $("#botMenu").innerHTML = list.map(b => `
    <div class="bot-item ${String(b.appid) === String(state.appid) ? "on" : ""}" data-appid="${esc(b.appid)}" data-botid="${esc(b.botId || "")}" data-name="${esc(b.name || "")}" data-avatar="${esc(b.avatar || "")}">
      <img class="bot-avatar" src="${esc(nickAvatar(b.name, b.avatar))}" alt="${esc(b.name || "机器人")}">
      <div class="bi-text"><strong>${esc(b.name || "未命名机器人")}</strong><small>${esc(b.uin || "")}${b.appid ? " · " + esc(b.appid) : ""}${b.connected === false ? " · 未接入 TRSS" : b.groups ? " · " + b.groups + " 群" : ""}</small></div>
      <i class="bi-dot ${b.online ? "on" : ""}"></i>
    </div>`).join("")
  $("#botMenu").querySelectorAll("[data-appid]").forEach(el => el.onclick = () => selectBot({
    appid: el.dataset.appid,
    botId: el.dataset.botid,
    name: el.dataset.name,
    avatar: el.dataset.avatar,
  }))
}
$("#botCurrent").onclick = e => {
  e.stopPropagation()
  $("#botPicker").classList.toggle("open")
  $("#botMenu").classList.toggle("hide")
}
document.addEventListener("click", e => {
  if (!e.target.closest("#botPicker")) {
    $("#botPicker")?.classList.remove("open")
    $("#botMenu")?.classList.add("hide")
  }
})

/* groups / local stats */
function avatarHtml(g) {
  const name = g.name || g.group || "群"
  if (g.avatar) return `<img class="grp-avatar" src="${esc(g.avatar)}" alt="${esc(name)}" loading="lazy">`
  let h = 0
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `<div class="grp-avatar" style="--h:${h}">${esc(String(name)[0] || "群")}</div>`
}
function recvLabel(v) {
  return ({ all: "全量消息", mention_and_context: "@及上下文", only_mention: "仅 @" })[v] || (v ? v : "消息设置未知")
}
function flagsHtml(g) {
  const out = []
  if (["owner", "admin"].includes(g.bot_role)) out.push(`<span class="tag ok">${g.bot_role === "owner" ? "群主" : "管理员"}</span>`)
  else if (g.bot_role) out.push(`<span class="tag">成员</span>`)
  if (g.allow_proactive) out.push(`<span class="tag cyan">主动消息</span>`)
  if (g.recv_msg_setting) out.push(`<span class="tag ${g.recv_msg_setting === "all" ? "violet" : ""}">${recvLabel(g.recv_msg_setting)}</span>`)
  return out.join(" ") || `<span class="tag">未知</span>`
}
async function loadGroupStats() {
  try {
    const d = await api("/api/group/stats?bot=" + encodeURIComponent(state.bot))
    $("#groupCards").innerHTML = [
      ["群总数", d.groups || 0, "个群"],
      ["群成员总数", d.members || 0, "人（按群累加）"],
      ["今日指令", d.commandsToday || 0, "条"],
      ["近 7 天指令", d.commands7d || 0, "条"],
    ].map(([k, v, x]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="k">${x}</div></div>`).join("")
    const top = d.top || []
    $("#groupTopTable").innerHTML = "<tr><th>群</th><th>总指令</th><th>今日指令</th><th>成员</th><th>最近活跃</th></tr>" +
      (top.map(g => `<tr><td>${avatarHtml(g)} <span class="grp-name">${esc(g.name || g.group_id)}</span></td><td>${g.commands || 0}</td><td>${g.days?.[dayKeyJs()]?.commands || 0}</td><td>${g.member_count || 0}</td><td class="muted">${g.last_active ? new Date(g.last_active).toLocaleString() : "-"}</td></tr>`).join("") || `<tr><td colspan="5" class="table-empty">还没有群消息数据，机器人收到群消息后会自动统计</td></tr>`)
  } catch (e) {
    $("#groupCards").innerHTML = `<div class="card muted">${esc(e.message)}</div>`
    $("#groupTopTable").innerHTML = `<tr><td class="table-empty">${esc(e.message)}</td></tr>`
  }
}
function dayKeyJs(t = Date.now()) {
  const d = new Date(t)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
}

async function loadGroups() {
  try {
    const data = await api("/api/groups?bot=" + encodeURIComponent(state.bot))
    state.groups = data.groups || []
    const sum = data.summary || {}
    $("#grpCards").innerHTML = [
      ["群总数", sum.groups ?? state.groups.length, "个群"],
      ["成员总数", sum.members || 0, "人"],
      ["今日指令", sum.commandsToday || 0, "条"],
      ["近 7 天指令", sum.commands7d || 0, "条"],
    ].map(([k, v, x]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="k">${x}</div></div>`).join("")
    $("#grpSel").innerHTML = state.groups.map(g => `<option value="${esc(g.group)}">${esc(g.name || g.group)}</option>`).join("") || "<option>无群</option>"
    $("#grpTable").innerHTML = "<tr><th>群</th><th>成员</th><th>总指令</th><th>今日指令</th><th>群内能力</th><th>最近活跃</th></tr>" +
      (state.groups.map(g => `<tr class="grp-row" data-group="${esc(g.group)}" style="cursor:pointer">
        <td>${avatarHtml(g)} <span class="grp-name">${esc(g.name || g.group)}</span><div class="grp-id">${esc(g.group)}</div></td>
        <td>${g.member_count || 0}</td><td>${g.commands || 0}</td><td>${g.commands_today || 0}</td>
        <td>${flagsHtml(g)}</td><td class="muted">${g.last_active ? new Date(g.last_active).toLocaleDateString() : "-"}</td></tr>`).join("") || `<tr><td colspan="6" class="table-empty">还没有群数据</td></tr>`)
    $("#grpTable").querySelectorAll(".grp-row").forEach(tr => tr.onclick = () => {
      $("#grpSel").value = tr.dataset.group
      loadMembers(tr.dataset.group)
    })
    if (state.groups[0]) loadMembers(state.groups[0].group)
    else { state.members = []; renderMembers() }
  } catch (e) { toast(e.message) }
}
async function loadMembers(group) {
  const q = new URLSearchParams({ bot: state.bot, group })
  state.currentGroup = group
  try {
    const data = await api("/api/group/members?" + q)
    state.members = data.members || []
    renderMembers()
  } catch (e) {
    state.members = []
    $("#memTable").innerHTML = `<tr><td style="color:#dc2626">${esc(e.message)}</td></tr>`
    $("#memCount").textContent = ""
  }
  loadBlacklist(group)
}
function renderMembers() {
  const q = ($("#memSearch")?.value || "").trim().toLowerCase()
  const members = state.members.filter(m => {
    const text = [m.member_openid, m.openid, m.user_id, m.username, m.nickname, m.member_role, m.role].join(" ").toLowerCase()
    return !q || text.includes(q)
  })
  $("#memCount").textContent = `${members.length} / ${state.members.length} 人`
  $("#memTable").innerHTML = "<tr><th>成员 openid</th><th>昵称</th><th>身份</th><th>操作</th></tr>" +
    (members.map(m => {
      const id = m.member_openid || m.openid || m.user_id
      return `<tr><td>${esc(id)}</td><td>${esc(m.username || m.nickname || "")}</td><td>${esc(m.member_role || m.role || "")}</td>
      <td><button class="ghost" data-mute="${esc(id)}">禁言</button>
      <button class="ghost" data-unmute="${esc(id)}">解除</button>
      <button class="danger" data-kick="${esc(id)}">踢出</button></td></tr>`
    }).join("") || `<tr><td colspan="4" class="table-empty">没有匹配的成员</td></tr>`)
  $("#memTable").querySelectorAll("[data-mute],[data-unmute],[data-kick]").forEach(b => b.onclick = async () => {
    const member = b.dataset.mute || b.dataset.unmute || b.dataset.kick
    const action = b.dataset.mute ? "mute" : b.dataset.unmute ? "unmute" : "kick"
    if (action === "kick" && !confirm("确定踢出该成员？")) return
    try {
      await api("/api/group/action", { method: "POST", body: JSON.stringify({ bot: state.bot, group: state.currentGroup, action, member, seconds: 600 }) })
      toast("操作成功")
    } catch (e) { toast(e.message) }
  })
}
$("#memSearch").oninput = renderMembers

async function loadBlacklist(group) {
  try {
    const data = await api("/api/group/blacklist?" + new URLSearchParams({ bot: state.bot, group }))
    const users = data.users || []
    $("#blTable").innerHTML = "<tr><th>openid</th><th>昵称</th><th>操作</th></tr>" +
      (users.map(u => `<tr><td>${esc(u.member_openid || u.openid)}</td><td>${esc(u.username || u.nickname || "")}</td><td><button class="danger" data-bl="${esc(u.member_openid || u.openid)}">移出</button></td></tr>`).join("") || "<tr><td colspan=3 class='muted'>暂无黑名单</td></tr>")
    $("#blTable").querySelectorAll("[data-bl]").forEach(b => b.onclick = async () => {
      try { await api("/api/group/blacklist", { method: "POST", body: JSON.stringify({ bot: state.bot, group, op: "del", members: [b.dataset.bl] }) }); loadBlacklist(group) } catch (e) { toast(e.message) }
    })
  } catch (e) { $("#blTable").innerHTML = `<tr><td style="color:#dc2626">${esc(e.message)}</td></tr>` }
}
$("#blReload").onclick = () => loadBlacklist($("#grpSel").value)
$("#blAdd").onclick = async () => {
  const member = $("#blInput").value.trim(); if (!member) return
  try { await api("/api/group/blacklist", { method: "POST", body: JSON.stringify({ bot: state.bot, group: $("#grpSel").value, op: "add", members: [member] }) }); $("#blInput").value=""; loadBlacklist($("#grpSel").value) } catch (e) { toast(e.message) }
}
$("#blDel").onclick = async () => {
  const member = $("#blInput").value.trim(); if (!member) return
  try { await api("/api/group/blacklist", { method: "POST", body: JSON.stringify({ bot: state.bot, group: $("#grpSel").value, op: "del", members: [member] }) }); $("#blInput").value=""; loadBlacklist($("#grpSel").value) } catch (e) { toast(e.message) }
}
$("#grpReload").onclick = loadGroups
$("#grpSel").onchange = () => loadMembers($("#grpSel").value)

/* ---------- group chat ---------- */
function closeChatStream() {
  if (state.chatES) { state.chatES.close(); state.chatES = null }
}
function renderChatGroupList() {
  const q = ($("#chatSearch")?.value || "").trim().toLowerCase()
  const list = (state.chatGroups || []).filter(g => {
    if (!q) return true
    return String(g.name || "").toLowerCase().includes(q) || String(g.group || "").toLowerCase().includes(q)
  })
  $("#chatGroups").innerHTML = list.map(g => `
    <div class="chat-group-item ${g.group === state.chatGroup ? "on" : ""}" data-chat-group="${esc(g.group)}">
      ${avatarHtml(g)}
      <div class="cg-text"><strong>${esc(g.name || g.group)}</strong><small>${g.member_count || 0} 人 · ${g.commands || 0} 指令</small></div>
    </div>`).join("") || `<div class="muted" style="padding:12px">${q ? "没有匹配的群" : "还没有群，先让机器人收到群消息"}</div>`
  $("#chatGroups").querySelectorAll("[data-chat-group]").forEach(el => {
    el.onclick = () => {
      const g = state.chatGroups.find(x => x.group === el.dataset.chatGroup)
      if (g) openChat(g)
    }
    el.oncontextmenu = e => {
      e.preventDefault()
      const g = state.chatGroups.find(x => x.group === el.dataset.chatGroup)
      if (g) showCtxMenu(e.clientX, e.clientY, [
        { label: "打开群聊", action: () => openChat(g) },
        { sep: true },
        { label: "退出群聊", danger: true, action: () => quitChatGroup(g) },
      ])
    }
  })
}
async function quitChatGroup(g) {
  const name = g.name || g.group
  if (!confirm(`确定让机器人退出群聊「${name}」吗？\n退出后将不再接收该群消息。`)) return
  try {
    await api("/api/group/quit", { method: "POST", body: JSON.stringify({ bot: state.bot, group: g.group }) })
    toast(`已退出群聊：${name}`)
    if (state.chatGroup === g.group) {
      state.chatGroup = ""
      closeChatStream()
      $("#chatMessages").innerHTML = `<div class="chat-empty">已退出群聊，正在刷新群列表…</div>`
    }
    await loadChatGroups()
  } catch (e) {
    toast(`退出群聊失败：${e.message}`)
  }
}
async function loadChatGroups(silent = false) {
  try {
    const data = await api("/api/groups?bot=" + encodeURIComponent(state.bot))
    state.chatGroups = data.groups || []
    const sig = state.chatGroups.map(g => [g.group, g.name, g.avatar, g.member_count, g.commands, g.bot_role].join("\u0001")).join("\u0002")
    if (!silent || sig !== state.chatGroupsSig) {
      state.chatGroupsSig = sig
      renderChatGroupList()
    }
    const current = state.chatGroups.find(x => x.group === state.chatGroup)
    if (!state.chatGroup && state.chatGroups[0]) openChat(state.chatGroups[0])
    else if (state.chatGroup && !current && state.chatGroups[0]) openChat(state.chatGroups[0])
    else if (current) {
      const title = current.name || current.group
      const meta = `${current.member_count || 0} 人 · ${current.commands || 0} 指令${current.bot_role ? " · " + (current.bot_role === "admin" ? "管理员" : current.bot_role === "owner" ? "群主" : "成员") : ""}`
      if ($("#chatTitle").textContent !== title) $("#chatTitle").textContent = title
      if ($("#chatMeta").textContent !== meta) $("#chatMeta").textContent = meta
    }
  } catch (e) {
    if (!silent) $("#chatGroups").innerHTML = `<div class="muted" style="padding:12px">${esc(e.message)}</div>`
  }
}
function startChatRefresh() {
  stopChatRefresh()
  state.chatRefreshTimer = setInterval(() => {
    if (document.hidden || state.tab !== "chat") return
    loadChatGroups(true)
    if (state.chatGroup) loadChatMembers(state.chatGroup, true)
  }, 15000)
}
function stopChatRefresh() {
  if (state.chatRefreshTimer) { clearInterval(state.chatRefreshTimer); state.chatRefreshTimer = null }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden || state.tab !== "chat") return
  loadChatGroups(true)
  if (state.chatGroup) loadChatMembers(state.chatGroup, true)
})
$("#chatSearch").addEventListener("input", renderChatGroupList)
$("#chatSearch").addEventListener("keydown", e => {
  if (e.key !== "Enter") return
  e.preventDefault()
  const q = ($("#chatSearch").value || "").trim().toLowerCase()
  const first = (state.chatGroups || []).find(g => !q || String(g.name || "").toLowerCase().includes(q))
  if (first) openChat(first)
})

async function openChat(group, reset = true) {
  if (!group) return
  if (state.chatGroup !== group.group) reset = true
  state.chatGroup = group.group
  $("#chatGroups").querySelectorAll("[data-chat-group]").forEach(el => el.classList.toggle("on", el.dataset.chatGroup === group.group))
  $("#chatTitle").textContent = group.name || group.group
  $("#chatMeta").textContent = `${group.member_count || 0} 人 · ${group.commands || 0} 指令${group.bot_role ? " · " + (group.bot_role === "admin" ? "管理员" : group.bot_role === "owner" ? "群主" : "成员") : ""}`
  closeChatStream()
  if (reset) {
    state.chatLastId = 0
    state.chatImages = []
    state.chatMap = new Map()
    state.chatMembersSig = ""
    renderChatPreviews()
    $("#chatMessages").innerHTML = `<div class="chat-empty">加载中…</div>`
  }
  try {
    const data = await api(`/api/group/messages?bot=${encodeURIComponent(state.bot)}&group=${encodeURIComponent(group.group)}&limit=100`)
    const list = data.messages || []
    $("#chatMessages").innerHTML = ""
    if (!list.length) $("#chatMessages").innerHTML = `<div class="chat-empty">还没有消息，机器人收到群消息后会实时显示</div>`
    for (const m of list) appendChatMessage(m, false)
    state.chatLastId = list.length ? list[list.length - 1].id : 0
    scrollChat(true)
    loadChatMembers(group.group)
    clearChatReply()
    clearChatMention()
    connectChatStream()
  } catch (e) {
    $("#chatMessages").innerHTML = `<div class="chat-empty">${esc(e.message)}</div>`
  }
}
function memberRoleLabel(v) {
  return ({ owner: "群主", admin: "管理员", member: "成员" })[v] || v || ""
}
function isBotAdmin() {
  return ["owner", "admin"].includes(state.chatBotRole)
}
async function loadChatMembers(group, silent = false) {
  if (silent && document.hidden) return
  const box = $("#chatMemberList")
  if (!silent) box.innerHTML = `<div class="muted" style="padding:12px">加载中…</div>`
  try {
    const data = await api(`/api/chat/members?bot=${encodeURIComponent(state.bot)}&group=${encodeURIComponent(group)}`)
    const next = data.members || []
    state.chatMembersLocalOnly = !!data.localOnly
    state.chatBotRole = data.bot_role || ""
    const sig = next.map(m => [
      m.member_openid || m.openid || m.user_id,
      m.username || m.nickname,
      m.avatar,
      m.member_role || m.role,
    ].join("\u0001")).join("\u0002") + `|${state.chatMembersLocalOnly}|${state.chatBotRole}`
    if (silent && sig === state.chatMembersSig) return
    state.chatMembersSig = sig
    state.chatMembers = next
    renderChatMembers(data.warning)
  } catch (e) {
    if (!silent) box.innerHTML = `<div class="muted" style="padding:12px">${esc(e.message)}</div>`
  }
}
function renderChatMembers(warning) {
  const list = state.chatMembers || []
  $("#chatMemberCount").textContent = `${list.length}${state.chatMembersLocalOnly ? " · 本地" : ""}`
  $("#chatMemberCount").title = state.chatMembersLocalOnly ? "没有群成员列表权限，仅显示本地收发消息里的成员" : (warning || "")
  $("#chatMemberList").innerHTML = list.map(m => {
    const id = m.member_openid || m.openid || m.user_id
    const role = m.member_role || m.role || ""
    return `<div class="chat-member" data-member="${esc(id)}" data-name="${esc(m.username || m.nickname || id)}" data-role="${esc(role)}" data-avatar="${esc(m.avatar || "")}">
      <img class="bot-avatar" src="${esc(nickAvatar(m.username || m.nickname || id, m.avatar))}" alt="${esc(m.username || m.nickname || id)}" loading="lazy" decoding="async">
      <div class="cm-text"><strong>${esc(m.username || m.nickname || id)}</strong><small>${esc(id)}</small></div>
      ${role ? `<span class="tag ${role === "owner" || role === "admin" ? "violet" : ""}">${memberRoleLabel(role)}</span>` : ""}
    </div>`
  }).join("") || `<div class="muted" style="padding:12px">暂无成员数据</div>`
  document.querySelectorAll("#chatMessages .quoted[data-raw]").forEach(el => {
    el.textContent = resolveAtMentions(el.dataset.raw).slice(0, 240)
  })
  document.querySelectorAll("#chatMessages [data-at]").forEach(el => {
    el.textContent = resolveAtMentions(el.dataset.at)
  })
  document.querySelectorAll("#chatMessages .msg .msg-name").forEach(row => {
    const msgRow = row.closest(".msg")
    const m = state.chatMap?.get(Number(msgRow?.dataset.mid))
    if (!m || m.direction === "out") return
    const raw = String(m.sender?.id || "").replace(/^\d+[:_\uF03A]/, "")
    const hit = list.find(x => String(x.member_openid || x.openid || x.user_id || "").replace(/^\d+[:_\uF03A]/, "") === raw)
    if (!hit) return
    if (!row.querySelector(".msg-role") && hit.member_role) {
      const tag = document.createElement("span")
      tag.className = "msg-role " + (["owner", "admin"].includes(hit.member_role) ? "violet" : "")
      tag.textContent = memberRoleLabel(hit.member_role)
      row.insertBefore(tag, row.querySelector(".msg-time"))
    }
    const img = msgRow?.querySelector(".msg-avatar")
    if (img && hit.avatar && img.dataset.avatarSrc !== hit.avatar) {
      img.src = nickAvatar(hit.username || hit.nickname, hit.avatar)
      img.dataset.avatarSrc = hit.avatar
      img.dataset.realAvatar = "1"
    }
  })
  $("#chatMemberList").querySelectorAll("[data-member]").forEach(el => {
    el.oncontextmenu = e => { e.preventDefault(); showMemberMenu(el.dataset, e.clientX, e.clientY) }
    el.onclick = () => setChatMention({ id: el.dataset.member, name: el.dataset.name })
  })
}
function showCtxMenu(x, y, items) {
  const menu = $("#ctxMenu")
  menu.innerHTML = items.map((it, i) => it.sep ? `<div class="ctx-sep"></div>` : `<div class="ctx-item ${it.danger ? "danger" : ""}" data-ci="${i}">${esc(it.label)}${it.hint ? `<span class="pk">${esc(it.hint)}</span>` : ""}</div>`).join("")
  menu.classList.remove("hide")
  const rect = menu.getBoundingClientRect()
  menu.style.left = Math.max(8, Math.min(x, innerWidth - rect.width - 8)) + "px"
  menu.style.top = Math.max(8, Math.min(y, innerHeight - rect.height - 8)) + "px"
  menu.querySelectorAll("[data-ci]").forEach(el => el.onclick = () => {
    const item = items[Number(el.dataset.ci)]
    closeCtxMenu()
    item?.action?.()
  })
}
function closeCtxMenu() { $("#ctxMenu").classList.add("hide") }
document.addEventListener("mousedown", e => { if (e.button === 0 && !e.target.closest("#ctxMenu")) closeCtxMenu() })
document.addEventListener("scroll", closeCtxMenu, true)
window.addEventListener("resize", closeCtxMenu)
function showMemberMenu(data, x, y) {
  const id = data.member_openid || data.member || data.id
  const name = data.username || data.name || id
  const items = [{ label: "@ " + name, action: () => setChatMention({ id, name }) }]
  if (isBotAdmin()) {
    items.push(
      { sep: true },
      { label: "禁言…", action: () => openMuteDialog({ id, name }) },
      { label: "解除禁言", action: () => memberAction("unmute", id) },
      { sep: true },
      { label: "踢出群", danger: true, action: () => memberAction("kick", id) },
    )
  }
  showCtxMenu(x, y, items)
}
let muteTarget = null
function openMuteDialog(member) {
  muteTarget = member
  $("#muteName").textContent = member.name || member.id
  $("#muteCustom").value = "10"
  $("#muteUnit").value = "60"
  $("#muteErr").textContent = ""
  $("#muteDialog").classList.remove("hide")
}
function closeMuteDialog() { $("#muteDialog").classList.add("hide") }
$("#muteCancel").onclick = closeMuteDialog
$("#muteDialog").addEventListener("mousedown", e => { if (e.target === $("#muteDialog")) closeMuteDialog() })
document.querySelectorAll("[data-mute-sec]").forEach(b => b.onclick = () => {
  const sec = Number(b.dataset.muteSec)
  if (sec % 86400 === 0) { $("#muteUnit").value = "86400"; $("#muteCustom").value = String(sec / 86400) }
  else if (sec % 3600 === 0) { $("#muteUnit").value = "3600"; $("#muteCustom").value = String(sec / 3600) }
  else { $("#muteUnit").value = "60"; $("#muteCustom").value = String(sec / 60) }
})
$("#muteConfirm").onclick = async () => {
  if (!muteTarget) return
  const n = Number($("#muteCustom").value)
  const unit = Number($("#muteUnit").value)
  const seconds = Math.round(n * unit)
  if (!Number.isFinite(seconds) || seconds < 1) return ($("#muteErr").textContent = "请输入有效时长")
  if (seconds > 30 * 86400) return ($("#muteErr").textContent = "最长 30 天")
  try {
    await api("/api/group/action", { method: "POST", body: JSON.stringify({ bot: state.bot, group: state.chatGroup, action: "mute", member: muteTarget.id, seconds }) })
    closeMuteDialog()
    toast("已禁言 " + (seconds >= 3600 ? Math.round(seconds / 3600) + " 小时" : Math.round(seconds / 60) + " 分钟"))
  } catch (e) { $("#muteErr").textContent = e.message }
}

async function memberAction(action, member, seconds = 0) {
  if (action === "kick" && !confirm("确定踢出该成员？")) return
  try {
    await api("/api/group/action", { method: "POST", body: JSON.stringify({ bot: state.bot, group: state.chatGroup, action, member, seconds }) })
    toast(action === "mute" ? "已禁言 10 分钟" : action === "unmute" ? "已解除禁言" : "已踢出")
    loadChatMembers(state.chatGroup)
  } catch (e) { toast(e.message) }
}
function renderMentionBar() {
  const list = state.chatMentions || []
  if (!list.length) {
    $("#chatMentionName").innerHTML = ""
    $("#chatMentionBar").classList.add("hide")
    return
  }
  $("#chatMentionName").innerHTML = list.map(m =>
    `<span class="mention-chip" data-mention-id="${esc(m.id)}">${esc(m.name || m.id)}<button type="button" data-remove-mention="${esc(m.id)}" title="移除">×</button></span>`
  ).join("")
  $("#chatMentionBar").classList.remove("hide")
  $("#chatInput").focus()
}
function setChatMention(member) {
  if (!member?.id) return
  const id = String(member.id).replace(/^\d+[:_\uF03A]/, "")
  if (!id) return
  const list = state.chatMentions ||= []
  if (!list.some(m => String(m.id).replace(/^\d+[:_\uF03A]/, "") === id))
    list.push({ id, name: member.name || member.username || id })
  renderMentionBar()
}
function clearChatMention() {
  state.chatMentions = []
  renderMentionBar()
}
$("#chatMentionName").addEventListener("click", e => {
  const id = e.target.closest("[data-remove-mention]")?.dataset.removeMention
  if (!id) return
  state.chatMentions = (state.chatMentions || []).filter(m => String(m.id) !== String(id))
  renderMentionBar()
})
function setChatReply(message) {
  if (!message?.message_id) return toast("这条消息没有可用的消息 ID")
  state.chatReply = message
  $("#chatReplyName").textContent = message.sender?.name || "消息"
  $("#chatReplyBar").classList.remove("hide")
  $("#chatInput").focus()
}
function clearChatReply() {
  state.chatReply = null
  $("#chatReplyBar").classList.add("hide")
}
async function recallMessage(message) {
  if (!confirm("确定撤回这条消息？")) return
  try {
    await api("/api/group/recall", { method: "POST", body: JSON.stringify({ bot: state.bot, group: state.chatGroup, message_id: message.message_id }) })
    message.recalled = true
    const row = document.querySelector(`.msg[data-mid="${message.id}"]`)
    if (row) { row.classList.add("recalled"); const b = row.querySelector(".bubble"); if (b) b.textContent = "消息已撤回" }
    toast("已撤回")
  } catch (e) { toast(e.message) }
}
async function copyPlainText(text) {
  text = String(text || "")
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    toast("已复制文字")
    return true
  } catch {
    try {
      const ta = document.createElement("textarea")
      ta.value = text
      ta.style.cssText = "position:fixed;left:-9999px;top:0"
      document.body.appendChild(ta)
      ta.select()
      document.execCommand("copy")
      ta.remove()
      toast("已复制文字")
      return true
    } catch { toast("复制失败"); return false }
  }
}
function imageUrlsOf(message) {
  return (message.content || []).filter(i => i.type === "image" && i.url).map(i => i.url)
}
function mediaLinksOf(message) {
  return (message.content || [])
    .filter(i => ["image", "record", "video", "file"].includes(i.type) && i.url)
    .map(i => i.url)
}
function copyTextOf(message) {
  const parts = []
  if (message.quoted) parts.push("> " + message.quoted)
  for (const i of message.content || []) {
    if (["text", "markdown", "face", "at"].includes(i.type) && i.text) parts.push(i.text)
    else if (i.type === "file" && i.url) parts.push(`${i.name || "文件"} ${i.url}`)
    else if (["record", "video"].includes(i.type) && i.url) parts.push(i.url)
  }
  return parts.join("\n").trim()
}
async function copyMessageImage(url) {
  const src = mediaUrl(url)
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    await copyPlainText(url)
    toast("浏览器不支持直接复制图片，已复制图片地址")
    return
  }
  try {
    const res = await fetch(src, { credentials: "same-origin" })
    if (!res.ok) throw new Error("图片下载失败")
    const blob = await res.blob()
    let png = blob
    if (blob.type !== "image/png") {
      const bitmap = await createImageBitmap(blob)
      const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement("canvas")
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"))
      bitmap.close?.()
    }
    if (!png) throw new Error("图片转换失败")
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
    toast("已复制图片")
  } catch (e) {
    await copyPlainText(url)
    toast("图片复制失败，已复制图片地址")
  }
}
async function copyMessage(message, mode = "all") {
  const text = copyTextOf(message)
  const images = imageUrlsOf(message)
  const links = mediaLinksOf(message)
  if (mode === "text") return copyPlainText(text)
  if (mode === "image") return images.length ? copyMessageImage(images[0]) : copyPlainText(text)
  if (mode === "link") return copyPlainText(links.join("\n") || text)
  if (images.length && !text) return copyMessageImage(images[0])
  const content = [text, ...links.filter(url => !images.includes(url))].filter(Boolean).join("\n")
  return copyPlainText(content || links[0] || "")
}

function showMessageMenu(message, x, y) {
  const items = []
  const text = copyTextOf(message)
  const images = imageUrlsOf(message)
  const links = mediaLinksOf(message)
  items.push({ label: "复制消息", action: () => copyMessage(message) })
  if (text) items.push({ label: "复制文字", action: () => copyMessage(message, "text") })
  if (images.length) items.push({ label: images.length > 1 ? "复制第一张图片" : "复制图片", action: () => copyMessage(message, "image") })
  if (links.length) items.push({ label: "复制链接", action: () => copyMessage(message, "link") })
  items.push({ sep: true })
  if (message.direction === "in" && message.sender?.id)
    items.push({ label: "@ " + (message.sender.name || "发送者"), action: () => setChatMention({ id: message.sender.id, name: message.sender.name }) })
  items.push({ label: "引用回复", action: () => setChatReply(message) })
  if (message.message_id)
    items.push({ sep: true }, { label: "撤回", danger: true, action: () => recallMessage(message) })
  showCtxMenu(x, y, items)
}
$("#chatMessages").addEventListener("contextmenu", e => {
  const row = e.target.closest(".msg")
  if (!row) return
  e.preventDefault()
  const message = state.chatMap?.get(Number(row.dataset.mid))
  if (!message) return
  if (e.target.closest(".msg-avatar") || e.target.closest(".msg-name")) {
    const s = message.sender || {}
    showMemberMenu({ member: s.id, name: s.name, username: s.name, avatar: s.avatar }, e.clientX, e.clientY)
  } else showMessageMenu(message, e.clientX, e.clientY)
})
$("#chatReplyCancel").onclick = clearChatReply
$("#chatMentionCancel").onclick = clearChatMention

function connectChatStream() {
  closeChatStream()
  if (!state.chatGroup) return
  const es = new EventSource(`/api/group/stream?bot=${encodeURIComponent(state.bot)}&group=${encodeURIComponent(state.chatGroup)}&since=${state.chatLastId}`)
  es.onmessage = ev => {
    try {
      const m = JSON.parse(ev.data)
      if (!m?.id || m.id <= state.chatLastId) return
      state.chatLastId = m.id
      appendChatMessage(m, true)
    } catch {}
  }
  es.onerror = () => { state.chatES = null }
  state.chatES = es
}
function mediaUrl(url) {
  return /^https?:\/\//i.test(url || "") ? "/api/chat/media?url=" + encodeURIComponent(url) : url
}
const CHAT_IMAGE_PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="
let chatImageObserver = null
function getChatImageObserver() {
  if (chatImageObserver || typeof IntersectionObserver === "undefined") return chatImageObserver
  const root = document.querySelector("#chatMessages")
  chatImageObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const img = entry.target
      const src = img.dataset.src
      if (!src) continue
      img.src = src
      img.removeAttribute("data-src")
      img.classList.add("lazy-loaded")
      chatImageObserver.unobserve(img)
    }
  }, { root, rootMargin: "300px 0px", threshold: 0.01 })
  return chatImageObserver
}
function observeChatImages(root = document) {
  const images = root.querySelectorAll ? root.querySelectorAll("img[data-src]") : []
  const observer = getChatImageObserver()
  for (const img of images) {
    if (observer) observer.observe(img)
    else {
      img.src = img.dataset.src
      img.removeAttribute("data-src")
    }
  }
}

function messageText(m) {
  return (m?.content || []).map(i => i.type === "at" ? i.text : i.type === "text" || i.type === "markdown" ? i.text : "").filter(Boolean).join(" ").slice(0, 240)
}
function fileSizeText(size) {
  const n = Number(size) || 0
  if (!n) return ""
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB"
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB"
  return n + " B"
}
function chatContentHtml(content) {
  return (content || []).map(i => {
    if (i.type === "text") return renderRichText(i.text)
    if (i.type === "face" && String(i.text || "").trim() === "[表情 0]") return ""
    if (i.type === "at") return `<span class="tag" data-at="${esc(i.text)}">${esc(resolveAtMentions(i.text))}</span>`
    if (i.type === "image") {
      if (!i.url) return `<span class="muted">[图片]</span>`
      const tall = i.width && i.height && i.height / i.width > 2.5
      const dim = i.width && i.height ? ` width="${Math.min(2000, i.width)}" height="${Math.min(2000, i.height)}"` : ""
      const style = tall ? ` style="width:min(100%,${Math.max(260, Math.min(420, i.width || 260))}px);height:auto"` : ""
      const lazySrc = esc(mediaUrl(i.url))
      return `<a class="msg-image-link" href="${esc(i.url)}" target="_blank" rel="noreferrer"><img class="msg-image" src="${CHAT_IMAGE_PLACEHOLDER}" data-src="${lazySrc}"${dim}${style} decoding="async" alt="图片"></a>`
    }
    if (i.type === "record") return i.url ? `<audio controls src="${esc(i.url)}"></audio>` : `<span class="muted">[语音]</span>`
    if (i.type === "video") return i.url ? `<video controls src="${esc(i.url)}"></video>` : `<span class="muted">[视频]</span>`
    if (i.type === "file") {
      if (!i.url) return `<span class="muted">[文件]</span>`
      const size = fileSizeText(i.size)
      return `<a class="file-card" href="${esc(i.url)}" target="_blank" rel="noreferrer">
        <span class="file-icon">📄</span>
        <span class="file-info"><b>${esc(i.name || "群文件")}</b>${size ? `<small>${esc(size)}</small>` : ""}</span>
        <span class="file-action">下载</span>
      </a>`
    }
    if (i.type === "markdown") return renderRichText(i.text)
    if (i.type === "card") return i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noreferrer">${esc(i.text)}</a>` : `<span>${esc(i.text)}</span>`
    if (i.type === "reply") return `<span class="tag">${esc(i.text)}</span>`
    return i.text ? esc(i.text) : ""
  }).join("")
}
function appendChatMessage(m, live) {
  const box = $("#chatMessages")
  if (!box) return
  if (box.querySelector(`[data-mid="${m.id}"]`)) return
  if (box.querySelector(".chat-empty")) box.innerHTML = ""
  const out = m.direction === "out"
  const name = m.sender?.name || (out ? "机器人" : "成员")
  const rawSender = String(m.sender?.id || "").replace(/^\d+[:_\uF03A]/, "")
  const known = state.chatMembers?.find(x => String(x.member_openid || x.openid || x.user_id).replace(/^\d+[:_\uF03A]/, "") === rawSender)
  const role = out ? "bot" : (m.sender?.role || known?.member_role || "")
  const roleText = out ? "机器人" : (role ? memberRoleLabel(role) : "")
  const time = new Date(m.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  state.chatMap.set(Number(m.id), m)
  const el = document.createElement("div")
  el.className = "msg " + (out ? "out" : "in") + (m.recalled ? " recalled" : "")
  el.dataset.mid = m.id
  const avatarSrc = m.sender?.avatar || known?.avatar || ""
  const retry = m.status === "failed"
    ? `<button class="msg-retry" data-retry="${esc(m.id)}" title="${esc(m.error || "发送失败，点击重试")}" aria-label="发送失败，点击重试">!</button>`
    : ""
  el.className += m.status === "failed" ? " failed" : (m.status === "sending" || m.status === "retrying") ? " sending" : ""
  el.innerHTML = `<img class="msg-avatar" src="${esc(nickAvatar(name, avatarSrc))}" alt="${esc(name)}">
    <div class="msg-body"><div class="msg-name"><span>${esc(name)}</span>${roleText ? `<span class="msg-role ${role === "owner" || role === "admin" ? "violet" : ""}">${esc(roleText)}</span>` : ""}<span class="msg-time">${time}</span></div>
    <div class="msg-line">${retry}<div class="bubble">${m.quoted ? `<div class="quoted" data-raw="${esc(String(m.quoted).slice(0, 240))}">${esc(resolveAtMentions(String(m.quoted)).slice(0, 240))}</div>` : ""}${m.recalled ? "消息已撤回" : chatContentHtml((m.content || []).filter(i => !(m.quoted && i.type === "reply")))}</div></div></div>`
  box.appendChild(el)
  observeChatImages(el)
  const rows = box.querySelectorAll(".msg")
  if (rows.length > 500) for (let i = 0; i < rows.length - 500; i++) rows[i].remove()
  if (live && box.scrollHeight - box.scrollTop - box.clientHeight < 160) scrollChat(true)
}
function scrollChat(force) {
  const box = $("#chatMessages")
  if (box && (force || box.scrollHeight - box.scrollTop - box.clientHeight < 160)) box.scrollTop = box.scrollHeight
}
function addChatImages(files) {
  const list = [...(files || [])].filter(f => f && /^image\//.test(f.type))
  if (!list.length) return
  for (const file of list.slice(0, 9 - state.chatImages.length)) {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const max = 1600
        const scale = Math.min(1, max / Math.max(img.width, img.height))
        const canvas = document.createElement("canvas")
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height)
        const type = /png/i.test(file.type) && file.size < 1.5 * 1024 * 1024 ? "image/png" : "image/jpeg"
        const data = canvas.toDataURL(type, 0.86)
        state.chatImages.push({ id: `${Date.now()}-${Math.random()}`, name: file.name || "image", data })
        renderChatPreviews()
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  }
}
function renderChatPreviews() {
  const box = $("#chatPreviews")
  box.classList.toggle("hide", !state.chatImages.length)
  box.innerHTML = state.chatImages.map(i => `<div class="chat-preview"><img src="${i.data}" alt=""><button data-remove-img="${i.id}">×</button></div>`).join("")
  box.querySelectorAll("[data-remove-img]").forEach(b => b.onclick = () => {
    state.chatImages = state.chatImages.filter(i => i.id !== b.dataset.removeImg)
    renderChatPreviews()
  })
}
$("#chatPick").onclick = () => $("#chatFile").click()
$("#chatFile").onchange = e => { addChatImages(e.target.files); e.target.value = "" }
$("#chatInput").addEventListener("paste", e => {
  const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === "file" && i.type.startsWith("image/")).map(i => i.getAsFile()).filter(Boolean)
  if (files.length) { e.preventDefault(); addChatImages(files) }
})
$(".chat-compose").addEventListener("dragover", e => { e.preventDefault() })
$(".chat-compose").addEventListener("drop", e => {
  e.preventDefault()
  addChatImages(e.dataTransfer?.files)
})
function removeChatRow(id) {
  document.querySelector(`#chatMessages .msg[data-mid="${id}"]`)?.remove()
  state.chatMap.delete(Number(id))
}
function refreshChatRow(m) {
  removeChatRow(m.id)
  state.chatMap.set(Number(m.id), m)
  appendChatMessage(m, false)
}
function makePendingMessage(payload) {
  const id = -Date.now() - Math.floor(Math.random() * 1000)
  const content = []
  for (const m of payload.mentions || []) content.push({ type: "at", text: "@" + (m.name || m.id) })
  if (payload.text) content.push({ type: "text", text: payload.text })
  for (const image of payload.images || []) content.push({ type: "image", url: image })
  return {
    id,
    time: Date.now(),
    direction: "out",
    status: "sending",
    sender: { id: state.bot, name: state.qqBotName || "机器人", avatar: state.botAvatar || "" },
    content,
    quoted: payload.quote || "",
    _payload: payload,
  }
}
async function postChatPayload(payload) {
  return await api("/api/group/send", {
    method: "POST",
    body: JSON.stringify({
      bot: state.bot,
      group: state.chatGroup,
      text: payload.text || "",
      images: payload.images || [],
      reply: payload.reply || "",
      mention: payload.mentions?.[0]?.id || "",
      mentions: (payload.mentions || []).map(m => m.id),
    }),
  })
}
function finishPending(temp, data) {
  removeChatRow(temp.id)
  if (data.message) appendChatMessage(data.message, true)
  else toast("消息已发送")
  setTimeout(() => scrollChat(true), 100)
}
function failPending(temp, message) {
  temp.status = "failed"
  temp.error = message || "发送失败"
  refreshChatRow(temp)
  setTimeout(() => scrollChat(true), 100)
}
async function retryChatMessage(id) {
  const m = state.chatMap.get(Number(id))
  if (!m?._payload || m.status === "sending" || m.status === "retrying") return
  m.status = "retrying"
  refreshChatRow(m)
  try {
    const data = await postChatPayload(m._payload)
    finishPending(m, data)
  } catch (err) {
    failPending(m, err.message)
    toast("重试失败：" + err.message)
  }
}
$("#chatMessages").addEventListener("click", e => {
  const btn = e.target.closest(".msg-retry")
  if (btn) { e.preventDefault(); e.stopPropagation(); retryChatMessage(btn.dataset.retry) }
})

async function sendChat() {
  if (!state.chatGroup) return toast("请先选择群")
  const text = $("#chatInput").value.trim()
  if (!text && !state.chatImages.length) return
  const payload = {
    text,
    images: state.chatImages.map(i => i.data),
    reply: state.chatReply?.message_id || "",
    mention: state.chatMentions?.[0]?.id || "",
    mentions: (state.chatMentions || []).map(m => ({ id: m.id, name: m.name })),
    quote: state.chatReply ? messageText(state.chatReply) : "",
  }
  const temp = makePendingMessage(payload)
  appendChatMessage(temp, true)
  state.chatMap.set(Number(temp.id), temp)
  $("#chatInput").value = ""
  state.chatImages = []
  renderChatPreviews()
  clearChatReply()
  clearChatMention()
  const btn = $("#chatSend")
  btn.disabled = true
  try {
    const data = await postChatPayload(payload)
    finishPending(temp, data)
  } catch (e) {
    failPending(temp, e.message)
    toast(e.message)
  } finally { btn.disabled = false }
}
$("#chatSend").onclick = sendChat
$("#chatInput").addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat() }
})

/* qq login */
async function loadQQ() {
  try {
    const s = await api("/api/qq/status")
    $("#qqStatus").textContent = s.loggedIn ? "已保存 Cookie" : "未登录"
    $("#qqStatus").className = "pill " + (s.loggedIn ? "ok" : "bad")
    $("#qqAt").textContent = s.at ? new Date(s.at).toLocaleString() : ""
    if (s.loggedIn) loadQQBots()
  } catch (e) { toast(e.message) }
}
async function loadQQBots() {
  try {
    const data = await api("/api/qq/bots")
    const bots = data.bots || []
    state.qqBots = bots
    const online = state.bots.filter(b => b.online).length
    $("#topStatusText").textContent = `${online}/${state.bots.length} 接入 · ${bots.length} 平台`
    renderBotPicker()
    if (!bots.length) { $("#qqBots").innerHTML = "<div class='card muted'>该 QQ 名下没有机器人</div>"; return }
    $("#qqBots").innerHTML = bots.map(b => `<div class="card" style="cursor:pointer${String(b.bot_appid)===String(state.appid)?';border-color:rgba(34,211,238,.55)':''}" data-appid="${esc(b.bot_appid)}" data-name="${esc(b.bot_name)}" data-avatar="${esc(b.bot_avatar || "")}">
      <div class="row"><img class="bot-avatar" src="${esc(nickAvatar(b.bot_name, b.bot_avatar))}" alt="${esc(b.bot_name || "机器人")}"><div><div class="v" style="font-size:18px">${esc(b.bot_name)}</div><div class="k">${esc(b.bot_uin)} · ${b.bot_status===1?"平台在线":"平台离线"}${state.bots.some(x => String(x.appid) === String(b.bot_appid)) ? "" : " · 未接入 TRSS"}</div></div></div>
      <div class="k">${esc(b.bot_appid)} · ${b.statistics_data?.existing_groups||0} 群 / ${b.statistics_data?.stock_added_friends||0} 好友</div>
    </div>`).join("")
    $("#qqBots").querySelectorAll("[data-appid]").forEach(el => el.onclick = () => {
      selectBot({ appid: el.dataset.appid, name: el.dataset.name, avatar: el.dataset.avatar })
      toast("已选择机器人：" + el.dataset.name)
    })
  } catch (e) {
    $("#qqBots").innerHTML = `<div class="card" style="color:#dc2626">${esc(e.message)}</div>`
  }
}
$("#qqSave").onclick = async () => {
  try { await api("/api/qq/cookie", { method: "POST", body: JSON.stringify({ cookie: $("#qqCookie").value }) }); toast("已保存"); loadQQ() } catch (e) { toast(e.message) }
}
$("#qqCheck").onclick = () => loadQQ()

let qrTimer = null
$("#qrStart").onclick = async () => {
  try {
    if (qrTimer) { clearInterval(qrTimer); qrTimer = null }
    const data = await api("/api/qq/qr", { method: "POST", body: "{}" })
    $("#qrImg").src = data.image
    $("#qrImg").style.display = "block"
    $("#qrMsg").textContent = "请用手机 QQ 扫码"
    const started = Date.now()
    qrTimer = setInterval(async () => {
      if (Date.now() - started > 125000) { clearInterval(qrTimer); qrTimer = null; $("#qrMsg").textContent = "二维码已过期，请重新获取"; return }
      try {
        const s = await api("/api/qq/qr/status?id=" + encodeURIComponent(data.id))
        $("#qrMsg").textContent = s.message || s.status
        if (s.status === "developers") {
          clearInterval(qrTimer); qrTimer = null
          $("#qrImg").style.display = "none"
          renderDevelopers(data.id, s.developers || [])
        }
        if (s.status === "success") {
          clearInterval(qrTimer); qrTimer = null
          $("#qrImg").style.display = "none"
          $("#qqDevsWrap").classList.add("hide")
          toast("QQ 登录成功" + (s.nickname ? "：" + s.nickname : ""))
          loadQQ(); loadQQBots()
        }
        if (s.status === "expired" || s.status === "error") { clearInterval(qrTimer); qrTimer = null }
      } catch (e) { clearInterval(qrTimer); qrTimer = null; $("#qrMsg").textContent = e.message }
    }, 2000)
  } catch (e) { $("#qrMsg").textContent = e.message }
}

function renderDevelopers(sessionId, developers) {
  $("#qqDevsWrap").classList.remove("hide")
  $("#qqDevs").innerHTML = developers.map(d => `
    <div class="card dev-card" data-dev="${esc(d.id)}">
      <div class="k">${esc(d.group || "开发账号")}</div>
      <div class="v" style="font-size:19px">${esc(d.name || d.id)}</div>
      <div class="k">${esc(d.mail || d.id)}</div>
      <button class="ghost" style="margin-top:12px">选择此账号</button>
    </div>`).join("")
  $("#qqDevs").querySelectorAll("[data-dev]").forEach(el => el.onclick = async () => {
    const developerId = el.dataset.dev
    el.style.opacity = ".5"
    try {
      await api("/api/qq/select-developer", { method: "POST", body: JSON.stringify({ id: sessionId, developerId }) })
      toast("开发账号已登录")
      $("#qqDevsWrap").classList.add("hide")
      await loadQQ()
      await loadQQBots()
      document.querySelector('nav button[data-tab="stats"]')?.click()
    } catch (e) {
      toast(e.message)
      el.style.opacity = "1"
    }
  })
}

/* menu / panels */
async function loadMenu() {
  try {
    const data = await api("/api/menu?bot=" + encodeURIComponent(state.bot))
    $("#menuJson").value = data.menu ? JSON.stringify(data.menu, null, 2) : ""
    const panels = data.panels || []
    $("#panelTable").innerHTML = "<tr><th>panel_id</th><th>摘要</th><th>操作</th></tr>" +
      (panels.map(p => `<tr><td>${esc(p.panel_id)}</td><td class="muted">${esc(JSON.stringify(p.panel || p).slice(0,80))}</td><td><button class="danger" data-panel="${esc(p.panel_id)}">删除</button></td></tr>`).join("") || "<tr><td colspan=3 class='muted'>暂无面板</td></tr>")
    $("#panelTable").querySelectorAll("[data-panel]").forEach(b => b.onclick = async () => {
      if (!confirm("删除指令面板 " + b.dataset.panel + "？")) return
      try { await api("/api/panel?bot=" + encodeURIComponent(state.bot) + "&id=" + encodeURIComponent(b.dataset.panel), { method: "DELETE" }); loadMenu() } catch (e) { toast(e.message) }
    })
  } catch (e) { toast(e.message) }
}
const MENU_EXAMPLE = {
  items: [
    { name: "功能菜单", type: "send_message", send_message: "#菜单" },
    { name: "今日天气", type: "send_message", send_message: "#天气" },
    { name: "签到", type: "send_message", send_message: "#签到" },
    { name: "官网", type: "link", link: "https://bot.q.qq.com/" },
    { name: "更多", type: "menu", sub_menu_items: [
      { name: "帮助", type: "send_message", send_message: "#帮助" },
      { name: "关于", type: "send_message", send_message: "#关于" },
    ]},
    { name: "提醒", type: "switch", switch: { switch_id: "remind", default: true } },
  ],
}
const PANEL_EXAMPLE = {
  scope: "group",
  target_type: "all",
  panel: {
    remark: "QQBot 功能面板",
    items: [
      { name: "#菜单", type: "command", desc: "打开功能菜单" },
      { name: "#签到", type: "command", desc: "每日签到" },
      { name: "#天气 上海", type: "command", desc: "查询天气" },
      { name: "QQ 开放平台", type: "link", link: "https://bot.q.qq.com/" },
    ],
  },
}
$("#menuSample").onclick = () => { $("#menuJson").value = JSON.stringify(MENU_EXAMPLE, null, 2); $("#menuMsg").textContent = "已填入示例" }
$("#menuFormat").onclick = () => {
  try { $("#menuJson").value = JSON.stringify(JSON.parse($("#menuJson").value || "{}"), null, 2); $("#menuMsg").textContent = "已格式化" }
  catch (e) { $("#menuMsg").textContent = e.message }
}
$("#panelSample").onclick = () => { $("#panelJson").value = JSON.stringify(PANEL_EXAMPLE, null, 2); $("#panelMsg").textContent = "已填入示例" }
$("#menuLoad").onclick = loadMenu
$("#panelReload").onclick = loadMenu
$("#menuSave").onclick = async () => {
  try {
    const menu = JSON.parse($("#menuJson").value || "{}")
    await api("/api/menu", { method: "PUT", body: JSON.stringify({ bot: state.bot, menu }) })
    $("#menuMsg").textContent = "已保存"
  } catch (e) { $("#menuMsg").textContent = e.message }
}
$("#panelCreate").onclick = async () => {
  try {
    const panel = JSON.parse($("#panelJson").value || "{}")
    await api("/api/panel", { method: "POST", body: JSON.stringify({ bot: state.bot, panel }) })
    $("#panelMsg").textContent = "已创建"; loadMenu()
  } catch (e) { $("#panelMsg").textContent = e.message }
}

/* ---------- system status ---------- */
function fmtBytes(n) {
  n = Number(n) || 0
  if (n >= 1024 ** 4) return (n / 1024 ** 4).toFixed(2) + " TB"
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + " GB"
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB"
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB"
  return Math.round(n) + " B"
}
function fmtRate(n) { return fmtBytes(n) + "/s" }
function fmtUptime(s) {
  s = Math.floor(s || 0)
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60)
  return `${d ? d + "天 " : ""}${h}小时 ${m}分`
}
function bar(percent) {
  return `<div class="sys-bar"><i style="width:${Math.max(1, Math.min(100, Number(percent) || 0))}%"></i></div>`
}
function sysCard(title, value, sub, percent) {
  return `<div class="card sys-card"><div class="sys-top"><div class="k">${title}</div></div><div class="sys-val">${esc(value)}</div><div class="sys-sub">${esc(sub || "")}</div>${percent == null ? "" : bar(percent)}</div>`
}
async function loadSystem() {
  try {
    const s = await api("/api/system")
    const g = s.gpu?.[0]
    const load = (s.load || [0,0,0]).map(x => Number(x).toFixed(2)).join(" / ")
    $("#sysCards").innerHTML = [
      sysCard("CPU", (s.cpu?.usage || 0) + "%", `${s.cpu?.cores || 0} 核 · ${s.cpu?.model || ""}`, s.cpu?.usage),
      sysCard("内存", (s.memory?.percent || 0).toFixed(1) + "%", `${fmtBytes(s.memory?.used)} / ${fmtBytes(s.memory?.total)}`, s.memory?.percent),
      sysCard("SWAP", s.swap?.total ? (s.swap.percent || 0).toFixed(1) + "%" : "未启用", s.swap?.total ? `${fmtBytes(s.swap.used)} / ${fmtBytes(s.swap.total)}` : "没有交换分区", s.swap?.total ? s.swap.percent : 0),
      sysCard("磁盘 /", s.disk ? (s.disk.percent || 0).toFixed(1) + "%" : "-", s.disk ? `${fmtBytes(s.disk.used)} / ${fmtBytes(s.disk.total)}` : "无法读取", s.disk?.percent),
      sysCard("负载", load, "1 / 5 / 15 分钟"),
      sysCard("GPU", g ? (g.util || 0) + "%" : "未检测到", g ? `${g.name} · ${g.memoryUsed}/${g.memoryTotal} MB · ${g.temperature}°C` : "nvidia-smi 不可用", g ? g.util : null),
      sysCard("网络", "↓ " + fmtRate(s.network?.rxRate), "↑ " + fmtRate(s.network?.txRate), null),
      sysCard("运行时间", fmtUptime(s.uptime), s.host || "", null),
      sysCard("Node", fmtBytes(s.node?.rss), `${s.node?.version || ""} · heap ${fmtBytes(s.node?.heapUsed)}`, null),
      sysCard("机器人", String(s.bots || 0), "已连接", null),
    ].join("")
    const ips = (s.network?.interfaces || []).map(i => `${i.name}: ${i.address}`).join(" · ")
    $("#sysTable").innerHTML = [
      ["主机名", s.host],
      ["系统", s.platform],
      ["CPU", `${s.cpu?.model || ""} (${s.cpu?.cores || 0} 核)`],
      ["负载", load],
      ["内存", `${fmtBytes(s.memory?.used)} / ${fmtBytes(s.memory?.total)}`],
      ["SWAP", s.swap?.total ? `${fmtBytes(s.swap.used)} / ${fmtBytes(s.swap.total)}` : "未启用"],
      ["磁盘", s.disk ? `${fmtBytes(s.disk.used)} / ${fmtBytes(s.disk.total)}` : "-"],
      ["网络", `接收 ${fmtBytes(s.network?.rx)} · 发送 ${fmtBytes(s.network?.tx)}`],
      ["网卡", ips || "-"],
      ["GPU", g ? `${g.name} · ${g.util}% · ${g.memoryUsed}/${g.memoryTotal} MB · ${g.temperature}°C` : "未检测到"],
      ["Node", `${s.node?.version} · RSS ${fmtBytes(s.node?.rss)} · Heap ${fmtBytes(s.node?.heapUsed)}`],
    ].map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v || "")}</td></tr>`).join("")
    $("#sysUpdated").textContent = "更新于 " + new Date().toLocaleTimeString()
  } catch (e) { toast(e.message) }
}
function startSystem() {
  loadSystem()
  if (!state.sysTimer) state.sysTimer = setInterval(loadSystem, 3000)
}
function stopSystem() {
  if (state.sysTimer) { clearInterval(state.sysTimer); state.sysTimer = null }
}
$("#sysReload").onclick = loadSystem

/* ---------- UI enhancements ---------- */
const TAB_META = {
  stats: ["运营数据", "机器人增长、消息与用户活跃度总览"],
  config: ["配置中心", "在线编辑 QQBot 与 TRSS YAML 配置"],
  logs: ["运行日志", "历史日志与 SSE 实时日志"],
  errors: ["机器人报错", "按错误码查看近 30 天 QQBot 报错"],
  system: ["系统状态", "负载、CPU、GPU、内存、SWAP、磁盘与网络"],
  materials: ["素材管理", "Markdown / 图片素材复用与清理"],
  groups: ["群管理", "成员、禁言、踢人与黑名单"],
  chat: ["群聊", "实时群消息、富媒体与机器人发言"],
  qq: ["QQ 开放平台", "扫码登录并选择要查看的机器人"],
  menu: ["菜单 / 面板", "自定义菜单与指令面板"],
}
function setPageMeta(tab) {
  const meta = TAB_META[tab] || ["QQBot Console", ""]
  $("#pageTitle").textContent = meta[0]
  $("#pageSub").textContent = meta[1]
  document.title = meta[0] + " · QQBot Console"
  localStorage.setItem("qqbot_tab", tab)
}
const savedTheme = document.documentElement.dataset.theme || "dark"
function paintTheme(theme) {
  document.documentElement.dataset.theme = theme
  localStorage.setItem("qqbot_theme", theme)
  $("#themeIcon").innerHTML = theme === "dark"
    ? '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>'
    : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'
}
paintTheme(savedTheme)
$("#themeBtn").onclick = () => paintTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")
$("#menuBtn").onclick = e => { e.stopPropagation(); document.body.classList.toggle("nav-open") }
document.addEventListener("click", e => {
  if (document.body.classList.contains("nav-open") && !e.target.closest("#sidebar") && !e.target.closest("#menuBtn"))
    document.body.classList.remove("nav-open")
})
document.addEventListener("keydown", e => {
  if (e.key === "Escape") document.body.classList.remove("nav-open")
  if (e.altKey && /^[1-9]$/.test(e.key)) {
    const tabs = ["stats","config","logs","system","materials","groups","chat","qq","menu"]
    const btn = document.querySelector(`nav button[data-tab="${tabs[Number(e.key)-1]}"]`)
    if (btn) btn.click()
  }
})
function submitOnEnter(selector, action) {
  document.querySelectorAll(selector).forEach(el => el.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); action() }
  }))
}
submitOnEnter("#pwd", () => $("#loginBtn").click())
submitOnEnter("#newPwd,#newPwd2", () => $("#setupBtn").click())
$("#statRefresh").onclick = () => loadStats(state.range, $("#start").value, $("#end").value)
function setAutoRefresh(on) {
  if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null }
  if (on) state.autoTimer = setInterval(() => { if (state.tab === "stats") loadStats(state.range, $("#start").value, $("#end").value) }, 60000)
  localStorage.setItem("qqbot_auto", on ? "1" : "0")
  $("#autoRefresh").classList.toggle("on", on)
  $("#autoRefresh").textContent = "自动刷新：" + (on ? "开" : "关")
}
$("#statExport").onclick = () => {
  const data = { exportedAt: new Date().toISOString(), appid: state.appid, range: state.range, rows: state.statsRows, raw: state.statsRaw || null }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" })
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = `qqbot-stats-${state.appid || "bot"}-${state.range}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}
$("#autoRefresh").onclick = () => setAutoRefresh(!state.autoTimer)
if (localStorage.getItem("qqbot_auto") === "1") setAutoRefresh(true)

/* ---------- command palette / help ---------- */
function switchTab(tab) {
  document.querySelector(`nav button[data-tab="${tab}"]`)?.click()
}
const PALETTE_ACTIONS = [
  { label: "运营数据", icon: "01", hint: "Alt+1", run: () => switchTab("stats") },
  { label: "配置中心", icon: "02", hint: "Alt+2", run: () => switchTab("config") },
  { label: "运行日志", icon: "03", hint: "Alt+3", run: () => switchTab("logs") },
  { label: "系统状态", icon: "04", hint: "Alt+4", run: () => switchTab("system") },
  { label: "素材管理", icon: "04", hint: "Alt+4", run: () => switchTab("materials") },
  { label: "群管理", icon: "05", hint: "Alt+5", run: () => switchTab("groups") },
  { label: "QQ 开放平台", icon: "06", hint: "Alt+6", run: () => switchTab("qq") },
  { label: "菜单 / 面板", icon: "07", hint: "Alt+7", run: () => switchTab("menu") },
  { label: "刷新运营数据", icon: "R", run: () => { switchTab("stats"); loadStats(state.range, $("#start").value, $("#end").value) } },
  { label: "切换深色 / 浅色主题", icon: "T", run: () => paintTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark") },
  { label: "保存当前配置", icon: "S", hint: "Ctrl+S", run: () => { switchTab("config"); $("#cfgSave").click() } },
  { label: "退出登录", icon: "Q", run: () => $("#logout").click() },
]
function renderPalette() {
  const q = $("#paletteInput").value.trim().toLowerCase()
  state.paletteActions = PALETTE_ACTIONS.filter(a => !q || a.label.toLowerCase().includes(q))
  if (!state.paletteActions.length) state.paletteActions = PALETTE_ACTIONS
  state.paletteIndex = 0
  $("#paletteList").innerHTML = state.paletteActions.map((a, i) =>
    `<div class="palette-item ${i === 0 ? "on" : ""}" data-idx="${i}"><span class="pi">${esc(a.icon)}</span><span>${esc(a.label)}</span>${a.hint ? `<span class="pk">${esc(a.hint)}</span>` : ""}</div>`
  ).join("")
  $("#paletteList").querySelectorAll(".palette-item").forEach(el => {
    el.onmouseenter = () => setPaletteIndex(Number(el.dataset.idx))
    el.onclick = () => runPalette(Number(el.dataset.idx))
  })
}
function setPaletteIndex(i) {
  state.paletteIndex = (i + state.paletteActions.length) % state.paletteActions.length
  $("#paletteList").querySelectorAll(".palette-item").forEach((el, idx) => el.classList.toggle("on", idx === state.paletteIndex))
  $("#paletteList").querySelector(".palette-item.on")?.scrollIntoView({ block: "nearest" })
}
function runPalette(i) {
  const action = state.paletteActions[i]
  closePalette()
  action?.run()
}
function openPalette() {
  $("#palette").classList.remove("hide")
  $("#paletteInput").value = ""
  renderPalette()
  setTimeout(() => $("#paletteInput").focus(), 20)
}
function closePalette() { $("#palette").classList.add("hide") }
$("#cmdBtn").onclick = openPalette
$("#paletteInput").oninput = renderPalette
$("#paletteInput").onkeydown = e => {
  if (e.key === "ArrowDown") { e.preventDefault(); setPaletteIndex(state.paletteIndex + 1) }
  else if (e.key === "ArrowUp") { e.preventDefault(); setPaletteIndex(state.paletteIndex - 1) }
  else if (e.key === "Enter") { e.preventDefault(); runPalette(state.paletteIndex) }
  else if (e.key === "Escape") closePalette()
}
document.querySelectorAll(".modal").forEach(m => m.addEventListener("mousedown", e => { if (e.target === m) m.classList.add("hide") }))
document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => $("#" + b.dataset.close).classList.add("hide"))
function openHelp() { $("#help").classList.remove("hide") }
document.addEventListener("keydown", e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || "")
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette() }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    if (state.tab === "config") { e.preventDefault(); $("#cfgSave").click() }
  } else if (e.key === "?" && !typing) { e.preventDefault(); openHelp() }
  else if (e.key === "Escape") { closePalette(); $("#help").classList.add("hide") }
})

/* boot */
;(async () => {
  try {
    await loadStatus()
    const tab = localStorage.getItem("qqbot_tab") || "stats"
    const btn = document.querySelector(`nav button[data-tab="${tab}"]`)
    if (btn && tab !== "stats") btn.click()
    else { setPageMeta("stats"); loadStats("7d"); loadGroupStats() }
    loadQQ()
  } catch (e) { if (e.message !== "未登录") toast(e.message) }
})()
