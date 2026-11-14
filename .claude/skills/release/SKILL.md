---
name: release
description: 「VSIX化して」と言われたとき、配布の区切りができたとき、GitHub Release を出すとき、Marketplace へ公開するとき、配布の記録を残すときに読む。PowerShell で通す手順、Marketplace へブラウザから上げる手順、どの段でどこまで上げるかの決まり（GitHubは全段、Marketplace と Open VSX は1段目2段目とバグの直しを含むパッチ）。
---

# 配布（VSIX化 → 検証 → GitHub Release → 記録）

**どこまで上げるかは、版のどの段が動いたかと、中身で決まる**（作者の指示、2026-09-21。2026-10-31 に「バグ対応はマーケットプレースにも出しましょう」で改めた）。

| | いつ |
|---|---|
| **GitHub Release** | **全段**。パッチを上げるたびに出す |
| **Marketplace・Open VSX** | **1段目（メジャー）・2段目（マイナー）が動いたとき**と、**バグの直しを含むパッチの版** |

**どちらも指示を待たずに自走してよい。** この機械に vsce の PAT は無い。Marketplace へは **GitHub Actions の Trusted Publishing（手順3の A）** で上げる。作者の Chrome から上げる道（手順3の B）は、A が使えないときの代わり。

**バグの直しを含まないパッチ（動作を変えない整理〈リファクタリング〉・文書・テストだけ）は、これまでどおり GitHub Release まで。** 次に Marketplace へ出す版で、溜まった分ごと届く。どの版を出すかは動かす人（リーダー）が決め、手順のファイルの `reason` に理由（「バグの直し」「機能」など）を書く。

## 手順

### 0. 先に、Marketplace にいま出ている版を読む

```bash
node scripts/checkMarketplace.mjs
```

**引継ぎ書を見て済ませない。** Release ノートにも報告にも「Marketplace は **◯◯** のまま」と書くので、文書の写しだと外れていたときに嘘を配る（CLAUDE.md の失敗4）。鍵は要らず、作品や原稿は1文字も送らない。数秒で終わる。**判断ではなく手順として、毎回頭に走らせる**（飛ばして出したことがある）。

### 1. VSIX を作って検証する

**PowerShell から走らせる**（Git Bash だと `verify:vsix` の `tar` が GNU tar になり ZIP を読めない）。**先に `ELECTRON_RUN_AS_NODE` を外す**（拡張機能ホストの環境変数を継ぐと Electron 製の子プロセスが即終了する）。

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
npm run package:vsix      # 全リリースゲート（check（bundle:core を含む）→ integration → web → audit）＋ vsce package
npm run verify:vsix       # 内容・隔離インストール・版の照合。SHA-256 が出る
npm run test:e2e          # 画面の自動テスト（ゲートの外。Marketplace へ出す版では必ず通す）
```

- **画面の自動テスト（`test:e2e`）はゲート（`check:release`）に入っていない**（安定を見てから入れる。設計書6.113）。**Marketplace へ出す版では必ず走らせ、Release ノートに件数を書く。** 落ちたら出さずに原因を読む（スキル `e2e`）。**落ちたテストだけを単独で2回流し、揺れ（通ったり落ちたり）か毎回か**を見てから製品のセッションへ渡す（2026-11-08〜09 に3回止めた：0.146.0・0.147.0・0.148.1。どれもテストの側の誤りだったが、決めつけず製品のセッションに読ませた）。**新しく書いた e2e は、製品のセッションが作業場か Mac で一度流してから main へ入れる**（流していない新しいテストが配布の前に落ちた）。走らせたあと、`novelai-e2e-` の `Code.exe` が残っていないことを確かめる

- 出力の `release/novel-ai-assistant-<版>.vsix` と、バイト数・ファイル数・SHA-256 を控える
- VSIX に **`dist/mcp-server.mjs` は入り、`.mcp.json` は入らない**のが正しい（設計書6.87.8）。束が無いと、作品へ書き出した MCP の登録が存在しないファイルを指し、配布版では黙って繋がらない

### 2. GitHub Release を出す

```bash
gh release create v<版> "release/novel-ai-assistant-<版>.vsix" --target <完全なコミット番号> --title "v<版>——<一言>" --notes-file <ノート>
```

- **`--target` には完全なコミット番号（40桁。`git rev-parse HEAD`）を渡す。** 短い番号は「target_commitish is invalid」で断られた（2026-10-12）

- 機能の種から入れた機能があれば、CHANGELOG と同じく、同意した参加者の名前を載せる（スキル `docs-sync` の「機能の種から入れた機能には、議論の主な参加者の名前を載せる」）
- ノートは CHANGELOG の該当版を作者向けに要約し、末尾に「版／テスト件数／SHA-256」を付ける。**日本語はファイルに書いて `--notes-file` で渡す**（引数に直接書かない）
- 試せることがある版は、ノートの `---` の線より上に `## 試してほしいこと`（2〜3件。1件は1つの操作で試せて結果が見えるもの。CHANGELOG には入れない）を書き、不具合の報告から直したものには報告した人の名前を付ける（どちらも書き方はスキル `docs-sync`）
- **ノートを書いたら、スキル `yomiyasu:yomiyasu` を通してから出す**（当て方とスクリプトの呼び方はスキル `docs-sync`）（README・`package.json` の `description`・`CHANGELOG.md` の新しい版の項目を書いたときも同じ。外の読み手が読む説明文だけに当てる）
- **全段で出すので、溜めない**（パッチごとに出す）。**配布のために版を上げ直さない**

### 3. Marketplace へ公開する（**1段目・2段目が動いたとき、バグの直しを含むパッチのときは指示を待たず自走**）

#### A. GitHub Actions の Trusted Publishing（2026-10-30〜。こちらが先）

手順2で GitHub Release に VSIX を付け、ノートの末尾に `SHA-256：<64桁>` を書いてあること。

```bash
gh workflow run publish-marketplace.yml -f version=<版> -f reason=<理由>
```

- 手順のファイルは `.github/workflows/publish-marketplace.yml`。Release の VSIX を**作り直さずに**取り寄せ、ノートの SHA-256・VSIX の中の版と照らしてから `vsce publish --packagePath … --oidc` で上げる。**版の段では断らない**（2026-10-31 から。出すかどうかは動かす人が上の表で決める）。`reason`（「バグの直し」「機能」など）は必須で、ログの最初に出る
- **承認では止まらない**（2026-11-07 作者の決定「承認を省く」。作者が GitHub の Environment `marketplace` の Required reviewers を外した。動かせるのは main だけ、の決まりは残っている）。動かすとそのまま公開まで進み、**公開は取り消せない**。動かす前に、上げるもの・バイト数・SHA-256・実機確認の済み具合を作者へ知らせる。母艦が `gh workflow run` を撃つと自動の判定に「外に公開する操作」で止められることがあるので、そのときは作者に「出してよい」の一言をもらう（迂回しない）。投稿ヘルパーの Chrome ウェブストア（Environment `chrome-web-store`）も同じ日に承認を外した
- Marketplace 側の登録は、管理画面の「信頼できる出版」の `novel-ai-assistant-publish`（リポジトリ nonahisa/novel-ai-assistant・手順 publish-marketplace.yml・Environment marketplace）。**手順のファイルの名前か Environment を変えたら、この登録も直す**（食い違うと鍵の交換で断られる。PAT へは落ちない）
- 終わったら手順8（`node scripts/checkMarketplace.mjs`）で反映を確かめる
- **反映を確かめたら、README の冒頭の「Marketplace に出ている版は **…**」を出した版へ直してコミットする**。この行は Marketplace の画面にもそのまま出る。手順に無かったため 0.148.2 のまま 0.152.8 まで残り、作者に指摘された（2026-11-14）。README は次に Marketplace へ出したときに向こうへ届く
- vsce は 4.0.2 以降が要る（devDependencies と手順のファイルの `npx @vscode/vsce@<版>` をそろえる）
- **Open VSX へも同じ手順の中で上げる**（作者の裁定 2026-10-31「進める」。設計書5.9）。Marketplace の段のあとに `npx ovsx@<版> publish <同じ VSIX>` の段がある（トークンは ovsx が環境変数 `OVSX_PAT` から自分で読む）。Environment は Marketplace と共通。落ちたら手順は赤になる（`continue-on-error` は付けない。気づけるように）
  - Open VSX の名前空間とトークン（`OVSX_PAT`）は準備済み（2026-10-31）。トークンが切れたら、作者に open-vsx.org の Settings → Access Tokens で発行し直してもらい、GitHub のリポジトリの Settings → Secrets and variables → Actions の `OVSX_PAT` を入れ替えてもらう
  - シークレット `OVSX_PAT` が無ければ、**その段だけ飛ばして**「上げません」の notice を出す。Marketplace の公開は止めない
  - Open VSX の段が落ちても Marketplace は済んでいる。直したら、同じ版で手順を動かし直さず、作者の手元の PowerShell で `npx ovsx@<版> publish <VSIX> -p <トークン>` を打ってもらい Open VSX だけ上げる（トークンはこちらが持たない）（Marketplace は同じ版を二度上げられない）
  - 反映は https://open-vsx.org/extension/nonahisa/novel-ai-assistant で見る

#### B. 作者の Chrome から管理画面へ上げる（A が使えないときの代わり）

Claude in Chrome（`mcp__claude-in-chrome__*`）を使う。管理画面は Microsoft アカウントのログインが要り、内蔵ブラウザは作者の Chrome と別の入れ物なので届かない。ログアウトしていたら止める（パスワードも二要素のコードも入力しない）。

1. `https://marketplace.visualstudio.com/manage/publishers/nonahisa` を開き、拡張機能の行の「…」メニューから Update を **ref で**押す（メニューは Update・Unpublish・Remove の順で Update の 20px 下が Unpublish なので、座標で押さない）
2. 「Click here to upload」は押さない（OS のファイル選択が開いて操作できなくなる）。type=file の input を `find` で探し、`file_upload` でその ref へ VSIX の道（`<リポジトリ>\\release\\novel-ai-assistant-<版>.vsix`。JSON なので `\` は2つ）を渡す
3. `file_upload` は送信しない。そのあと **Upload を押す**（押し忘れた実績がある）。押す直前に、上げるもの・バイト数・SHA-256・実機確認の済み具合を作者へ出して確認する（公開は取り消せない）
4. 行の版の欄が「Verifying 0.x.y」か「just now」になったかを `get_page_text` で確かめる。窓が閉じていたら開き直して入れ直す。「503」が出ても受け付けられていることがあるので、入れ直す前に `node scripts/checkMarketplace.mjs` で版を見る（検証は数分〜十数分、タブは閉じてよい。画像認証が出たら押さず作者へ）
5. 反映は `node scripts/checkMarketplace.mjs` で確かめる。終わったら開いたタブを `tabs_close_mcp` で閉じる

## push のあとは CI を見る

**push のたびに GitHub の CI（`.github/workflows/ci.yml`、windows-latest）が走る。落ちると作者の Gmail へ失敗のメールが届く。** 10-06〜10-18 に気づかないまま175回落ち続けていた（検査機の一時フォルダーが短い形 RUNNER~1 で返る・遅さで5秒の時間切れ・15分の上限）。配布の前と、まとまった push のあとに `gh run list -L 3` で結果を見る。落ちていたら `gh run view <id> --log-failed` で理由を読み、その場で直す。**ci.yml を変える push には workflow の権限が要る**——Claude アプリの中の gh の鍵にだけ付いているので、`git -c credential.helper= -c "credential.helper=!gh auth git-credential" push` で押す（通常の push は資格情報マネージャーの鍵で、権限が無い）。

## 記録

1. 引継ぎ書 8章の末尾に `### 【配布】<日付>：v<版> を GitHub Release に出した` を足す（ファイル名・バイト数・SHA-256・URL・何が入る版か・テスト件数・Marketplace へ出したかどうか）
2. 引継ぎ書「いまの状態」の版の行を `（VSIX＝GitHub Release は **v<版>**）` に直す
3. `node scripts/handoverToc.mjs`
4. `npm run test:unit` を通してから `docs: v<版> を配布した記録` でコミット・push
5. `SendUserFile` で VSIX を作者へ送る（`status: proactive`。Release の URL を添える）

## 判断

- **VSIX化を伴う配布は、規則ではマイナー版**（機能のまとまり・説明文の書き換え）。ただし既に上げたパッチ版で出すのは前例どおり可
- **配布の直前に引継ぎ書の版と実装が合っているかを見る。** 手元の版のほうが Marketplace より先へ進んでいることが常なので、「未公開」と早合点しない（**Marketplace の側は手順0で読む**）
- 配布後に見つけた不具合の修正は、次の区切りでまとめて出すか、その場で出すかを作者に聞く
