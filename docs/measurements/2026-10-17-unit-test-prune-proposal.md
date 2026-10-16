# 単体テストから「消してよいテスト」の案（2026-10-17・途中版）

`test/unit` の 1,205 ファイル・20,088 件（`10c447ca` で数えた）を走査し、消してよい候補を洗い出した。**テストは1件も消していない。** 消すかどうかは作者が選ぶ。

- **途中版である。** 9つに分けて走査したうち8つの結果が入っている。**ai と prompts と mcp（133ファイル）はまだ載っていない**（担当が走査中のまま、本体が報告を締め切った）
- **本体が自分で開いて確かめたのは、表で「本体が確かめた」と書いた件だけ**（recheckProposal・modelTuningLookup・bm25Memory）。ほかは担当が両方のテストを開いて比べた報告をそのまま載せた。消す前に1件ずつ開いて確かめること
- 区分：**A 重なる**（同じ関数の同じ振る舞いを別の件が確かめている）／**B 古い**（もう無い物や道を見張っている、または常に通る）／**C ソースの文字を読むだけ**（同じことを動きで確かめるテストが既にある）
- 「全部消してよさそう」は、残す側が同じ入力で同じ値を確かめているものだけにした。部分的に重なるだけのもの、作者の報告の再現テスト同士が重なるもの、裁定の番人は「1件ずつ見てほしい」へ回した
- 走査では全 it の本文までは読んでいない。名前の一覧と、import する関数が同じテストを機械的に突き合わせ、重なりそうな組だけ両方を開いて入力と期待値を比べた

## 全体の傾向（先に結論）

**消せる件数は少ない。** 走査した1,072ファイルで、確信をもって消せるのは59件、1件ずつ見る候補を足しても132件（全体の0.7％）だった。理由は2つある。

1. **ほとんどのファイルが、作者の報告・日付・実機確認の番号が付いた再現テスト**だった（1,205ファイル中1,046ファイルの冒頭に、日付・「不具合」・「作者」・F-xx などの印がある）
2. 名前が同じでも、**調べると別の関数・別の層を見ている**ことが多かった（例：`settingsEdit` と `organization` と `customField` の「壊れていたら勝手に直さず止める」は、それぞれ別の読み取り関数）

**件数を減らすより、書き直して行を減らすほうが効く。** 同じ形の it が並ぶファイルと、前準備を写しているファイル群は多い（後の節）。直しのたびに増えていく重さには、こちらのほうが効く。

## 件数

| まとまり | A | B | C | 計（件） |
|---|---|---|---|---|
| 全部消してよさそう | 49 | 2 | 8 | **59** |
| 1件ずつ見てほしい | 44 | 24 | 5 | **73** |
| 計 | 93 | 26 | 13 | **132** |

ファイルまるごと消せるのは `cross/episodePlotNoOverwrite.test.ts`（4件）の1ファイルだけ。ほかは、ファイルの中の何件かを消す形になる。候補が出たファイルは約60。

担当の区切りごとの内訳（全部／1件ずつ）：core 前半 11／9、core 中ほど 3／5、core 後半の一 7／11、core 後半の二 4／1、features 前半 9／9、features 後半 4／2、cross 7／13、views と models 11／23、ai・prompts・mcp 未着。

## 消したあとの件数と時間の見込み

| 選び方 | 件数 | 実行時間（作者の環境で約80秒） |
|---|---|---|
| いま | 20,088 | 約80秒 |
| 「全部消してよさそう」だけ | 20,029 | ほぼ変わらない（1秒未満） |
| 「1件ずつ」もすべて通したとき | 19,956 | 約2〜3秒縮む見込み |

- 時間の大半は件数ではなく、少数のファイルが占めている。全件を JSON の記録つきで回したときの、ファイルごとの時間の合計（並列の担当の合計）は527秒。うち **`features/resolveDivergence.test.ts` 139秒、`features/handoffStartupFold.test.ts` 68秒、`cross/manuscriptRevealLine.test.ts` 31秒、`features/walkConflicts.test.ts` 26秒** で半分を超える
- **ソースの文字を読むテスト（184ファイル）が合わせて137秒**（26％）。src 全体を読み歩くものが重い。候補のうち `cross/smallModelNoticeRemoved.test.ts` だけで15秒あり、「1件ずつ」の縮みはほぼこのファイルの分
- 重いソース走査は、負荷がかかると時間切れで落ちる。今回、全件の実行で `cross/outputTokensWiring.test.ts` が1件、覆いを測りながらの実行で同じものと `cross/logTargetBeforeNotifyDone.test.ts` が1件ずつ落ちた（どちらも単体では通る作り）。`cross/thirdPartyNotices.test.ts` は作業場に `node_modules` が無いため落ちたもので、製品とは関係ない
- 行の覆い（coverage）は、src 全体を対象にした基準だけ取った（覆われた行 55,351）。**候補を外して取り直す比較はまだしていない。** ファイルまるごとの候補は区分Cの1ファイルだけで、これは src の行を実行しないので覆いは減らない。ファイルの中の何件かを消す候補は、外して測る手だてが無いため、言葉で「消すと失う見張り」を書いた

## 全部消してよさそう（59件）

| ファイル | テスト名 | 区分 | 残す側／根拠 | 消すと失う見張り |
|---|---|---|---|---|
| features/workChatPanelTruncated.test.ts | タイムアウトは、その場で直せる > 案内に「秒数を上げる」札が付く | A | features/workChatPanelTimeoutAdvice.test.ts「延ばす札を出し、チャンクの話はしない」（同じ失敗で同じ札を見て、文の中身まで見ている） | なし |
| features/recheckProposal.test.ts | 再チェックの口（3件） | A | features/proposalPanelContradictionRecheck.test.ts「矛盾の描画に、再チェックの口がある」（同じ3つの文字列を、矛盾の描画の範囲に絞ってより厳しく見る。本体が両方を開いて確かめた） | なし。今の3件は HTML 全体を探すので、誤字脱字側だけ欠けても気づけず、元から見張れていない |
| core/modelTuningLookup.test.ts | 台帳への書き込み > 作者が手で書いた、読めない欄・知らない欄を落とさない | A | core/modelTuningSave.test.ts「読めない欄・知らない欄は、そのまま残る」（本体が確かめた。注の「生の中身を土台にする」理由は残す側へ移す） | 既にある欄を上書きしながら知らない欄を残す組み合わせ（残す側は新しい欄を足す形）。ほぼ同じ |
| core/modelTuningLookup.test.ts | 台帳への書き込み > 欄を消しても、ほかの欄は残る | A | core/modelTuningSave.test.ts「`undefined` を渡すと、その欄だけ消える」（本体が確かめた） | なし |
| core/nameRename.test.ts | 提案パネルの適用経路に、そのまま乗る > target は必ず original の中にある | A | 同じファイル「1件ずつの適用（個別確認変換）が全件通る」（target が original に無ければ失敗に数える。入力も同じ） | なし |
| core/plotDoc.test.ts | 書き出し（テンプレート） > 埋める欄を並べない | A | core/plotTemplate.test.ts「空欄を並べない」 | なし |
| core/plotDoc.test.ts | 書き出し（テンプレート） > 自由に書いてよいことを書く | A | core/plotTemplate.test.ts「自由に書いてよいと書く」（こちらが広い） | なし |
| core/plotDoc.test.ts | 書き出し（テンプレート） > 使える見出しの名前は載せる | A | core/plotTemplate.test.ts「使える見出しの名前は、案内に全部載せる」（全項目を見る） | なし |
| core/procedureSelect.test.ts | 規則を変えても崩してはいけないこと > 緩めた先でも、創作の相談には手順書きを渡さない | A | core/procedures.test.ts「合うものが無ければ渡さない」（同じ4文・同じ呼び方。注にも「procedures.test.ts が見張っている4件」とある） | なし |
| core/procedureSelect.test.ts | どこを取りこぼすか > 誤検出も取り違えも、いまは0件 | A | 同じファイル「いま：当たり22・見逃し4・取り違え0・誤検出0」 | なし |
| core/pathInside.test.ts | 以前の写し（startsWith 型）が誤っていたこと > 「..下書き」を外と誤判定していた | B | 同じファイル「「..」で始まる名前のフォルダーは、中にある」（同じ入力を製品の関数で見る）。消す側は、製品に無い昔の写しを自前で作って false を見ているだけ | なし |
| core/sceneMemo.test.ts | 読者向けの出力とAIから消す > 投稿用にコピー：メモは投稿されない | A | core/postingConvert.test.ts「シーンメモは、どちらの経路でも落ちる」（出力を完全一致で見る） | なし |
| core/tuningCeiling.test.ts | 断りの書き方を揃える > 書ける長さの時間切れも、括弧書きのまま | A | core/tuningStats.test.ts「時間切れ混じりの実測には、その印を残す」（入力も期待値も同じ） | なし |
| core/tuningOutputChars.test.ts | 書ける長さの字数 > 時間切れだけのときは、これまでどおり | A | 同上 | なし |
| core/tuningCeiling.test.ts | 天井の印が、設定から表まで届く > `true` はこれまでどおり読める | A | core/tuningOutputChars.test.ts「天井の印が読めている」 | なし（`false` を見る隣の件は残す） |
| core/tuningCeiling.test.ts | 天井の印が、設定から表まで届く > `true` の行には、これまでどおり出る | A | core/tuningOutputChars.test.ts「設定から読んだものを表にすると、断りが全部出る」 | なし |
| core/bm25Memory.test.ts | 含む語で引ける／一致が無い文書は返さない／件数の上限を守る（3件） | A | core/retrieval.test.ts の同名3件（同じ `Bm25Index.search` の同じ振る舞い。本体が両方を開いて確かめた）。bm25Memory はメモリーの再現テストなので、メモリーと「空の索引・空の質問」の件は残す | なし |
| cross/episodePlotNoOverwrite.test.ts | （ファイル全体 4件） | C | features/episodePlotCreate.test.ts「既にあれば、1文字も変えずにそのまま開く」（既存のファイルを置いて実際に呼び、1文字も変わらない・開く・知らせ・ファイルが増えない、を見る） | 「create_ という文字がソースにあること」だけ |
| cross/epubDoesNotTouchManuscript.test.ts | EPUB は本文へ触れない > 口述筆記は、触れるかわりに履歴へ残す | A | cross/dictationHistory.test.ts「適用に成功したら編集履歴を残す」（同じ文字列を見て、書く順序まで見る） | なし |
| cross/manuscriptWriteAudit.test.ts | 本文を書く経路 > 口述の整文も、履歴を通す（0.40.8） | A | 同上 | なし |
| cross/manuscriptWriteAudit.test.ts | 本文を書く経路 > 改行を揃えるのも、履歴を通す（0.50.6） | A | core/eolUnifyHistory.test.ts「書き込みが通ったときだけ残す」ほか（動きで、順序・失敗時・元の値まで見る）。core 前半の担当も同じ結論 | なし |
| core/contextProbeTokens.test.ts | 指示文に雛形を残さない > 合言葉そのものは、これまでどおり user 側にだけ置く | A | core/contextProbe.test.ts「合言葉は user 側にだけ置く」 | なし |
| core/chunkMerge.test.ts | 確保するコンテキスト長 > モデルの上限は超えない | A | core/contextStep.test.ts「モデルの上限は超えない」 | なし |
| core/chunkMerge.test.ts | 確保するコンテキスト長 > 短いプロンプトでも4096は確保する | A | core/contextStep.test.ts「下限4096は保つ」 | なし |
| core/contradictionSendVolume.test.ts | 既定は2話ぶん引き継ぐ（測った値） | A | core/contradictionMaterial.test.ts「既定は2話ぶん引き継ぐ」 | なし |
| core/contradictionSendVolume.test.ts | 送る量の言い方 > 本文と、それ以外を分けて言う | A | cross/contradictionConsentVolume.test.ts「同じ本文を重ねて送らないなら、「のべ」と言わない」（同じ数から同じ文） | なし |
| core/editHistory.test.ts | 編集者モードで使える操作 > 原稿の受け渡しに要るものは開く | A | core/editorMode.test.ts「原稿を受け取り、直したものを返すために要るものは開く」 | なし |
| core/charCount.test.ts | stripRuby の定義は1つ > charCount.ts は ruby.ts のものを読んでいる | C | 同じファイル「同じ関数が返る」（動き） | import の書き方だけ |
| core/charCount.test.ts | stripRuby の定義は1つ > charCount.ts に写しの定義が戻っていない | A | 同じファイル「実体を持つのは ruby.ts だけ」（src/core 全体を見る） | なし |
| core/episodeCharCount.test.ts | 数え方の置き場所 > 作品一覧（scanner）は countEpisodeChars を通す | A | core/episodeCharSingleSource.test.ts「数え方の源は1つ」の2件 | なし |
| core/episodeCharCount.test.ts | 数え方の置き場所 > 原稿エディタも同じ関数を通す | A | 同上 | なし |
| core/aiInstructions.test.ts | 指示書の中身 > 本文は1つで、違うのは頭の数行だけ | A | 同じファイル「4つの相手ぶんを置くと、本文は同じで頭の数行だけが違う」（実際に書き出して見る） | 純関数の側で落ちたときに原因を絞る手がかり |
| features/firstRun.test.ts | Ollamaを選んで、つながらなかったとき > セットアップの案内へ繋ぐ | C | ai/registry.test.ts「Ollamaにつながらなければ、セットアップの案内へ繋ぐ」（動き） | なし |
| features/plotModePanelAdvice.test.ts | 書き込みの道 > 書いてある項目を置き換えるときは、モーダルで確かめてから書く | C | features/plotAdvice.test.ts「作者の書いた項目を置き換えるときは確認し、断られたら書かない」 | なし |
| features/plotModePanelAdvice.test.ts | 書き込みの道 > 送るときは何も書かない | C | features/plotAdvice.test.ts「会話の文と書き込み案を並べ、案は何も書かない」 | なし |
| features/measureContext.test.ts | 残高切れ・鍵の失効も数えない | A | 同じファイル「数えてよいのは bad_response と unknown だけ」（13種別の表） | なし |
| features/measureContextTokens.test.ts | 反映しなければ、延ばした待ち時間は元へ戻る | A | features/measureContextTuning.test.ts「反映しなければ、元の待ち時間へ戻す」 | なし |
| features/measureContextTokens.test.ts | 台帳に待ち時間が無いモデルでも、測り直しの最中に欄を作らない | A | features/measureContextTuning.test.ts「元から欄が無かった台帳は元どおり空に戻る」 | なし |
| features/chatterService.test.ts | 本文の感想 > AIが仕事中なら取りに行かない | A | 同じファイル「黙るとき > AIが仕事中なら話さない」（同じ分岐） | なし |
| features/epubEditorPanelPreview.test.ts | 素材置き場の下のフォルダーの画像も当たる | A | core/characterIconLookup.test.ts「素材の下のフォルダーの絵も当たる」 | なし |
| features/exportEpubNotices.test.ts | 素材の下のフォルダーの画像も入る | A | 同上 | なし |
| views/workChatPanelStaged.test.ts | JavaScriptとして読める | A | views/workChatPanelLarge.test.ts「どちらもJavaScriptとして読める」 | なし |
| views/chatPanelChatter.test.ts | スクリプトがJavaScriptとして読める | A | 同上 | なし |
| views/writingStatsCelebration.test.ts | スクリプトがJavaScriptとして読める | A | views/writingStatsPanelHtml.test.ts の同名の件 | なし |
| views/notify.test.ts | 実行前の確認 > Escで閉じられたら false | A | views/confirmInTopPicker.test.ts「閉じられたら false」 | なし |
| views/confirmInTopPicker.test.ts | 作品名を渡すと、題の頭に作品名が出る | A | views/notify.test.ts「作品名を渡すと、確認の文の1行目（窓の題）に出る」（全文一致で包む） | なし |
| views/actionList.test.ts | 更新告知文の置き場所 > 「投稿脱稿 → 広報支援」に「更新SNS告知文作成」が並ぶ | A | 同じファイル「告知の入口の場所（F-48）」の同じ場所の件 | なし |
| views/menuVisible.test.ts | 分類は10で、この順に並ぶ | A | views/actionList.test.ts「分類は決めた順に並ぶ」 | なし |
| views/menuVisible.test.ts | 見出しを挟まない分類は、中身がちょうど1つの操作 | B | 直前の件が「その分類は無い」と言い切っているので、空の並びを回して常に通る | なし |
| views/viewVisibility.test.ts | 印の名前は、`package.json` の式に実在する | A | 同じファイルの「相談だけ落ちる」「ほかが全部落ちる」の2件（名前が無ければ通らない） | なし |
| models/characterAppellations.test.ts | 無関係な2人は候補にしない | A | 同じファイル「肩書きが同じだけの別人は候補にしない」（より厳しい入力） | なし |
| models/book.test.ts | 登場人物一覧は、選ばないかぎり本へ入らない | A | 同じファイル「題名だけ渡せば、残りは既定で埋まる」（toEqual に同じ値） | なし |

（3件まとめた行と4件まとめた行があるので、行の数と件数は合わない。件数は59）

## 1件ずつ見てほしい（73件）

| ファイル | テスト名 | 区分 | 残す側／根拠 | 迷う点・消すと失う見張り |
|---|---|---|---|---|
| features/proposalPanelEditorColumn.test.ts | ソースのどこにも、下段を前へ出す呼び出しが残っていない | C | 同じファイル「下段のビューへフォーカスを移さない…」（動き） | 動きのテストは結果を出す道しか通らない。`src/extension.ts` など別の呼び元から戻ったら気づけなくなる |
| features/targetReader.test.ts | 狙いが無ければ、AIへ行かずに止め、紙も作らない | A | features/targetSheetAdvice.test.ts「狙いが無ければ、AIを呼ばずに止める」 | 入口経由で失敗が返ることと、紙が1枚も置かれないこと。「紙を作らない」だけに縮めて残す手もある |
| core/modelTuningMigration.test.ts | 引っ越したあと、設定は見ない > 書き込み先も設定ではない | A | core/modelTuningLookup.test.ts「保管庫のファイルへ書き、設定 novelai.modelTuning は触らない」（作者の報告 2026-09-18 の注つき） | なし。ただし引っ越しの文脈の見張りとして読む人がいるかどうか |
| core/nameRename.test.ts | 本文の置換の計画 > 同じ行に同じ名前が2回出ても、2件目を1件目の位置に化けさせない | A | 同じファイル「同じ行に2回出ても、両方が正しい位置に当たる」（実際に当てて結果を見る） | 計画の段階で位置が 0 と 3 になることだけを見る点 |
| core/epubPackage.test.ts | 目次の見出しの形 > 番号・題を持たない話は heading のまま | A | 同じファイル「numberLabel・title を渡さなければ、従来どおり heading を出す」 | 書き出した目次に heading が出るところ |
| core/epubPackage.test.ts | 目次の見出しの形 > numberOnly は番号だけ | A | 同じファイル「番号だけを選ぶと、題を落とす」 | numberOnly が目次まで届くこと（titleOnly と同じ配線なので実質なし） |
| core/kinsoku.test.ts | 行頭に置かない字 > 小さい仮名と長音は行頭に来てよい | A | 同じファイル「升目のゆるい側は変えない」 | 「ぁ」だけ。残す側に「ぁ」を足せば全部消せる |
| core/noteMarkdown.test.ts | 投稿用のコピーと同じ落とし方をする > シーンメモの行は落とす | A | core/postingConvert.test.ts「シーンメモは、どちらの経路でも落ちる」 | note 用の変換を単体で呼んだときの付箋落とし |
| core/noteMarkdown.test.ts | 投稿用のコピーと同じ落とし方をする > ルビは括弧書きになる | A | core/ruby.test.ts「ルビを「漢字（かんじ）」にする」 | note 用の変換が括弧書きの関数を呼び損ねる配線の崩れ |
| core/proofreadSuggestionCleared.test.ts | 「空文字」の書き写し | A | core/placeholderText.test.ts「「空文字」が本文へ書き込まれない」 | 確かめる値が違う（こちらは空にした理由の印まで見る）。2件を1件にまとめる案 |
| core/onyomiReading.test.ts | 修正案が音読みの熟語をひらいているか（3件） | A | core/proofreadValidation.test.ts「音読みの熟語はひらかない」の3件（同じ入力文を、検算の上で見る） | 判定関数だけが誤る場合。**どちらも作者の報告の再現**なので、寄せるなら理由を書いて |
| core/readerStatsPostingSite.test.ts | 数字でない作品ID・組み立てられないサイトは undefined | A | core/postingSiteUrls.test.ts「組み立てない」の4件 | 作品IDが空文字の場合だけ。残す側に1行足してから |
| core/runtime.test.ts | Node では、ブラウザ扱いしない | B | Node の上では常に通る（ファイルの注にも書いてある） | 条件が逆になる誤りだけ |
| core/runtime.test.ts | Nodeでは外部プロセスを起動できる扱いにする | B | 同上 | 同上 |
| core/runtime.test.ts | hostTag は、毎回呼んでも同じ値を返す | B | 値の形を見ていない | 毎回違う値になる退行。形の確認を足して残す手もある |
| core/procedureSelect.test.ts | 成績 > しきい値を2へ戻すと、当たりが22→12へ落ちる | B | 緩めた経緯の記録を数字で固定している。製品はその値で動いていない | 質問表を触るたびに数字の書き換えが要る、という保守の重さが消える |
| cross/workType.test.ts | 作品タイプ > これまでのタイプの読み取りは変わらない | A | core/workFormatBehavior.test.ts「形式の読み取り」（4つの入力とも同じ期待値） | なし |
| cross/extractCancelOutcome.test.ts | 確認画面で断ったら取りやめ | C | features/extractCharactersFlow.test.ts「確認で中止したら取りやめ（cancelled）を返す」 | なし。同じファイルのほかの件（競合確認・走行中の中止など）は動きのテストが無いので残す |
| cross/appliedFindingsOutboxNotes.test.ts | 本文に修正案が入っていない判断は並べない | A | core/appliedFindings.test.ts「本文に修正案が入っていない判断は読まない」 | 「採らない」の1行だけ残す側に無い。足せば全部消せる |
| cross/chapterProposalRepropose.test.ts | 章立ての提案を出し直す（3件） | A | core/proposalBuckets.test.ts「同じ分類へ足す」の3件 | こちらは F-66 の代わりの再現テスト。**決まりどおりなら逆に、一般側（proposalBuckets）を消す案もある** |
| cross/dictationClean.test.ts | 照合と WorkspaceEdit を通している（照合を見る2行） | C | 同じファイルの動きの3件 | なし。「ファイルへ直に書かない」の見張りは動きでは見られないので残す |
| cross/smallModelNoticeRemoved.test.ts | 知らせを出す部品のファイルが無い／src/ に %s が出てこない（6名）（計7件） | B | 作者の裁定（2026-10-10）で外した部品が戻らないかの番人。名前は製品のどこにも無い | 外した部品が戻っても気づけない（不具合ではなく裁定に反するだけ）。**このファイルは15秒かかる**。同じファイルの「いま在る作りの見張り」の件は残す |

| core/chunkMerge.test.ts | 実物のプロンプトからは、その字数と応答が入る大きさにする | A | core/contextStep.test.ts「必要な量を下回らない」＋「モデルの上限は超えない」 | 応答 8192・本文 30000 の組だけ |
| core/episodeCharSingleSource.test.ts | カクヨム形式の頭書きと後書きは、話の字数に入れない | A | core/episodeCharCount.test.ts の頭書き・合本の件 | 単話に後書きが付いた形と「【文字数】」の混入 |
| core/episodeCharSingleSource.test.ts | 設定で「外さない」にすれば、.md でも印まで数える | A | core/episodeCharCount.test.ts「設定で外さないと決めていれば .md でも外さない」 | こちらは傍点、あちらはルビ。傍点で効くことはこちらでしか見ていない |
| core/episodeParser.test.ts | 日付の名前は、話数ではなく日付として読む | A | core/datedEpisode.test.ts の2件 | 副題が null になること |
| core/aiInstructions.test.ts | 「開いて使う」の本文は、頭が付かない | A | 同じファイル「使い方の頭は、本文を1文字も変えない」（純関数） | 実際に書き出す道で頭が付かないこと |
| core/chatModelNotes.test.ts | 相談の行に案内を付ける対応が無い／案内の定数そのものが残っていない（2件） | B | 作者の裁定（2026-10-09）で外した定数の番人。名前はどこにも無い | 定数が戻る退行 |
| core/contextProbeTokens.test.ts | 申告どおり全部読めるなら、天井まで通る／公称値へ跳んで切られたら…（2件） | A | core/contextProbe.test.ts「二分探索」の2件 | トークンの伸びで判定する道でも同じになること |
| features/plotModePanelAdvice.test.ts | 節の差し替えは updatePlotMarkdown／本文と同じ書き戻しの口だけを通る（2件） | C | features/plotAdvice.test.ts「案をプロットに書く」の件 | 直に書く道が足されたときの見逃し（動きのテストは差し替えた道しか見ない） |
| features/measureContext.test.ts | 分あたりの上限は数えない／時間切れは数えない（2件） | A | 同じファイルの13種別の表 | なし。実機の注は表のコメントへ移す |
| features/measureContextTokens.test.ts | 「読めない」とは言わない | A | features/measureContext.test.ts「どの理由でも「読めない」とは言わない」 | 測定の通しで文面がその関数を通る配線 |
| features/chatterService.test.ts | 本文の感想 > 有料のAIでは取りに行かない | A | 同じファイル「有料のAIでは話さない」 | 感想だけが判定を迂回する将来の変更（課金） |
| features/chaptersFromHeadings.test.ts | 台帳が空でなければ立てない／見出しの無い作品では何も立てない（2件） | A | 同じファイルの通しの2件 | 関数単体での局所化 |
| features/epubEditorPanelPreview.test.ts | 別名と同じ名前の画像でも当たる | A | core/characterIconLookup.test.ts「別名でも引ける」 | 画面側が別名を索引へ渡す配線 |
| views/notify.test.ts | 確認の顔つき（3件） | A | views/confirmInTopPicker.test.ts の「閉じられたら false」「取り消しにくい操作の印」 | 試験用の部品側の判定の崩れ |
| views/actionList.test.ts | 「SNS告知設定」は「作品管理 → 作品別設定」にある | A | 同じファイル F-48 の件 | 広報支援にも同じ操作が残っていないこと |
| views/actionList.test.ts | メニューに `novelai.dev.*` は1件も残っていない | B | 名前は src にも package.json にも無い | 開発用の操作が紛れ込む不具合 |
| views/actionList.test.ts | F5でもストア版でも、同じ分類が並ぶ | A | 同じファイル「分類は決めた順に並ぶ」ほか | 描画の道で「テスト中」が戻る不具合 |
| views/actionList.test.ts | 「その他支援」はもう無い | B | views/menuVisible.test.ts の丸ごと写す件 | 小分類が戻る不具合 |
| views/actionList.test.ts | 投稿キットの入口の2件 | A | views/menuVisible.test.ts「組み直した並びを、丸ごと写す」 | 隠した操作が間に挟まった並び |
| views/stepMenu.test.ts | 実装できたものは、枠を外して実物に置き換える | B | 枠は今は空で、空を確かめるだけ | 枠が残る見落とし |
| views/stepMenu.test.ts | 段の説明が、いま作れるものと合っている | B | 古い文言が無いことを見るだけ | 古い文言へ巻き戻る不具合 |
| views/manuscriptEditorHtml.test.ts | 消した「読む」「並べる」の面（5件）と「色分けの凡例を出さない」（計6件） | B | 0.25.2 などで消した名前の不在確認 | 消した仕組みが部分的に戻る不具合 |
| views/manuscriptFootCheer.test.ts | 原稿エディターでは風船も花火も描かない | B | 原稿エディターに当該の仕組みが無い | 統計パネルの描画が紛れ込む不具合 |
| models/chapter.test.ts | 章を外しても、ほかの章は残る | A | models/removeChapterKeepsEpisodes.test.ts「台帳から、その章だけが落ちる」（F-60 の再現） | 先頭の章を外す入力。どちらを残すか人が決める |
| models/customField.test.ts | AIの提案を反映しただけなら作者確定にしない | A | core/settingsEdit.test.ts の同名の件（同じ関数、渡す項目だけ違う） | 追加項目を渡したときだけ効かない不具合 |
| models/postingEpisodeKey.test.ts | 同じ話を2度記録しても1件／パスの区切りは揃えて引く（2件） | A | models/posting.test.ts の同じ趣旨の2件 | 話単位の鍵のときだけ効かない不具合 |
| core/characterMerge.test.ts | 敬称違いを同一人物として扱い、呼び名を別名に残す | A | models/characterSplitFix.test.ts「⑨敬称違いを機械で寄せる」（A-18 の再現） | 短い名前（シル→シルさん）での敬称寄せ |

## まとめて書き直せば行が減るもの（件数は減らない）

**同じ形の it を表（`it.each`）にまとめられるもの**

- core/githubRepoRef.test.ts「リポジトリの指し方を読む」10件 → 読める／読めないの表2つ
- core/kinsoku.test.ts 行頭・行末・ぶら下げの約10件
- core/markFont.test.ts 11件（約120行が半分）
- core/epubXhtml.test.ts「空行の詰め方」3件
- core/readAloud.test.ts「声に渡す文字列」10件
- core/relativeTime.test.ts 11件
- core/redactUrl.test.ts 6件
- core/postingSiteUrls.test.ts「導けない形」4件と「組み立てない」3件
- core/printHtml.test.ts「読む紙の縦中横」8件
- core/scriptLines.test.ts 柱・ト書き・セリフの約14件
- core/notePreview.test.ts 8件
- core/predicateArity.test.ts 7件
- core/tateChuYoko.test.ts 21件
- core/textEdit.test.ts 12件
- core/setupRequest.test.ts「断る」約14件
- core/typoCheckScope.test.ts `shouldAskScope` 5件
- core/typoBenchFindings.test.ts 全角空白7件・句点抜け6件
- core/syncAllPlan.test.ts「置き場ごとの手順」10件ほか
- core/syncTarget.test.ts 11件
- core/suffixCandidate.test.ts 12件
- core/settingsRuby.test.ts 22件
- features/runRequestHandler.test.ts「確認も出さずに断る」10件
- features/proposalPanelSwitch.test.ts「表示を切り替えると、前の中身が消える」5件
- features/readerStatsNarouFun.test.ts 拒否側4件
- cross/providerOutputLimit.test.ts プロバイダ5つ×3種の15件（約180行）
- 未確認：core/gpuLoad.test.ts（36件）

**前準備の写しを共通の部品へ寄せられるもの**

- features の workChat* 8ファイルが `fakeView` を、6ファイルが `fakeAi` を写している
- features の proposalPanel* 12ファイルが `panelWithView`／`newPanel` を写している
- 「並べたコマンドが全部、詳細メニューに実在する」を4ファイル（core/procedures・processAvailability・proofreadingSuite・plotMode）が別々に書いている
- 保存ファイルの読み書き（無ければ空・壊れたJSONは止める・外で変わったら上書きしない・競合マーカー）を3ファイル（core/scheduleStore・postingStore・photoTranscribeRequestStore）が同じ形で書いている
- core/tuningCeiling と tuningOutputChars の `entry()`・`rowOf()`
- cross の setWorkKindStatusBar・writingStatsKindRefresh・workKindWiring（extension.ts の登録を切り出す関数）、renameCarriesAppearance・renameClosesManuscript
- features/readerStatsDailyChange と readerStatsKakuyomuDaily の前準備
- cross/dictationClean.test.ts の applyEdit の差し替え4か所 → beforeEach／afterEach
- **メモリ上のファイル置き場（`workspace.fs` の作り物）を、test/unit 全体で約121ファイルが自前で組んでいる**（features だけで約50〜60行の `installDisk` が13ファイル）。`support/` に共通の部品を1つ置くのが、保守の軽さではいちばん効く
- ソースから関数の本体を切り出す `bodyOf` が11ファイルに写されている → `support/` に1本
- 「答えを保留する警告」の前準備：features/gitSyncBehindNoWait と gitSyncDirtyPullNoWait（約60行がほぼ同じ）、handoffStartupNoWait・gitSyncWaitResend・autoResend も似る
- features/checkTyposTruncatedSplit と checkProofreadTruncatedSplit：同じ場面を機能違いで2回 → 機能を引数にした表
- features/exportEpubCollected と exportPdfCollected「合本は話ごとに章へ割る」の4観点 → 取り出し方だけ差し替える表
- **WebView 画面の定型**（nonce・CSP・埋め込みの印が残っていない・JavaScriptとして読める・バッククォート・タグの数）：views だけで約11ファイルが各自で書いている → 画面を作る関数を並べた1つの表で全部見る
- models/foreshadow（止まる7件）・storyFact（弾く5件）・timeline（壊れた設定8件）・book（作品フォルダの外を指せない6か所、null で断る十数件）→ 表
- 作者確定の印の対（organization・worldExtraction・customField に各2件）→ `describe.each`
- 小さな表：core/backupSite 10件・eolAudit 6件・endpointNotice 6件・emphasisToggle 9件・announcement 8件＋4件・bundledTuning 3件、features/manuscriptEditorMemoLine 5件・notationResult 7件・chunkSettingsDeclared 4件
- views/workTree* 5ファイルの provider の前準備、stepMenu と actionList の「開閉を覚える」の前準備

## 重なって見えたが残したもの（抜粋）

- 同名の「壊れていたら勝手に直さず止める」（settingsEdit／organization／customField）：それぞれ別の読み取り関数
- core/existingWorkFolderHome と newFolderHome：構成はそっくりだが別の関数で、返す起点が違う。どちらも実機の不具合の再現
- features/resolveDivergence と walkConflicts の同名の件：合流の結果と、見比べの返り値という別の層
- 区分Cに見えるソース読みの多く（登録の配線・呼ぶ順序・文言・静的importの禁止・src 全体の網）：同じことを動きで確かめるテストが無い
- core/redactSecrets と secretScanParity：後者が広いが、前者を消して失うものが少ないと言い切れず挙げなかった

## まだ見ていない範囲

- ai と prompts と mcp の133ファイル（担当が走査中のまま締め切った）。続ける場合は同じ決まりで走査し、この文書へ足す
- 走査した範囲でも、全 it の本文までは読んでいない。名前から重なりを拾えなかったものは漏れている。担当が「中身まで見ていない」と書いた大きなファイル：cross/composeFace（177件）・chatSettingsSync（48件）・chatProfilePrompts（42件）・writingStats（65件）、views/manuscriptEditorUnsent・Save・Keys・ClipboardMenu、epubEditorPanelHtml、relationGraphPanelHtml、settingsPanelLayout、features/epubEditorPanelPreview（88件）・extractCharactersFlow（64件）
- 候補を外して行の覆いを取り直す比較
