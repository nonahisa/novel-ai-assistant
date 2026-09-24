/**
 * ブラウザ版（vscode.dev / github.dev 向けの束）を、**実際に動かして**確かめる
 * （設計書5.8.13）。`npm run test:web` から `@vscode/test-web` が
 * 手元のChromiumにブラウザのVS Codeを立ち上げ、この関数を呼ぶ。
 *
 * **これまで、ブラウザ版を動かした検査は1つも無かった。**
 * `test/unit/cross/browserReach.test.ts` は「Node専用のファイルへ静的importが
 * 届いていない」ことしか見ておらず、それは「起動できるはず」までしか言えない
 * （CLAUDE.md の繰り返し起きた失敗6）。ここで確かめるのは、起動した**あと**に
 * 実際に通る道である。
 *
 * ## 確かめられないもの
 *
 * - クラウドAI（鍵が要る。検査に鍵を持たせない）
 * - ソース管理からGitHubへ保存する道（VS Code本体の機能で、繋ぎ先も要る）
 * - **本物の vscode.dev の、GitHub の上のファイルへ書く道**（`vscode-vfs://`）。
 *   ここで書くのは `@vscode/test-web` の仮想ファイルシステムで、書き込みは
 *   ブラウザのメモリに置かれるだけ（手元の材料へは返らない。
 *   `scripts/runWebTests.mjs` が前後の指紋で確かめる）。本文を書き換える道
 *   そのもの（ハッシュ照合・退避・作り直し）は、ここで通す
 *
 * ## パネル（WebView）の中身
 *
 * 拡張機能ホストからは、パネルが「作られた」ことまでしか分からない。
 * 中身が描かれたかは、`scripts/webviewProbe.mjs` が見えない Chromium の
 * フレームを DevTools の口で読み、ここから `fetch` で尋ねる
 * （Claude の内蔵ブラウザでは、タブは出るのに中身が空だった。2026-09-23）。
 *
 * ## Mocha を使っていない
 *
 * `@vscode/test-web` の作例は Mocha のブラウザ版を束ねるが、この作品の
 * VS Code上の検査（`src/test/run.ts`）はもともと `runCase` で1件ずつ
 * 通し、落ちた分だけを最後にまとめて投げる形にしてある。**同じ形に揃えた**
 * ——1件ずつ落ちる理由が出るという目的は満たせて、依存も増えない。
 */
import * as vscode from "vscode";
import { countChars } from "../../src/core/charCount";
import { fromUri, join, toUri } from "../../src/core/paths";
import {
  readTextFile,
  writeTextFilePreservingFormat,
} from "../../src/core/textFile";
import type { WorkEntry } from "../../src/models/types";
import { registerAll } from "../../src/features/addCollection";
import { WorkRegistry, readWorkConfig } from "../../src/core/workRegistry";
import { writeWorkKind } from "../../src/core/workKindStore";

/** 束ねるときに `scripts/buildWebTests.mjs` が埋める（publisher を変えても付いてくる） */
declare const __EXTENSION_ID__: string;
/** パネルの中身を覗く口（`scripts/webviewProbe.mjs`）。同じく束ねるときに埋める */
declare const __WEB_PROBE_URL__: string;

/** テストの中で使う作品名。実在の作品と紛れない名前にする */
const WORK_TITLE = "ブラウザ確認用作品";

/** 本文へ書き足す文。材料に無い言い回しにして、書けたかを取り違えない */
const EDITED_MARK = "（ブラウザ版の検査で書き足した一文）";

/**
 * パネルの種類（`createWebviewPanel` の第1引数）。**製品の定数を import しない**
 * ——パネルの部品ごと束へ引き込むと、検査の束が拡張機能の束と同じ大きさになる
 */
const SETTINGS_VIEW_TYPE = "novelai.settings";
const PROPOSALS_VIEW_TYPE = "novelai.proposals";
const WRITING_STATS_VIEW_TYPE = "novelai.writingStats";
const PLOT_MODE_VIEW_TYPE = "novelai.plotMode";

export async function run(): Promise<void> {
  const failures: string[] = [];

  // どのVS Codeで通ったのかを、結果と一緒に残す。
  // `@vscode/test-web` は既定で insiders を落としてくるので、
  // 「どの版で緑だったか」が分からないと後から追えない
  console.log(`[web] VS Code ${vscode.version} / 拡張機能ID ${__EXTENSION_ID__}`);

  /** 登録できた作品。あとの検査が使う */
  let registered: WorkEntry | undefined;

  await runCase("拡張機能が起動し、コマンドが登録される", failures, async () => {
    const extension = vscode.extensions.getExtension(__EXTENSION_ID__);
    assert(extension !== undefined, `拡張機能 ${__EXTENSION_ID__} が見つかりません`);
    await extension.activate();
    assert(extension.isActive, "activate が終わっても isActive が false です");

    const registeredCommands = await vscode.commands.getCommands(true);
    const mine = registeredCommands.filter((c) => c.startsWith("novelai."));
    assert(
      mine.includes("novelai.showVersion"),
      `novelai.showVersion が登録されていません（novelai.* は${mine.length}件）`
    );
    // **数も見る。** `activate()` が途中で失敗すると、いくつかだけ
    // 登録された状態で止まる（`features/diagnoseWeb.ts` と同じ見方）
    assert(mine.length >= 50, `novelai.* の登録が少なすぎます（${mine.length}件）`);
  });

  await runCase("作品フォルダーを登録できる", failures, async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    assert(folders.length > 0, "フォルダーが1つも開かれていません");
    const folderPath = fromUri(folders[0].uri);
    assert(
      folderPath.startsWith("vscode-test-web://"),
      `ブラウザの仮想フォルダーではありません: ${folderPath}`
    );

    // 選択画面と入力画面を飛ばすための引数（設計書5.8.13）
    const entry = await vscode.commands.executeCommand<WorkEntry | undefined>(
      "novelai.addWork",
      { folderPath, title: WORK_TITLE }
    );
    assert(entry !== undefined, "作品を登録できませんでした（undefined が返りました）");
    assert(entry.title === WORK_TITLE, `作品名が違います: ${entry.title}`);
    assert(
      entry.folderPath === folderPath,
      `登録された場所が違います: ${entry.folderPath}`
    );
    registered = entry;
  });

  /*
    **登録したら、設定ファイルがその場で読めること**（2026-09-24）。

    実機で「作品の種類」が「設定ファイルが見つかりません」で止まった。
    原因は test-web の置き場の性質（書いたものはメモリに置かれ、読み込み
    直すと消える。`test/unit/features/addCollectionConfig.test.ts`）だったが、
    **同じ画面の中で書けて読めること**はここで押さえておく。ここが割れたら、
    それは置き場のせいではなく登録の道の不具合である。
  */
  await runCase("登録した作品に設定ファイル（.aiwriter/config.json）ができる", failures, async () => {
    assert(registered !== undefined, "作品が登録されていないため確かめられません");
    const config = await readConfigFile(registered.folderPath);
    assert(
      config.workTitle === WORK_TITLE,
      `設定ファイルの作品名が違います: ${String(config.workTitle)}`
    );
  });

  await runCase("「動作を診断」が通り、登録した作品が出る", failures, async () => {
    await vscode.commands.executeCommand("novelai.diagnoseWeb");
    const text = await waitForDocument("# ブラウザ版の動作診断");
    assert(text !== undefined, "診断の結果が開かれませんでした");

    assert(
      !text.includes("登録簿は空です"),
      "登録した作品が登録簿に入っていません（一覧は空になります）"
    );
    assert(
      text.includes(WORK_TITLE),
      `診断に「${WORK_TITLE}」が出ていません`
    );

    // 診断の表は「作品 | 設定 | 走査 | 場所」の並び。
    // **走査の欄が `○` であること**が、一覧に文字数が出る条件である
    const row = text
      .split("\n")
      .find((line) => line.startsWith(`| ${WORK_TITLE} |`));
    assert(row !== undefined, "診断の表に作品の行がありません");
    assert(
      /○ \d+話/.test(row),
      `走査が通っていません（この行）: ${row}`
    );

    // **表が崩れずに読めるか**（実機確認リストの「表が崩れずに読めるか」）。
    // Markdown の表は、1行でも列の数がずれるとその行から下が表でなくなる。
    // 見出しと区切りと各行の列の数が揃っていることを、表ごとに見る
    const broken = brokenTableRows(text);
    assert(
      broken.length === 0,
      `診断の表の列がずれています:\n${broken.join("\n")}`
    );

    // ファイル操作（作る・書く・読む・消す）が全部通ったか。
    // ここが割れると、ブラウザ版では設定資料を保存できない
    assert(
      text.includes("**すべて通りました。**"),
      `ファイル操作のどれかが通っていません。診断の「まとめ」:\n${summaryOf(text)}`
    );
  });

  await runCase("本文を開いて、文字数が数えられる", failures, async () => {
    assert(registered !== undefined, "作品が登録されていないため確かめられません");

    // **名前を書き下さない。** 材料の名前を変えたときに、
    // 「本文が読めない」ではなく「ファイルが無い」で落ちてほしい
    const entries = await vscode.workspace.fs.readDirectory(
      toUri(registered.folderPath)
    );
    const first = entries
      .filter(([name, kind]) => kind === vscode.FileType.File && name.endsWith(".txt"))
      .map(([name]) => name)
      .sort()[0];
    assert(first !== undefined, "作品フォルダーに本文（.txt）がありません");

    const document = await vscode.workspace.openTextDocument(
      toUri(join(registered.folderPath, first))
    );
    const text = document.getText();
    assert(text.length > 0, `${first} が空です`);

    // 製品と同じ数え方を通す（`core/charCount.ts`）
    const counts = countChars(text);
    assert(counts.net > 0, `${first} の文字数が0です`);
    console.log(`[web] ${first}: ${counts.net}字（記号を除く）`);
  });

  await runCase("本文をエディタで書き換えて保存できる", failures, async () => {
    assert(registered !== undefined, "作品が登録されていないため確かめられません");
    // 1話目は上の検査が開いているので、2つ目の本文で試す
    const name = (await manuscriptNames(registered.folderPath))[1];
    assert(name !== undefined, "作品フォルダーに本文が2つありません");
    const uri = toUri(join(registered.folderPath, name));
    const before = await vscode.workspace.fs.readFile(uri);

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, document.positionAt(document.getText().length), EDITED_MARK);
      assert(await vscode.workspace.applyEdit(edit), "applyEdit が断られました");
      assert(document.isDirty, "書き換えたのに、未保存の印が付きません");
      assert(await document.save(), "保存が断られました");

      // **エディタの中ではなく、ファイルの側を読み直す。** 画面に出ているだけで
      // 書けていない、という壊れ方を拾うため
      const saved = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      assert(
        saved.includes(EDITED_MARK),
        `保存したはずの文が、読み直したファイルにありません（${name}）`
      );
    } finally {
      await restoreBytes(uri, before);
    }
  });

  await runCase(
    "本文の書き戻し（writeTextFilePreservingFormat）は、ハッシュが合うときだけ書く",
    failures,
    async () => {
      assert(registered !== undefined, "作品が登録されていないため確かめられません");
      // エディタで開いていない本文で試す（開いていて未保存なら、別の理由で断られる）
      const name = (await manuscriptNames(registered.folderPath))[2];
      assert(name !== undefined, "作品フォルダーに本文が3つありません");
      const filePath = join(registered.folderPath, name);
      const uri = toUri(filePath);
      const before = await vscode.workspace.fs.readFile(uri);

      try {
        // 製品と同じ読み方（読んだ時点のハッシュを持つ）
        const content = await readTextFile(filePath);
        const rewritten = `${EDITED_MARK}${content.text}`;

        // ① ハッシュが違う → 書かない。ファイルは1バイトも変わらない
        const refused = await writeTextFilePreservingFormat(
          filePath,
          rewritten,
          content,
          "0".repeat(content.hash.length)
        );
        assert(
          !refused.ok && refused.reason === "modified_externally",
          `ハッシュが違うのに断りませんでした: ${JSON.stringify(refused)}`
        );
        assert(
          sameBytes(await vscode.workspace.fs.readFile(uri), before),
          "断ったはずなのに、ファイルが変わっています"
        );

        // ② 読んだあとで外から書き換えられた → 読んだときのハッシュでは書かない。
        //    **外の書き換えを押し流さない**のが、この照合の目的である
        const external = new TextEncoder().encode(`${content.text}外から足した一行\n`);
        await vscode.workspace.fs.writeFile(uri, external);
        const overwritten = await writeTextFilePreservingFormat(
          filePath,
          rewritten,
          content,
          content.hash
        );
        assert(
          !overwritten.ok && overwritten.reason === "modified_externally",
          `外から書き換えられたのに書きました: ${JSON.stringify(overwritten)}`
        );
        assert(
          sameBytes(await vscode.workspace.fs.readFile(uri), external),
          "外から書き換えた内容が、押し流されています"
        );

        // ③ ハッシュが合う → 書ける。書く前の本文は回復先へ退避される
        await vscode.workspace.fs.writeFile(uri, before);
        const written = await writeTextFilePreservingFormat(
          filePath,
          rewritten,
          content,
          content.hash
        );
        assert(written.ok, `ハッシュが合うのに書けませんでした: ${JSON.stringify(written)}`);
        const after = await readTextFile(filePath);
        assert(
          after.text === rewritten,
          `書いた内容が違います（先頭: ${after.text.slice(0, 40)}）`
        );
        // 文字コード・改行・末尾の改行を読み込んだときのままにする（設計書5.4.2）
        assert(
          after.encoding === content.encoding &&
            after.eol === content.eol &&
            after.hasTrailingNewline === content.hasTrailingNewline,
          `形式が変わりました: ${content.encoding}/${content.eol}/${content.hasTrailingNewline}` +
            ` → ${after.encoding}/${after.eol}/${after.hasTrailingNewline}`
        );
        assert(written.recoveryPath !== undefined, "書く前の本文を退避した先が返りません");
        assert(
          sameBytes(await vscode.workspace.fs.readFile(toUri(written.recoveryPath)), before),
          `退避した本文が、書く前の本文と違います: ${written.recoveryPath}`
        );
      } finally {
        await restoreBytes(uri, before);
      }
    }
  );

  await runCase("設定資料パネルが開き、中身が描かれる", failures, async () => {
    assert(registered !== undefined, "作品が登録されていないため確かめられません");
    await runCommand("novelai.openSettingsPanel");
    await waitForWebviewTab(SETTINGS_VIEW_TYPE);
    await expectWebviewContent("設定資料", "左の一覧から選んでください。");
  });

  /** 本文を置いた列。提案パネル・執筆統計の置き場所の基準にする */
  let textColumn: vscode.ViewColumn | undefined;

  await runCase("提案パネルは、本文の右の列に開く", failures, async () => {
    assert(registered !== undefined, "作品が登録されていないため確かめられません");
    textColumn = await showOnlyManuscript(registered.folderPath);

    await runCommand("novelai.openProposals");
    const { group } = await waitForWebviewTab(PROPOSALS_VIEW_TYPE);
    assert(
      group.viewColumn > textColumn,
      `提案パネルが本文（${textColumn}列目）の右に開いていません（${group.viewColumn}列目）`
    );
    // 押して開いたときは、フォーカスごと移る（`novelai.openProposals` の引数なし）
    assert(
      vscode.window.tabGroups.activeTabGroup.viewColumn === group.viewColumn,
      "提案パネルを開いたのに、前面の列が移っていません"
    );
    await expectWebviewContent("提案");
  });

  await runCase(
    "執筆統計は、右の列が前面でも本文の列に開く（wideViewColumn）",
    failures,
    async () => {
      assert(textColumn !== undefined, "本文の列が決まっていないため確かめられません");
      const proposals = findWebviewTab(PROPOSALS_VIEW_TYPE);
      assert(proposals !== undefined, "提案パネルが開いていないため確かめられません");
      // **ここが e16a8bf2 の場面**——細い右の列が前面のときに開く
      assert(
        vscode.window.tabGroups.activeTabGroup.viewColumn === proposals.group.viewColumn,
        "右の列（提案パネル）が前面になっていないため、確かめたい場面になりません"
      );

      await runCommand("novelai.showWritingStats");
      const { group } = await waitForWebviewTab(WRITING_STATS_VIEW_TYPE);
      assert(
        group.viewColumn === textColumn,
        `執筆統計が本文の列（${textColumn}列目）ではなく${group.viewColumn}列目に開きました`
      );
      await expectWebviewContent("執筆量");
    }
  );

  await runCase("プロットモードが開き、中身が描かれる", failures, async () => {
    assert(registered !== undefined, "作品が登録されていないため確かめられません");
    await runCommand("novelai.openPlotMode");
    await waitForWebviewTab(PLOT_MODE_VIEW_TYPE);
    await expectWebviewContent("プロットモード", "プロットの節");
  });

  await runCase("拡張機能の記録に、失敗が残っていない", failures, async () => {
    assert(registered !== undefined, "作品が登録されていないため確かめられません");
    /*
      出力チャネルは外から読めないので、同じ行を写しているファイルを読む
      （`core/logger.ts`）。**置き場は2つある**——作品が決まった処理は作品の下、
      決まらない処理は拡張機能の保管庫（`globalStorageUri`。ブラウザでは
      `vscode-userdata:` の下）。保管庫の場所は拡張機能の中からしか分からない
      ので、VS Code の決まった置き方から組み立てる。
    */
    const places = [
      join(registered.folderPath, ".aiwriter", "logs", "actions.log"),
      `vscode-userdata:/User/globalStorage/${__EXTENSION_ID__.toLowerCase()}/.aiwriter/logs/actions.log`,
    ];
    const lines: string[] = [];
    for (const place of places) {
      let log = "";
      try {
        log = new TextDecoder().decode(await vscode.workspace.fs.readFile(toUri(place)));
      } catch {
        // 記録が1行も無いなら、そこには失敗も無い
      }
      const read = log.split("\n").filter((line) => line !== "");
      // **何行見たかを残す。** 0行なら、その置き場については何も確かめていない
      console.log(`[web] 拡張機能の記録 ${place}: ${read.length}行`);
      lines.push(...read);
    }
    // `logFailure` は「--- 何の失敗 ---」の見出しで始まる
    const failed = lines.filter((line) => /\] --- .+ ---$/.test(line));
    assert(
      failed.length === 0,
      `失敗の記録があります（${failed.length}件）:\n${failed.join("\n")}`
    );
  });

  /*
    **書庫の道（「n件の作品が見つかりました」から選ぶ登録）でも、設定ファイルが
    できて種類を書けること**（2026-09-24。実機で止まった操作そのもの）。

    **いちばん後ろに置く。** 作品フォルダーの中に書庫の形（子フォルダーに本文）を
    メモリの上だけで作るので、前の検査（診断の話数・文字数）に混ざらないように
    する。終わったら消す。

    選択画面は押せないので、画面のあとに通る `registerAll` を直に呼ぶ。
    **登録簿は使い捨て**（拡張機能の登録簿には入れない）——ここで確かめたいのは
    「ブラウザの置き場で `addExisting` が設定ファイルを書き、読めるか」
    （読み口の「見つからない」の見分け・書き込みの両方）である。
  */
  await runCase("書庫の道で登録すると、設定ファイルができて種類を書ける", failures, async () => {
    assert(registered !== undefined, "作品が登録されていないため確かめられません");
    const shelf = join(registered.folderPath, "書庫確認用");
    const child = join(shelf, "仮作品");
    await vscode.workspace.fs.createDirectory(toUri(child));
    await vscode.workspace.fs.writeFile(
      toUri(join(child, "episode_0001.txt")),
      new TextEncoder().encode("書き出しの一文です。")
    );
    try {
      let stored: WorkEntry[] = [];
      const throwaway = new WorkRegistry({
        globalState: {
          get: <T>(_key: string, _fallback: T): T => stored as unknown as T,
          update: async (_key: string, value: unknown) => {
            stored = value as WorkEntry[];
          },
        },
      } as unknown as vscode.ExtensionContext);
      const added = await registerAll(throwaway, [
        { folderPath: child, title: "仮作品", hasConfig: false, alreadyRegistered: false },
      ]);
      assert(added.length === 1, `登録できませんでした（${added.length}件）`);

      const config = await readConfigFile(child);
      assert(config.workTitle === "仮作品", `設定ファイルの作品名が違います: ${String(config.workTitle)}`);

      await writeWorkKind(added[0], "essay");
      const kind = (await readWorkConfig(added[0]))?.kind;
      assert(kind === "essay", `種類が書けていません: ${String(kind)}`);
    } finally {
      await vscode.workspace.fs.delete(toUri(shelf), { recursive: true });
    }
  });

  if (failures.length > 0) {
    throw new Error(`ブラウザ版の検査が失敗しました:\n${failures.join("\n")}`);
  }
}

/**
 * 作品の設定ファイルを、**拡張機能の読み口を通さずに**読む。
 *
 * 製品の `readWorkConfig` は「見つからない」を `undefined` に畳むので、
 * 無いのか読めないのかを取り違える。ここでは置き場へ直に訊き、
 * 無ければ無いと言って落ちる。
 */
async function readConfigFile(folderPath: string): Promise<{ workTitle?: unknown }> {
  const uri = toUri(join(folderPath, ".aiwriter", "config.json"));
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    throw new Error(
      `設定ファイルがありません（${fromUri(uri)}）: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as { workTitle?: unknown };
}

/**
 * 1件ずつ通して、落ちた理由を溜める。
 *
 * **最初の1件で止めない。** ブラウザ版は「どこまで動いて、どこから駄目か」を
 * 知りたい場面で使うので、後ろの検査も走らせて全部の結果を出す
 * （`src/test/run.ts` と同じ）。
 */
async function runCase(
  name: string,
  failures: string[],
  test: () => Promise<void>
): Promise<void> {
  try {
    await test();
    console.log(`PASS ${name}`);
  } catch (error) {
    const detail =
      error instanceof Error ? error.stack ?? error.message : String(error);
    console.log(`FAIL ${name}`);
    failures.push(`FAIL ${name}\n${detail}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * 開かれた文書のうち、目印を含むものの中身を返す。
 *
 * **すぐには現れない。** `openGeneratedMarkdown` は書き出しと表示を
 * 待ってから返るが、`workspace.textDocuments` への反映は1拍遅れることがある。
 */
async function waitForDocument(marker: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const found = vscode.workspace.textDocuments.find((d) =>
      d.getText().startsWith(marker)
    );
    if (found) return found.getText();
    await delay(100);
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 作品フォルダーの本文（.txt と .md）の名前を、並び順で返す */
async function manuscriptNames(folderPath: string): Promise<string[]> {
  const entries = await vscode.workspace.fs.readDirectory(toUri(folderPath));
  return entries
    .filter(
      ([name, kind]) =>
        kind === vscode.FileType.File && (name.endsWith(".txt") || name.endsWith(".md"))
    )
    .map(([name]) => name)
    .sort();
}

/**
 * 書き換えた本文を元のバイトへ戻す。
 *
 * 仮想ファイルシステムの書き込みは材料へ返らないが、**あとの検査が
 * 書き換えた本文を読まないように**、その場で戻す。戻ったことも確かめる。
 */
async function restoreBytes(uri: vscode.Uri, bytes: Uint8Array): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, bytes);
  const now = await vscode.workspace.fs.readFile(uri);
  if (!sameBytes(now, bytes)) {
    throw new Error(`本文を元へ戻せませんでした: ${uri.toString()}`);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/**
 * コマンドを実行する。**待ち続けない。**
 *
 * 画面を出さないブラウザでは、確認のダイアログや選択画面が出ると
 * 誰も押さないので、検査がそこで止まったまま終わらなくなる。
 */
async function runCommand(command: string, ...args: unknown[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${command} が20秒たっても返りません（選択画面か確認が出ている？）`)),
      20_000
    );
  });
  try {
    await Promise.race([vscode.commands.executeCommand(command, ...args), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 編集の列をすべて閉じて、1話目の本文だけを1列目に置く。置いた列を返す */
async function showOnlyManuscript(folderPath: string): Promise<vscode.ViewColumn> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  const name = (await manuscriptNames(folderPath))[0];
  assert(name !== undefined, "作品フォルダーに本文がありません");
  const document = await vscode.workspace.openTextDocument(toUri(join(folderPath, name)));
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.One,
    preview: false,
  });
  assert(editor.viewColumn !== undefined, "本文を置いた列が分かりません");
  return editor.viewColumn;
}

/**
 * その種類のパネルのタブ。
 *
 * **VS Code はタブの viewType に内部の接頭辞を付ける**
 * （`mainThreadWebview-novelai.settings` のように）ので、末尾で比べる
 * （`features/editorColumn.ts` の `columnOfWebviewPanel` と同じ見方）。
 */
function findWebviewTab(
  viewType: string
): { tab: vscode.Tab; group: vscode.TabGroup } | undefined {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input: unknown = tab.input;
      if (
        input instanceof vscode.TabInputWebview &&
        (input.viewType === viewType || input.viewType.endsWith(`-${viewType}`))
      ) {
        return { tab, group };
      }
    }
  }
  return undefined;
}

async function waitForWebviewTab(
  viewType: string
): Promise<{ tab: vscode.Tab; group: vscode.TabGroup }> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const found = findWebviewTab(viewType);
    if (found) return found;
    await delay(100);
  }
  throw new Error(`パネル（${viewType}）のタブが出ません`);
}

/** 覗く口（`scripts/webviewProbe.mjs`）が返す、WebView の1フレーム */
interface ProbeFrame {
  url: string;
  title: string;
  text: string;
}

async function readWebviewFrames(): Promise<ProbeFrame[]> {
  let response: Response;
  try {
    response = await fetch(__WEB_PROBE_URL__);
  } catch (error) {
    // **覗けないことを「描かれていない」と取り違えない**
    throw new Error(
      `パネルの中身を覗く口（${__WEB_PROBE_URL__}）に繋がりません: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const body = (await response.json()) as { frames?: ProbeFrame[]; error?: string };
  if (!response.ok || body.frames === undefined) {
    throw new Error(`パネルの中身を覗けませんでした: ${body.error ?? response.status}`);
  }
  return body.frames;
}

/**
 * 見出し（`<title>`）が `title` のパネルが描かれるまで待つ。
 * `text` を渡したら、その文字が画面に出ていることまで確かめる。
 *
 * **タブが出ただけでは「開けた」ではない**——Service Worker の登録に
 * 失敗したブラウザでは、タブは出るのに中身が空のままになる。
 */
async function expectWebviewContent(title: string, text?: string): Promise<void> {
  let last: ProbeFrame[] = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    last = await readWebviewFrames();
    const hit = last.find(
      (frame) => frame.title === title && (text === undefined || frame.text.includes(text))
    );
    if (hit) {
      console.log(`[web] パネル「${title}」: ${hit.text.replace(/\s+/g, " ").slice(0, 60)}`);
      return;
    }
    await delay(250);
  }
  const seen = last
    .filter((frame) => frame.title !== "")
    .map((frame) => `「${frame.title}」${frame.text.replace(/\s+/g, " ").slice(0, 40)}`);
  throw new Error(
    `パネル「${title}」の中身が描かれませんでした` +
      (text === undefined ? "" : `（「${text}」を待った）`) +
      `。見えたパネル: ${seen.length > 0 ? seen.join(" / ") : "なし"}`
  );
}

/** 診断の「まとめ」だけを取り出す。失敗したときの手がかりにする */
/**
 * 列の数が見出しと合わない表の行を返す（無ければ空）。
 *
 * 数えるのは**逃がしていない縦棒**だけ（`\|` は欄の中の文字）。表は
 * 「| で始まる行が続くところ」とし、1行目を見出し、2行目を区切りと読む。
 * 区切りが `|---|` の形でなければ、そこは表として組まれない（崩れている）。
 */
function brokenTableRows(text: string): string[] {
  const cellCount = (line: string): number =>
    line.replace(/\\\|/g, "").split("|").length - 2;
  const broken: string[] = [];
  let table: string[] = [];
  const check = (): void => {
    if (table.length === 0) return;
    const [header, separator, ...rows] = table;
    const width = cellCount(header);
    if (!separator || !/^\|(\s*:?-+:?\s*\|)+$/.test(separator.trim())) {
      broken.push(`区切りの行がない表: ${header}`);
    } else if (cellCount(separator) !== width) {
      broken.push(`区切りの列の数が見出しと違う: ${header} / ${separator}`);
    }
    for (const row of rows) {
      if (cellCount(row) !== width) broken.push(`列の数が${width}でない: ${row}`);
    }
    table = [];
  };
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("|")) {
      table.push(line.trim());
    } else {
      check();
    }
  }
  check();
  return broken;
}

function summaryOf(text: string): string {
  const index = text.indexOf("## まとめ");
  return index < 0 ? text.slice(-400) : text.slice(index, index + 600);
}
