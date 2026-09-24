import { findExtensionVariant, pickFileHints, type FileHint } from "./chatEdit";
import { SYNOPSIS_FILE } from "./synopsisDoc";

/**
 * 相談（P-21）で、AIが求めたファイル（`needFiles`）を読んで聞き直すための部品
 * （設計書6.19・6.87.8）。
 *
 * **製品の相談パネル（`features/workChatPanel.ts`）と、MCP の相談
 * （`mcp/tools/chat.ts`）が同じものを通る**（0.85.1）。以前はパネルの中に
 * しか無く、MCP は1往復で止まっていた——AIが `needFiles` を返すとそこで
 * 終わるので、製品で起きる「読めなかったときの聞き直し」（0.84.7）を
 * 外から測れなかった。写しを作ると、読み方・上限・候補の選び方が片方だけ
 * 直ってずれる。
 *
 * ファイルの読み方（`vscode.workspace.fs` か Node の `fs` か）だけは呼ぶ側が
 * 渡す（`RequestedFileAccess`）。**作品フォルダーの外を指していないかの確かめも
 * 読む側の仕事**——パスの形の関門（`sanitizeRequestedPaths`）は通したあとでも、
 * 解決したパスが本当に中かを、読む直前にもう一度見る。
 *
 * `vscode` に依存しない。
 */

/** AIの求めに応じて読むファイルの上限。読みすぎると入力が膨らむ */
export const MAX_REQUESTED_FILES = 3;
/** 1ファイルあたりに渡す上限 */
export const REQUESTED_FILE_CHARS = 6_000;
/**
 * 求められたファイルが見つからなかったとき、代わりに示す候補の数。
 * 目次を全部並べると、219話の作品で数千字になる。番号の近いものを
 * 先に選ぶ（`pickFileHints`）ので、この数で足りる
 */
export const MISSING_FILE_HINTS = 8;
/**
 * 全体像に並べる話数の上限。
 *
 * 219話の作品でそのまま並べると4,000字を超え、
 * 肝心の本文の抜粋が入らなくなる。
 */
export const OVERVIEW_EPISODE_LIMIT = 40;
/** 全体像に載せる紹介文・プロットの上限 */
export const OVERVIEW_FILE_CHARS = 2_000;

/**
 * 材料の見出し。**定数で持つ**——製品は送った量を見出しで分けて測る
 * （`workChatPanel.ts` の `referenceChars`）ので、組む側と測る側で同じ文字を使う。
 */
export const OVERVIEW_HEADING = "【作品の全体像】";
export const CHARACTER_NAMES_HEADING = "登場人物: ";

/**
 * 全体像に載せる設定の文書（`設定/` の下）。**並びもここで決める**。
 * 製品と MCP が同じファイルを同じ順で読むため。
 */
export const CHAT_OVERVIEW_DOCUMENTS: ReadonlyArray<{ label: string; file: string }> = [
  { label: "作品紹介文・各話あらすじ", file: SYNOPSIS_FILE },
  { label: "プロット", file: "plot.md" },
];

/** 求められたファイルを読む口。**作品フォルダーの外は読まない**（呼ぶ側が確かめる） */
export interface RequestedFileAccess {
  /** 作品フォルダーからの相対で1つ読む。外を指す・無い・読めないなら undefined */
  readText(relative: string): Promise<string | undefined>;
  /**
   * そのファイルと同じフォルダーにあるファイルの名前。
   * フォルダーごと無い・読めないなら undefined（拡張子違いを引き当てない）
   */
  siblingNames(relative: string): Promise<readonly string[] | undefined>;
}

/**
 * AIが求めたファイルを読む。
 *
 * **無いファイルは、拡張子だけ違う原稿が1つだけあればそれを読む**
 * （`findExtensionVariant`。2026-09-24、`.txt` を求められて実物は `.md`
 * だった）。それでも読めなかったものは `missing` に入れて返す——以前は
 * 黙って飛ばしており、1つも読めないと作者には何が起きたか分からなかった。
 *
 * @param wanted `sanitizeRequestedPaths` を通した相対パス
 */
export async function readRequestedFiles(
  wanted: readonly string[],
  access: RequestedFileAccess
): Promise<{
  files: Array<{ path: string; content: string }>;
  missing: string[];
}> {
  const files: Array<{ path: string; content: string }> = [];
  const missing: string[] = [];

  for (const relative of wanted) {
    let actual = relative;
    let text = await access.readText(relative);
    if (text === undefined) {
      const names = await access.siblingNames(relative);
      const variant = names ? findExtensionVariant(relative, names) : undefined;
      if (variant) {
        text = await access.readText(variant);
        if (text !== undefined) actual = variant;
      }
    }
    if (text === undefined) {
      missing.push(relative);
      continue;
    }
    // `a.txt` と `a.md` を両方求められ、どちらも `a.md` に行き着くことがある。
    // 同じ中身を2回渡すと入力が膨らむだけなので1回にする
    if (files.some((file) => file.path === actual)) continue;
    files.push({
      path: actual,
      content:
        text.length > REQUESTED_FILE_CHARS
          ? `${text.slice(0, REQUESTED_FILE_CHARS)}\n（以下省略）`
          : text,
    });
  }
  return { files, missing };
}

/**
 * 求められたファイルが見つからなかったとき、AIへ示す候補を組む。
 *
 * **目次（全体像の話の一覧）と同じ一覧から作る**のは呼ぶ側の約束。
 * 別の数え方をすると、全体像には載っているのに候補には無い、という
 * 食い違いが起きる。
 */
export function missingFileHintsFrom(
  missing: readonly string[],
  all: readonly FileHint[]
): { available: FileHint[]; availableTotal: number } {
  return {
    available: pickFileHints(missing, all, MISSING_FILE_HINTS),
    availableTotal: all.length,
  };
}

/**
 * 作品の全体像を、畳んだ形で組み立てる。
 *
 * **全文は渡せない**（78.5万字の作品がある）ので、作品紹介文・プロットの
 * 要点・話数の一覧という「目次」を渡す。どこに何があるかが分かれば、
 * AIは needFiles で必要な話を求められる。
 *
 * **題にファイルの場所を添える。** 題だけだと、AI は needFiles のパスを
 * 当て推量で書き、拡張子や表記を取り違える（2026-09-24、`episode_0001.txt`
 * を求めたが実物は `.md` だった）。
 *
 * @param episodes 話の一覧（作品フォルダーからの相対パスと表示名）。並びは呼ぶ側の走査のまま
 * @param documents `CHAT_OVERVIEW_DOCUMENTS` を読んだ中身。無い・空のものは渡さない
 */
export function formatChatOverview(input: {
  episodes: readonly FileHint[];
  documents: ReadonlyArray<{ label: string; file: string; text: string }>;
}): string | undefined {
  const lines: string[] = [];

  const total = input.episodes.length;
  if (total > 0) {
    lines.push(`全${total}話。`);
    const labels = input.episodes.map((episode) => `${episode.label}（${episode.path}）`);
    // 多いときは先頭と末尾だけ見せる。**間を省いたことを明記する**
    // （省略に気づかないと「これで全部」と誤解する）
    if (labels.length <= OVERVIEW_EPISODE_LIMIT) {
      lines.push(`話の一覧: ${labels.join(" / ")}`);
    } else {
      const head = labels.slice(0, OVERVIEW_EPISODE_LIMIT / 2).join(" / ");
      const tail = labels.slice(-OVERVIEW_EPISODE_LIMIT / 2).join(" / ");
      lines.push(`話の一覧（多いため中間を省略）: ${head} …（中略）… ${tail}`);
    }
  }

  for (const document of input.documents) {
    const text = document.text.trim();
    if (!text) continue;
    lines.push(
      `【${document.label}（${document.file}）】\n` +
        (text.length > OVERVIEW_FILE_CHARS
          ? `${text.slice(0, OVERVIEW_FILE_CHARS)}\n（以下省略。全文が要るなら needFiles で求めてください）`
          : text)
    );
  }

  if (lines.length === 0) return undefined;
  return `${OVERVIEW_HEADING}\n${lines.join("\n")}`;
}
