<div align="center">

# 🚀 QQBot Plugin 更新日志

**TRSS-Yunzai · QQ 官方机器人适配器 · WebUI 控制台**

[![GitHub](https://img.shields.io/badge/GitHub-XingYunStar%2Fqq--official--bot--plugin-181717?style=for-the-badge&logo=github)](https://github.com/XingYunStar/qq-official-bot-plugin)
[![Last Commit](https://img.shields.io/github/last-commit/XingYunStar/qq-official-bot-plugin?style=for-the-badge&logo=git&label=last%20commit&color=8b5cf6)](https://github.com/XingYunStar/qq-official-bot-plugin/commits)
[![Commit Activity](https://img.shields.io/github/commit-activity/m/XingYunStar/qq-official-bot-plugin?style=flat-square&logo=github&label=commits%2Fmonth&color=06b6d4)](https://github.com/XingYunStar/qq-official-bot-plugin/graphs/commit-activity)

[![Stars](https://img.shields.io/github/stars/XingYunStar/qq-official-bot-plugin?style=flat-square&logo=github&color=f59e0b)](https://github.com/XingYunStar/qq-official-bot-plugin/stargazers)
[![Forks](https://img.shields.io/github/forks/XingYunStar/qq-official-bot-plugin?style=flat-square&logo=git&color=ec4899)](https://github.com/XingYunStar/qq-official-bot-plugin/forks)
[![Issues](https://img.shields.io/github/issues/XingYunStar/qq-official-bot-plugin?style=flat-square&logo=github&color=ef4444)](https://github.com/XingYunStar/qq-official-bot-plugin/issues)

[![TRSS-Yunzai](https://img.shields.io/badge/TRSS--Yunzai-3.1.3-8b5cf6?style=for-the-badge)](https://github.com/TimeRainStarSky/Yunzai)
[![Node](https://img.shields.io/badge/Node.js-24-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-173%20passed-22c55e?style=flat-square&logo=checkmarx&logoColor=white)](#-验证)
[![WebUI](https://img.shields.io/badge/WebUI-online-22c55e?style=flat-square&logo=googlechrome&logoColor=white)](http://61.184.23.160:2540/)

</div>

---

## 📅 2026-11-11

> 今天共有 **12 个功能提交**，从 `GROUP_MEMBER` 事件恢复，到错误码归档、日志连续浏览、运营数据日期修复，再到群聊退出和消息日志补全。

### ✨ 今日摘要

| 领域 | 更新 | 状态 |
| --- | --- | :---: |
| QQ 群事件 | 恢复 `GROUP_MEMBER`、入群申请、群成员变动 | ✅ |
| WebUI 日志 | 大日志安全读取、20K tail、连续滚动窗口 | ✅ |
| WebUI 报错 | 错误码归档、30 天保留、默认屏蔽 `40034005` | ✅ |
| 运营数据 | 相对日期按当前日期计算，过期登录明确提示 | ✅ |
| 群聊管理 | 右键群聊支持打开 / 退出群聊 | ✅ |
| 消息日志 | 群消息 INFO 落盘，实时日志捕获 `Bot.makeLog` | ✅ |

### 🕒 提交时间线

```mermaid
timeline
    title 2026-11-11 提交时间线
    20:01 : GROUP_MEMBER 与入群申请恢复
    20:11 : 大日志尾部读取修复
    21:17 : 测试插件事件改为只记日志
    22:53 : 错误码归档 + 日志连续滚动
    23:00 : 运营数据相对日期修复
    23:18 : 群聊退出 + 消息日志补全
```

### 📋 提交总览

| 提交 | 时间 | 类型 | 标题 |
| --- | --- | --- | --- |
| `cb40090` | 20:01 | 🛠️ 修复 | 订阅 `GROUP_MEMBER`，恢复入群申请和群成员事件 |
| `edfad32` | 20:11 | 🛠️ 修复 | WebUI 大日志尾部读取，避免 `Invalid string length` |
| `90716fa` | 21:17 | 🛠️ 修复 | 测试插件不再自动发送进群/退群消息 |
| `e2d5f4b` | 22:53 | ✨ 功能 | 错误码归档、日志页重构、连续滚动日志浏览 |
| `e5c4925` | 23:00 | 🛠️ 修复 | 运营数据相对日期改为按当前日期过滤 |
| `5663ae3` | 23:18 | ✨ 功能 | 群聊右键退出、消息 INFO 日志补全 |
| `dda05d8` | 23:22 | 🎨 修复 | 历史日志去除 ANSI 颜色转义 |
| `1af95f2` | 23:28 | ✨ 功能 | 日志页全文件搜索，结果可跳转定位 |
| `ae7adb3` | 23:34 | 🎨 功能 | WebUI 日志保留 ANSI 颜色并映射为主题配色 |
| `f358065` | 23:42 | 🛠️ 修复 | 报错归档记录发送内容全文，默认屏蔽新错误码 |
| `fc634c5` | 23:44 | ✨ 功能 | 全文件日志搜索支持随时停止 |
| `ffe9996` | 23:47 | 🛠️ 修复 | 搜索结果跳转 502，搜索时预热行索引并自动重试 |

---

### `cb40090` — 恢复入群申请事件

**提交信息：**

```text
fix(qqbot): subscribe GROUP_MEMBER for join requests
```

**问题：**

- WebSocket intents 只有 `GROUP_AND_C2C_EVENT`（1<<25）
- 缺少 `GROUP_MEMBER`（1<<24）
- QQ 平台不会下发 `GROUP_JOIN_REQUEST`
- `notice.group.join_request` 无法触发
- 进群/退群成员事件也无法触发

**改动：**

- 群 Bot 连接时增加 `GROUP_MEMBER` intent
- 新增 `groupMemberEvent` 配置，默认 `true`
- 如果平台返回 `4014 intent无权限`：
  - 记录明确错误
  - 自动关闭 `GROUP_MEMBER` 并重新连接
  - 避免反复 4014 重连
  - 入群申请仍由轮询兜底
- WebUI 配置页增加「群成员/入群申请事件」开关
- `makeJoinRequestNotice()` 的日志从 `info` 改为 `mark`，可在 command 日志中看到
- README 修正 `GROUP_AND_C2C_EVENT` 的说明
- README 新增 `GROUP_MEMBER` 和 4014 说明
- 测试增加 `GROUP_MEMBER` intent 断言

**验证：**

- 两个机器人的连接日志均出现：

```text
WebSocket intents：... GROUP_AND_C2C_EVENT, GROUP_MEMBER, ...
```

- 没有出现 4014
- 测试：173 通过，0 失败

---

### `edfad32` — 大日志读取修复

**提交信息：**

```text
fix(webui): tail large log files safely
```

**问题：**

- WebUI 的 `/api/logs` 使用 `fs.readFile` 读取整个 `error.log`
- 文件达到约 760MB，超过 V8 字符串限制
- 接口返回：

```json
{"error":"Invalid string length"}
```

**改动：**

- 改为从文件尾部按块读取
- 不再把完整日志读入内存
- 跳过文件中间开始的不完整首行
- 接口返回增加：
  - `truncated`
  - `size`
- 支持较大的尾部读取行数

**验证：**

- 760MB `error.log` 可正常读取
- `tail=2000`、`tail=20000` 均返回 HTTP 200
- 不再出现 `Invalid string length`

---

### `90716fa` — 测试插件事件只记日志

**提交信息：**

```text
fix(example): do not auto-send on join/leave notices
```

**问题：**

- `plugins/example/qqbot-test.js` 在以下事件中自动发群消息：
  - `notice.group.increase`
  - `notice.group.bot.increase`
- 大群进群事件频繁，导致刷屏
- 删除文件不会卸载已加载到内存的事件监听
- `autoInstallExample: true` 会在重启时重新安装测试插件

**改动：**

- 进群：只 `logger.mark`
- 退群：只 `logger.mark`
- 机器人被拉群：只 `logger.mark`
- 删除自动发送欢迎消息的 `e.reply`
- README 补充说明：测试插件事件只写日志，不自动发消息
- 手动命令仍可正常发送测试消息

**验证：**

- 测试插件只保留四个事件监听，全部为日志输出
- 手动 `#qqbot...` 测试命令不受影响

---

### `e2d5f4b` — 错误码归档 + 日志页重构

**提交信息：**

```text
feat(webui): add error archive and continuous log viewer
```

**新增错误码归档：**

- WebUI 新增「报错」页
- 按错误码筛选，例如只看 `40034006`
- 记录内容：
  - 时间
  - 机器人
  - 错误码
  - 错误消息
  - 堆栈/详情
- 错误码从以下位置提取：
  - `err.code`
  - `err.response.data.code`
  - `err.data.code`
  - `error.message` 中的 `code(40034006)`
- 保留 30 天
- 启动时和每 6 小时清理过期记录
- 数据文件：

```text
data/QQBot/error-log.ndjson
data/QQBot/error-log.json
```

- 默认屏蔽 `40034005`：
  - 不写入归档
  - 发送消息和 SDK 错误路径不再记录这条错误
- WebUI 可修改屏蔽码列表
- 加入屏蔽码后，历史归档中对应 code 也会删除
- 报错页支持分页加载更早记录，直到看完所有匹配数据

**日志页重构：**

- 顶部控制分为三组：
  - 实时日志：级别、开启/停止、暂停/继续
  - 历史日志：文件、初始加载行数、加载
  - 当前视图：搜索、下载当前内容
- 控制项增加可见文字说明，不再依赖鼠标悬浮提示
- 暂停按钮仅在实时模式下可用
- 状态栏显示：
  - 当前文件
  - 已加载行范围
  - 文件总行数
  - 当前窗口行数
  - 是否仅显示尾部

**大文件连续浏览：**

- 不再使用分页按钮
- 维护当前加载窗口
- 滚动到顶部自动加载更早日志
- 滚动到底部自动加载更新日志
- 当前窗口最多保留 3000 行
- 超出窗口后卸载远端内容
- 使用绝对行号锚点保存当前阅读位置
- 加载新范围后保持当前可见行不跳转
- 实测 `error.log` 约 744 万行，连续滚动可用

**服务端：**

- 新增 `/api/logs/page`
- 建立稀疏行索引，每 1000 行一个字节锚点
- 支持增量扫描追加内容
- 避免每次都完整扫描大文件
- `/api/logs` 尾部读取仍保留，作为快速预览

**验证：**

- WebUI `200`
- 两个机器人在线
- 错误码归档筛选、屏蔽码、分页加载测试通过
- 日志页连续滚动、上下自动加载、范围保持测试通过
- 测试：173 通过，0 失败

---

### `e5c4925` — 运营数据相对日期修复

**提交信息：**

```text
fix(webui): use current dates for stats ranges
```

**问题：**

- 登录过期后，运营数据接口返回旧历史
- 前端选择「昨天」仍显示最后的旧数据日期
- 用户看到的是 `20261103`，不是实际的昨天
- 原因是 `filterRows` 使用：

```js
out.slice(-2, -1)
```

这会取历史数组里的倒数第二天，而不是当前日期的昨天。

**改动：**

- 新增本地日期键 `localDayKey`
- 「今天」严格按当前日期过滤
- 「昨天」严格按昨天日期过滤
- 「近 7/14/30 天」改为按当前日期向前计算日历窗口
- 「本月」保持当前月份过滤
- 接口新增：
  - `stale`：数据是否落后于昨天
  - `apiError`：QQ 接口错误
  - `lastDate`：历史最后日期
- 所选范围没有数据时，WebUI 显示明确空状态：
  - 数据最后更新时间
  - 登录可能已过期
  - 去 QQ 登录按钮
- 不再把最后一条旧数据伪装成「昨天」

**验证：**

- 登录过期场景：
  - 「昨天」返回 0 行
  - 「今天」返回 0 行
  - 「近 7 天」返回 0 行
  - `stale: true`
  - `lastDate: 20261104`
- WebUI 昨天页面显示：

```text
所选范围没有运营数据
数据最后更新于 2026-11-04，登录状态可能已过期，请重新登录 QQ 开放平台后刷新。
```

- 历史数据仍可通过自定义范围查询

---

### `5663ae3` — 群聊退出与消息日志补全

**提交信息：**

```text
feat(webui): add quit group action and capture message logs
```

#### 群聊右键菜单

群聊列表中右键群聊，现在有：

- 打开群聊
- 退出群聊

退出流程：

1. 二次确认群名
2. WebUI 调用 `POST /api/group/quit`
3. 服务端通过 `getBotState` 获取机器人自己的 `member_openid`
4. 调用 `batch_remove_members` 将机器人移出群聊
5. 清理本地群聊缓存、群统计和 `gl` 群映射
6. 刷新群列表并自动打开下一个群

> 注意：QQ 官方 `batch_remove_members` 属于内邀/白名单能力；如果机器人没有接口权限，会返回明确错误，不会假装退出成功。

#### 日志页看不到群消息

**原因：**

- `logger.info` 走的是 `message` 分类
- 原来 `message` 分类只挂了 `stdout`
- `command` 文件只接收 `warn/error/mark`
- 所以 WebUI 读取 `command` 历史日志时看不到 INFO 群消息

**修复：**

- TRSS 日志配置新增：

```js
message: {
  appenders: ["stdout", "command"],
  level: cfg.bot.log_level,
}
```

- `command` 分类级别改为 `info`
- 群消息、好友消息、发送消息等 INFO 现在会写入 `command.*.log`
- 实时日志 hook 从外层 `logger.info` 改为内层 `logger.logger[level]`
  - `Bot.makeLog` 的 INFO 也能被 WebUI 实时流捕获

**验证：**

- `command.2026-11-11.log` 已出现：

```text
[23:17:41.733][INFO][3889049339] 群消息：[...] ...
```

- `/api/logs` 历史日志包含群消息
- `/api/logs/live` 实时日志包含群消息
- 旧日志不会回填，只有修复后的新日志包含 INFO

---

### `dda05d8` — 历史日志去除 ANSI

**提交信息：**

```text
fix(webui): strip ANSI sequences from historical logs
```

**问题：**

- `command.*.log` 里保留了颜色转义：

```text
[23:21:02.391][INFO][34m[3889060440][39m 群消息：...
```

- WebUI 历史日志直接显示这些控制字符，影响可读性。

**修复：**

- `humanizeLogLine()` 先执行 `stripAnsi()`
- 再做人名/群名映射
- 实时日志原本已经去除 ANSI，本次统一历史与实时行为

**验证：**

- `/api/logs` 返回的群消息不再包含 ``
- WebUI 显示为正常纯文本

---

### `1af95f2` — 日志全文件搜索

**提交信息：**

```text
feat(webui): add full-file log search
```

**问题：**

- 原来的搜索框只过滤当前已加载窗口
- 跳到日志中段后，搜索只能搜到窗口内的少量行
- 对排障没有意义

**服务端搜索：**

新增：

```text
GET /api/logs/search?file=command.2026-11-11.log&q=群消息
```

- 使用 `readline` 流式扫描整个日志文件
- 不会把整个文件读进内存
- 返回：
  - `total`：扫描的总行数
  - `found`：全文件匹配总数
  - `matches`：最多前 500 条匹配，带行号
  - `truncated`：是否因为结果过多被截断
- 支持可选 `case=1` 区分大小写
- 匹配结果统一做 ANSI 清理和 ID 可读化

**前端：**

- 「当前视图」搜索框改为**全文件搜索**
- 支持回车或点击「搜索」
- 增加「区分大小写」
- 增加「清除」
- 搜索结果面板显示：
  - 匹配总数
  - 扫描总行数
  - 当前只展示前 N 条
- 点击任意结果：
  - 计算绝对行号
  - 调用 `/api/logs/page?center=...`
  - 打开该行前后 3000 行窗口
  - 高亮关键词
  - 滚动到命中行

**验证：**

- 搜索 `群消息`：
  - 全文件找到 769 条
  - 扫描 248,633 行
  - 结果面板展示前 500 条
- 点击第 28 行：窗口定位到 1-3000 行
- 点击第 3768 行：窗口定位到 2268-5267 行
- 命中行高亮和滚动定位正常
- 没有匹配时显示空结果，不会误报

---

### `ae7adb3` — WebUI 日志 ANSI 配色

**提交信息：**

```text
feat(webui): render ANSI colors in logs
```

**问题：**

- 终端日志本身带 ANSI 颜色，例如：

```text
[34m[3889049339][39m 群消息：...
```

- WebUI 为了清理控制字符，把所有颜色都去掉了
- 日志变成单色，层级和来源不容易区分

**服务端：**

- 历史日志 `/api/logs`、`/api/logs/page` 保留 ANSI 转义
- 实时日志 `/api/logs/live` 保留 ANSI 转义
- 全文件搜索结果仍然输出纯文本，避免结果列表出现乱码

**前端：**

- 新增 ANSI SGR 解析器
- 支持：
  - 30-37 / 90-97 前景色
  - 40-47 / 100-107 背景色
  - 38;5;N 256 色
  - 38;2;R;G;B 真彩色
  - 粗体、暗色、斜体、下划线、反色
- ANSI 转义转换为安全的 `<span style="...">`
- 文本仍然经过 HTML 转义，不会把日志内容当 HTML
- 搜索关键词的 `<mark>` 高亮保留

**配色：**

- 蓝色：机器人 ID / 群标识
- 绿色：处理完成
- 黄色：开始处理 / 警告
- 红色：错误
- 灰蓝：普通辅助信息
- 其它 ANSI 色按终端近似色映射

**验证：**

- 历史日志 API 返回 ANSI 转义
- WebUI 日志 HTML 中无裸 `\x1b`
- 当前日志窗口检测到 **2721 个彩色片段**
- 全文件搜索、命中高亮、上下滚动仍正常

---

### `f358065` — 报错归档记录完整上下文

**提交信息：**

```text
fix(webui): record error payload and add default ignore codes
```

**问题：**

- 报错页只展示 `err.stack`
- 只能看到「消息内容违规」，看不到违规的发送内容
- 对排查没有任何帮助

**现在会记录：**

- `payload`：发送消息的完整参数，包含：
  - `reply` 消息 ID
  - 图片 URL、文件名、summary
  - 文本内容、类型
- `context`：完整的调用参数
- `stack`：完整错误堆栈
- `request`：请求方法、URL、params、data
- `response`：平台接口返回的数据
- `message`：平台错误消息
- `code`、时间、机器人

**存储位置：**

```text
data/QQBot/error-log.ndjson
```

**报错页展示：**

- 「发送内容 / 调用参数」直接展示，不用点开
- 下方可展开完整调用参数、请求、响应和堆栈
- 旧记录没有 payload 时仍兼容原详情

**默认屏蔽错误码新增：**

```text
40034105
40034128
```

当前默认：

```text
40034005
40034105
40034128
```

- 不写入报错归档
- 不记录发送消息错误日志
- 已存在的历史对应 code 会被清理

**验证：**

- 单元测试捕获 `40034006`：
  - payload 包含完整消息数组
  - stack / request / response 均存在
  - detail 包含调用参数
- `isIgnored` 对 `40034105`、`40034128` 返回 `true`
- 生产接口默认屏蔽列表已包含三个码

---

### `fc634c5` — 日志搜索随时停止

**提交信息：**

```text
feat(webui): allow stopping full-file log search
```

**问题：**

- 大日志全文件搜索可能要十几秒
- 搜索开始后只能等它结束，不能中途取消
- 扫 `error.log` 这类 700MB 文件时体验很差

**前端：**

- 搜索期间显示「停止搜索」按钮
- 点击后调用 `AbortController.abort()`
- 搜索结果面板显示「搜索已停止」
- 搜索按钮恢复可用
- 关闭结果、切换文件、开启实时日志也会自动停止正在进行的搜索

**服务端：**

- `/api/logs/search` 监听请求 abort / 响应 close
- `searchLogFile` 每读一行检查 `signal.aborted`
- 客户端断开后立即停止 readline 扫描
- 不再继续白扫整个大文件

**验证：**

- 对 `error.log` 发起搜索
- 扫描期间点击「停止搜索」
- 面板立即显示「搜索已停止」
- 停止按钮隐藏，搜索按钮恢复
- 未等到完整扫描结束

---

### `ffe9996` — 修复搜索结果跳转 502

**提交信息：**

```text
fix(webui): warm log index during search and retry page loads
```

**问题：**

- 全文件搜索完成后点击结果
- `/api/logs/page?center=7427686&limit=3000` 返回 502
- 原因是搜索只返回行号，没有建立行索引
- 点击结果时才开始扫描 700MB+ 的 `error.log`
- 首次建索引耗时过长，被反向代理判定超时

**修复：**

1. 搜索扫描时同步记录每 1000 行的字节锚点
2. 搜索完成后直接写入 `logIndexCache`
3. 点击搜索结果时 `/api/logs/page?center=...` 直接命中缓存
4. 前端增加页面加载重试：
   - 第一次 `limit=3000`
   - 502 / 超时后重试 `limit=1000`
   - 再失败重试 `limit=300`
5. 重试期间显示「日志索引尚未就绪，正在重试」

**验证：**

- 搜索 `error.log` 中的 `11255`
- 匹配 1389 条，扫描 745 万行
- 点击第一条结果：
  - 不再 502
  - 直接打开第 `136055-139054` 行
  - 高亮 12 处命中
- 搜索结果跳转稳定

---

## ✅ 验证

| 检查项 | 结果 |
| --- | :---: |
| 自动化测试 | **173 通过 / 0 失败** |
| WebUI | **HTTP 200** |
| 机器人在线 | **2 / 2** |
| `error.log` 20K tail | **20000 行** |
| 大日志分页总量 | **约 744 万行** |
| 运营数据过期判断 | **昨天 / 今天 / 近 7 天均返回 0 行** |
| 群消息 INFO 落盘 | **通过** |
| 历史日志 ANSI 清理 | **通过** |
| 全文件搜索 | **通过：769 条 / 248,633 行** |
| 搜索结果跳转定位 | **通过** |
| ANSI 日志配色 | **通过：2721 个彩色片段** |
| 报错完整上下文 | **通过：payload / stack / request / response** |
| 默认屏蔽码 | **40034005、40034105、40034128** |
| 搜索随时停止 | **通过** |
| 搜索结果跳转 | **通过：745 万行文件不再 502** |
| 实时日志群消息 | **通过** |
| 错误码归档 | **40034005 默认屏蔽** |
| 群聊退出 API | **路由与错误处理通过**，实际退出受平台白名单限制 |

> 群聊退出调用的是 QQ 官方 `batch_remove_members`，属于内邀能力。没有权限时 WebUI 会显示平台错误，不会伪造成功状态。

---

### 部署与推送记录

- 上述改动已部署到生产 TRSS 容器
- WebUI 地址：`http://61.184.23.160:2540/`
- 已推送 GitHub：
  - `cb40090`
  - `edfad32`
  - `90716fa`
- 仅本地提交，当前未推送：
  - `e2d5f4b`（错误码归档、日志页重构）
  - `e5c4925`（运营数据日期修复）
  - `5663ae3`（群聊退出、消息日志补全）
  - `dda05d8`（历史日志去除 ANSI）
  - `1af95f2`（全文件日志搜索）
  - `ae7adb3`（ANSI 日志配色）
  - `f358065`（报错完整上下文 / 新默认屏蔽码）
  - `fc634c5`（全文件搜索随时停止）
  - `ffe9996`（搜索结果跳转 502 修复）
  - 本更新日志的提交
