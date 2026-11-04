/**
 * q.qq.com 扫码登录
 * 流程：lite/create_session -> ptqrshow -> ptqrlogin -> developer_list -> pskey_login
 * 成功后把完整 Cookie 交给 WebUI 保存（stats 接口需要 qlogin_uid / qticket 等）。
 */
import crypto from "node:crypto"

const QR_APPID = "1600001541"
const QR_DAID = "750"
const sessions = new Map()

function hash33(str) {
  let e = 0
  for (let i = 0; i < str.length; i++) e += (e << 5) + str.charCodeAt(i)
  return e & 0x7fffffff
}

class CookieJar {
  constructor() {
    this.cookies = []
  }

  add(headers, url) {
    let list = []
    try {
      list = headers.getSetCookie?.() || []
    } catch {}
    const host = new URL(url).hostname
    for (const raw of list) {
      const [pair, ...attrs] = raw.split(";")
      const index = pair.indexOf("=")
      if (index <= 0) continue
      const cookie = {
        name: pair.slice(0, index).trim(),
        value: pair.slice(index + 1).trim(),
        domain: "",
        path: "/",
        expires: 0,
      }
      for (const attr of attrs) {
        const [k, ...v] = attr.trim().split("=")
        const key = k.toLowerCase()
        const value = v.join("=")
        if (key === "domain") cookie.domain = value
        else if (key === "path") cookie.path = value
        else if (key === "max-age") cookie.expires = Date.now() + Number(value) * 1000
        else if (key === "expires") cookie.expires = Date.parse(value) || 0
      }
      if (!cookie.domain) cookie.domain = host
      const old = this.cookies.findIndex(
        i => i.name === cookie.name && i.domain === cookie.domain && i.path === cookie.path,
      )
      if (cookie.expires && cookie.expires < Date.now()) {
        if (old >= 0) this.cookies.splice(old, 1)
        continue
      }
      if (old >= 0) this.cookies[old] = cookie
      else this.cookies.push(cookie)
    }
  }

  header(url) {
    const { hostname, pathname } = new URL(url)
    return this.cookies
      .filter(c => {
        const domain = c.domain.replace(/^\./, "")
        return (hostname === domain || hostname.endsWith(`.${domain}`)) && pathname.startsWith(c.path)
      })
      .map(c => `${c.name}=${c.value}`)
      .join("; ")
  }

  all() {
    const seen = new Set()
    const out = []
    for (const c of this.cookies) {
      if (seen.has(c.name)) continue
      seen.add(c.name)
      out.push(`${c.name}=${c.value}`)
    }
    return out.join("; ")
  }

  get(name) {
    return this.cookies.find(c => c.name === name)
  }
}

async function request(jar, url, options = {}, redirect = 0) {
  const headers = { ...(options.headers || {}) }
  const cookie = jar.header(url)
  if (cookie) headers.Cookie = cookie
  const res = await fetch(url, { ...options, headers, redirect: "manual" })
  jar.add(res.headers, url)
  if ([301, 302, 303, 307, 308].includes(res.status) && redirect < 8) {
    const location = res.headers.get("location")
    if (location) return request(jar, new URL(location, url).href, { ...options, method: "GET" }, redirect + 1)
  }
  return res
}

async function createSession(jar) {
  const res = await request(jar, "https://q.qq.com/lite/create_session", {
    headers: { Accept: "application/json", Referer: "https://q.qq.com/" },
  })
  const data = await res.json()
  const sessionId = data?.data?.session_id || data?.session_id
  if (!sessionId) throw new Error(`创建登录会话失败：${JSON.stringify(data).slice(0, 200)}`)
  return sessionId
}

export async function startQrLogin() {
  const id = crypto.randomUUID()
  const jar = new CookieJar()
  const sessionId = await createSession(jar)
  const u1 = `https://q.qq.com/h5/ptlogin-callback.html?session_id=${sessionId}&_wv=16777218`
  const qrUrl =
    "https://xui.ptlogin2.qq.com/ssl/ptqrshow" +
    `?appid=${QR_APPID}&e=2&l=M&s=3&d=72&v=4&t=${Math.random()}` +
    `&daid=${QR_DAID}&pt_3rd_aid=0&u1=${encodeURIComponent(u1)}`
  const res = await request(jar, qrUrl, { headers: { Referer: "https://q.qq.com/" } })
  if (!res.ok) throw new Error(`生成二维码失败：HTTP ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  const qrsig = jar.get("qrsig")?.value || ""
  if (!qrsig) throw new Error("二维码 Cookie 获取失败")
  sessions.set(id, { id, jar, qrsig, u1, sessionId, createdAt: Date.now() })
  for (const [key, value] of sessions) if (Date.now() - value.createdAt > 10 * 60 * 1000) sessions.delete(key)
  return { id, image: `data:image/png;base64,${buffer.toString("base64")}`, expiresIn: 120 }
}

export async function pollQrLogin(id) {
  const session = sessions.get(id)
  if (!session) throw new Error("二维码会话不存在或已过期")
  const token = hash33(session.qrsig)
  const url =
    "https://ssl.ptlogin2.qq.com/ptqrlogin" +
    `?u1=${encodeURIComponent(session.u1)}&ptqrtoken=${token}` +
    "&ptredirect=1&h=1&t=1&g=1&from_ui=1&ptlang=2052" +
    `&action=0-0-${Date.now()}&js_ver=10233&js_type=1` +
    `&login_sig=${encodeURIComponent(session.jar.get("pt_login_sig")?.value || "")}` +
    `&pt_uistyle=40&aid=${QR_APPID}&daid=${QR_DAID}&pt_3rd_aid=0`
  const res = await request(session.jar, url, { headers: { Referer: "https://xui.ptlogin2.qq.com/" } })
  const text = await res.text()
  const match = text.match(/ptuiCB\(([^)]*)\)/)
  if (!match) throw new Error("无法解析登录返回")
  const args = match[1].split(",").map(s => s.trim().replace(/^'|'$/g, ""))
  const code = args[0]
  const redirect = args[2]
  const message = args[4] || ""
  const nickname = args[5] || ""
  if (code === "66") return { status: "waiting", message: "二维码未失效，等待扫码" }
  if (code === "67") return { status: "scanned", message: "已扫码，请在手机上确认" }
  if (code === "65") return { status: "expired", message: "二维码已失效，请刷新" }
  if (code !== "0") return { status: "error", message: message || `登录失败（${code}）` }

  if (redirect) await request(session.jar, redirect, { headers: { Referer: "https://q.qq.com/" } })
  const listRes = await request(session.jar, "https://q.qq.com/api/v3/login/developer_list", {
    headers: { Accept: "application/json", Referer: "https://q.qq.com/" },
  })
  const list = await listRes.json()
  if (list?.res?.ret !== 0) return { status: "error", message: `获取开发者列表失败：${list?.res?.msg || list?.res?.ret}` }
  const developers = []
  for (const group of list.developers || [])
    for (const item of group.items || []) developers.push({ ...item, group: group.typeName })
  if (!developers.length) return { status: "error", message: "该 QQ 没有可用的开发者主体" }
  const developer = developers.find(item => item.status === 2) || developers[0]
  session.jar.cookies.push({
    name: "developer_id_lite",
    value: String(developer.id),
    domain: "q.qq.com",
    path: "/",
    expires: 0,
  })
  const target = "https://q.qq.com/qqbot/dashboard/"
  await request(
    session.jar,
    `https://q.qq.com/api/v3/login/pskey_login?developer_id=${encodeURIComponent(developer.id)}&url=${encodeURIComponent(target)}`,
    { headers: { Referer: "https://q.qq.com/" } },
  )
  const cookie = session.jar.all()
  session.status = "success"
  return {
    status: "success",
    message: "登录成功",
    nickname,
    developer: { id: developer.id, name: developer.name, mail: developer.regMail },
    cookie,
  }
}
