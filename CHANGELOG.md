# 更新日志

## 2026-11-11

今天共有 5 个功能提交，按时间从早到晚记录。

| 提交 | 时间 | 类型 | 标题 |
| --- | --- | --- | --- |
| `cb40090` | 20:01 | 修复 | 订阅 `GROUP_MEMBER`，恢复入群申请和群成员事件 |
| `edfad32` | 20:11 | 修复 | WebUI 大日志尾部读取，避免 `Invalid string length` |
| `90716fa` | 21:17 | 修复 | 测试插件不再自动发送进群/退群消息 |
| `e2d5f4b` | 22:53 | 功能 | 错误码归档、日志页重构、连续滚动日志浏览 |
| `e5c4925` | 23:00 | 修复 | 运营数据相对日期改为按当前日期过滤 |

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
  - 本更新日志的提交
