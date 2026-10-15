# T3 Code 日本語カスタム版

[T3 Code](https://github.com/pingdotgg/t3code) を元に、日常利用向けの変更を加えた非公式の日本語版です。上流の T3 Tools Inc. とは独立して配布しています。

**Mac用アプリは [Releases](https://github.com/meguta12/t3code-japanese/releases/latest) からダウンロードできます。**

## この版の変更

- 設定やメニューを含む日本語UI。
- フォルダと会話をまとめたサイドバー、セッションのトークン使用量、アカウント使用量の表示。
- 別モデルへのタスク委譲、委譲先スレッドへの追加指示、右の「エージェント」パネルでのタスク表示。
- チャット内の画像・動画・音声表示、HTMLプレビュー、コマンドを可視ターミナルで実行する操作。
- ソケット設定の EINVAL による終了への対処と、Antigravity の割り込み後の再開処理。

委譲は設定の「エージェントの委譲」をONにして使います。「実装をClaudeへ委譲して、結果を回収して」のように依頼してください。親が委譲できるタスクは同時に最大3件で、子タスクからの再委譲はできません。作業フォルダを共有するため、同じファイルを同時に変更する担当は分けてください。

## Macで使う

配布版は **Apple Silicon（arm64）、macOS 13以降** が対象です。Intel Mac、Windows、Linux用の日本語カスタム版バイナリは用意していません。

1. [最新版の配布ページ](https://github.com/meguta12/t3code-japanese/releases/latest) から `T3-Code-Japanese-0.0.44-ja.6-mac-arm64.zip` をダウンロードして展開します。
2. `T3 Code 日本語版.app` を「アプリケーション」フォルダへ移します。
3. 初回はアプリを右クリックして「開く」を選びます。macOSにブロックされた場合は「システム設定 → プライバシーとセキュリティ」の表示を確認してください。この配布物はAppleの公証を受けていません。
4. 自分のPCで認証済みのプロバイダーを選び、作業するフォルダを追加します。

配布物に作者の会話、プロジェクト登録、個人設定、APIキー、ログイン情報は含めていません。初回は各自のデータで始まります。すでにこの日本語版を使っているPCでは、そのPCに保存された既存データを使います。

日本語版のデータ保存先は `~/Library/Application Support/T3 Code 日本語版/runtime` です。配布版の上流向け自動更新は無効です。更新はこのリポジトリのReleasesから取得してください。

## AIの準備

少なくとも1つのプロバイダーをインストール・認証してから使ってください。プロバイダーの利用契約は各自で必要です。

- [Codex CLI](https://developers.openai.com/codex/cli): インストール後に `codex login`。
- [Claude Code](https://claude.com/product/claude-code): インストール後に `claude auth login`。
- ほかの対応プロバイダーについては [インストールガイド](docs/user/install.md) を参照してください。

作者のAI設定やスキルは同梱していません。委譲の利用可否は、各自のプロバイダー設定と認証状態にも依存します。

## ソースから起動

Node.js 24（`package.json` の対応範囲）と Vite+ の `vp` が必要です。

### Install vp

[Vite+ の導入手順](https://viteplus.dev/guide/) に従って `vp` をインストールします。

```sh
git clone https://github.com/meguta12/t3code-japanese.git
cd t3code-japanese
vp i
vp run dev --home-dir "$PWD/.t3"
```

ターミナルに表示されるペアリングURLを開きます。デスクトップの開発起動は `vp run dev:desktop --home-dir "$PWD/.t3"` です。

公開ソースはローカル版のコミット `74ca6e3e` を元にした、過去のGit履歴を含まないスナップショットです。起動案内としてこのREADMEを差し替え、作業用の `REPO-NOTES.md` と上流向けの `.github/workflows/` を除外しています。製品コードは元のコミットと同じです。

配布アプリには日本語版用のアプリ名、保存先の分離、自動更新の無効化も適用しています。通常の開発起動や上流のパッケージ処理だけでは、配布アプリと同一の外装にはなりません。既存の日本語版を使うメンテナー向けの更新処理は `scripts/update-japanese-app.py` にあります。

## 検証範囲

今回の公開前に、サーバー側の委譲・宛先解決・ソケット対処71件と、Web側の委譲・トークン表示34件を実行しました。配布アプリの同梱サーバーは空のデータ領域でHTTP起動し、過去の会話がないことを確認しています。別のMacでのインストール、GUI全体、全プロバイダーの接続は未検証です。

## ライセンスと元プロジェクト

MIT License。元プロジェクトの著作権表示は [LICENSE](LICENSE) に保持しています。

- 元プロジェクト: [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
- 利用ガイド: [docs/user](docs/user)
- 開発ガイド: [docs/operations/development.md](docs/operations/development.md)
- 同梱依存物の表記: [オープンソースライセンス](docs/user/open-source-licenses.md)
