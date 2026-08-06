# さくらAI Engine GitHub Actions スモークテスト設計

## 目的

GitHub Actions から、さくらのAI Engine の OpenAI互換チャット補完APIへ `gemma-4-31B-it` で最小の実リクエストを送り、認証・モデル提供・応答形式が利用可能であることを確認する。これは拡張機能の通常テストとは分離した外部サービスのスモークテストとする。

## 実行方式

- `.github/workflows/sakura-ai-smoke.yml` を `workflow_dispatch` 専用で追加する。push、pull request、schedule では自動実行せず、利用回数と外部依存による不安定化を避ける。
- Ubuntuランナーとリポジトリ同梱のNodeスクリプトを使い、`https://api.ai.sakura.ad.jp/v1/chat/completions` へBearer認証でPOSTする。
- モデルは `gemma-4-31B-it`、非ストリーミング、低い最大出力トークン数に固定する。
- HTTP 200、OpenAI互換の `choices[0].message.content` が空でないこと、レスポンスのモデル情報が存在することを成功条件とする。
- ジョブの権限は `contents: read`、タイムアウトは5分とする。

## Secretと安全性

アカウントトークンはリポジトリの Actions Secret `SAKURA_AI_ACCOUNT_TOKEN` からだけ渡す。ローカル `.env` はGitとVSIXの両方で除外し、テストはトークン、Authorizationヘッダー、完全なAPI応答をログへ出さない。Secretが未設定、認証失敗、レート制限、応答形式不正の場合は、秘密情報を含まない理由とHTTPステータスだけを表示して失敗する。

## テスト方針

API呼び出し処理は依存注入できる小さなNodeモジュールとし、実装前に偽レスポンスによる成功、Secret欠落、HTTP失敗、空応答の単体テストを追加する。ワークフローは構文、手動トリガー、最小権限、Secret参照、固定モデルを静的検査する。最後にGitHub上で手動実行し、実サービスの成功を確認する。

## 完了条件

単体・静的テストと既存リリースゲートが成功し、GitHub Actions の手動実行が `gemma-4-31B-it` の非空応答で成功すること。公式仕様は [さくらのAI Engine 利用手順](https://manual.sakura.ad.jp/cloud/ai-engine/02-howto.html) を正とする。
