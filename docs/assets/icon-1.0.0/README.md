# 1.0.0 で切り替える共通アイコン

作者の依頼（2026-10-18）で作った新しいアイコン。紺の地に、生成り色のキーボードと万年筆、ペン先から伸びる緑の芽。ペン先は左から 38.2% の線、左右の葉の大きさは 1:1.618（黄金比）。統合小説執筆環境・ヘルパー・Discord の共通アイコンにする。

**配布物で切り替えるのは 1.0.0 を出すとき**（作者の裁定 2026-10-18）。それまで `media/icon.png`・`media/icon.svg` は今のまま。Discord（サーバーのアイコン・ボットのアバター）は先に使っている。

- `icon-color.svg`：色つき。`icon-16〜1024.png` はこれを Edge で書き出したもの
- `icon-mono.svg`：アクティビティバー用の1色・塗りだけ（`media/icon.svg` の差し替え先。test/unit/cross/icon.test.ts の決まりを満たす）
- `icon-discord.svg`・`icon-discord-1024.png`：丸く切り抜かれる場所用の余白つき版（Discord 計画セッションが作った）

切り替えるとき：`icon-256.png` を `media/icon.png` へ、`icon-mono.svg` を `media/icon.svg` へ写す。CHANGELOG と README の画像も合わせる。
