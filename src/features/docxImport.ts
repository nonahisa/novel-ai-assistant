import * as vscode from "vscode";
import * as path from "../core/paths";
import { AtomicWriteFileError, atomicWriteFile } from "../core/atomicWrite";
import { docxToMarkdown } from "../core/docxToMarkdown";
import { pathExists } from "../core/fileSystem";
import { timestampedFileNameCandidates } from "../core/timestampedFileName";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import type { WorkEntry } from "../models/types";
import { cancelItem, isCancelItem } from "../views/dialogs";
import { revealFolder } from "../views/openDocument";
import { withCancellableProgress } from "../views/progress";
import { pickFolder } from "./pickFolder";

/**
 * Word（.docx）の作品を、まとめて .md にする（設計書6.85）。
 *
 * 作者の要望（2026-09-06）：「ワードファイルの作品をMDに一括変更できる
 * ようにしてください。ルビは保存してください」。
 *
 * ## 変換であって、移動ではない
 *
 * **元の .docx には触れない。** 名前を変える `.txt` → `.md`
 * （`markdownConvert.ts`）と違い、こちらは中身の組み方がまるごと変わる
 * ——見比べたくなったときに元が無いと、作者は確かめようがない。
 * Word 側で書き足していた作者が、変換後にどちらが新しいかを見失わない
 * ように、**古いほうを残す**選択でもある。
 *
 * ## 既にある .md も上書きしない
 *
 * 同じ名前の .md があれば別名で書き出す（`timestampedFileName.ts`）。
 * 上書きすれば、そちらに書いてあった本文が消える。書き込みは
 * `atomicWriteFile` の `mode: "create"` だけを使う——新規作成しか
 * しないと決めておけば、上書きの経路が紛れ込む余地がない。
 */

/** Word が開いている間だけ作る一時ファイルの印 */
const WORD_LOCK_PREFIX = "~$";

/** 1件ぶんの結果。通知を組み立てるためだけに持つ */
interface FileResult {
  name: string;
  ruby: number;
  emphasis: number;
  skipped: string[];
}

export async function convertDocxToMarkdown(
  work?: WorkEntry
): Promise<boolean> {
  const folder = await chooseFolder(work);
  if (!folder) return false;

  const { docx, legacy } = await listWordFiles(folder);
  if (docx.length === 0) {
    void vscode.window.showInformationMessage(
      `${folder} に変換できる .docx がありませんでした。` +
        (legacy > 0
          ? `古い形式の .doc が${legacy}件ありますが、こちらは変換できません。` +
            "Word で開いて「.docx」として保存し直してからお試しください。"
          : "")
    );
    return false;
  }

  // **件数と書き出し先を見せてから確認する**（設計書6.81の規則1）。
  // 何件ぶんのファイルが増えるのかを知らせずに走らせない
  const answer = await vscode.window.showWarningMessage(
    `${docx.length}件の .docx を .md にしますか？`,
    {
      modal: true,
      detail: [
        `書き出し先：${folder}（同じフォルダーに .md を作ります）`,
        "",
        "ルビは {漢字|かんじ}、傍点は {{強調}} として持ち帰ります。",
        "元の .docx はそのまま残ります。",
        "同じ名前の .md がすでにあるものは、上書きせず別の名前で書き出します。",
        "",
        "画像・表・脚注・コメントは .md に入りません（件数はあとでお知らせします）。",
      ].join("\n"),
    },
    "変換する"
  );
  if (answer !== "変換する") return false;

  const done: FileResult[] = [];
  const failed: string[] = [];
  let cancelled = false;

  // **中止できるようにする。** 何十話ぶんもある作品では数十秒かかり、
  // そのあいだ画面が動かないままだと「固まった」としか見えない
  await withCancellableProgress(
    "Word の原稿を .md にする",
    async (progress, token) => {
      for (const [index, name] of docx.entries()) {
        if (token.isCancellationRequested) {
          cancelled = true;
          return;
        }
        progress.report({
          message: `${docx.length}件中 ${index + 1}件目（${name}）`,
        });

        try {
          const bytes = await vscode.workspace.fs.readFile(
            path.toUri(path.join(folder, name))
          );
          const converted = docxToMarkdown(bytes);
          await createMarkdownFile(
            folder,
            name.slice(0, name.length - ".docx".length),
            converted.markdown
          );
          done.push({
            name,
            ruby: converted.rubyCount,
            emphasis: converted.emphasisCount,
            skipped: converted.skipped,
          });
        } catch (error) {
          // **1件失敗しても残りは進める。** 途中で止めると、どこまで
          // 終わったのかが作者に分からない（.txt の一括変換と同じ流儀）
          failed.push(
            `${name}（${
              error instanceof Error ? error.message : String(error)
            }）`
          );
        }
      }
    }
  );

  // **中止しても、そこまでの .md は消さない。** 出来上がったものを
  // 巻き戻すほうが、作者にとっては失うものが大きい
  await reportResult(folder, done, failed, legacy, cancelled);
  return done.length > 0;
}

/**
 * 変換するフォルダーを決める。
 *
 * **既定は選んだ作品の本文フォルダー**だが、作品の外にある .docx も
 * 変換できるようにしてある——Word で書いたものは、たいてい作品として
 * 登録する前の段階にある。
 */
async function chooseFolder(work?: WorkEntry): Promise<string | undefined> {
  const home = work ? await manuscriptFolder(work) : undefined;
  if (!home) {
    return pickFolder(
      "Word（.docx）のあるフォルダーを選ぶ",
      "このフォルダーを変換する"
    );
  }
  // **0件でも選べるままにする。** そのまま選べば「.docx がありません
  // （.doc なら Word で保存し直してください）」まで届く。ここで黙って
  // フォルダー選択の窓へ飛ばすと、作者は何が起きたのか分からない
  const count = (await listWordFiles(home)).docx.length;

  const picked = await vscode.window.showQuickPick<
    vscode.QuickPickItem & { choice?: "work" | "other" }
  >(
    [
      {
        label: "$(files) この作品の本文フォルダー",
        description: `.docx が${count}件`,
        detail: home,
        choice: "work",
      },
      {
        label: "$(folder-opened) 別のフォルダーを選ぶ",
        detail: "作品として登録していないフォルダーでもかまいません",
        choice: "other",
      },
      cancelItem(),
    ],
    {
      title: "Word（.docx）を .md にする",
      placeHolder: "変換するフォルダーを選びます",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !picked.choice) return undefined;
  if (picked.choice === "work") return home;
  return pickFolder(
    "Word（.docx）のあるフォルダーを選ぶ",
    "このフォルダーを変換する"
  );
}

/**
 * 本文の置き場。
 *
 * **本文フォルダーが無ければ、作品フォルダーの直下を見る**
 * （`markdownConvert.ts` と同じ扱い。原稿を直に置く作者がいる）。
 */
async function manuscriptFolder(work: WorkEntry): Promise<string> {
  let config;
  try {
    config = await readWorkConfig(work);
  } catch {
    config = undefined;
  }
  const paths = workPaths(work, config);
  return (await pathExists(paths.manuscript)) ? paths.manuscript : paths.root;
}

/**
 * フォルダー直下の Word ファイル。
 *
 * **1階層だけ。** 下の階層まで拾うと、作品と関係のない書類まで
 * .md になって作品フォルダーへ散らばる。
 */
async function listWordFiles(
  folder: string
): Promise<{ docx: string[]; legacy: number }> {
  let entries: Array<[string, vscode.FileType]>;
  try {
    entries = await vscode.workspace.fs.readDirectory(path.toUri(folder));
  } catch {
    return { docx: [], legacy: 0 };
  }

  const docx: string[] = [];
  let legacy = 0;
  for (const [name, kind] of entries) {
    if (kind !== vscode.FileType.File) continue;
    // Word が開いている間だけ作る隠しファイル。中身は原稿ではない
    if (name.startsWith(WORD_LOCK_PREFIX)) continue;
    const lower = name.toLowerCase();
    if (lower.endsWith(".docx")) docx.push(name);
    else if (lower.endsWith(".doc")) legacy += 1;
  }
  return { docx: docx.sort(), legacy };
}

/**
 * .md を**新規作成**する。既にあれば名前をずらす。
 *
 * 名前のずらし方は `timestampedFileName.ts` に寄せてある——同じ規則を
 * 2か所に書くと、片方だけ直したときに「こちらは秒まで、あちらは分まで」
 * というずれが静かに残る。
 */
async function createMarkdownFile(
  folder: string,
  baseName: string,
  markdown: string
): Promise<string> {
  // 文字コードは UTF-8、改行は LF。**元の .docx には文字コードが無い**
  // （XMLはUTF-8で固定）ので、保つべき「元の形」がそもそも無い
  const bytes = new TextEncoder().encode(markdown);
  const candidates = [
    `${baseName}.md`,
    ...timestampedFileNameCandidates(baseName, new Date(), ".md"),
  ];

  for (const candidate of candidates) {
    const target = path.join(folder, candidate);
    try {
      await atomicWriteFile(target, bytes, { mode: "create" });
      return target;
    } catch (error) {
      if (!(error instanceof AtomicWriteFileError)) throw error;
      /*
        **名前をずらしてよいのは「まだ置いていない」ときだけ。**

        `path_conflict` には2つある。名前がぶつかって1文字も書けなかった
        （`not_saved`）ときは、別の名前で作り直すのが正しい。
        いっぽう**置いたあとに中身を確かめられなかった**（`ambiguous`）
        ときにずらすと、同じ本文の .md が2つできてしまう——作者は
        どちらが本物か分からないまま、片方を書き足していく。
      */
      if (
        error.kind === "path_conflict" &&
        error.persistenceState === "not_saved"
      ) {
        continue;
      }
      throw new Error(
        `「${target}」へ書き出しましたが、置いたあとの中身を確かめられませんでした` +
          "（同じ本文の .md を2つ作らないため、別の名前では作り直していません）。" +
          `ファイルを開いて中身をお確かめください：${error.message}`
      );
    }
  }
  throw new Error(
    "同じ名前の .md が多すぎて、書き出す名前を決められませんでした。"
  );
}

/**
 * 一覧は**先頭3件まで**にして、残りは件数で言う。
 *
 * 何十件も変換したときに、全部並べると通知が画面を覆って、肝心の
 * 「何件できたか」まで読んでもらえない。
 */
function summarize(items: readonly string[], separator: string): string {
  return (
    items.slice(0, 3).join(separator) +
    (items.length > 3 ? ` ほか${items.length - 3}件` : "")
  );
}

/**
 * 結果を伝える。
 *
 * **件数つきなので通知に残す**（設計書6.81の規則3）。落としたもの・
 * 失敗したものは、作者が次にすることが変わるので黙って捨てない。
 */
async function reportResult(
  folder: string,
  done: readonly FileResult[],
  failed: readonly string[],
  legacy: number,
  cancelled: boolean
): Promise<void> {
  if (done.length === 0) {
    if (cancelled) {
      void vscode.window.showInformationMessage(
        "中止しました（1件も .md にしていません）。"
      );
      return;
    }
    void vscode.window.showErrorMessage(
      `1件も .md にできませんでした。${summarize(failed, "、")}`
    );
    return;
  }

  const ruby = done.reduce((total, entry) => total + entry.ruby, 0);
  const emphasis = done.reduce((total, entry) => total + entry.emphasis, 0);
  const kept: string[] = [];
  if (ruby > 0) kept.push(`ルビ${ruby}件`);
  if (emphasis > 0) kept.push(`傍点${emphasis}件`);
  const keptNote = kept.length > 0 ? `（${kept.join("・")}を保存）` : "";

  const notes = [
    // **中止したことを先に言う。** 「3件を .md にしました」だけだと、
    // 残りが飛ばされたことに気づけないまま作者が次へ進んでしまう
    (cancelled
      ? `中止しました（${done.length}件まで .md にしました${keptNote}）`
      : `${done.length}件を .md にしました${keptNote}`) +
      "。元の .docx はそのまま残っています。",
  ];

  const dropped = done
    .filter((entry) => entry.skipped.length > 0)
    .map((entry) => `${entry.name}：${entry.skipped.join("、")}`);
  if (dropped.length > 0) {
    notes.push(`入らなかったもの → ${summarize(dropped, " / ")}`);
  }
  if (failed.length > 0) {
    // **落としたもの側と同じ揃え方にする。** 片方だけ全部並べると、
    // 失敗が多いときに限って通知が画面を覆う
    notes.push(
      `${failed.length}件は変換できませんでした：${summarize(failed, "、")}`
    );
  }
  if (legacy > 0) {
    notes.push(
      `古い形式の .doc が${legacy}件ありますが、こちらは変換できません` +
        "（Word で .docx として保存し直してください）。"
    );
  }

  const action = await vscode.window.showInformationMessage(
    notes.join(" "),
    "フォルダーを開く"
  );
  if (action === "フォルダーを開く") await revealFolder(folder);
}
