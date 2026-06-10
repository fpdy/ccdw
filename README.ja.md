# ccdw

[英語版](README.md)

## 概要

このリポジトリは、現在手元で使うCodexエージェント関連ファイルと
Dynamic Workflows拡張機能の実装を管理しています。

Dynamic Workflowsは、作業計画を本物の `codex exec` または `claude -p`
サブエージェントで実行する手元の宣言的な作業手順実行に変換します。呼び出し側エージェントがWorkflowSpec
(JSON) を書き、実行プログラムがそれを検証し、上限を超えたら安全側で停止する
予算管理のもとでタスクを並列スケジュールします。作業手順の仕様、実行状態、
追記型の処理記録、作業成果物を保存し、承認、実行、監視、再開、取り消しが
できるようにします。

この拡張機能はCodex組み込みの `/goal` の処理の流れとは意図的に分離されています。
`/goal` に組み込んだり置き換えたりしません。付属スキルを使うか、実行プログラムを直接実行してください。

## リポジトリ構成

```text
.
├── AGENTS.md
└── plugins/
    └── dynamic-workflows/
        ├── .codex-plugin/plugin.json
        ├── .mcp.json
        ├── README.md
        ├── package.json
        ├── schemas/
        ├── scripts/
        ├── skills/
        └── tests/
```

ccdwが管理する手元の状態ファイルと生成成果物は、初期設定では `.ccdw/` に保存されます。
保存先を変えるには `CCDW_HOME` を設定します。相対パスはワークスペースルートから解決されます。

## Dynamic Workflows

Dynamic Workflows拡張機能は `plugins/dynamic-workflows` にあります。

各実行ディレクトリには次のファイルが作成されます。

- `workflow.yaml`: 作業手順仕様 (JSON)。
- `run.json`: 現在の実行状態の記録 (単一の書き込み主体がロックで保護)。
- `events.ndjson`: 追記型の処理記録と監査記録。
- `artifacts/`: 構造化された作業結果と試行ごとの生出力。

実行処理は3種類組み込まれています。

- **codex実行**: `kind` が `codex` で始まるタスクは `codex exec` の
  子プロセスとして実行されます。JSONLイベントストリーム、スキーマで強制した
  構造化出力、`workspace_policy` から導出したサンドボックス (仕様で書き込みを
  許可しない限り読み取り専用)、プロセスグループへの段階的シグナルによる
  タスク単位のタイムアウト、実行予算へのトークン使用量の計上を行います。
  バイナリは `CCDW_CODEX_BIN` で差し替えられます。
- **claude実行**: `kind` が `claude` で始まるタスクはClaude Codeの
  `claude -p` の子プロセスとして実行されます。stream-jsonイベントストリーム、
  同じスキーマで強制した構造化出力、`workspace_policy` から導出した
  OSサンドボックス (仕様で書き込みを許可しない限り読み取り専用)、周囲の設定と
  カスタマイズの除外、実行予算へのトークン使用量の計上を行います。
  バイナリは `CCDW_CLAUDE_BIN` で差し替えられます。周囲の設定を除外するため、
  `apiKeyHelper` による認証はworkerには使えません (代わりに
  `ANTHROPIC_API_KEY` を設定してください)。ユーザー設定の `model` も
  適用されないため、タスクの `model` フィールドを使ってください。claudeタスクを
  含む作業手順では `workspace_policy.network:true` は計画時に拒否されます。
- **ローカル実行**: `local_*` のタスク種別は毎回同じ結果になる手元の実行処理で、
  既定テンプレートとテスト一式が使います。LLMセッションは起動しません。

スケジューラはフェーズ/タスクDAG上のready-queueです。依存が満たされたタスクから
`max_concurrency` まで並列に実行し、`max_tokens`、`max_duration_ms`、
`max_agents` を超えたら安全側で停止します。タスク単位の再試行ポリシー
(`retryable`、`max_attempts`、`backoff_ms`) も適用されます。
Workflowの `phase_id` と `task_id` は
`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` に一致する必要があります。成果物の
書き込み先も解決後に検証されるため、タスクID経由で実行ディレクトリ内の
`artifacts/` の外へ書き出すことはできません。

承認サマリには、実際に強制されるworkerサンドボックスが表示されます。workerは
`workspace_policy.write_scope` に `"workspace"` が含まれない限り読み取り専用で
実行されます。networkはcodexタスクのworkspace-writeモードでのみ対応します。
`workspace_policy.shell:true` と `workspace_policy.mcp_write:true` は、現在の
worker起動では強制できないため実行側が拒否します。

## 必要環境

- ESM対応のNode.js。
- 拡張機能のテストスクリプトを実行するためのnpm。
- codexタスクを使う作業手順では、PATH上の `codex` CLI。
- claudeタスクを使う作業手順では、PATH上の `claude` CLI (2.1.x以降)。

テスト一式ではパッケージインストールは不要です。codex実行とclaude実行は同梱の
擬似バイナリでテストされます。

## はじめに

拡張機能のテストを実行します。

```bash
cd plugins/dynamic-workflows
npm test
```

拡張機能のファイル配置を検証します。

```bash
cd plugins/dynamic-workflows
npm run validate -- --json
```

リポジトリルートから、呼び出し側が作成した作業手順を計画します。

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js plan \
  --spec-file my-workflow.json \
  --workspace "$PWD" \
  --json
```

`plan` コマンドは `run_dir` と `approval.summary` (フェーズ、タスクごとの
プロンプト、強制されるサンドボックス、予算、仕様ハッシュ) を返します。
以降のコマンドでは `run_dir` を使います。`--spec-file` なしの `plan --objective "..."` は
固定のローカルテンプレート (動作確認用) を計画します。

## 実行コマンド

実行を作らずに仕様だけ検証します。

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js plan \
  --spec-file my-workflow.json --dry-run --json
```

承認ゲートを通してバックグラウンドで実行します (codex/claudeの
サブエージェントタスクでは推奨)。

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js run \
  --run-dir "<run_dir>" \
  --detach \
  --approve \
  --max-tasks 4 \
  --json
```

`--max-tasks` は0以上の整数で、その数のタスクを起動したところで実行を一時停止します。
`plan --force --run-id <id>` は、実行中でない既存の実行ディレクトリを作り直します。
稼働中のorchestrator lockがある場合は置き換えを拒否します。

状態を確認します (軽量で、ポーリングしても安全)。

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js status \
  --run-dir "<run_dir>" \
  --json
```

新しいイベントだけを差分取得します。

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js events \
  --run-dir "<run_dir>" \
  --since-offset 0 \
  --json
```

実行を一覧します。

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js list \
  --workspace "$PWD" \
  --json
```

一時停止中・異常終了した実行を再開し、失敗した実行を再試行します。

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js resume \
  --run-dir "<run_dir>" \
  --resume-failed \
  --json
```

完了していない実行を取り消します (実行中の場合は制御チャネル経由で
オーケストレータがworkerを停止します)。

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js cancel \
  --run-dir "<run_dir>" \
  --reason "No longer needed" \
  --json
```

実行ディレクトリを検証します。

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js validate \
  --run-dir "<run_dir>" \
  --json
```

## テスト

`plugins/dynamic-workflows` から実行します。

```bash
npm test
```

現在のテストは次を確認します。

- 承認待ちの実行ディレクトリ作成。呼び出し側作成の仕様、`--dry-run` 検証、
  依存循環の拒否、安全なphase/task ID、再試行ポリシー検証、runIdの
  パストラバーサル拒否を含む。
- 承認の強制と手元の作業実行。
- ready-queueスケジューラ (宣言順が依存順と異なるフェーズ、並列実行の重なり、
  安全側で停止するトークン予算、タスク単位のタイムアウト、不正な
  `maxTasks` の拒否)。
- 同梱の擬似codexバイナリによるcodex実行 (JSONL解析、thread id記録、
  スキーマ違反の隔離、再試行ポリシー)。
- 同梱の擬似claudeバイナリによるclaude実行 (実行処理の振り分け、
  終了コード0でも `is_error` なら失敗とする判定、構造化出力のスキーマ違反の
  隔離、一箇所での予算計上、networkの計画時拒否)。
- 実行中の取り消し (制御チャネル経由) と計画済み実行の取り消し。
- バックグラウンド実行と異常終了からの再開 (`--resume-failed` を含む)、
  および強制再計画時の古い状態削除。
- 実行一覧 (`list`) とイベント差分取得 (`events`)。
- CLIのJSON出力と拡張機能のファイル配置検証。
- MCPの初期化、ツール一覧取得、計画作成、`isError` によるツール失敗応答、
  LFのみの標準入出力ヘッダー、Codexの改行区切りJSONメッセージ形式。

## MCP連携

拡張機能には `plugins/dynamic-workflows/.mcp.json` にMCPサーバー設定があります。

設定されたサーバーは拡張機能のルートから起動します。

```json
{
  "command": "node",
  "args": ["./scripts/dynamic-workflows-mcp.js"],
  "cwd": "."
}
```

MCPの操作口は、計画作成 (呼び出し側作成の `spec` オブジェクト対応)、承認、
実行 (既定でバックグラウンド開始し即座に返答。状態はポーリング)、再開、
状態確認、実行一覧、イベント差分取得、取り消し、検証のための機能を公開します。
ツールの失敗は `isError` 付きの結果として返されるため、呼び出し側モデルは
タイムアウトせずに対処できます。

## 手元の成果物

初期設定の作業手順実行は `.ccdw/dynamic-workflows/runs` に書き込まれます。
この経路はリポジトリの `.gitignore` で無視されます。

ccdwが管理する手元の状態ファイルの保存先を変えるには `CCDW_HOME` を設定します。
Dynamic Workflowsは `<CCDW_HOME>/dynamic-workflows/runs` に実行を保存します。
CLIの `--run-root` またはMCPの `runRoot` を明示した場合は、その実行では `CCDW_HOME` より優先されます。

## 問題への対処

`run` が承認エラーで失敗する場合は、`--approve` を渡すか、先に実行を承認してください。

実行ディレクトリの検証に失敗した場合は、次を確認してください。

- `workflow.yaml`
- `run.json`
- `events.ndjson`
- `artifacts/` 配下のタスク結果ファイル

バックグラウンド実行が止まって見える場合は、実行ディレクトリの `runner.log` と
`status --json` を確認してください (`runner.active` がオーケストレータの生存を
示します)。オーケストレータが死んだ実行は `resume` で復旧できます。

MCPの起動に失敗する場合は、コマンドが `plugins/dynamic-workflows` から実行されているか、
`.mcp.json` の `cwd` が拡張機能のルートになっているか確認してください。

## 開発メモ

- Dynamic Workflows拡張機能はCodex `/goal` から独立させる。
- 副作用は実行ディレクトリと手元の成果物に閉じる。
- 場当たり的なテキスト解析より、構造化JSON成果物を優先する。
- `run.json` の書き込み主体はオーケストレータのみとする。他のプロセスは
  `control/` のシグナルファイルと `orchestrator.lock` の生存確認で連携する。
- 作業手順の状態遷移、スケジューリング、実行処理、MCPメッセージ形式、
  形式定義の検証の挙動を変更する場合は、テストを追加または更新する。
