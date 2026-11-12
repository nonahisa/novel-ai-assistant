---
name: e2e
description: 画面の自動テスト（E2E。Playwright で本物の VS Code を画面の外で起こして押す）を書く・走らせる・直すときに読む。実機確認リストの「押して起きること」をテストへ移すとき、画面に出る不具合の再現テストを書くとき、配布前に画面を見張るときも。部品の一覧、1件の書き方、作者の画面を取らない決まり、片づけ、見張れないもの、落ちたときの読み方。
---

# 画面の自動テスト（E2E）

**作者の画面を触らずに「押して起きること」を確かめる道。** 本物の VS Code（既定 1.141.0。前の版で回すなら `NOVELAI_E2E_VSCODE=1.138.0`）を Playwright の Electron モードで画面の外に起こし、キー・クリック・右クリック・打ち込みを送る。設計書 6.113（土台）・6.114（広報の動画）が正。

**画面の確認はまずここで行う**（computer-use は作者の画面の前面を取れずに止まり、空の窓を作者の画面に出したため）。computer-use と違い、**打つ・キー・右クリック・修飾キーもできる。**

## いつ・どこで走らせるか

- **作者がこのパソコン（母艦）を使っている間は、ここで E2E を走らせない。** 起こした直後の窓が焦点を奪い、ほかのソフトも含めて日本語入力の変換が切れた（2026-10-04）
- 作者がいるあいだの E2E は**ノートPC（テスト環境のセッション）**で回す。担当は作業場の枝を push し、ノートPCに走らせてもらう。母艦で走らせてよいのは、作者が離れているとき（夜・外出中）と、作者が「走らせてよい」と言ったときだけ
- 担当は E2E を書いてよいが、走らせる前にリーダーへ確かめる。単体テスト・型検査・ビルドはいつでもよい
- 同時に走らせるのは1本だけ

## 走らせ方

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
npm run test:e2e                                   # 本番ビルド → 全件（1件ごとに VS Code を起こす。1件 5〜15秒）
npx vitest run --config vitest.e2e.config.mts test/e2e/<ファイル>.test.ts   # 1ファイルだけ（先に npm run build）
npm run typecheck:tests                            # 型（test/e2e/tsconfig.json も見る）
```

- **`npm run check` には入らない。** 画面に関わる変更をしたら、`check` のあとに自分で走らせる
- 窓を見ながら直したいときだけ `$env:NOVELAI_E2E_SHOW = "1"`（**作者の画面の前面に出る**ので、作者が作業中なら使わない）
- 遅い機械・狭い画面の落ち方を手元で写すなら `$env:NOVELAI_E2E_WINDOW = "1024x640"`（全件の窓の大きさ。ノートPCで毎回落ちた件はこの大きさと CPU の負荷で再現した）
- 同じ作業場で2本同時に走らせても、相手の VS Code は止めない（台帳に走りの親の PID を書く）。それでも窓の取り合いで揺れるので、数を数えるときは1本ずつ
- 吹き出し（タブの場所の表示など）がボタンに重なると押せない。押す前に `dismissWorkbenchHover`
- 版を替えるなら `NOVELAI_E2E_VSCODE`（`VSCODE_` で始めない——起動前に全部落とすため）

## 部品（`test/e2e/support/`）

| ファイル | 何をするか |
|---|---|
| `vscodeApp.ts` | `withVsCode(名前, 話の配列, 本体, 起こし方?)`——一時フォルダーに作品を作り、VS Code を画面の外で起こし、作品を登録して、終われば必ず止めて消す。失敗したら写真を `%TEMP%\novelai-e2e-screenshots\` に残す。`LaunchOptions` で settings・keybindings を足せる |
| `manuscriptFrame.ts` | 原稿エディター（WebView）の中：`openEpisode`・`placeCaretAfter`・`caretPosition`・`composeText`・`footText`・`selectionCollapsed`・`revealFlashLit`・`memoPanelFrame`。再読み込みのあと面を探し直す `waitForManuscriptFrame`、届かなかった字を作る `dropEditsToHost`（打った字の便だけを WebView の外側の枠で落とす）と `classOpen`・`rescueBarText` |
| `workbenchDom.ts` | **VS Code 本体の DOM に頼るのはここ1か所**：`readTabState`（列ごとのタブの名前・前に出ているか・未保存の印を読む唯一の口）・`editorGroupTabs`（列ごとのタブ）・`activateTab`（タブを押して前に出す）・`tabLocator`。**タブの名前を期待値と比べるときは `tabNameMatches`／`tabNamesInclude`／`countTabsNamed`**（拡張子のあり／なしのどちらでも当たる。`=== name` や `.includes(name)` で比べない）・`quickOpen`・`clearNotifications`・`dialogText`・`closeDialog`。版で壊れたらここだけ直す |
| `workbenchDom.ts` の続き | 選ぶ画面（QuickPick）：`waitForQuickPick`・`quickPickTitle`・`quickPickRows`・`pickQuickPickRow`・`toggleQuickPickRow`・`acceptQuickPick`（1.138 はチェック欄が `.monaco-checkbox`。決めるのは［OK］——チェックのあと Enter で戻る）。WebView を開いたあとの本体向けのキーは `pressWorkbenchKey`（焦点が iframe にあると本体のキー割り当てに届かない。ノートPCで落ちた） |
| `settingsFixture.ts` | 設定資料の見本（人物を製品と同じファイル名で置く）・設定資料パネルの面と一覧の読み取り |
| `LaunchOptions` の追加 | `globalState`（起こす前に `state.vscdb` へ書く。`node:sqlite`）・`prepareWork`（起こす前に作品フォルダーへ置く） |
| `sampleFinding.ts` | 校正の指摘の見本を `.aiwriter/findings.jsonl` へ製品と同じ形で置く（**AI を呼ばない**）。提案パネルを開くキー |
| `wait.ts` | `waitUntil`（条件が満たされるまで）・`holdsFor`（**起きないこと**を決めた時間見続ける。遅れて開く2枚目を拾う） |
| `fileSettle.ts` | 書き込みの途中を読まない。`saveAndSettle`（Ctrl+S のあと、**VS Code 本体の保存がいったん空にしてから書く**のが終わるまで待つ。保存の直後に「変わらない」を確かめる所で使う）・`readFileWhenPresent`／`readJsonWhenPresent`（**製品の書き戻しは退避→削除→作り直しで一瞬ファイルが無い**。その ENOENT だけ待って読み直す。`waitUntil` の中で素の `readFile` を使うと消えた瞬間に落ちる）。新しい中身を正の形で待つだけの所には要らない |
| `cleanup.ts`・`globalSetup.ts` | 起こした PID と一時フォルダーの台帳。1件ごとと走りの最初・最後に、**一時フォルダー名を引数に含むプロセスだけ**を木ごと止める |

## 1件の書き方

1. **見本の話は台本の中に書く**（`FixtureEpisode[]`）。作者の原稿・確認用コピーは使わない
2. `withVsCode` の中で：`openEpisode` で開く → キー（`page.keyboard.press`）・打ち込み（`keyboard.insertText`）・押す（`frame.locator(...).click()`）→ 確かめる
3. **確かめるのは、ファイル → 画面の順。** 本文が変わったかはファイルを読む（`\r\n` を `\n` に揃える）。画面はそのあと。**本文フォルダーを一覧で読むときは、書き込み途中の一時ファイル（`*.novelai-*.tmp`）を拾わない**（製品が保存の途中で一瞬置く）
4. **「起きない」ことは `holdsFor` で数秒見続ける**（2枚目のタブ・確認の窓・素のエディター）。一瞬だけ見て「無い」としない
5. 製品のコマンドを押すキーが無いときは、**使い捨ての keybindings.json に足す**（`LaunchOptions.keybindings`）。`ctrl+alt+shift+F1`〜`F12` は埋まった。足すときは `test/e2e` を `ctrl+alt+shift+` で検索し、使われておらず製品の `package.json` のキーとも重ならないもの（`ctrl+alt+shift+` と文字キーなど）を選ぶ
6. **キーは Mac でも通る形で押す**（2026-11-06）：VS Code 本体のキーは `ControlOrMeta+…`（`Control+…` と決め打ちしない）。Mac の割り当てが Cmd＋同じキーでない本体のキー（文書の頭・末、エディターを閉じる）と、**製品のキー（package.json の割り当て）は `support/keys.ts` を通す**（`productKey("novelai.xxx")`・`OPEN_SCENE_MEMOS_PRESS` など。製品のキーを外す `-` の行は `productKeybinding`）。使い捨ての `ctrl+alt+shift+…` は Mac でも Control なので `Control+…` のまま
7. 冒頭のコメントに「何を見張るか」と設計書の節・作者の指示の日付を書く

## 守ること

- **製品にテスト専用の口を足さない。** キー割り当て・コマンドの引数・ファイルの見本で届かせる。届かないなら、まずリーダーへ（足すなら field-check の「届く道を足す」の線引きで）
- **作者の画面の前面を取らない。** 窓は画面の外・タスクバーに出さない・焦点を取らない（`vscodeApp.ts` の `keepOutOfTheWay`）。ここを崩す変更はしない
- **`Code.exe` を名前で止めない**（作者の VS Code まで落ちる）。止めるのは台帳の PID と一時フォルダー名だけ
- **走らせたあと、テスト用の VS Code が残っていないことを確かめる**：
  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -match 'novelai-e2e-' } | Measure-Object
  ```
  0 でなければ cleaner へ（残った黒い窓を作者に見つけられた）
- **AI・GitHub・課金のかかるものは呼ばない。** AI の結果が要るなら見本を置く
- **原稿エディターの下の段の字数は2回に分けて届く**（このファイル → 作品・今日）。数える前に、あとの分を待つ
- **裏に回った WebView の部品も locator は見つける。** 押す前に前に出ている面かを確かめる（`test/e2e/support/workbenchDom.ts` の `webviewLayer`）
- **タブの名前に件数が付く**（「提案（1）」）。名前は `tabNameMatches` で比べる
- **全件の中でだけ落ちるものは、単独で3回走らせてから揺れと決める**
- **偽の Ollama（`support/fakeOllama.ts`）を同じファイルの中の件で共有するときは、件の頭で `fake.requests` の数を控え、その件で増えた分だけを数える**（または件ごとに空にする）。前の件の呼び出しを数えて「確認の前に AI が呼ばれた」「名前の候補が並ぶ前に進んだ」と2件が取り違えて落ちた（2026-10-12。同じ形が announcementCopyButtons・episodePlotContrast・chatPanelsSync に残っている）
- **完了の知らせ（`notifyDone`）は右下でなくステータスバーに6秒だけ出る。** 待つときはステータスバーも見る（`support/workbenchDom.ts` の `statusBarTexts`）
- **落ちたテストを「やり直せば通る」で済ませない。** 1回目で落ちたなら、写真と文を読んで原因を書く（登録簿の消失は、4回に1回落ちる形で見つかった）
- **待ちで落とすときは、その時の様子を必ず失敗の文に添える**：出ている知らせ・確認の窓・選ぶ画面・前に出ているタブ・探した名前・送った中身。文が薄いと、離れた機械（ノートPC）で落ちたときに原因が読めず回し直しが重なる（2026-10-12）
- **製品の不具合で落ちたら、テストは落ちたまま残し、直さずに報告する**（直すのは implementer。テストは再現テストとして使う）

## 見張れないもの（作者の手に残す）

- **日本語入力の本物の変換**（字は確定した形で入る。IME の未確定の字・変換キー・半角英数の切り替えは届かない）
- ほかのアプリとのキーの取り合い（Notion の Ctrl+Shift+K など）
- **見た目の良し悪し**（並びや重なりは機械で測れるが、「読みやすいか」は作者）
- F5 の開発ホストそのもの
- AI を本当に呼ぶもの（MCP か `ai-bench` で測る）
- 拡張機能ホストの再起動をまたぐことは **1.138.0 では見張れない**（再起動の確かめの窓で［Restart Anyway］を押すと原稿のタブが閉じる）。1.141.0 なら見張れる——下の節

## 拡張機能ホストの再起動をまたぐ（1.141.0）

- 見本は `e2e/hostRestartDisconnect.test.ts`（つながりの切れたモーダル→再読み込み→打った字が入る／届かなかった字を［戻す］）
- 再起動の確かめの窓（Please confirm restart of extensions …）は出る。テストは［Restart Anyway］を押して進み、押したあともタブが残ることを確かめる
- 再起動のキーは `ctrl+alt+shift+r`（使い捨ての keybindings.json）。原稿を後ろへ回すのは新しい無題のファイル（`ctrl+alt+shift+n`）で（キーボード ショートカットの画面はタブでなく窓で開き、原稿が後ろに回らない）

## 実機確認リストへの反映

印の付け方（覆った項目・製品の不具合で落ちた項目）はスキル `field-check` の「画面の自動テストへ移す」の手順4が正。**テストの名前は、何を見ているか分かるように**付ける。

## 落ちたときの読み方

1. 失敗の文の「画面の写真: …」を開く（`Read` で絵が見られる）
2. `waitUntil` の文は「何を待って時間切れか」を名乗る。そこから押す前か後かを分ける
3. 作品の登録で落ちたら、**「登録簿に入っていません」は製品の不具合**（5.7.8 の再発）。それ以外は起動の遅れ
4. VS Code の版を上げたあとにだけ落ちるなら、まず `workbenchDom.ts`（本体の DOM の名前が変わる。1.141.0 ではタブの名前から拡張子が `.label-suffix` へ分かれた）
5. ノートPCで `backupDropFromExplorer` の Shift ありが「外へ出る動きを終えた」のあと40秒の上限で落ちるのは既知（Shift を押したあと合成のマウスの動きが引きずりに届かない、テストの道具の限界）。ノートPCで全件を回すときは `$env:NOVELAI_E2E_SLOW_DRAG = "1"` を付けて飛ばす。母艦では付けない（2026-11-04）

## 本物の AivisSpeech で流す（`test/e2e/real/*.real.ts`。2026-11-12）

実機確認リスト 48・49・74・80（読み上げ10文以上・遅さの知らせ1回・長い話の MP3 書き出し・本物のライセンスで止まらない）を、本物のエンジンで確かめる。**`test:e2e` の全件・`check`・CI・配布の検査には入らない**（名前が `*.real.ts`、設定が `vitest.real.config.mts`。環境変数 `NOVELAI_REAL_AIVIS=1` が無ければ飛ぶ）。本文は見本の話をテストの中で作る（作者の作品は読まない）。所要は CPU の機械で 48・74 が約4分半、49・80 が約32分。

- 先に AivisSpeech を起動しておく（127.0.0.1:10101）。`npm run test:e2e:real` が先にビルドする
- `ELECTRON_RUN_AS_NODE` を外す。`NOVELAI_REAL_AIVIS=1`。控えの置き場は `NOVELAI_REAL_OUT`
- 長いので機械を眠らせない。ノートPCは Modern Standby で本体が止まるため、**流す PowerShell と同じ窓で**先に指定する（呼んだスレッドの指定なので、別の窓では効かない。窓を閉じると外れる）：

```powershell
# Windows（PowerShell）
Add-Type -Namespace W -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[W.P]::SetThreadExecutionState(0x80000003) | Out-Null   # 0x80000000 継続 + 0x1 眠らせない + 0x2 画面も消さない
Set-Location <リポジトリ>
$env:ELECTRON_RUN_AS_NODE = $null
$env:NOVELAI_REAL_AIVIS = "1"
$env:NOVELAI_REAL_OUT = "$HOME\novelai-real-out"
npm run test:e2e:real
```

```zsh
# Mac（zsh）：caffeinate が、流している間だけ眠りを止める
cd <リポジトリ>
unset ELECTRON_RUN_AS_NODE
export NOVELAI_REAL_AIVIS=1
export NOVELAI_REAL_OUT="$HOME/novelai-real-out"
caffeinate -dis npm run test:e2e:real
```

- **VOICEVOX の門と件を足した（2026-11-12。`localRealEngines.real.ts`、共通の部品は `realSupport.ts`）**。門：`NOVELAI_REAL_AIVIS=1`（127.0.0.1:10101）・`NOVELAI_REAL_VOICEVOX=1`（127.0.0.1:50021）。混ぜる件は両方が要る。`NOVELAI_REAL_FAST_PC=1`（＋AIVIS）は速い PC でだけ見る件（遅さの知らせが出ないこと。遅い機械で付けると落ちる）。件：26・28（混ぜた声。窓0回・VOICEVOX へ頼まれた・MP3 が 44100Hz・注意書きに両方）、99・113（VOICEVOX で2人を別の声にして読み・書き出す）、123（台詞の控えで感情を決め、感情ごとに頼んだスタイルの番号を記録）、104（速い PC で遅さの知らせが出ない）。111 は上の 49・80 の件が MP3 と注意書きを置き場へ写す
- **置き場**：`NOVELAI_REAL_OUT` の下の `v<版>_<日付>/` に、MP3・「クレジットと利用条件.txt」・「ライセンス/」・件ごとの `結果.json`・**`聞くところ.md`**（ファイルごとに「どの項目の何を聞くか」を1行）が並ぶ。作者へはセッションがこのフォルダーのファイルを送る。流すコマンドは上と同じで、環境変数を足すだけ（Mac は `export NOVELAI_REAL_VOICEVOX=1`、PowerShell は `$env:NOVELAI_REAL_VOICEVOX = "1"`）
- 走らせたあと `novelai-e2e-` を引数に含む `Code.exe` が残っていないことを確かめる（上の「守ること」）。控えの JSON には作者の話の題名が入ることがあるので、リポジトリへ入れない

## 広報の動画

同じ土台で撮る（`npm run promo:record`。ffmpeg が要る。台本は `test/e2e/promo/*.promo.ts`）。押す絵は `clickWithCursor`——**矢印が目標の上にあることを機械で確かめてから押す**（`assertCursorOn`。外れたら撮影を失敗にする）。詳細は設計書 6.114。

## 画面の動きと押す間合い（2026-11-03）

- **テスト用 VS Code の画面の動きは止めてある**（`support/vscodeApp.ts` の settings.json に `"workbench.reduceMotion": "on"`）。既定の auto は Windows の「アニメーション効果」に従うので、作者が設定を切り替えたら、選ぶ画面の行が動いている最中に押す・Esc を送るなどで17件（12ファイル）が落ちた。**外さない**
- 動きを止めると Playwright が「落ち着くのを待つ」時間が無くなり、人には無理な速さで押す。VS Code の仕掛けに当たる2つ：
  - **通知の連打よけ**：800ms に4つ目の通知は右下に出さず、通知センターへ入れるだけ（`NotificationsToasts.SPAM_PROTECTION`）。続けて通知のボタンを押すときは、その通知が 1 秒出たままなのを `holdsFor` で見届けてから押す（`announcementCopyButtons` の `pressNoticeButton`）
  - **品書きは開いて 100ms は押しても効かない**（`runOnceToEnableMouseUp`）。押したあと品書きが閉じなければ1度だけ押し直す（`menuNoticeFollowUps`）。右クリックの品書きの部品（`support/sidebar.ts`）は Enter で選び直す形で、もとから避けている
- **全件が同じ形で落ちたら、先に古い版で同じテストを回す。** 作業場（`git worktree add --detach <道> <コミット>`、`npm ci`、`npm run build`）で古い版を組み、落ちたテストを1〜2本回す。古い版でも落ちれば機械の側。`repositoryRoot` はテストのファイルの場所から決まるので、作業場の dist で走る
- **「環境のせい」と書く前に、土台の作りを読む。** 窓を前に出さないのは `keepOutOfTheWay` の作りどおりで、前面の窓が Claude アプリのままでも正しい（11-03 に「前面に出られない」と書いて取り消した）。落ちた瞬間の `document.activeElement`・`document.hasFocus()`・選ぶ画面の display を書き出し、`HTMLElement.prototype.focus` を包んで呼び元の stack を取ると、どこで焦点が動いたかが分かる（Esc で閉じたのに一覧が出たままに見えたのは、閉じる動きの最中だった）
