import * as vscode from "vscode";
import * as path from "../core/paths";
import { atomicWriteFile } from "../core/atomicWrite";
import { pathExists } from "../core/fileSystem";
import { logFailure, useLogFile } from "../core/logger";
import { parsePlotMarkdown } from "../core/plotDoc";
import { readPlotText, writePlotSections } from "../core/plotFile";
import {
  buildSynopsisMarkdown,
  SYNOPSIS_FILE,
  type SynopsisDoc,
} from "../core/synopsisDoc";
import {
  plotDraftFromWorkInfo,
  synopsisDraftFromWorkInfo,
} from "../core/workInfoDraft";
import { formatCount } from "../core/charCount";
import { readWorkConfig, scaffoldWorkFolder, workPaths } from "../core/workRegistry";
import {
  inspectWorkZip,
  WorkZipError,
  type WorkZipInspection,
} from "../core/workZip";
import type { WorkInfo } from "../core/workInfoParse";
import { DEFAULT_MANUSCRIPT_DIR, type WorkEntry } from "../models/types";
import type { WorkLocation } from "../core/libraryHome";
import type { CollectionOptions } from "./addCollection";
import { askText } from "../views/dialogs";
import { confirmRun } from "../views/notify";
import { revealFolder } from "../views/openDocument";
import { withProgress } from "../views/progress";
import { resolveNewWorkHome } from "./newWorkHome";

/**
 * ZIPから作品を取り込む（設計書6.99）。
 *
 * 作者の指示（2026-09-19）：「初心者が初めて使うところを魅せたい」。
 * カクヨム・なろうからダウンロードしたバックアップのZIPを渡せば、
 * 展開・作品フォルダーの用意・登録までが一度に済む。
 *
 * ## 作品名を打たせない
 *
 * 題は `about.txt` の【タイトル】から採る（無ければZIPのファイル名から）。
 * **入力欄は出すが、既定値が入っている**ので、そのままEnterで進める。
 * 打たせないことと、直せないことは違う。
 *
 * ## すでに書いてあるものを、AIに作り直させない
 *
 * `about.txt` にはキャッチコピー・紹介文・ジャンル・タグが入っている。
 * これを捨てて「AIで紹介文を作りましょう」と言うのは、作者が書いた
 * ものを見ていないのと同じである。**空の欄にだけ**下書きとして置く
 * （実装ルール2。新しい作品なので普通は空だが、確かめてから入れる）。
 *
 * ## 決め事は、ここでは決めない
 *
 * 置き場は `newWorkHome.ts`、登録は `extension.ts` の
 * `registerFolderAsWork`、ZIPの読み取りは `core/workZip.ts` が持つ。
 * ここがするのは**順に繋ぐことと、作者に確かめること**だけである。
 */

/** 作品として登録する道。`extension.ts` の `registerFolderAsWork` を渡す */
export type RegisterWork = (
  folderPath: string,
  title: string,
  options: CollectionOptions
) => Promise<WorkEntry | undefined>;

export async function importWorkFromZip(
  works: readonly WorkLocation[],
  register: RegisterWork
): Promise<void> {
  const zipPath = await pickZipFile();
  if (!zipPath) return;

  const inspection = await inspectPickedZip(zipPath);
  if (!inspection) return;

  if (!(await confirmImport(zipPath, inspection))) return;

  // **置き場を決めてから題を訊く。** 逆にすると、名前を考えたあとで
  // 「どこに作りますか」と訊かれる（書庫の決め方は 6.97.2 のまま）
  const home = await resolveNewWorkHome(works);
  if (!home) return;

  const title = await askWorkTitle(inspection, home.note);
  if (!title) return;

  const folderPath = path.join(home.folderPath, title);
  if (await pathExists(folderPath)) {
    // **上書きしない**（実装ルール1・2）。同じ名前の作品が既にあるなら、
    // 中身を混ぜるより、名前を変えてもらうほうが取り返しがつく
    await vscode.window.showWarningMessage(
      `「${title}」はすでにあります。`,
      {
        modal: true,
        detail: [
          `${folderPath} がすでに存在するため、取り込みを中止しました。`,
          "",
          "中のファイルを上書きしないための決まりです。",
          "別の作品名でもう一度お試しください。",
        ].join("\n"),
      }
    );
    return;
  }

  // **ここから先の失敗は、その作品の記録へ残す**（`logFileRouting.test.ts`）。
  // 出力チャンネルにしか残らないと、VS Code を閉じた時点で手がかりが消える。
  // 場所が決まるのはここが最初である（ZIPを読むところまでは作品が無い）
  useLogFile(folderPath);

  const extracted = await extractInto(folderPath, title, inspection);
  if (!extracted) return;

  /*
    登録は「フォルダから追加」と同じ道を通る（写しを作らない）。

    **ただし「書庫かもしれない」の見分けだけは通さない**（`knownSingleWork`）。
    いま作ったのはこの作品フォルダー1つで、`本文/` と `設定/` を置いたのも
    ここである。それを見分けの道へ入れると、`設定/` があるせいで
    「作品にも書庫にも見えます」と訊かれ、**しかも既定は書庫のほう**を
    指す（2026-09-19、作者の実機確認）。知っていることを訊かない。
  */
  const entry = await register(folderPath, title, { knownSingleWork: true });
  if (!entry) return;

  const placed = inspection.info
    ? await applyWorkInfo(entry, inspection.info)
    : [];

  await reportResult(entry, inspection, placed);
}

/**
 * ZIPを選ぶ。
 *
 * **フォルダー選択（`pickFolder.ts`）とは分ける。** あちらはブラウザ版で
 * 「開いているフォルダーから選ぶ」へ切り替える必要があるが、ZIPは
 * ワークスペースの中にあるとはかぎらない。ダイアログが出せない環境では
 * 何も選ばれずに戻るだけで、原稿には触れない。
 */
async function pickZipFile(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "このZIPを取り込む",
    title: "取り込むZIPファイルを選ぶ",
    filters: { "ZIPファイル": ["zip"] },
  });
  if (!picked || picked.length === 0) return undefined;
  return path.fromUri(picked[0]);
}

/** 読んで確かめる。**この時点では1文字も書かない** */
async function inspectPickedZip(
  zipPath: string
): Promise<WorkZipInspection | undefined> {
  try {
    const bytes = await withProgress("ZIPの中を見ています…", async () =>
      vscode.workspace.fs.readFile(path.toUri(zipPath))
    );
    return inspectWorkZip(bytes, path.basename(zipPath));
  } catch (error) {
    if (error instanceof WorkZipError) {
      await vscode.window.showWarningMessage(error.message, {
        modal: true,
        detail: error.detail,
      });
      return undefined;
    }
    logFailure("ZIPの読み取り", {
      ファイル: zipPath,
      詳細: error instanceof Error ? error.message : String(error),
    });
    await vscode.window.showErrorMessage(
      `ZIPを読めませんでした：${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
}

/**
 * 何が入っているかを見せてから確認を取る（設計書6.81の規則1）。
 *
 * **展開する前に見せる。** 取り込んだあとで「思っていたものと違った」と
 * 分かっても、作者はフォルダーごと消すしかない。
 */
async function confirmImport(
  zipPath: string,
  inspection: WorkZipInspection
): Promise<boolean> {
  const lines = [
    `取り込む元：${path.basename(zipPath)}`,
    `作品名：${inspection.title}` +
      (inspection.titleSource === "about"
        ? "（作品情報から採りました。次の画面で直せます）"
        : "（ZIPの名前から採りました。次の画面で直せます）"),
    "",
    `話のファイル：${inspection.episodeCount}件`,
    `合計の文字数：${formatCount(inspection.totalChars)}字`,
  ];

  const info = inspection.info;
  if (info) {
    const found = [
      info.catchphrase ? "キャッチコピー" : "",
      info.blurb ? "紹介文" : "",
      info.genre ? "ジャンル" : "",
      info.tags.length > 0 ? `タグ${info.tags.length}件` : "",
    ].filter((item) => item !== "");
    lines.push(
      "",
      found.length > 0
        ? `作品情報（about.txt）から下書きにできるもの：${found.join("・")}`
        : "作品情報（about.txt）が入っていますが、使える欄はありませんでした。"
    );
  }

  if (inspection.skipped.length > 0) {
    lines.push(
      "",
      `原稿ではないファイル${inspection.skipped.length}件は入れません` +
        "（.txt と .md だけを取り込みます）。"
    );
  }

  return confirmRun("この内容で作品を作りますか？", "取り込む", {
    detail: lines.join("\n"),
  });
}

/** 題を直せるようにして訊く。既定値が入っているのでEnterだけで進める */
async function askWorkTitle(
  inspection: WorkZipInspection,
  homeNote: string
): Promise<string | undefined> {
  const title = await askText({
    title: homeNote,
    value: inspection.title,
    prompt: "作品名を確かめてください（フォルダ名になります）",
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return "作品名を入力してください";
      if (/[/\\:*?"<>|]/.test(trimmed)) {
        return "フォルダ名に使えない文字が含まれています";
      }
      return null;
    },
  });
  return title?.trim() || undefined;
}

/**
 * 作品フォルダーを作って、中身を書き出す。
 *
 * **書き込みは `mode: "create"` だけ**（新規作成しか行わないと決めて
 * おけば、上書きの経路が紛れ込む余地がない。`docxImport.ts` と同じ流儀）。
 * `scaffoldWorkFolder` も、すでにあるフォルダーには作らない。
 *
 * プロットの雛形は置かない（`withPlot: false`）。すでに書き上がっている
 * 原稿を入れるのだから、見出しだけのプロットは邪魔になる。**`about.txt`
 * から書くものがあるときだけ**、あとで `plot.md` ができる。
 */
async function extractInto(
  folderPath: string,
  title: string,
  inspection: WorkZipInspection
): Promise<boolean> {
  try {
    await scaffoldWorkFolder(folderPath, title, { withPlot: false });

    // `scaffoldWorkFolder` が置いたばかりの設定は既定のままなので、
    // 本文の置き場も既定である（登録前で `WorkEntry` がまだ無い）
    const manuscript = path.join(folderPath, DEFAULT_MANUSCRIPT_DIR);

    await withProgress("ZIPから原稿を取り出しています…", async (progress) => {
      for (const [index, file] of inspection.files.entries()) {
        progress.report({
          message: `${inspection.files.length}件中 ${index + 1}件目（${file.name}）`,
        });
        const target = path.join(manuscript, file.name);
        await vscode.workspace.fs.createDirectory(
          path.toUri(path.dirname(target))
        );
        await atomicWriteFile(target, file.bytes, { mode: "create" });
      }
    });
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logFailure("ZIPからの取り込み", { 作品: title, 詳細: detail });
    await vscode.window.showErrorMessage(
      `取り込みに失敗しました：${detail} ` +
        `途中まで作られたものが「${folderPath}」に残っていることがあります。` +
        "中をご確認のうえ、要らなければ削除してください。"
    );
    return false;
  }
}

/**
 * `about.txt` の中身を、製品の置き場へ下書きとして置く。
 *
 * **どこへ置いてよいかは `core/workInfoDraft.ts` が決める**（空の欄にだけ、
 * という一番間違えやすい決まりを試験にかけられるようにするため）。
 * ここがするのは、いまの中身を読んで渡すことと、書くことだけである。
 *
 * @returns 実際に置いたものの名前（作者への報告に使う）
 */
async function applyWorkInfo(
  work: WorkEntry,
  info: WorkInfo
): Promise<string[]> {
  const placed: string[] = [];

  try {
    placed.push(...(await writeSynopsisIfAbsent(work, info)));
  } catch (error) {
    // **設定資料を置けなくても、取り込みそのものは成り立っている。**
    // ここで止めると、登録済みの作品が中途半端に見える
    logFailure("作品情報からの紹介文の下書き", {
      作品: work.title,
      詳細: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const filled = await writePlotFromInfo(work, info);
    placed.push(...filled);
  } catch (error) {
    logFailure("作品情報からのプロットの下書き", {
      作品: work.title,
      詳細: error instanceof Error ? error.message : String(error),
    });
  }

  return placed;
}

/**
 * `設定/synopsis.md` がまだ無いときだけ作る。
 *
 * **あれば触らない。** 作者が書いた紹介文が、取り込みの下書きで
 * 押し流されることが無いようにする（判断は `workInfoDraft.ts`）。
 */
async function writeSynopsisIfAbsent(
  work: WorkEntry,
  info: WorkInfo
): Promise<readonly string[]> {
  const config = await readWorkConfig(work);
  const target = path.join(workPaths(work, config).settings, SYNOPSIS_FILE);
  const existing = (await pathExists(target)) ? emptySynopsisDoc() : null;

  const draft = synopsisDraftFromWorkInfo(info, existing);
  if (!draft) return [];

  const body = buildSynopsisMarkdown(work.title, draft.doc);
  await vscode.workspace.fs.createDirectory(
    path.toUri(path.dirname(target))
  );
  await atomicWriteFile(target, new TextEncoder().encode(body), {
    mode: "create",
  });
  return draft.labels;
}

/**
 * 「すでに文書がある」ことだけを伝えるための値。
 *
 * 中身は読まない——**あると分かった時点で触らない**ので、読み取って
 * 比べる必要が無い（読んで書き戻す道を作れば、そこが上書きの経路になる）。
 */
function emptySynopsisDoc(): SynopsisDoc {
  return { catchphrase: null, blurb: "" };
}

/** プロットの空いている節にだけ書き足す。戻りは置いたものの名前 */
async function writePlotFromInfo(
  work: WorkEntry,
  info: WorkInfo
): Promise<readonly string[]> {
  const current = parsePlotMarkdown(await readPlotText(work));
  const draft = plotDraftFromWorkInfo(info, current.sections);
  if (draft.labels.length === 0) return [];

  await writePlotSections(work, draft.updates);
  return draft.labels;
}

/**
 * 結果を伝える（設計書6.81の規則3）。
 *
 * **登録できたことは `registerFolderAsWork` が既に伝えている**ので、
 * ここで言うのは「`about.txt` から何を下書きにしたか」である。
 * 作者が次に確かめる場所が変わる。
 */
async function reportResult(
  work: WorkEntry,
  inspection: WorkZipInspection,
  placed: readonly string[]
): Promise<void> {
  const notes = [
    `${inspection.episodeCount}話を取り込みました。`,
    placed.length > 0
      ? `作品情報から ${placed.join("・")} を下書きとして置きました（設定フォルダーにあります）。`
      : "",
    inspection.skipped.length > 0
      ? `原稿ではないファイル${inspection.skipped.length}件は入れていません。`
      : "",
  ].filter((note) => note !== "");

  const action = await vscode.window.showInformationMessage(
    notes.join(" "),
    "フォルダーを開く"
  );
  if (action === "フォルダーを開く") await revealFolder(work.folderPath);
}
