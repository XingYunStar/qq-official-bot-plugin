/**
 * q.qq.com 运营数据接口。
 * 官方只提供 7/14/30 天，月/总览/自定义范围由这里基于 30 天数据过滤。
 * 返回 q.qq.com 概览页使用的全部字段，不做裁剪。
 */
import axios from "axios"
import fs from "node:fs/promises"
import path from "node:path"

const HISTORY_FILE = path.join("data", "QQBot", "stats-history.json")
let historyCache = null
let historyTimer = null
async function loadHistory() {
  if (historyCache) return historyCache
  try { historyCache = JSON.parse(await fs.readFile(HISTORY_FILE, "utf8")) } catch { historyCache = {} }
  return historyCache
}
function scheduleHistorySave() {
  if (historyTimer) return
  historyTimer = setTimeout(async () => {
    historyTimer = null
    try {
      await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true })
      const tmp = `${HISTORY_FILE}.tmp`
      await fs.writeFile(tmp, JSON.stringify(historyCache || {}))
      await fs.rename(tmp, HISTORY_FILE)
    } catch {}
  }, 3000)
  historyTimer.unref?.()
}
async function mergeHistory(appid, rows) {
  const all = await loadHistory()
  const key = String(appid)
  const map = all[key] || (all[key] = {})
  for (const row of rows) if (row?.date) map[row.date] = row
  const dates = Object.keys(map).sort()
  if (dates.length > 3650) for (const d of dates.slice(0, dates.length - 3650)) delete map[d]
  scheduleHistorySave()
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date))
}

const STATS_API = "https://bot.q.qq.com/cgi-bin/v2/datareport/query"
export const statsRange = { "7d": 0, "14d": 1, "30d": 2 }

const num = v => +(v || 0)

export function mapDaily(row) {
  return {
    date: String(row.report_date),
    activeUsers: num(row.active_user_cnt),
    activeUsersChain: num(row.active_user_cnt_chain),
    activeGroups: num(row.active_group_cnt),
    activeGroupsChain: num(row.active_group_cnt_chain),
    activeGuilds: num(row.active_guild_cnt),
    activeGuildsChain: num(row.active_guild_cnt_chain),
    messages: num(row.up_msg?.total),
    c2c: num(row.up_msg?.c2c),
    group: num(row.up_msg?.group),
    messagesChain: num(row.up_msg_cnt_chain),
    friends: num(row.friends?.stock_cnt),
    friendsAdd: num(row.friends?.add_cnt),
    friendsRemove: num(row.friends?.remove_cnt),
    friendsChain: num(row.stock_friends_chain),
    groups: num(row.groups?.stock_cnt),
    groupsAdd: num(row.groups?.add_cnt),
    groupsRemove: num(row.groups?.remove_cnt),
    groupsChain: num(row.stock_groups_chain),
    guilds: num(row.guilds?.stock_cnt),
    guildsAdd: num(row.guilds?.add_cnt),
    guildsRemove: num(row.guilds?.remove_cnt),
    guildsChain: num(row.stock_guilds_chain),
    newUsers: num(row.new_user_cnt),
    returningUsers: num(row.returning_user_cnt),
    replyCount: num(row.reply_cnt),
    replyRate: num(row.reply_rate),
    replyRateChain: num(row.reply_rate_chain),
    firstReplyRate: num(row.first_reply_rate),
    firstReplyRateChain: num(row.first_reply_rate_chain),
    avgResponse: num(row.avg_response_time),
    avgResponseChain: num(row.avg_response_time_chain),
    avgRounds: num(row.avg_rounds),
    avgRoundsChain: num(row.avg_rounds_chain),
    profile: normalizeDist(row.user_profile),
    groupDist: normalizeDist(row.group_dist),
    hotCommands: normalizeDist(row.hot_commands),
  }
}

export function normalizeDist(list) {
  return (list || []).map(i => ({
    type: i?.type || "",
    key: i?.key || "",
    count: num(i?.cnt),
    ratio: num(i?.ratio),
    comparison: num(i?.comparison),
  }))
}

export function summarize(rows) {
  const sum = key => rows.reduce((n, r) => n + (r[key] || 0), 0)
  const last = rows[rows.length - 1] || {}
  const avg = key => rows.length ? +(sum(key) / rows.length).toFixed(2) : 0
  return {
    days: rows.length,
    activeUsers: sum("activeUsers"),
    activeGroups: last.activeGroups || 0,
    activeGuilds: last.activeGuilds || 0,
    messages: sum("messages"),
    c2c: sum("c2c"),
    group: sum("group"),
    newUsers: sum("newUsers"),
    returningUsers: sum("returningUsers"),
    replyCount: sum("replyCount"),
    friends: last.friends || 0,
    friendsAdd: sum("friendsAdd"),
    friendsRemove: sum("friendsRemove"),
    groups: last.groups || 0,
    groupsAdd: sum("groupsAdd"),
    groupsRemove: sum("groupsRemove"),
    guilds: last.guilds || 0,
    guildsAdd: sum("guildsAdd"),
    guildsRemove: sum("guildsRemove"),
    avgActiveUsers: rows.length ? Math.round(sum("activeUsers") / rows.length) : 0,
    avgMessages: rows.length ? Math.round(sum("messages") / rows.length) : 0,
    replyRate: +(avg("replyRate") * 100).toFixed(2),
    firstReplyRate: +(avg("firstReplyRate") * 100).toFixed(2),
    avgResponse: avg("avgResponse"),
    avgRounds: avg("avgRounds"),
    replyRateChain: last.replyRateChain || 0,
    firstReplyRateChain: last.firstReplyRateChain || 0,
    activeUsersChain: last.activeUsersChain || 0,
    groupsChain: last.groupsChain || 0,
  }
}

export function filterRows(rows, { range, start, end }) {
  let out = rows
  if (start || end)
    out = out.filter(
      r => (!start || r.date >= start.replace(/-/g, "")) && (!end || r.date <= end.replace(/-/g, "")),
    )
  if (range === "month") {
    const month = String(new Date().getFullYear()) + String(new Date().getMonth() + 1).padStart(2, "0")
    out = out.filter(r => r.date.startsWith(month))
  }
  if (range === "today") out = out.slice(-1)
  else if (range === "yesterday") out = out.slice(-2, -1)
  return out
}

export async function fetchStats({ appid, range = "7d", start = "", end = "", cookie }) {
  // 始终拉最近 30 天并落盘；超过 30 天的范围使用本地历史。
  let data
  let apiError = ""
  try {
    const res = await axios.post(
      STATS_API,
      { bot_appid: Number(appid), data_range: 2, data_type: 4 },
      { headers: { Cookie: cookie, "Content-Type": "application/json" }, timeout: 15000 },
    )
    data = res.data
    if (data?.retcode !== 0) {
      apiError = data?.msg || "接口返回错误"
      data = null
    }
  } catch (err) {
    apiError = String(err.response?.data?.msg || err.message || err)
  }
  let allRows
  if (data) {
    const liveRows = (data.data?.developer_metrics_data || []).map(mapDaily).sort((a, b) => a.date.localeCompare(b.date))
    allRows = await mergeHistory(appid, liveRows)
  } else {
    allRows = Object.values((await loadHistory())[String(appid)] || {}).sort((a, b) => a.date.localeCompare(b.date))
    if (!allRows.length) throw new Error(apiError || "接口返回错误")
  }
  const rows = filterRows(allRows, { range, start, end })
  const last = rows[rows.length - 1] || {}
  return {
    daily: rows,
    summary: summarize(rows),
    sections: data ? {
      guild: data.data?.guild_data || [],
      message: data.data?.msg_data || [],
      group: data.data?.group_data || [],
      friend: data.data?.friend_data || [],
    } : {},
    profile: last.profile || [],
    groupDist: last.groupDist || [],
    hotCommands: last.hotCommands || [],
    history: {
      from: allRows[0]?.date || "",
      to: allRows[allRows.length - 1]?.date || "",
      days: allRows.length,
    },
    limited: "官方只提供最近 30 天；本地历史需要持续采集，范围越用越全",
  }
}
