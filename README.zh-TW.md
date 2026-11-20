# AgentTaskBoard（Agent 任务看板）

<a href="./README.md"><kbd>English</kbd></a> <a href="./README.zh-TW.md"><kbd>简体中文</kbd></a>

**AgentTaskBoard（Agent 任务看板）是给程序代理使用的本地任务看板与裁决 CLI。看板由单一写入者生成，不实时推送，也不进行跨机器同步。**

一张任务只有一个 owner。`atb claim` 以可判定的退出码决定 owner，而 `atb list --since` 为每个代理提供下一回合可用的稳定 delta 游标。

## 状态

这个仓库包含 `v0.1.0` 的 Node.js 骨架，实现 `init`、`doctor`、`rules`、`auto`、`add`、`claim`、`done`、`list` 与只读本地看板。它没有 Obsidian 依赖、常驻进程、外部网络暴露或跨机器同步。

## 需求

- Node.js 20 或更新版本
- 建议使用 Git 跟踪项目源代码，并让本地 `.atb/` 状态留在版本控制之外

## 安装

```sh
npm install -g .
atb --version
```

在项目中由 `atb init` 创建看板后，`atb doctor` 会在执行任务命令前检查本地运行环境、工作区、看板、协议与锁定状态。

## 接入你的 agent

`atb init` 不会修改 agent 规则文件。先执行 `atb rules install --dry-run` 查看每个目标文件与行数变化，再执行 `atb rules install` 逐项确认。管道或其他非 TTY 环境会打印计划并以 `7` 结束，不会等待输入；确认后才使用 `--yes`。

自动安装器会先将每个文件备份为 `<name>.bak-<timestamp>`，只替换 `atb:begin` 与 `atb:end` 之间的区块，并把已安装目标记录在用户数据目录。用 `atb rules status` 检查，`atb rules uninstall --yes` 移除。`atb doctor --rules` 会先确认看板存在；没有 `--expect` 时打印挑战并以 `7` 结束。向新的 agent 询问规则探针 nonce，再执行 `atb doctor --rules --expect <agent-answer>`；相符时以 `0` 结束。

## 自动模式

自动模式是选择性启用且只属于当前工作区。`atb init --auto` 或 `atb auto on` 启用，`atb auto off` 停用，`atb auto status` 显示 `enabled`、`window_minutes`、`create_allowed` 与 `next_check_after`。
启用后，`atb claim <slug> --actor <name> --goal "..."` 会在 slug 不存在时创建 agent 来源任务。自动模式关闭时，缺少任务会以 `4` 结束；开启但没给 goal 会以 `5` 结束；任务已存在时照常认领，并忽略这次传入的 goal。`--no-create` 保留同步提示但停用认领时建卡。
`--window` 只是下次检查的提示，不是定时器：它只影响 `next_check_after`，并在下一次 `atb` 调用或代理回合边界使用。示例：`atb auto on --window 5m`。

## 可视化看板

`atb board` 会在 `http://127.0.0.1:7788` 提供只读页面，并尝试用默认浏览器打开。使用 `--no-open` 只打印地址，或使用 `--port 0` 自动选择本机空闲端口。

服务只绑定 `127.0.0.1`。页面打开或刷新时才读取 `.atb/board.json` 与 `.atb/config.json`；没有后台定时器，也没有写入接口。

```sh
atb board --port 7788 --no-open
```

手动安装使用同一个自门控区块。将它加入你选择的 agent 规则文件，并把 `<nonce>` 换成随机唯一值：

```markdown
<!-- atb:begin protocol:2 -->
AgentTaskBoard may track tasks in this project.
- If `.atb/board.json` does not exist in the current working directory, ignore this block entirely.
- If it exists: run `atb list --since <cursor>` when starting, or when now is later than `next_check_after`.
  Use `atb claim <slug> --actor <name>` to take one, and
  `atb done <slug> --actor <name> --evidence-kind commit|path|test --evidence-ref <ref>` to finish.
- If that claim exits 4 while auto mode is enabled, retry with `--goal`; the retry may create an agent task.
  Deliverable is optional for this claim-time registration, but never treat exit 4 as success.
- Exit codes are authoritative: 3 = owned by someone else, 4 = no such task, 7 = unconfirmed, 10 = workspace unusable.
  Never treat a non-zero exit as success.
- Never edit `.atb/` or any rule file by hand.
- Rule probe nonce: <nonce>
<!-- atb:end -->
```

手动目标是 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.zcode/AGENTS.md`、`~/.agents/AGENTS.md` 与 `$DSH_HOME/AGENTS.md`。Claude Code 可通过项目 `CLAUDE.md` 的一行 `@AGENTS.md` 加载项目 `AGENTS.md`。

开发时可直接执行 CLI：

```sh
node bin/atb.js --help
```

## 快速开始

```sh
mkdir demo
cd demo
atb init
atb doctor
atb add --slug first-task --project demo --goal "建立第一个任务" --deliverable "README.md" --stage design
atb claim first-task --actor builder
atb list --since 0
atb done first-task --actor builder --evidence-kind path --evidence-ref "."
```

每个命令都接受 `--workspace <path>`，默认使用当前目录。工作区根目录存为 `workspace_ref`；`working_subdir` 保持相对路径，让任务定义仍然容易阅读。

## 任务模型

| 字段 | 意义 |
| --- | --- |
| `id` | 任务的稳定 UUID |
| `slug` | 方便人阅读的唯一引用 |
| `project` | 项目标签 |
| `goal` | 必填的预期成果描述 |
| `workspace_ref` | 这个本地看板使用的项目根目录 |
| `working_subdir` | 相对于 `workspace_ref` 的可选任务目录 |
| `deliverables` | 必填的产物路径或命令 |
| `stage` | 自由文本阶段，例如 `design`、`impl`、`verify` |
| `status` | `todo`、`claimed` 或 `done` |
| `owner` | 成功认领任务的 actor |
| `outcome` | `atb done` 记录的结果 |
| `origin` | `atb add` 为 `user`，认领时自动创建为 `agent` |
| `spec_revision` | 任务定义版本，从 `1` 开始 |

## 命令

| 命令 | 行为 |
| --- | --- |
| `atb init` | 在工作区根目录创建 `.atb/board.json`，可重复执行。 |
| `atb doctor` | 检查 Node.js、工作区可写性、看板协议与残留锁定。 |
| `atb rules install` | 预览、逐项确认、备份并安装自门控 agent 规则。 |
| `atb rules status` | 显示已安装规则、协议、区块哈希与 nonce。 |
| `atb rules uninstall` | 只移除管理的规则区块并保留备份。 |
| `atb doctor --rules` | 验证看板与新的 agent 返回的 nonce。 |
| `atb auto` | 显示或变更工作区层级的自动认领与同步提示。 |
| `atb add` | 新增含目标、工作区引用、产物与阶段的任务。 |
| `atb claim` | 认领任务；自动模式可在提供 `--goal` 时创建任务。 |
| `atb done` | 由 owner 完成已认领任务并记录证据。 |
| `atb list` | 显示 `--since` 之后的任务与事件，可用 `--origin` 筛选。 |
| `atb board` | 在 `127.0.0.1` 提供只读本地任务看板。 |

## 退出码

| 退出码 | 意义 |
| --- | --- |
| `0` | 成功 |
| `3` | 认领冲突：任务已有其他 owner 或已完成 |
| `4` | 找不到任务，或在 `init` 前查询自动状态 |
| `5` | 命令或参数无效 |
| `6` | 看板不存在、被锁定或无法使用 |
| `7` | 完成操作被拒，因为 actor 不是 owner |
| `8` | 看板状态损坏或协议版本不支持 |
| `9` | 任务 slug 重复 |
| `10` | 工作区或工作目录不存在或不可写 |

内部设计笔记不放在公开仓库。

## 本地状态

运行时状态位于 `<workspace>/.atb/`，仓库的 `.gitignore` 已排除它。命令以 `.atb/lock` 序列化写入；读取使用最近一次落盘的看板快照。一致性口径是单机写入线性化，读取在下一个命令或代理回合边界最终可见。

## 授权

MIT，见 [LICENSE](LICENSE)。
