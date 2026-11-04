/**
 * 图文卡片（msg_type=8）辅助函数。
 * 插件内部沿用旧版 qq-group-bot 的扁平结构，发送前统一成 SDK 结构。
 */

/** 规范成 { type:"card", data:{ type:"tuwen", content } } */
export function normalizeCard(el) {
  const raw = el?.data ?? el?.card ?? el
  const content = raw?.content && typeof raw.content === "object" ? raw.content : raw
  if (!content || typeof content !== "object") return null
  const title = String(content.title ?? "").trim()
  const url = String(content.url ?? content.link ?? "").trim()
  const pic_url = String(content.pic_url ?? content.picUrl ?? content.image ?? "").trim()
  if (!title || !url || !pic_url) return null
  return {
    type: "card",
    data: {
      type: "tuwen",
      content: {
        title: title.slice(0, 50),
        description: String(content.description ?? title).trim().slice(0, 200),
        url,
        pic_url,
      },
    },
  }
}

export function cardToText(el) {
  const raw = el?.data ?? el?.card ?? el
  const content = raw?.content && typeof raw.content === "object" ? raw.content : raw
  if (!content || typeof content !== "object")
    return typeof Bot !== "undefined" && Bot.String ? Bot.String(el) : String(el)
  return [content.title, content.description, content.url].filter(Boolean).join("\n")
}

/** 图文卡片只能单独成条，把卡片从普通消息里拆出来 */
export function splitCardMessages(msg) {
  const list = Array.isArray(msg) ? msg : [msg]
  const parts = []
  let batch = []
  for (const i of list) {
    if (i && typeof i === "object" && i.type === "card") {
      if (batch.length) {
        parts.push(batch)
        batch = []
      }
      parts.push([i])
    } else batch.push(i)
  }
  if (batch.length) parts.push(batch)
  return parts
}
