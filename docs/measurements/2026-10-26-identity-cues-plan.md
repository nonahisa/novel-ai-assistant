# 手順書：事実の照合で体と心の組（憑依・入れ替わり）を照合する（作者の裁定 2026-10-25「体と心の組も」）

設計担当（Plan）の案を母艦が写したもの（2026-10-26）。作者の判断（末尾）が付いたら implementer へ渡す。作りは移動の照合（2026-10-26-travel-ai-cues-plan.md・`core/travelCues.ts`）に揃える。

## 1. いまの照合器がしていること・製品の道で空なもの
- 照合器はある：`findIdentityDrift`（同じ体で、隣り合う2場面の人格や身分が遷移の記録なしに変わったら「状態」の候補）と、`findPostDeathAppearances` の遷移による除外（幽霊・転生・憑依が死亡より後にある人物を外す）。働くのは単体テストの中だけ
- 製品の道は `transitions: []`・`scenes: []` で呼んでいる（`checkFactContradictions.ts` 754行付近・`mcp/tools/factContradiction.ts` 579行付近）。製品で効くのは、宿り（`Character.dwellings`）から作る印 `afterlives` による死亡後の除外だけ
- 埋もれている穴：`findIdentityDrift` は候補の左右に `scene.source` を入れるが、`candidateSidesOf` は `factById` でしか引かないので、事実の id でなければ候補が黙って消える。照合器は同居（第17話から文佳の心も戻る）を表せない（2人の心が行き来するたびに遷移が要る）
- P-37 は憑依の場面の事実の主語を、体の持ち主と心の側のどちらにも付けうる。区間の照合（一人称・口調）で誤検出になるおそれ

## 2. AI に抜かせるもの（P-37 は変えない。新しいプロンプト P-53「場面の体と心」）
- `src/prompts/sceneMindExtract.ts`、`SCENE_MIND_EXTRACT_VERSION` "1.0"。割当 `factExtract`、温度0、think:false、num_ctx 明示、スキーマ。控えは `feature: "scene_mind_extract"`、鍵はチャンクのハッシュ・宿りの組の一覧の指紋・プロバイダ・モデル・版
- 送るのは、宿りの組（心と体）の名前か別名を含むチャンクだけ。作者の宿りの記録が組の候補を決め、AI は自由に誰の心かを決めない
- スキーマ `{minds:[{body, mind, evidence, line}], transitions:[{kind, body, toMind, evidence, line}]}`。mind は閉じた選択肢（体の持ち主・宿る心・分からない）。kind は `IDENTITY_TRANSITION_KINDS`。maxItems を置き、同じ数を文面にも書く
- 検算（`core/identityCues.ts`）：引用がチャンクにそのまま在る（行は引用で探す）／名前が台帳の組に引け、体と心が別人／「分からない」と見本と同じ値は捨てる（見本は本文に出ない名前）／遷移は引用が「」の外のときだけ（台詞の「まるで別人」で除外が効かないように）
- 身分（偽名・変装）は扱わず、identityId は bodyId と同じ

## 3. 照合器への渡し方
- `runIdentityCues` を `src/core/identityCues.ts` に（vscode・node: に依存しない。拡張機能と MCP は `ask` を渡すだけ。`runTravelCues` と同じ形）
- AI なし：`dwellingLinks`／`findDwellingBody` で宿りを id に結ぶ（結べない宿りは捨てる）。宿りから遷移を作る（fromChapter に possession、untilChapter の次の話に switch〔toPersona＝体の持ち主〕）
- AI：P-53 で場面の組と本文の遷移を作り `MatchInput.scenes`／`transitions` へ
- 場面ごとに表示用の事実（id `scene:<話>:<行>:<n>`）を `factById`・`places` にだけ登録し、`facts` には入れない（「人格」の区間が二重に出るため）
- 挙げる：宿りの話の範囲の外で別の心が体にいる／宿りの組に無い第三の心／遷移の描写も記録も無いのに人格が変わる
- 除く：宿りの範囲の中の体の持ち主と心の行き来（同居）／引用で裏付けた幽霊・転生・憑依の遷移が死亡より後にある人物の死亡後の登場／回想／憑依の場面の中で体の持ち主の名で抜かれた心の項目（一人称・口調・性格）を区間の照合から外す
- 候補に `origin: "identity"`。確かめの段は `CONTRADICTION_VERIFY_IDENTITY_VERSION` 1.0 の文面を分け、控えの鍵 `1.2:identity1.0`。本命と future の文面・版は変えない（移動の照合は文面を分けるまで全件「作中の変化」で取り下げられていた）
- 完了報告（`describeFactRun`）と MCP の `stages.identity` に件数（心と体の記録 N組・訊いたチャンク・場面の読み〔捨てた数〕・本文の遷移・記録の無い組）
- 宿りの無い作品では AI を呼ばず、「心と体の記録が無いので体と心の照合はしていません（人物の編集の「心と体が別の人物」で記録してください）」

## 4. 設定資料への提案
- 宿りは提案しない（作者だけが付け外しする欄。6.5.13、`keepAuthorOnlyMarks`。承認待ちに置いても取り込みで落ちる）
- 完了報告で案内：「本文で別の心が入っている読み（第N話「引用」）が心と体の記録にありません」。作者のデータには書かない

## 5. テストと測定
- 再現テストを先に：製品と同じ入力（scenes・transitions が空）では体と心の食い違いが0件／場面の source が事実の id でない候補を `candidateSidesOf` が落とす
- 単体：宿りから遷移（結べない宿りは捨てる）／同居の範囲の行き来を出さない／P-53 の検算5種／検算を通った幽霊の遷移だけが死亡後の除外に効く／控えの鍵・browserReach・promptDocShape（P-53）
- 新しい台 `test/fixtures/seeded/contradiction-identity/`（6話・宿りの記録あり）。仕込み：①宿りの範囲が切れたあとの話で心が体の中で名乗る ②組に無い第三の心 ③遷移なしで死者が地の文に出る（既存の型が残ること）。罠：範囲の中の憑依の場面（一人称が違う）・同居の行き来・本文に幽霊の描写がある死者・回想の死者・台詞の「別人みたい」・変装の偽名。`identityCues.json` に手で書いた正しい答えと読み違えの答え。受け入れは仕込み3/3・罠0/6
- 実接続：`scripts/measure.mjs factContradiction` を gemma4:26b・e4b で（Ollama の札）。新しい台で見逃しと誤検出／既存の contradiction・contradiction-travel・contradiction-travel-ai の成績が変わらず誤検出0。記録 `docs/measurements/2026-10-2x-identity-cues.md`

## 6. 触るファイル
- 新規：src/prompts/sceneMindExtract.ts・src/core/identityCues.ts・新しい台・test/unit/core/identityCues.test.ts
- 変更：src/core/contradictionMatch.ts・factContradictionFlow.ts・factContradiction.ts・src/prompts/contradictionVerify.ts・src/features/checkFactContradictions.ts・src/mcp/tools/factContradiction.ts
- 文書：設計書 6.88.5／6.88.10／6.88.14（新設）・プロンプト設計書 P-53 と P-12b identity・実装の残り

## 7. 大きさ
implementer 3〜4回分（1：宿りから遷移・照合器の直し・P-53 と検算・単体／2：両方の道のつなぎ・場面の事実の登録・確かめの段の文面・新しい台と採点／3：実接続の測定と文書）

## 判断
- 母艦の判断：④確かめの段は identity 用の文面を分ける ⑤身分（偽名・変装）は今回扱わない
- 作者の判断（2026-10-26 昼）：①宿りの記録が無い作品は対象外にし案内だけ ②宿りの範囲の中の体の持ち主と心の行き来は指摘しない ③宿りは提案せず完了の知らせで案内 ⑥**憑依の場面で体の持ち主の名で抜かれた心の項目（一人称・口調・性格）は、心の側の人物へ付け替える**（設計担当の推奨「外す」ではない）。付け替えは、P-53 の場面の読みが検算を通り、その場面でその体に宿る心が1人に決まるときだけ行い、付け替えた事実には印を残して完了の知らせと候補の根拠で分かるようにする。決まらない場面（分からない・同居で2人）では付け替えず照合から外す
