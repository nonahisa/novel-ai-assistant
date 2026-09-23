import * as vscode from "vscode";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import { readTextFile, type TextFileContent } from "../core/textFile";
import { bookChaptersOf } from "../core/bookChapters";
import { atomicWriteFile } from "../core/atomicWrite";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { readWorkKind } from "../core/workKindStore";
import { readWorkFormat } from "../core/workFormatStore";
import type { WorkFormatKey } from "../core/workFormat";
import { bookHeading, episodeUnit } from "../core/episodeLabel";
import { timestampedFileNameCandidates } from "../core/timestampedFileName";
import {
  buildPrintHtml,
  MARGIN_CONTENTS,
  marginContentLabel,
  PRINT_PRESETS,
  printPreset,
  type HeaderFooter,
  type MarginContent,
  type PrintEpisode,
  type PrintPreset,
} from "../core/printHtml";
import { notationModeFor } from "../core/manuscriptRender";
import { BookStore } from "../core/bookStore";
import {
  buildGridPrintHtml,
  GRID_HEADER_FOOTER,
  type GridPaper,
} from "../core/printGridHtml";
import { layoutGrid, type GridOptions } from "../core/manuscriptGrid";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";
import { revealFolder } from "../views/openDocument";
import { openInDefaultApp } from "../core/openExternalFile";
import { logFailure, useLogFile } from "../core/logger";

/**
 * 本文を印刷用に組んで、ブラウザで開く（PDF出力）。
 *
 * **PDFを直接は作らない。** 理由は `core/printHtml.ts` の頭に書いた
 * ——日本語の縦書き・ルビ・傍点・禁則をきちんと組めるPDF生成の道具が
 * 実質無く、ブラウザの組版エンジンに任せるほうが仕上がりが良い。
 * ここは「組んだHTMLを作品の中へ置いて、ブラウザへ渡す」までを持つ。
 *
 * **原稿は読むだけで、1文字も書き換えない。**
 *
 * ## 書き出し先は `.aiwriter/exports/`
 *
 * 登録時の `.gitignore` 整備で除外済み（`core/workRegistry.ts` の
 * `IGNORED_PATHS`）。組み直せるものをGitへ載せると、話を1つ直すたびに
 * 履歴が膨らむ。
 *
 * **既存ファイルへは書かない**（`atomicWrite.ts` の設計では、そもそも
 * 置換は必ず失敗する）。名前がぶつかったら秒・連番で別名にする。
 */
export async function exportPdf(work: WorkEntry): Promise<void> {
  const scan = await scanWork(work);
  if (scan.episodes.length === 0) {
    void vscode.window.showInformationMessage(
      `「${work.title}」に本文のファイルが見つかりません。`
    );
    return;
  }

  const format = await readWorkFormat(work);
  const unit = episodeUnit(format);
  // 組み方は種類で決まる（設計書6.109）。形式（長さ）とは別の軸
  const kind = await readWorkKind(work);

  const selected = await pickEpisodes(scan.episodes, unit.noun, format);
  if (!selected || selected.length === 0) return;

  const paper = await pickPaper();
  if (!paper) return;

  // 上下の余白に刷るもの（設計書6.33.5 の2）。**書き出すときに選ぶだけで、
  // どこにも保存しない**——紙の大きさと同じ持ち方にそろえた
  const headerFooter = await pickHeaderFooter(
    paper.kind === "grid" ? GRID_HEADER_FOOTER : printPreset(paper.preset).headerFooter
  );
  if (!headerFooter) return;
  let author: string | undefined;
  if (headerFooter.top === "author" || headerFooter.bottom === "author") {
    author = await askAuthorName(work);
    if (author === undefined) return;
  }

  const chapters: PrintEpisode[] = [];
  /** 競合マーカーが残っている話。組んでも読めない紙になるので外す */
  const conflicted: string[] = [];
  /** 区切りだけで、紙に出る本文が1文字も無かった合本。**黙って減らさない** */
  const empty: string[] = [];
  for (const episode of selected) {
    let file: TextFileContent;
    try {
      file = await readTextFile(episode.filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // **記録の直前に書き先を向ける**（0.43.3 と同じ）
      useLogFile(work.folderPath);
      logFailure("印刷用HTMLの組み立て", {
        ファイル: episode.fileName,
        内容: message,
      });
      await vscode.window.showErrorMessage(
        `${episode.fileName} を読めませんでした。${message}`
      );
      return;
    }
    // **未解決の競合をそのまま組まない。** マーカーと両方の版が混ざった紙は
    // 読めないうえ、刷ってから気づくことになる
    if (file.hasConflictMarkers) {
      conflicted.push(episode.fileName);
      continue;
    }
    // 投稿サイトからDLしたファイルは、先頭にヘッダーが付いている。
    // 合本（1ファイルに複数話）は話ごとに割って、1話＝1章で組む
    // （設計書6.65.15。切り分けは `core/bookChapters.ts` が1か所で持ち、
    // EPUBと同じものを通す——別々に切ると、同じ原稿から出た本と紙で
    // 話の切れ目が違うことになる）
    const parts = bookChaptersOf(episode, file.text, format);
    if (parts.length === 0) {
      empty.push(episode.fileName);
      continue;
    }

    for (const part of parts) {
      chapters.push({
        heading: part.heading,
        body: part.body,
        // **話ごとに記法を見る。** 1つの作品に `.md` と `.txt` が混ざる
        // ことがある（DLした話と、こちらで書き足した話）
        notation: notationModeFor(episode.fileName),
      });
    }
  }

  if (chapters.length === 0) {
    // **理由で言い分ける**（EPUBと同じ）。競合が1つも無いのに
    // 「競合解決で直して」と言われると、作者は在りもしないマーカーを探す
    void vscode.window.showWarningMessage(
      conflicted.length > 0
        ? "選んだ本文はすべて未解決の競合を含んでいるため、書き出しませんでした。" +
            "「競合解決」で直してからもう一度お試しください。"
        : "紙に出せる本文がありませんでした。" + emptyNote(empty)
    );
    return;
  }

  // 公募の納品用（設計書6.33.5 の3）は1字1マスで組む。**種類ごとの組み方
  // （台本の柱・ト書きの字下げなど）は当てない**——字下げや寄せを入れると
  // 1行の字数が指定からずれる。公募の原稿は本文をそのまま升目に置く
  const html =
    paper.kind === "grid"
      ? buildGridPrintHtml({
          workTitle: work.title,
          episodes: chapters,
          paper: paper.paper,
          grid: paper.grid,
          headerFooter,
          author,
        })
      : buildPrintHtml({
          workTitle: work.title,
          episodes: chapters,
          preset: paper.preset,
          // **種類で組み方が変わる**（設計書6.70・6.109。台本は柱・ト書き・台詞）。
          // 上で読んだものをそのまま渡す——ここで読み直すと、選んでいる間に
          // 設定が書き換わったときに、見出しと組み方で別の種類を指す
          kind,
          headerFooter,
          author,
        });
  // 公募の規定は枚数で決まることが多い。刷る前に枚数が分かるよう知らせる
  const gridNote =
    paper.kind === "grid"
      ? `\n${paper.grid.columns}字×${paper.grid.rows}行で本文${
          layoutGrid(chapters, paper.grid).length
        }枚（扉を除く）です。`
      : "";

  let target: string;
  try {
    target = await writeExport(work, html);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useLogFile(work.folderPath);
    logFailure("印刷用HTMLの書き出し", { 作品: work.title, 内容: message });
    await vscode.window.showErrorMessage(
      `印刷用のファイルを保存できませんでした。${message}`
    );
    return;
  }

  // `.html` は既定のブラウザに関連づいている。VS Code の中で開くと
  // 印刷（Ctrl+P）が使えないので、外のブラウザへ渡す
  const opened = await openInDefaultApp(target);

  const droppedNote =
    gridNote +
    (conflicted.length > 0
      ? `\n未解決の競合を含む${conflicted.length}件は外しました（${conflicted.join(
          "、"
        )}）。`
      : "") + emptyNote(empty);

  // **開けたかどうかで案内を変える。** 以前は戻り値を見ずに
  // 「ブラウザで開きました」と告げており、VS Codeがエラーダイアログを
  // 出しているのに成功したことになっていた（作者の報告、2026-08-30）
  if (!opened) {
    useLogFile(work.folderPath);
    logFailure("印刷用HTMLをブラウザで開く", { 作品: work.title, 場所: target });
    const action = await vscode.window.showWarningMessage(
      "印刷用のファイルは作りましたが、ブラウザを開けませんでした。" +
        "フォルダーの中の .html をダブルクリックすると開きます。" +
        "開いたら印刷（Ctrl+P）で送信先を「PDFに保存」にしてください。" +
        droppedNote,
      "フォルダーを開く"
    );
    if (action === "フォルダーを開く") await revealFolder(target);
    return;
  }

  const action = await vscode.window.showInformationMessage(
    "ブラウザで開きました。画面に並んだ白い面が、そのまま紙1枚ずつになります。" +
      "印刷（Ctrl+P）で送信先を「PDFに保存」にするとPDFになります。" +
      "用紙サイズと余白は「既定」のままにし、「ヘッダーとフッター」のチェックは外してください。" +
      droppedNote,
    "フォルダーを開く"
  );
  if (action === "フォルダーを開く") await revealFolder(target);
}

/**
 * どの話を組むかを決める。
 *
 * **全部と、選ぶ、の2択にする。** 話が19本ある作品で毎回すべてに
 * チェックを入れさせるのは、いちばんよく使う道を遠回りにすることになる。
 */
async function pickEpisodes(
  episodes: readonly EpisodeFile[],
  noun: string,
  format: WorkFormatKey | undefined
): Promise<EpisodeFile[] | undefined> {
  const scope = await vscode.window.showQuickPick(
    [
      {
        label: `すべての${noun}（全${episodes.length}${noun}）`,
        detail: "登録されている本文をすべて、話数の順に並べます",
        all: true,
      },
      {
        label: `${noun}を選ぶ`,
        detail: "一部だけを本にするときに使います",
        all: false,
      },
      cancelItem(),
    ],
    {
      title: "PDFにする範囲を選んでください",
      ignoreFocusOut: true,
    }
  );
  if (!scope || isCancelItem(scope) || !("all" in scope)) return undefined;
  if (scope.all) return [...episodes];

  // **複数選択に「取りやめる」を足さない。** VS Code が自分で
  // 「OK」「キャンセル」を出すので、項目として並べるとかえって紛らわしい
  const picked = await vscode.window.showQuickPick(
    episodes.map((episode) => ({
      // 選ぶ画面の見出しは、紙に出る単話の見出しと同じ部品で作る
      // （合本は1行で1ファイルを指すので、割る前の見出しでよい）
      label: bookHeading(episode, format),
      description: episode.fileName,
      episode,
    })),
    {
      title: `PDFにする${noun}を選んでください`,
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );
  return picked?.map((item) => item.episode);
}

/** 紙の選び方。ふつうの紙（流し込み）か、公募の納品用（1字1マス） */
type PaperChoice =
  | { kind: "preset"; preset: PrintPreset }
  | { kind: "grid"; paper: GridPaper; grid: GridOptions };

async function pickPaper(): Promise<PaperChoice | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...PRINT_PRESETS.map((preset) => ({
        label: preset.label,
        detail: preset.detail,
        id: preset.id,
      })),
      // 公募の納品用（設計書6.33.5 の3）。字数・行数・向きは次の画面で決める
      {
        label: "公募の納品用（字数×行数を決める）",
        detail: "1ページの字数と行数を決めて、1字1マスで組みます。句読点・括弧の禁則処理つき",
        manuscript: true as const,
      },
      cancelItem(),
    ],
    {
      title: "紙の大きさと組み方を選んでください",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  if ("id" in picked) return { kind: "preset", preset: picked.id };
  if (!("manuscript" in picked)) return undefined;
  return pickGrid();
}

/**
 * 公募の納品用の組み方を決める：字数×行数 → 向きと紙 → ぶら下げ。
 *
 * **よくある字数×行数を先に並べる。** 募集要項に「40字×40行」とあれば
 * 1回で選べる。要項ごとに違う（42字×34行など）ので、自分で決める道も置く。
 */
async function pickGrid(): Promise<PaperChoice | undefined> {
  const size = await vscode.window.showQuickPick(
    [
      { label: "40字×40行", detail: "A4に縦書きで組む公募でよく使われます", columns: 40, rows: 40 },
      { label: "40字×30行", detail: "行間を広めにとる公募で使われます", columns: 40, rows: 30 },
      {
        label: "20字×20行（原稿用紙）",
        detail: "400字詰め原稿用紙と同じ。原稿用紙の枚数で数える公募に",
        columns: 20,
        rows: 20,
      },
      {
        label: "字数と行数を自分で決める",
        detail: "募集要項の指定（42字×34行など）に合わせます",
        custom: true as const,
      },
      cancelItem(),
    ],
    { title: "1ページの字数と行数を選んでください（募集要項の指定に合わせます）", ignoreFocusOut: true }
  );
  if (!size || isCancelItem(size)) return undefined;
  let columns: number;
  let rows: number;
  if ("columns" in size && size.columns !== undefined && size.rows !== undefined) {
    columns = size.columns;
    rows = size.rows;
  } else {
    const typedColumns = await askGridNumber("1行の字数", "40");
    if (typedColumns === undefined) return undefined;
    const typedRows = await askGridNumber("1ページの行数", "40");
    if (typedRows === undefined) return undefined;
    columns = typedColumns;
    rows = typedRows;
  }

  const layout = await vscode.window.showQuickPick(
    [
      {
        label: "縦書き・A4横置き",
        detail: "用紙を横長に使い、右から左へ行が進みます。縦書きの公募で多い形です",
        paper: "a4-landscape" as const,
        vertical: true,
      },
      {
        label: "縦書き・A4縦置き",
        detail: "用紙を縦長に使います。行が多いと字が小さくなります",
        paper: "a4-portrait" as const,
        vertical: true,
      },
      {
        label: "横書き・A4縦置き",
        detail: "横書きの公募に。半角の英数字は2字で1マスに入れます",
        paper: "a4-portrait" as const,
        vertical: false,
      },
      cancelItem(),
    ],
    { title: "向きと用紙を選んでください", ignoreFocusOut: true }
  );
  if (!layout || isCancelItem(layout) || !("paper" in layout)) return undefined;

  const hang = await vscode.window.showQuickPick(
    [
      {
        label: "句読点をぶら下げる",
        detail: "行末からはみ出す「。」「、」を、行の外（余白）に書きます。原稿用紙の書き方です",
        hanging: true,
      },
      {
        label: "句読点をぶら下げない",
        detail: "「。」「、」が行の頭に来るときは、前の字ごと次の行へ送ります",
        hanging: false,
      },
      cancelItem(),
    ],
    { title: "行末の句読点の扱いを選んでください", ignoreFocusOut: true }
  );
  if (!hang || isCancelItem(hang) || !("hanging" in hang)) return undefined;

  return {
    kind: "grid",
    paper: layout.paper,
    grid: { columns, rows, hanging: hang.hanging, vertical: layout.vertical },
  };
}

/** 自分で決める字数・行数の幅。小さすぎても大きすぎても、紙として読めない */
const GRID_MIN = 5;
const GRID_MAX = 60;

async function askGridNumber(
  what: string,
  example: string
): Promise<number | undefined> {
  const typed = await askText({
    title: what,
    prompt: `${what}を数字で入れてください（${GRID_MIN}〜${GRID_MAX}）`,
    placeHolder: `例：${example}`,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!/^\d+$/.test(trimmed)) return "半角の数字で入れてください";
      const number = Number(trimmed);
      if (number < GRID_MIN || number > GRID_MAX) {
        return `${GRID_MIN}から${GRID_MAX}までの数にしてください`;
      }
      return undefined;
    },
  });
  if (typed === undefined) return undefined;
  return Number(typed.trim());
}

/**
 * 上下の余白（ヘッダー・フッター）に刷るものを決める。
 *
 * **いちばん上は「この紙の既定のまま」。** 毎回2つ選ばせると、いちばん
 * よく使う道が遠回りになる。既定の中身は項目の横に書いて見せる。
 *
 * ブラウザの印刷画面にも「ヘッダーとフッター」（日付とファイルの場所）が
 * あり、名前が同じで紛らわしい。こちらは紙の余白に刷る中身で、あちらは
 * 外すもの——と項目の説明で言い分ける。
 */
async function pickHeaderFooter(
  defaults: HeaderFooter
): Promise<HeaderFooter | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "この紙の既定のまま",
        description: `上：${marginContentLabel(defaults.top)}／下：${marginContentLabel(
          defaults.bottom
        )}`,
        detail:
          "ブラウザの印刷画面の「ヘッダーとフッター」（日付とファイルの場所）とは別のものです。あちらは外してください",
        margins: "default" as const,
      },
      {
        label: "上と下を選ぶ",
        detail: "題名・話の見出し・作者名・ページ番号・なし から選びます",
        margins: "choose" as const,
      },
      cancelItem(),
    ],
    {
      title: "ページの上と下の余白に何を刷るか選んでください",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("margins" in picked)) return undefined;
  if (picked.margins === "default") return defaults;

  const top = await pickMargin("上の余白（ヘッダー）に刷るもの", defaults.top);
  if (!top) return undefined;
  const bottom = await pickMargin("下の余白（フッター）に刷るもの", defaults.bottom);
  if (!bottom) return undefined;
  return { top, bottom };
}

async function pickMargin(
  title: string,
  byDefault: MarginContent
): Promise<MarginContent | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...MARGIN_CONTENTS.map((item) => ({
        label: item.label,
        description: item.id === byDefault ? "この紙の既定" : undefined,
        detail: item.detail,
        margin: item.id,
      })),
      cancelItem(),
    ],
    { title, ignoreFocusOut: true }
  );
  if (!picked || isCancelItem(picked) || !("margin" in picked)) return undefined;
  return picked.margin;
}

/**
 * 余白に刷る作者名を尋ねる。取りやめたら undefined。
 *
 * **EPUBの設計図（`設定/書籍/book.json`）に筆名があれば、初めから入れて
 * 見せる。** 同じ名前を二度打たせない。ただし**ここで入れた名前は設計図へ
 * 書き込まない**——PDFの余白に刷る名前を変えただけで、本の奥付まで
 * 変わってしまうのは、作者の思っていない書き換えになる。
 *
 * 設計図が壊れていて読めなくても止めない（ここは読むだけで、直すのは
 * EPUBエディターの役目）。空欄から尋ねる。
 */
async function askAuthorName(work: WorkEntry): Promise<string | undefined> {
  let known = "";
  try {
    known = (await new BookStore(work).load()).author;
  } catch {
    known = "";
  }
  const typed = await askText({
    title: "余白に刷る作者名",
    prompt:
      "上下の余白に刷る作者名（筆名）を入れてください。この書き出しにだけ使い、どこにも保存しません。",
    value: known,
    placeHolder: "例：山田太郎",
  });
  return typed === undefined ? undefined : typed.trim();
}

/**
 * 本文が1文字も無かった合本を伝える言葉。無ければ空文字。
 *
 * **黙って減らさない。** 話が紙に入らなかった理由は、作者にしか直せない
 * （EPUBの同じ場面と揃えてある）。
 */
function emptyNote(empty: readonly string[]): string {
  if (empty.length === 0) return "";
  return `\n紙に出る本文が無かった${empty.length}件は外しました（${empty.join(
    "、"
  )}）。`;
}

/** 書き出し先。**新規作成だけ**を使い、名前がぶつかったら別名にする */
async function writeExport(work: WorkEntry, html: string): Promise<string> {
  const config = await readWorkConfig(work);
  const directory = path.join(workPaths(work, config).aiwriter, EXPORT_DIR);
  await vscode.workspace.fs.createDirectory(path.toUri(directory));

  const target = await freshExportPath(directory, new Date());
  await atomicWriteFile(target, new TextEncoder().encode(html), {
    mode: "create",
  });
  return target;
}

/** 組み直せるものの置き場所。`.gitignore` で除外済み */
const EXPORT_DIR = "exports";

/**
 * まだ使われていない保存先を決める。
 *
 * 名前の作り方は `timestampedFileName.ts`（相談メモと同じ規則）。
 */
async function freshExportPath(
  directory: string,
  at: Date
): Promise<string> {
  for (const name of timestampedFileNameCandidates("印刷用", at, ".html")) {
    const target = path.join(directory, name);
    try {
      await vscode.workspace.fs.stat(path.toUri(target));
    } catch {
      // 読めない＝まだ無い。ここへ書く
      return target;
    }
  }
  throw new Error("書き出し先の名前を決められませんでした。");
}
