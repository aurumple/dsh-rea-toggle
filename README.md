# dsh-rea-toggle

[English](#english) · [中文](#中文)

One switch per conversation that decides whether the **REA**
(`reverse-engineer-anything`) MCP server's context reaches the model at all.

REA registers **207 tool schemas** plus a multi-kilobyte server-instructions
block. `dsh-mcp-client` puts both on the **global** layer, so every agent pays
for them on every request — whether or not the turn has anything to do with
reverse engineering.

With this plugin installed, a small pill appears below the composer:

- **REA on** (green) — exactly the pre-install behaviour. REA's tools and
  instructions are visible to the model.
- **REA off** (grey) — those 207 tool schemas and the `mcp:rea` instructions
  block **leave the model context**, taking effect on the next step.

**The switch is per conversation.** Each conversation remembers its own
position, and a new conversation starts **off**. That is the whole point: a
conversation about a web app should not pay for 207 reverse-engineering schemas
just because some other conversation needs them. Subagents inherit the position
of the conversation that created them, so delegating inside reverse-engineering
work does not silently break the subagent.

The same switch is on the keyboard: `/rea off`, `/rea on`, `/rea status`,
`/rea toggle` — all acting on the conversation you typed them in.

Nothing is uninstalled and nothing restarts. The MCP connection stays up; the
model simply stops being told those tools exist.

---

## English

### What it actually does

The token cost comes from two different places that travel two different paths,
so one mechanism is not enough:

| Target | Mechanism |
| --- | --- |
| Tool schemas | `tools.restrict({ deny })` is called **in each agent's own context**. `ToolRuntime.view()` filters what that scope *inherits* from the global layer, and the model-facing schema list is rebuilt from that view on every assembly. The reserved `run_code` transport sits outside the filterable layers, so it is unaffected. |
| Instructions text | `dsh-mcp-client` registers the server instructions as a prompt section named `mcp:<server>` at order `MCP_SERVERS` (3100). **A scoped section with the same name shadows the global one** — a documented contract of `systemPrompt.section()` ("a scoped section shadows a global section with the same name"), not an implementation detail — and an empty section is dropped at render (`renderPrompt` keeps only `text.length > 0`). Registering that name and returning `''` therefore removes the block for that agent alone. |

Both are scoped registrations, so disposing them restores the previous state
exactly. That is why flipping the switch needs no restart and no reload.

Coverage includes **subagents**: `agent/created` is serial and awaited by the
registry, so installing inside it lands ahead of any prompt assembly.

### Install

```bash
dsh plugin --profile <profile> add github:aurumple/dsh-rea-toggle
```

Or point at a checkout:

```bash
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-rea-toggle
```

The bundle row id is `rea-toggle`; the package name is `dsh-rea-toggle`.

### Use

| Where | What |
| --- | --- |
| Pill under the composer | Click to flip **this conversation**. Green = on, grey = off, red border = the host did not answer. |
| `/rea off` · `/rea on` | Set this conversation's position. `enable` / `disable` work too. |
| `/rea toggle` | Flip this conversation. |
| `/rea status` | Report this conversation's position. |

A new conversation starts off. The first time you turn one on, that conversation
is remembered; conversations you never touch stay on the default and are not
written down.

Positions are remembered in `$DSH_HOME/rea-toggle.json` (usually
`~/.dsh/rea-toggle.json`), keyed by session id, and survive a restart. The file
keeps the 500 most recently changed conversations; an older one simply falls
back to the default.

### Configuration

Every field is optional.

```yaml
- id: rea-toggle
  name: dsh-rea-toggle
  config:
    server: rea               # one MCP server to govern; default "rea"
    # servers: [rea, ghidra]  # or several; wins over `server` when present
    # defaultEnabled: true    # new conversations start ON instead of off
```

Changing `server` governs a different MCP server by the same rules: tool prefix
`mcp__<server>__`, instructions section `mcp:<server>`. Because the mechanism is
generic, this works for any MCP server whose tools are bridged by
`dsh-mcp-client` — the REA case is just the one that motivated it.

`defaultEnabled` exists for anyone who wants the pre-plugin behaviour back: with
it on, a conversation nobody has switched behaves exactly as if this plugin were
not installed.

### HTTP API

The Client half talks to the Host over one exact route on the bare `webServer`
(the same shape other bundles use, so it does not travel through the `/api`
prefix fence). The conversation is `session=` on GET and a body field on POST:
the pill always knows which conversation it is showing, and a request that does
not say cannot be answered for it.

```
GET  /rea-toggle/state?session=<id>
  -> { session, enabled, known, defaultEnabled, servers, agents, tools, statePath }

GET  /rea-toggle/state            (no session: a summary)
  -> { session: null, defaultEnabled, servers, conversations, agents, tools, statePath }

POST /rea-toggle/state
  body: { "session": "<id>", "enabled": true | false }   (omit `enabled` to flip)
  -> the per-conversation status object
```

`known` says whether this conversation has ever been switched; when it is
`false`, `enabled` is just `defaultEnabled` and nothing has been written yet.
`agents` is how many live agents of that conversation are currently covered;
`tools` is how many of the governed server's tools were recognised, which is the
honest answer to "did it find REA at all" — if it reads `0`, the server is not
connected under that name (and stays `0`-safe because `restrictableNames` is the
denyable set, not the filtered view).

### Scope and limits

- **One server per row by default.** Other MCP servers are untouched; use
  `servers` to govern more than one.
- **Hidden, not unloaded.** The MCP connection stays up and the REA process
  keeps running. When the switch is off the model simply cannot reach it —
  including indirectly through `run_code`. That is deliberate: leaving a second
  path open would save only half the tokens.
- **Per-conversation state, in-process.** Positions are read from the file at
  `apply()` and written on every change. Two DSH instances sharing one profile
  each read it once and do not live-sync with each other.
- **It does not delete anything.** Turning it off is reversible in one click,
  and uninstalling the bundle lifts every registration.

### Verify it yourself

The claim is that the tools are gone from the model's context, not merely
hidden in a UI. Check it where the model's own view is exposed:

1. With the switch **on**, ask the agent to list its tools — `mcp__rea__*`
   entries are there (207 of them for a stock REA install).
2. Turn it **off**, ask again — they are gone, and calling one by name returns
   `Error: unknown tool "mcp__rea__binary_session"`.
3. Turn it back **on** — they return, unchanged.
4. Open a **second conversation** and check its tool list: it is off, while the
   first one is still on. That is the property that distinguishes this plugin
   from a global toggle.

### Development

```bash
npm test        # node:test, no dependencies
```

The suite drives the real `apply()` against a small model of the three
contracts it depends on (tool view, prompt section merge, agent registry). It
pins what "off" removes, that "on" restores the previous state exactly, that a
new subagent is covered before its first step, that the position survives a
restart, and that the HTTP surface validates its input.

### License

MIT

---

## 中文

一个开关（**每个对话一个**），决定 **REA**（`reverse-engineer-anything`）MCP
服务器的上下文是否进入模型。

REA 注册了 **207 个工具 schema**，外加一段几千字的服务端说明。
`dsh-mcp-client` 把它们放在**全局层**，所以每个 agent、每次请求都在为它们付
token —— 不管这一轮到底要不要逆向。

装上这个插件后，聊天输入框下方会多一个小胶囊：

- **REA 开**（绿色）— 和装之前完全一样，REA 的工具与说明对模型可见。
- **REA 关**（灰色）— 这 207 个工具 schema 和 `mcp:rea` 说明块**从模型上下文
  里消失**，下一步请求立即生效。

**开关按对话独立**：每个对话记住自己的位置，**新对话默认关**。这正是它存在的
理由——一个聊 Web 应用的对话，不该因为另一个对话要逆向就一直背着 207 个逆向
schema。子智能体**继承创建它的那个对话**的位置，所以在逆向对话里派活不会把子
智能体悄悄废掉。

同样的开关也在键盘上：`/rea off`、`/rea on`、`/rea status`、`/rea toggle` ——
全都只作用于你敲命令的那个对话。

不卸载任何东西，也不重启。MCP 连接照旧，只是模型不再被告知这些工具存在。

### 它到底做了什么

token 成本来自两个不同的地方，走的是两条不同的路径，所以一种机制不够：

| 目标 | 机制 |
| --- | --- |
| 工具 schema | 在**每个 agent 自己的 ctx** 上调 `tools.restrict({ deny })`。`ToolRuntime.view()` 用这层限制过滤它从全局层**继承**来的工具，而模型可见的 schema 列表每次组装都从这个 view 重建。保留名 `run_code` 挂在可过滤层之外，不受影响。 |
| 说明文本 | `dsh-mcp-client` 把服务端说明注册成名为 `mcp:<server>`、order 为 `MCP_SERVERS`（3100）的 prompt section。**同名 section 在子作用域会遮蔽全局的**（`SystemPrompt.assemble` 按名合并），而空 section 在渲染时被丢弃（`renderPrompt` 只保留 `text.length > 0`）。所以在 agent 作用域注册同名 section 并返回 `''`，就只对那个 agent 抹掉这一段。 |

两者都是**作用域注册**，dispose 之后状态精确还原 —— 这就是切换不需要重启、
不需要刷新的原因。

覆盖范围包括**子智能体**：`agent/created` 是串行且被注册表 await 的事件，在它
里面安装就落在任何组装之前。

### 安装

```bash
dsh plugin --profile <profile> add github:aurumple/dsh-rea-toggle
```

或者指向本地目录：

```bash
dsh plugin --profile <profile> add link:/本目录绝对路径
```

bundle 行 id 是 `rea-toggle`，包名是 `dsh-rea-toggle`。

### 使用

| 位置 | 作用 |
| --- | --- |
| 输入框下方的小胶囊 | 点一下翻转**本对话**。绿=开，灰=关，红框=宿主没应答。 |
| `/rea off` · `/rea on` | 设定**本对话**的位置（`enable` / `disable` 亦可）。 |
| `/rea toggle` | 翻转**本对话**。 |
| `/rea status` | 报告**本对话**的位置。 |

新对话默认关。你第一次把某个对话打开时，那次选择才会被记下来；从没碰过的对话
一直走默认值，不写盘。

位置存在 `$DSH_HOME/rea-toggle.json`（通常是 `~/.dsh/rea-toggle.json`），按
session id 索引，重启后保持。文件保留最近改动的 500 个对话，更早的自动回落到默
认值。

### 配置

字段全部可选。

```yaml
- id: rea-toggle
  name: dsh-rea-toggle
  config:
    server: rea               # 要控制哪个 MCP server，默认 rea
    # servers: [rea, ghidra]  # 也可以给多个；存在时优先于 server
    # defaultEnabled: true    # 新对话默认改为「开」
```

改了 `server` 就按同样规则控制另一个 MCP server：工具前缀
`mcp__<server>__`、说明 section `mcp:<server>`。机制本身是通用的，所以任何由
`dsh-mcp-client` 桥接的 MCP server 都能用 —— REA 只是促成它的那个场景。

`defaultEnabled` 是给想退回装插件前行为的人用的：打开它，没被手动切过的对话就和
没装这个插件时完全一样。

### HTTP 接口

Client 那一半通过裸 `webServer` 上的 exact 路由说话（和已装的几个 bundle 同样
的形状，不走 `/api` 前缀栅栏）。对话在 GET 里是 `session=`，在 POST 里是 body
字段：胶囊永远知道自己显示的是哪个对话，而一个不说自己是谁的请求没法替它回答。

```
GET  /rea-toggle/state?session=<id>
  -> { session, enabled, known, defaultEnabled, servers, agents, tools, statePath }

GET  /rea-toggle/state            （不带 session：汇总）
  -> { session: null, defaultEnabled, servers, conversations, agents, tools, statePath }

POST /rea-toggle/state
  body: { "session": "<id>", "enabled": true | false }   （省略 enabled 表示翻转）
  -> 该对话的状态对象
```

`known` 表示这个对话有没有被切过；为 `false` 时 `enabled` 就是 `defaultEnabled`，
盘上还没有它的记录。

`agents` 是当前这个对话里被覆盖的 agent 数，`tools` 是识别到的该 server 工具数。
`tools` 是「它到底认没认到 REA」的诚实答案 —— 读作 `0` 说明服务器没以这个名字连
上（`restrictableNames` 是「可拒绝集合」而不是过滤后的视图，所以关着的时候这个
数照样是准的）。

### 边界

- **默认一行只管一个 server**。别的 MCP server 照旧；要管多个就用 `servers`。
- **是隐藏，不是卸载**。MCP 连接还在，REA 进程照跑。关着的时候模型够不到它 ——
  包括通过 `run_code` 间接够到。这是有意的：留第二条路等于只省了一半 token。
- **状态按对话，但仍在进程内**。`apply()` 时读一次文件，每次改动写一次。多个 DSH
  实例共用一个 profile 时各自读一次，互不实时同步。
- **它不删除任何东西**。关掉一键可逆，卸载 bundle 会把所有注册都撤掉。

### 自己验一遍

要验的是「工具从模型上下文里没了」，不是「UI 上藏起来了」。在暴露模型视角的地
方查：

1. 开关**开**着，让 agent 列一下工具 —— `mcp__rea__*` 都在（原版 REA 是 207
   个）。
2. 关**掉**，再列一次 —— 全没了；直接按名字调用会返回
   `Error: unknown tool "mcp__rea__binary_session"`。
3. 再打**开** —— 原样回来。
4. **开第二个对话**再看它的工具清单：它是关的，而第一个对话仍然是开的。这一条才
   是它区别于全局开关的地方。

### 开发

```bash
npm test        # node:test，无依赖
```

测试用一个小模型模拟它依赖的契约（工具视图、prompt section 合并、带归属关系的
agent 注册表），驱动真实的 `apply()`。它钉住的是：新对话默认关、一次切换只影响
那一个对话、子智能体继承父对话的位置、「开」精确还原、「关」抹掉了什么、位置跨
重启保持、HTTP 接口校验输入。

还有一条**回归守卫**：一次 `tools/change` 只允许做有界的注册/注销。曾经在
reconcile 的锁之外去卸注册，会带着开着的锁重入事件监听器，一次外部事件放大成
约 4 万次 register/dispose，把整个界面卡死。这类问题在测试里表现为超时，所以直
接用计数守住。

### 许可

MIT
