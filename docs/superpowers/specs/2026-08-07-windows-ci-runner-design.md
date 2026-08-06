# Windows CI Runner Design

## 背景

`main` の CI run 31131301410 は Ubuntu 上で `npm run ci` を実行し、Windows パスを安全性要件として扱う単体テスト 269 件中 25 件が失敗した。同じマージコミットを Windows で実行すると、単体テスト 269 件、品質・カバレッジ、VS Code 1.90.0 統合テスト 5 件、依存監査がすべて成功する。

## 選択肢

1. **CI を Windows に合わせる（採用）**: 利用者・開発環境とパス安全性テストの前提を一致させる最小変更。既存の全リリースゲートをそのまま実行できる。
2. テストを全面的に OS 非依存へ変更する: 将来の複数 OS 対応には有効だが、永続化・競合保護テストの再設計が必要で v0.0.2 の修正範囲を超える。
3. Windows と Ubuntu のマトリクスにする: Ubuntu 側の既知の不一致が残り、リリースゲートを緑にできない。

## 設計

`.github/workflows/ci.yml` の `quality` ジョブを `windows-latest` で実行する。Windows では X virtual framebuffer が不要なため、`npm run ci`、`npm run package:vsix`、`npm run verify:vsix` を直接呼ぶ。トリガー、Node.js 22、権限、concurrency、15 分のタイムアウトは変更しない。

製品コード、テスト期待値、Sakura AI の手動 workflow、Secret、原稿・作者データの処理には変更を加えない。

## 検証

変更前の失敗証拠は main の Ubuntu CI、変更前の成功基準は同一コミットの Windows `npm run ci` とする。変更後はローカルで全リリースゲートを再実行し、非ドラフト PR の GitHub Actions が Windows runner で成功することを受け入れ条件とする。マージ後の main CI も成功してから v0.0.2 を公開する。
