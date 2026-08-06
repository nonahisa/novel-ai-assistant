# VSIX Worktree Exclusion Design

## 背景

リポジトリ直下のcheckoutからv0.0.2を生成したところ、`.gitignore`済みの`.worktrees/`がVSIXへ入り、24,523ファイル・91MBとなって検証が失敗した。`.gitignore`はGit追跡だけを制御し、VSIXの収録対象は`.vscodeignore`で別に除外する必要がある。

## 方針

`.vscodeignore`へ`.worktrees/**`を追加する。既存のパッケージ処理、許可ファイル検証、製品コード、テスト期待値は変更しない。パッケージ前にworktreeを削除する案は環境依存かつ破壊的で、allowlist stagingへ作り替える案は今回の修正として過大なため採用しない。

## 検証

隔離worktree内へ`.worktrees/package-sentinel/DO_NOT_SHIP.txt`を作り、実際の`vsce ls --no-dependencies`で変更前に混入すること、変更後に除外されることを確認する。その後、全CIゲート、VSIX生成、VSIX隔離検証を実行し、8ファイルだけを含む`local.novel-ai-assistant@0.0.2`になることを受け入れ条件とする。
