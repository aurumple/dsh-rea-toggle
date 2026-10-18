# dsh-rea-toggle

[English](#english) · [中文](#中文)

One switch that decides whether the **REA** (`reverse-engineer-anything`) MCP
server's context reaches the model at all.

REA registers **207 tool schemas** plus a multi-kilobyte server-instructions
block. `dsh-mcp-client` puts both on the **global** layer, so every agent pays
for them on every request — whether or not the turn has anything to do with
reverse engineering.

With this plugin installed, a small pill appears below the composer:

- **REA on** (green) — exactly the pre-install behaviour. REA's tools and
  instructions are visible to the model.
- **REA off** (grey) — those 207 tool schemas and the `mcp:rea` instructions
  block **leave the model context**, taking effect on the next step.

The same switch is on the keyboard: `/rea off`, `/rea on`, `/rea status`,
`/rea toggle`.

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
| Instructions text | `dsh-mcp-client` registers the server instructions as a prompt section named `mcp:<server>` at order `MCP_SERVERS` (3100). **A scoped section with the same name shadows the global one** (`SystemPrompt.assemble` merges by name), and an empty section is dropped at render (`renderPrompt` keeps only `text.length > 0`). Registering that name and returning `''` therefore removes the block for that agent alone. |

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
| Pill under the composer | Click to flip. Green = on, grey = off, red border = the host did not answer. |
| `/rea off` · `/rea on` | Set the position explicitly. `enable` / `disable` work too. |
| `/rea toggle` | Flip it. |
| `/rea status` | Report the current position. |

The position is remembered in `$DSH_HOME/rea-toggle.json` (usually
`~/.dsh/rea-toggle.json`) and survives a restart.

### Configuration

Every field is optional.

```yaml
- id: rea-toggle
  name: dsh-rea-toggle
  config:
    server: rea            # one MCP server to govern; default "rea"
    # servers: [rea, ghidra]   # or several; wins over `server` when present
```

Changing `server` governs a different MCP server by the same rules: tool prefix
`mcp__<server>__`, instructions section `mcp:<server>`. Because the mechanism is
generic, this works for any MCP server whose tools are bridged by
`dsh-mcp-client` — the REA case is just the one that motivated it.

### HTTP API

The Client half talks to the Host over one exact route on the bare `webServer`
(the same shape other bundles use, so it does not travel through the `/api`
prefix fence):

```
GET  /rea-toggle/state
  -> { enabled, servers, agents, tools, statePath }

POST /rea-toggle/state
  body: { "enabled": true | false }   (omit `enabled` to flip)
  -> the same status object
```

`agents` is how many live agents are currently covered; `tools` is how many of
the governed server's tools were recognised. `tools` is the honest answer to
"did it find REA at all" — if it reads `0` while the switch is on, the server is
not connected under that name.

### Scope and limits

- **One server per row by default.** Other MCP servers are untouched; use
  `servers` to govern more than one.
- **Hidden, not unloaded.** The MCP connection stays up and the REA process
  keeps running. When the switch is off the model simply cannot reach it —
  including indirectly through `run_code`. That is deliberate: leaving a second
  path open would save only half the tokens.
- **Per-process state.** The position is read from the file at `apply()` and
  written on every change. Two DSH instances sharing one profile each read it
  once and do not live-sync with each other.
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

一个开关，决定 **REA**（`reverse-engineer-anything`）MCP 服务器的上下文是否
进入模型。

REA 注册了 **207 个工具 schema**，外加一段几千字的服务端说明。
`dsh-mcp-client` 把它们放在**全局层**，所以每个 agent、每次请求都在为它们付
token —— 不管这一轮到底要不要逆向。

装上这个插件后，聊天输入框下方会多一个小胶囊：

- **REA 开**（绿色）— 和装之前完全一样，REA 的工具与说明对模型可见。
- **REA 关**（灰色）— 这 207 个工具 schema 和 `mcp:rea` 说明块**从模型上下文
  里消失**，下一步请求立即生效。

同样的开关也在键盘上：`/rea off`、`/rea on`、`/rea status`、`/rea toggle`。

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
| 输入框下方的小胶囊 | 点一下翻转。绿=开，灰=关，红框=宿主没应答。 |
| `/rea off` · `/rea on` | 显式设定位置（`enable` / `disable` 亦可）。 |
| `/rea toggle` | 翻转。 |
| `/rea status` | 报告当前位置。 |

位置存在 `$DSH_HOME/rea-toggle.json`（通常是 `~/.dsh/rea-toggle.json`），重启后
保持。

### 配置

字段全部可选。

```yaml
- id: rea-toggle
  name: dsh-rea-toggle
  config:
    server: rea            # 要控制哪个 MCP server，默认 rea
    # servers: [rea, ghidra]   # 也可以给多个；存在时优先于 server
```

改了 `server` 就按同样规则控制另一个 MCP server：工具前缀
`mcp__<server>__`、说明 section `mcp:<server>`。机制本身是通用的，所以任何由
`dsh-mcp-client` 桥接的 MCP server 都能用 —— REA 只是促成它的那个场景。

### HTTP 接口

Client 那一半通过裸 `webServer` 上的 exact 路由说话（和已装的几个 bundle 同样
的形状，不走 `/api` 前缀栅栏）：

```
GET  /rea-toggle/state
  -> { enabled, servers, agents, tools, statePath }

POST /rea-toggle/state
  body: { "enabled": true | false }   （省略 enabled 表示翻转）
  -> 同一个状态对象
```

`agents` 是当前被覆盖的 agent 数，`tools` 是识别到的该 server 工具数。`tools`
是「它到底认没认到 REA」的诚实答案 —— 开着的时候读作 `0`，说明服务器没以这个
名字连上。

### 边界

- **默认一行只管一个 server**。别的 MCP server 照旧；要管多个就用 `servers`。
- **是隐藏，不是卸载**。MCP 连接还在，REA 进程照跑。关着的时候模型够不到它 ——
  包括通过 `run_code` 间接够到。这是有意的：留第二条路等于只省了一半 token。
- **状态是进程内的**。`apply()` 时读一次文件，每次改动写一次。多个 DSH 实例共用
  一个 profile 时各自读一次，互不实时同步。
- **它不删除任何东西**。关掉一键可逆，卸载 bundle 会把所有注册都撤掉。

### 自己验一遍

要验的是「工具从模型上下文里没了」，不是「UI 上藏起来了」。在暴露模型视角的地
方查：

1. 开关**开**着，让 agent 列一下工具 —— `mcp__rea__*` 都在（原版 REA 是 207
   个）。
2. 关**掉**，再列一次 —— 全没了；直接按名字调用会返回
   `Error: unknown tool "mcp__rea__binary_session"`。
3. 再打**开** —— 原样回来。

### 开发

```bash
npm test        # node:test，无依赖
```

测试用一个小模型模拟它依赖的三份契约（工具视图、prompt section 合并、agent 注
册表），驱动真实的 `apply()`。它钉住的是：「关」抹掉了什么、「开」是否精确还原、
新建的子智能体是否在第一步之前被覆盖、位置是否跨重启保持、HTTP 接口是否校验输
入。

### 许可

MIT
