# ccdw

[英語版](README.md)

## 概要

このリポジトリは、現在手元で使うCodexエージェント関連ファイルと
Dynamic Workflows拡張機能の実装を管理しています。

Dynamic Workflowsは、作業目的を手元の宣言的な作業手順実行に変換します。
作業手順の仕様、実行状態、追記型の処理記録、作業成果物を保存し、
承認、実行、状態確認、再開、取り消しができるようにします。

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

`docs/local` は、一時的な手元の文書、動作確認の出力、作業用成果物の置き場です。
このディレクトリ内のファイルは、永続的なプロジェクト文書として扱わないでください。

## Dynamic Workflows

Dynamic Workflows拡張機能は `plugins/dynamic-workflows` にあります。

各実行ディレクトリには次のファイルが作成されます。

- `workflow.yaml`: YAML互換のJSON作業手順仕様。
- `run.json`: 現在の実行状態の記録。
- `events.ndjson`: 追記型の処理記録と監査記録。
- `artifacts/`: 構造化された作業結果と合成出力。

現在の実装は、毎回同じ結果になる手元の実行処理を使います。これにより、入れ子の
Codex実行を起動せずに、状態遷移、承認の関門、処理記録、再開経路、
取り消し、MCPの操作口、形式定義の検証をテストできます。

## 必要環境

- ESM対応のNode.js。
- 拡張機能のテストスクリプトを実行するためのnpm。

現在のテスト一式ではパッケージインストールは不要です。

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

リポジトリルートから手元の作業手順実行を作成します。

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js plan \
  --objective "Review this repository" \
  --workspace "$PWD" \
  --json
```

`plan` コマンドは `run_dir` を返します。以降のコマンドではその値を使います。

## 実行コマンド

実行を計画します。

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js plan \
  --objective "Review this repository" \
  --workspace "$PWD" \
  --json
```

承認ゲートを通して実行します。

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js run \
  --run-dir "<run_dir>" \
  --approve \
  --json
```

状態を確認します。

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js status \
  --run-dir "<run_dir>" \
  --json
```

一時停止中の実行を再開します。

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js resume \
  --run-dir "<run_dir>" \
  --json
```

完了していない実行を取り消します。

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

- 承認待ちの実行ディレクトリ作成。
- 承認の強制。
- 手元の作業実行の成功。
- 終了状態の実行に対する `resume` の挙動。
- 未終了の実行の取り消し。
- CLIのplan/runのJSON出力。
- 拡張機能のファイル配置検証。
- MCPの初期化、ツール一覧取得、計画作成。
- LFのみのMCP標準入出力ヘッダー。
- Codexの改行区切りJSONによるMCPメッセージ形式。

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

MCPの操作口は、Dynamic Workflows実行の計画作成、承認、実行、
再開、状態確認、取り消し、検証のための機能を公開します。

## 手元の成果物

初期設定の作業手順実行は `.codex-dynamic-workflows/runs` に書き込まれます。
この経路はリポジトリの `.gitignore` で無視されます。

開発中または挙動検証中に役立つ手元のメモ、動作確認の出力、一時レポートには
`docs/local` を使います。

## 問題への対処

`run` が承認エラーで失敗する場合は、`--approve` を渡すか、先に実行を承認してください。

実行ディレクトリの検証に失敗した場合は、次を確認してください。

- `workflow.yaml`
- `run.json`
- `events.ndjson`
- `artifacts/` 配下のタスク結果ファイル

MCPの起動に失敗する場合は、コマンドが `plugins/dynamic-workflows` から実行されているか、
`.mcp.json` の `cwd` が拡張機能のルートになっているか確認してください。

## 開発メモ

- Dynamic Workflows拡張機能はCodex `/goal` から独立させる。
- 副作用は実行ディレクトリと手元の成果物に閉じる。
- 場当たり的なテキスト解析より、構造化JSON成果物を優先する。
- 作業手順の状態遷移、MCPメッセージ形式、形式定義の検証の挙動を変更する場合は、テストを追加または更新する。
