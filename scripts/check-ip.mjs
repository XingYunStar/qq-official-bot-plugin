import { execFileSync } from "node:child_process"
import fs from "node:fs"

const files = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { encoding: "utf8" })
  .split("\n")
  .map(s => s.trim())
  .filter(Boolean)

const binary = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|zip|gz|mp3|mp4|webm|pdf)$/i
const allowed = /^(?:0\.0\.0\.0|127\.0\.0\.1|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/
const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g

let blocked = false
for (const file of files) {
  if (binary.test(file)) continue
  let text
  try { text = fs.readFileSync(file, "utf8") } catch { continue }
  if (text.includes("\u0000")) continue
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    for (const hit of lines[i].match(ipv4) || []) {
      const parts = hit.split(".").map(Number)
      if (parts.some(n => n > 255)) continue
      if (allowed.test(hit)) continue
      console.error(`[check-ip] ${file}:${i + 1} 检测到公网 IPv4，已阻止提交`)
      blocked = true
    }
  }
}
if (blocked) {
  console.error("[check-ip] 请把 IP 替换为 <服务器IP>/<内网IP> 等占位符，或从提交中移除该文件。")
  process.exit(1)
}
