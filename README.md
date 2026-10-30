<div align="center">

# qq-official-bot-plugin

**TRSS-Yunzai 的 QQBot 适配器插件**（基于 [`qq-official-bot`](https://www.npmjs.com/package/qq-official-bot) 重写，兼容旧版 `QQBot-Plugin`）

[QQ 群 1046894467](https://qm.qq.com/q/WdZoPbyPsI) · [旧版插件](https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin)

</div>

---

## 简介

本插件是 [Yunzai-QQBot-Plugin](https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin)（基于 `qq-group-bot`）的**新版实现**，改用持续维护的 [`qq-official-bot`](https://www.npmjs.com/package/qq-official-bot) 1.3.3，在保留旧版配置、命令、数据目录的基础上，补上了旧版缺失的一批官方能力。

- 适配器 ID、`config/QQBot.yaml`、`data/QQBot/`、`#QQBotxxx` 命令全部沿用旧版，**可以从旧版直接迁移**
- 收发消息内部仍使用 TRSS 熟悉的扁平消息结构，仅在适配器边界转换成 `qq-official-bot` 的 `{ type, data }`
- 赠送一个功能测试插件（[example/qqbot-test.js](example/qqbot-test.js)），首次启动时自动安装到 `plugins/example/`，方便验证各项能力

## 快速开始

### 1. 准备

安装并启动 [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai)（Node.js **>= 20.12**）。

### 2. 安装插件

```bash
cd TRSS-Yunzai/plugins
git clone https://github.com/XingYunStar/qq-official-bot-plugin.git
cd qq-official-bot-plugin
npm install
```

**移除/停用旧的 [QQBot-Plugin](https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin)** 后重启 TRSS-Yunzai。两个插件都使用 `QQBot` 作为适配器 ID，不能同时启用；同时存在时本插件会自动跳过连接并报错。

### 3. 创建机器人

打开 [QQ 开放平台](https://q.qq.com) 创建 Bot：

1. 创建机器人
2. 开发设置 → 得到 `机器人QQ号:AppID:Token:AppSecret`

### 4. 配置账号

输入：

```text
#QQBot设置机器人QQ号:AppID:Token:AppSecret:是否群Bot:是否频道私域
#QQBot设置机器人QQ号:AppID:Token:AppSecret:2     # WebHook 模式
```

格式示例：

- 机器人QQ号 `3889012345`、AppID `102345678`、Token `AbCdEfGhIjKlMnOpQrStUvWxYz123432`、AppSecret `aBcDeFgHiJkLmNoPqRsTuVwXyZ123432`、群Bot `1`、频道私域 `0`

```
#QQBot设置3889012345:102345678:AbCdEfGhIjKlMnOpQrStUvWxYz123432:aBcDeFgHiJkLmNoPqRsTuVwXyZ123432:1:0
```

- WebHook 模式（需要启用公网 HTTPS，在 `TRSS-Yunzai/config/config/server.yaml` 的 `https` 段配置证书 `key` / `cert`，并在[开放平台](https://q.qq.com)添加回调地址 `<url>/QQBot`）

```
#QQBot设置3889012345:102345678:AbCdEfGhIjKlMnOpQrStUvWxYz123432:aBcDeFgHiJkLmNoPqRsTuVwXyZ123432:2
```

### 5. 发送图片 / MD 消息

- **不想用 MD 消息，或没有公网地址，可切换普通消息：**

```
#QQBotMD机器人QQ号:legacy
```

> legacy（普通消息）模式下，频道/频道私信的本地图片会走 **multipart 上传**，不需要公网地址；群聊/单聊图片本来就走上行接口，也不需要。

- **使用 MD 按钮消息 / MD 消息（含本地图片）时，需要一个公网可访问的地址：**

1. 在 `TRSS-Yunzai/config/config/server.yaml` 的 `url` 填入公网地址 **域名或 IP**（需放行 2536 端口，或反向代理到 TRSS 的内网地址），浏览器打开该地址，后台日志应出现访问请求。
2. 使用域名时，需要在宿主机把域名反向代理到 TRSS 的内网地址 `http://<TRSS内网IP>:2536`；docker 容器 TRSS 的内网 IP 可用下面命令查看（把 `TRSS` 换成你的容器名）：

   ```bash
   docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' TRSS
   ```

3. 如果图片加载失败，可以限制图片大小：`#QQBot图片限制2`（单位 MB，默认 3）。

> 说明：`url` 用于拼接图片等资源地址，必须是 QQ 能访问到的公网地址；只填 IP 时用 `http://IP:2536`。

`server.yaml` 示例（把域名/IP换成自己的）：

```yaml
# 服务器地址（公网可访问；MD 消息中的图片必须，legacy 频道图片走 multipart 不需要）
url: http://bot.example.com
# 服务器端口
port: 2536
# 服务器缺省跳转地址
redirect: https://qm.qq.com/q/WdZoPbyPsI
# 服务器鉴权
auth: # Authorization: Bearer <access_token>

https:
  # url: https://localhost:2537
  # port: 2537
  # key: config/localhost.key
  # cert: config/localhost.crt
```

### 6. 基础命令

| 命令 | 说明 |
| --- | --- |
| `#QQBot账号` | 列出已配置账号 |
| `#QQBot设置机器人QQ号:AppID:Token:AppSecret:是否群Bot:是否频道私域` | 添加/删除账号（是 1 否 0） |
| `#QQBot设置...:2` | 使用 Webhook 模式 |
| `#QQBotMD机器人QQ号:raw/inline/legacy` | MD按钮消息 / MD消息 / 普通消息 |
| `#QQBot图片限制2` | 图片大小限制（MB，默认 3） |
| `#QQBot重连 [QQ号]` | 手动重连 |
| `#QQBot绑定用户QQ号` | 绑定按钮回调用户 |

## 新版支持了什么

| 能力 | 说明 |
| --- | --- |
| **群内全量消息** | 支持 `GROUP_MESSAGE_CREATE`（开启「接收所有消息」后普通群消息也会派发）；按 `msg_id` 去重，只有真的 @机器人 才补自身 `at` |
| **群引用（收）** | QQ 群引用不在 `message_reference`，而在 `msg_elements`（`message_type=103`）+ `message_scene.ext`；插件会自动补 `reply` 元素、还原真实消息 ID，`e.getReply()` 可读取被引用内容 |
| **群引用（发）** | 按官方要求把 `message_reference.message_id` 转成 `msg_idx`（引用用户消息）或 `ref_idx`（引用机器人自己的消息），引用气泡正常显示；`msg_id` 仍是本条消息 ID，不影响被动回复 |
| **群管理** | `e.group.muteMember()` 禁言、`e.group.kickMember()` 踢人、`e.group.getInfo()` 群信息、`e.group.getMemberInfo()` 成员信息；`e.member.is_admin / is_owner` |
| **群通知** | 成员进群/退群 → `notice.group.increase/decrease`；入群申请 → `notice.group.join_request`；机器人被拉群 → `notice.group.bot.increase` |
| **成员身份 / 昵称** | 优先使用消息事件 `author` / `mentions` 自带的 `member_role`、`username`，不依赖需要申请权限的「群成员详情」接口（接口报 `11253` 时自动回退） |
| **入群审批** | 通过 `qq-official-bot` 的入群申请接口查询、同意、拒绝 |
| **频道图片** | legacy（普通消息）模式支持 **multipart `file_image`** 直传，不依赖公网 URL；MD 模式仍转公网 URL |
| **URL 处理** | `toQRCode: true` 转二维码（旧行为）、`"link"` 转 Markdown 链接 `[host](url)`、`false` 原样发送 |
| **稳定性** | 断线退避重连、心跳超时探测、access_token 失败无限重试、重复连接清理、与旧插件冲突时自动跳过连接 |
| **Webhook** | 继续复用 TRSS 的 `/QQBot` 路由，签名改用 SDK 的 Ed25519（不再依赖 tweetnacl） |
| **测试插件自动安装** | 首次启动把 `example/qqbot-test.js` 复制到 `plugins/example/`，并向 master 发送使用说明（单聊） |

## 配置

沿用旧版的 `TRSS-Yunzai/config/QQBot.yaml`，不需要重新配置账号。

```yaml
# 机器人QQ号:AppID:Token:AppSecret:是否群Bot:是否频道私域
# Webhook 模式用最后一段 2：机器人QQ号:AppID:Token:AppSecret:2
token:
  - 114514:102000000:xxxxxxxx:xxxxxxxx:1:0

bot:
  sandbox: false        # 已废弃，新平台统一域名，保留仅为兼容
  maxRetry: .inf
  timeout: 30000

toQRCode: link          # true=二维码 / link=Markdown 链接 / false=原样
toCallback: true
toBotUpload: true
hideGuildRecall: false
imageLength: 3
autoInstallExample: true  # 首次启动把测试插件装到 plugins/example/

markdown:
  "114514": raw         # raw / inline / legacy / 模板ID
```

| 配置项 | 说明 |
| --- | --- |
| `token` | 账号列表，格式同旧版 |
| `bot` | 传给 SDK 的公共配置；`sandbox` 已废弃，`maxRetry` / `timeout` 仍生效 |
| `toQRCode` | URL 处理方式：`true` 二维码、`"link"` Markdown 链接、`false` 原样 |
| `markdown` | `机器人QQ号: raw / inline / legacy / 模板ID` |
| `autoInstallExample` | 是否在首次启动时自动安装测试插件（默认 `true`） |
| `exampleGuideSent` | 是否已向 master 发送过测试插件说明（发送成功后自动置 `true`） |
| `reconnect` | 重连/心跳参数，同旧版 |
| 其余 | `toCallback` / `toBotUpload` / `hideGuildRecall` / `imageLength` / `permission` 同旧版 |

## 测试插件（example/qqbot-test.js）

**不会随适配器一起加载**；复制到 `plugins/example/` 后由 TRSS 作为独立插件加载。安装插件后首次启动会自动复制到 `TRSS-Yunzai/plugins/example/qqbot-test.js`（如果该文件已存在则不会覆盖，更新测试插件请手动替换）。也可以在仓库里手动下载该文件放到 `plugins/example/`。

加载后发送 `#qqbot测试` 查看全部命令：

| 命令 | 测试内容 |
| --- | --- |
| `#qqbot昵称 [@某人]` | 获取昵称（消息事件字段优先） |
| `#qqbot群名` | 获取群名（事件/缓存优先，其次群信息接口） |
| `#qqbot身份 [@某人]` | 群身份（群主/管理员/成员）、是否机器人、入群时间 |
| `#qqbotat` | `e.at` / `e.atBot` / at 元素解析结果 |
| `#qqbot引用` | 发送一条引用回复 |
| `#qqbot引用消息` | 读取被引用消息内容（支持 `msg_elements` 引用） |
| `#qqbot撤回` | 撤回测试消息；引用消息时撤回被引用那条（只能撤回机器人自己的消息） |
| `#qqbot禁言 @某人 [秒数]` | 禁言，`0` 为解除（需要机器人是群管理员） |
| `#qqbot踢人 @某人 [拉黑]` | 踢人，可选加入群黑名单 |
| `#qqbot进群申请` | 待审批入群申请列表 |
| `#qqbot同意进群 [序号]` / `#qqbot拒绝进群 [序号]` | 审批入群申请 |
| `#qqbot原始` | 调试：输出本条消息的原始事件字段（`auth_token` 打码） |

权限：群管理命令要求发送者是 TRSS master 或群主/管理员；测试插件顶部有 `SKIP_PERMISSION_CHECK` 开关（默认 `false`）。

### master 单聊通知

首次自动安装（或首次启动且尚未发送过）时，插件会向 **master** 发送一条单聊使用说明，发送成功后写入 `exampleGuideSent`，之后不会重复打扰。

master 来自 `TRSS-Yunzai/config/config/other.yaml` 的 `master` 配置（按机器人 ID 分组）：

```yaml
master:
  - "114514:你的openid"   # QQBot 需要使用 openid；也可以先在群里 #QQBot绑定用户
```

找不到可用 master 时只会输出一条 warn 日志，不影响使用。

## 与旧版的差异

- SDK：`qq-group-bot` 1.1.0（停更）→ `qq-official-bot` 1.3.3（持续维护）
- 域名：`api.sgroup.qq.com` → `api.bot.qq.com`（`sandbox` 已废弃）
- 鉴权：只需 AppID + AppSecret；旧 Token 字段保留但不再使用
- Intents：`GROUP_AT_MESSAGE_CREATE` + `C2C_MESSAGE_CREATE` 合并为 `GROUP_AND_C2C_EVENT`
- Webhook：仍是 `/QQBot` 单路由，签名改用 Ed25519
- 频道/频道私信图片：legacy（普通消息）模式走 multipart `file_image` 上传，不需要公网 URL；MD 模式会先转公网 URL（需要 `TRSS-Yunzai/config/config/server.yaml` 的 `url` 可被 QQ 访问）
- 消息元素：插件内部仍是扁平结构，收发边界自动转换，对上层透明

## 已知限制

- 「群成员详情」接口需要开放平台权限，未申请时返回 `11253`；身份/昵称会回退到消息事件字段
- QQ 官方接口只能撤回**机器人自己发送的消息**；引用别人消息时只能读内容，不能撤回
- 引用机器人自己的旧消息时，若平台只给 `REFIDX` 索引且本进程没有记录 `ref_idx`，则无法还原真实消息 ID（重启后旧记录丢失）
- 群内全量消息需要在群设置中由群主开启「接收所有消息」

## 测试

```bash
npm test
```

离线集成测试：用桩替代 TRSS 框架与网络，但使用真实的 `qq-official-bot` 解析和真实插件代码，覆盖连接、消息解析、全量消息、群引用收发、元素转换、频道 multipart、群管理 API、通知、自动安装、master 说明、重连、冲突保护等（101 条断言）。

## 致谢

- 旧版插件作者：[时雨🌌星空](https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin)
- SDK：[qq-official-bot](https://github.com/zhinjs/qq-official-bot)（凉菜）
- QQ 群：[1046894467](https://qm.qq.com/q/WdZoPbyPsI)
