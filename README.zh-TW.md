# AgentTaskBoard（Agent 任務看板）

**AgentTaskBoard（Agent 任務看板）是給程式代理使用的本機任務看板與裁決 CLI。看板由單一寫入者生成，不即時推送，也不進行跨機器同步。**

一張任務只有一個 owner。`atb claim` 以可判定的退出碼決定 owner，而 `atb list --since` 為每個代理提供下一回合可用的穩定 delta 游標。

## 狀態

這個倉庫包含 `v0.1.0` 的 Node.js 骨架，實作 `init`、`add`、`claim`、`done`、`list` 五個命令。它沒有 Web 面板、Obsidian 依賴、常駐程序、網路服務或跨機器同步。

## 需求

- Node.js 20 或更新版本
- 建議使用 Git 追蹤專案原始碼，並讓本機 `.atb/` 狀態留在版本控制之外

## 安裝

```sh
npm install -g .
atb --version
```

在專案中由 `atb init` 建立看板後，`atb doctor` 會在執行任務命令前檢查本機執行環境、工作區、看板、協定與鎖定狀態。

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
| `spec_revision` | 任務定義版本，從 `1` 開始 |

## 命令

| 命令 | 行為 |
| --- | --- |
| `atb init` | 在工作區根目錄建立 `.atb/board.json`，可重複執行。 |
| `atb doctor` | 檢查 Node.js、工作區可寫性、看板協定與殘留鎖定。 |
| `atb add` | 新增含目標、工作區引用、產物與階段的任務。 |
| `atb claim` | 由一個 actor 認領任務，第二個 actor 會以退出碼 `3` 失敗。 |
| `atb done` | 由 owner 完成已認領任務並記錄證據。 |
| `atb list` | 顯示目前任務，以及 `--since` 游標之後的事件。 |

## 退出碼

| 退出碼 | 意義 |
| --- | --- |
| `0` | 成功 |
| `3` | 認領衝突：任務已有其他 owner 或已完成 |
| `4` | 找不到任務 |
| `5` | 命令或參數無效 |
| `6` | 看板不存在、被鎖定或無法使用 |
| `7` | 完成操作被拒，因為 actor 不是 owner |
| `8` | 看板狀態損壞或協定版本不支援 |
| `9` | 任務 slug 重複 |
| `10` | 工作區或工作目錄不存在或不可寫 |

詳細欄位規則見 [docs/DESIGN.md](docs/DESIGN.md)，機器協定見 [docs/PROTOCOL.md](docs/PROTOCOL.md)。

## 本機狀態

執行期狀態位於 `<workspace>/.atb/`，倉庫的 `.gitignore` 已排除它。命令以 `.atb/lock` 序列化寫入；讀取使用最近一次落盤的看板快照。一致性口徑是單機寫入線性化，讀取在下一個命令或代理回合邊界最終可見。

## 授權

MIT，見 [LICENSE](LICENSE)。
