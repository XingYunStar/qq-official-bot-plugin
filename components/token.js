/**
 * 账号配置解析：兼容新旧两种格式（Token 已不再使用）。
 * 新：QQ号:AppID:AppSecret:是否群Bot:是否频道私域
 *     QQ号:AppID:AppSecret:2（WebHook）
 * 旧：QQ号:AppID:Token:AppSecret:是否群Bot:是否频道私域
 *     QQ号:AppID:Token:AppSecret:2（WebHook）
 */
export function parseTokenLine(line) {
  const parts = String(line ?? "").trim().split(":")
  if (parts.length < 4) return null
  const [id, appid] = parts
  if (!/^\d{5,}$/.test(id) || !/^[A-Za-z0-9_-]+$/.test(appid)) return null
  if (parts.length === 4) {
    if (parts[3] !== "2") return null
    return { id, appid, secret: parts[2], webhook: true, group: "0", private: "0" }
  }
  if (parts.length === 5) {
    if (parts[4] === "2")
      return {
        id,
        appid,
        token: parts[2],
        secret: parts[3],
        webhook: true,
        group: "0",
        private: "0",
      }
    return { id, appid, secret: parts[2], webhook: false, group: parts[3], private: parts[4] }
  }
  // 旧格式：第 3 段是 Token，读取时忽略
  return {
    id,
    appid,
    token: parts[2],
    secret: parts[3],
    webhook: false,
    group: parts[4],
    private: parts[5],
  }
}

/** 输出新格式（不含 Token） */
export function formatTokenLine(info) {
  if (info.webhook) return `${info.id}:${info.appid}:${info.secret}:2`
  return `${info.id}:${info.appid}:${info.secret}:${info.group}:${info.private}`
}

/**
 * 新版无 QQ 号配置：AppID:AppSecret 或 AppID:AppSecret:2（WebHook）
 * 机器人 QQ 号在连接前通过开放平台接口自动获取。
 */
export function parseCompactTokenLine(line) {
  const parts = String(line ?? "").trim().split(":")
  if (!/^[A-Za-z0-9_-]+$/.test(parts[0] || "")) return null
  if (parts.length === 2 && parts[1]) return { appid: parts[0], secret: parts[1], webhook: false, group: "1", private: "0" }
  if (parts.length === 3 && parts[1] && parts[2] === "2") return { appid: parts[0], secret: parts[1], webhook: true, group: "0", private: "0" }
  return null
}

/** 用 AppID + AppSecret 获取机器人 QQ 号（/users/@me 的 share_url.robot_uin） */
export async function fetchBotQQ({ appid, secret, timeout = 30000 } = {}) {
  if (!appid || !secret) throw new Error("缺少 AppID 或 AppSecret")
  if (typeof fetch !== "function") throw new Error("当前 Node 环境不支持 fetch")
  const signal = AbortSignal.timeout?.(timeout)
  const tokenRes = await fetch("https://bots.qq.com/app/getAppAccessToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: appid, clientSecret: secret }),
    signal,
  })
  const tokenData = await tokenRes.json().catch(() => ({}))
  if (!tokenRes.ok || !tokenData.access_token)
    throw new Error(`获取 access_token 失败：${tokenData.message || tokenData.code || tokenRes.status}`)
  const meRes = await fetch("https://api.sgroup.qq.com/users/@me", {
    headers: { Authorization: `QQBot ${tokenData.access_token}`, "X-Union-Appid": appid },
    signal: AbortSignal.timeout?.(timeout),
  })
  const me = await meRes.json().catch(() => ({}))
  if (!meRes.ok) throw new Error(`获取机器人详情失败：${me.message || me.code || meRes.status}`)
  let qq
  try {
    qq = new URL(me.share_url).searchParams.get("robot_uin")
  } catch {}
  if (!/^\d{5,}$/.test(qq || "")) throw new Error("接口未返回 robot_uin，无法自动获取机器人 QQ 号")
  return { id: qq, qq, username: me.username || "", appid, shareUrl: me.share_url || "" }
}
