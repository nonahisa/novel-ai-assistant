/**
 * ブラウザ版（vscode.dev / github.dev 向けの束）を、**実際に動かして**確かめる
 * （設計書5.8.13）。`npm run test:web` から `@vscode/test-web` が
 * 手元のChromiumにブラウザのVS Codeを立ち上げ、この関数を呼ぶ。
 *
 * **これまで、ブラウザ版を動かした検査は1つも無かった。**
 * `test/unit/browserReach.test.ts` は「Node専用のファイルへ静的importが
 * 届いていない」ことしか見ておらず、それは「起動できるはず」までしか言えない
 * （CLAUDE.md の繰り返し起きた失敗6）。ここで確かめるのは、起動した**あと**に
 * 実際に通る道である。
 *
 * ## 確かめられないもの
 *
 * - クラウドAI（鍵が要る。検査に鍵を持たせない）
 * - ソース管理からGitHubへ保存する道（VS Code本体の機能で、繋ぎ先も要る）
 * - 本文を書き換えて保存する道（原稿を守るハッシュ照合。**ここは実機で見る**）
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
import type { WorkEntry } from "../../src/models/types";

/** 束ねるときに `scripts/buildWebTests.mjs` が埋める（publisher を変えても付いてくる） */
declare const __EXTENSION_ID__: string;

/** テストの中で使う作品名。実在の作品と紛れない名前にする */
const WORK_TITLE = "ブラウザ確認用作品";

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

  if (failures.length > 0) {
    throw new Error(`ブラウザ版の検査が失敗しました:\n${failures.join("\n")}`);
  }
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

/** 診断の「まとめ」だけを取り出す。失敗したときの手がかりにする */
function summaryOf(text: string): string {
  const index = text.indexOf("## まとめ");
  return index < 0 ? text.slice(-400) : text.slice(index, index + 600);
}
