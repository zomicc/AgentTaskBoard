# AgentTaskBoard（Agent 任務看板）

**AgentTaskBoard（Agent 任務看板）是給程式代理使用的本機任務看板與裁決 CLI。看板由單一寫入者生成，不即時推送，也不進行跨機器同步。**

一張任務只有一個 owner。`atb claim` 以可判定的退出碼決定 owner，而 `atb list --since` 為每個代理提供下一回合可用的穩定 delta 游標。

## 狀態

這個倉庫包含 `v0.1.0` 的 Node.js 骨架，實作 `init`、`doctor`、`rules`、`auto`、`add`、`claim`、`done`、`list`。它沒有 Web 面板、Obsidian 依賴、常駐程序、網路服務或跨機器同步。

## 需求

- Node.js 20 或更新版本
- 建議使用 Git 追蹤專案原始碼，並讓本機 `.atb/` 狀態留在版本控制之外

## 安裝

```sh
npm install -g .
atb --version
```

在專案中由 `atb init` 建立看板後，`atb doctor` 會在執行任務命令前檢查本機執行環境、工作區、看板、協定與鎖定狀態。

## 接入你的 agent

`atb init` 不會修改 agent 規則檔。先執行 `atb rules install --dry-run` 查看每個目標檔案與行數變化，再執行 `atb rules install` 逐項確認。管線或其他非 TTY 環境會印出計畫並以 `7` 結束，不會等待輸入；確認後才使用 `--yes`。

自動安裝器會先將每個檔案備份為 `<name>.bak-<timestamp>`，只替換 `atb:begin` 與 `atb:end` 之間的區塊，並把已安裝目標記錄在使用者資料目錄。用 `atb rules status` 檢查，`atb rules uninstall --yes` 移除。`atb doctor --rules` 會先確認看板存在；沒有 `--expect` 時印出挑戰並以 `7` 結束。向新的 agent 詢問規則探針 nonce，再執行 `atb doctor --rules --expect <agent-answer>`；相符時以 `0` 結束。

## 自動模式

自動模式是選擇性啟用且只屬於目前工作區。`atb init --auto` 或 `atb auto on` 啟用，`atb auto off` 停用，`atb auto status` 顯示 `enabled`、`window_minutes`、`create_allowed` 與 `next_check_after`。
啟用後，`atb claim <slug> --actor <name> --goal "..."` 會在 slug 不存在時建立 agent 來源任務。自動模式關閉時，缺少任務會以 `4` 結束；開啟但沒給 goal 會以 `5` 結束；任務已存在時照常認領，並忽略這次傳入的 goal。`--no-create` 保留同步提示但停用認領時建卡。
`--window` 只是下次檢查的提示，不是定時器：它只影響 `next_check_after`，並在下一次 `atb` 呼叫或代理回合邊界使用。範例：`atb auto on --window 5m`。

手動安裝使用同一個自門控區塊。將它加入你選擇的 agent 規則檔，並把 `<nonce>` 換成隨機唯一值：

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

手動目標是 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.zcode/AGENTS.md`、`~/.agents/AGENTS.md` 與 `$DSH_HOME/AGENTS.md`。Claude Code 可透過專案 `CLAUDE.md` 的一行 `@AGENTS.md` 載入專案 `AGENTS.md`。

開發時可直接執行 CLI：

```sh
node bin/atb.js --help
```

## 快速開始

```sh
mkdir demo
cd demo
atb init
atb doctor
atb add --slug first-task --project demo --goal "建立第一個任務" --deliverable "README.md" --stage design
atb claim first-task --actor builder
atb list --since 0
atb done first-task --actor builder --evidence-kind path --evidence-ref "."
```

每個命令都接受 `--workspace <path>`，預設使用目前目錄。工作區根目錄存為 `workspace_ref`；`working_subdir` 保持相對路徑，讓任務定義仍然容易閱讀。

## 任務模型

| 欄位 | 意義 |
| --- | --- |
| `id` | 任務的穩定 UUID |
| `slug` | 方便人閱讀的唯一引用 |
| `project` | 專案標籤 |
| `goal` | 必填的預期成果描述 |
| `workspace_ref` | 這個本機看板使用的專案根目錄 |
| `working_subdir` | 相對於 `workspace_ref` 的選填任務目錄 |
| `deliverables` | 必填的產物路徑或命令 |
| `stage` | 自由文字階段，例如 `design`、`impl`、`verify` |
| `status` | `todo`、`claimed` 或 `done` |
| `owner` | 成功認領任務的 actor |
| `outcome` | `atb done` 記錄的結果 |
| `origin` | `atb add` 為 `user`，認領時自動建立為 `agent` |
| `spec_revision` | 任務定義版本，從 `1` 開始 |

## 命令

| 命令 | 行為 |
| --- | --- |
| `atb init` | 在工作區根目錄建立 `.atb/board.json`，可重複執行。 |
| `atb doctor` | 檢查 Node.js、工作區可寫性、看板協定與殘留鎖定。 |
| `atb rules install` | 預覽、逐項確認、備份並安裝自門控 agent 規則。 |
| `atb rules status` | 顯示已安裝規則、協定、區塊雜湊與 nonce。 |
| `atb rules uninstall` | 只移除管理的規則區塊並保留備份。 |
| `atb doctor --rules` | 驗證看板與新的 agent 回傳的 nonce。 |
| `atb auto` | 顯示或變更工作區層級的自動認領與同步提示。 |
| `atb add` | 新增含目標、工作區引用、產物與階段的任務。 |
| `atb claim` | 認領任務；自動模式可在提供 `--goal` 時建立任務。 |
| `atb done` | 由 owner 完成已認領任務並記錄證據。 |
| `atb list` | 顯示 `--since` 之後的任務與事件，可用 `--origin` 篩選。 |

## 退出碼

| 退出碼 | 意義 |
| --- | --- |
| `0` | 成功 |
| `3` | 認領衝突：任務已有其他 owner 或已完成 |
| `4` | 找不到任務，或在 `init` 前查詢自動狀態 |
| `5` | 命令或參數無效 |
| `6` | 看板不存在、被鎖定或無法使用 |
| `7` | 完成操作被拒，因為 actor 不是 owner |
| `8` | 看板狀態損壞或協定版本不支援 |
| `9` | 任務 slug 重複 |
| `10` | 工作區或工作目錄不存在或不可寫 |

內部設計筆記不放在公開倉庫。

## 本機狀態

執行期狀態位於 `<workspace>/.atb/`，倉庫的 `.gitignore` 已排除它。命令以 `.atb/lock` 序列化寫入；讀取使用最近一次落盤的看板快照。一致性口徑是單機寫入線性化，讀取在下一個命令或代理回合邊界最終可見。

## 授權

MIT，見 [LICENSE](LICENSE)。
