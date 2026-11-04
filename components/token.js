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
