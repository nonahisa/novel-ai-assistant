# 推敲（P-10）漢字ひらきの測定台

答え付きの作り物作品。`answers.json` に、当て字・ひらくべき語・ひらいてはいけない語（罠）・本動詞（罠）の出現数を実測で記録してある（`grep -o` で数えて合わせた）。

**数え方**：`ateji`・`mustOpen` の各語は、`results[].accepted[]`（`reason` が「漢字ひらき」）の `original` にその語が含まれ、かつ `suggestion` にその語の読み（ひらがな）が含まれていれば「拾った」。`suggestion` が空なら「出たが提案なし」。`mustNotOpen`・`verbTraps` は、`original` にその語が含まれ `suggestion` でひらかれていれば「誤検出」。

このリポジトリの `test/fixtures/mcp-work` と人称・世界観を合わせてある（設定/plot.md・設定/characters/ は写し）。**このフォルダーは推敲P-10の測定専用**で、他のテストからは使わない。
