import type { WorkPdfExportConfig } from "../models/types";
import {
  describeHeaderFooter,
  emptyHeaderFooter,
  MARGIN_CONTENTS,
  PRINT_PRESETS,
  printPreset,
  type HeaderFooter,
  type MarginContent,
  type MarginRow,
  type PageMargins,
  type PrintPreset,
} from "./printHtml";
import { GRID_MARGINS, GRID_PAPERS, gridHeaderFooter, type GridPaper } from "./printGridHtml";
import { isRecord } from "./isRecord";

/**
 * ［PDF出力］の前回の設定（`.aiwriter/config.json` の `pdfExport`）の読み方と使い方。
 * **VS Code に依存しない**（作品の設定の読み `parseWorkConfig` から呼ばれる）。
 *
 * 作者の裁定 2026-10-16 夜の3：外部AIからの PDF の書き出し（`run.request` の
 * `exportPdf`）は、**作品の前回の書き出しの設定**を使う。無ければ文庫サイズ・縦書き・
 * 全話。それまでの［PDF出力］は選んだものをどこにも覚えていなかったので、
 * 作者が画面で書き出せたときに、紙・向き・範囲だけをここへ覚えるようにした。
 *
 * **覚えるのは紙・向き・範囲と、上下の余白の置き方**（奇数・偶数ページごとの
 * ヘッダー・フッターの左・中央・右。2026-10-17 から）。**作者名そのものは覚えない**
 * （［PDF出力］は「どこにも保存しません」と言って作者名を訊いている。覚えるのは
 * 「作者名をどこに置くか」だけで、外部AIの依頼ではその枠を空ける）。
 *
 * **置き場を作品の設定にしたのは**、紙と範囲が作品の性格（文庫で刷る作品、
 * 公募の 40字×40行 で出す作品）だからである。名前の系統（`nameOrigin`）と
 * 同じく、別の機械でも同じ設定で書き出せてよい。
 */

/** 公募の納品用で、自分で決める字数・行数の幅。小さすぎても大きすぎても紙として読めない */
export const GRID_MIN = 5;
export const GRID_MAX = 60;

/** 前回の記録が無いときの設定（文庫サイズ・縦書き・全話。作者の裁定） */
export const DEFAULT_PDF_EXPORT: WorkPdfExportConfig = {
  // 一覧の先頭（文庫サイズ・縦書き）。`satisfies` で写しの id がずれたら型検査で落とす
  paper: { kind: "preset", preset: PRINT_PRESETS[0].id satisfies PrintPreset },
  range: { scope: "all" },
};

/** 区切りを `/` に揃える。符号で書くのは、正規表現の中の円記号が読みにくいため */
export function normalizeRelativePath(relative: string): string {
  return relative.replace(/[\u005C]/g, "/");
}

/**
 * 読む。**壊れていても投げない**——欄ごと無かったことにする（`parseAnnounceConfig` と
 * 同じ理由。手で書き間違えたせいで作品が開けなくなるほうが困る）。半端に読まない：
 * 紙だけ読めて範囲が読めないときに「全話」へ寄せると、作者が選んだつもりの範囲が
 * 黙って変わる。
 */
export function parsePdfExportConfig(raw: unknown): WorkPdfExportConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const paper = parsePaper(raw.paper);
  const range = parseRange(raw.range);
  if (!paper || !range) return undefined;
  if (raw.headerFooter === undefined) return { paper, range };
  // 置き方が読めないときも、紙・範囲ごと無かったことにする（半端に読まない。
  // 作者が選んだつもりの置き方が、黙って紙の既定に変わらないように）
  const headerFooter = parseHeaderFooter(raw.headerFooter);
  if (!headerFooter) return undefined;
  return { paper, range, headerFooter };
}

/**
 * 余白の置き方を読む。今の形（奇数・偶数 × 上・下 × 左・中央・右）のほかに、
 * **前の形（上と下に1つずつ。`{ top, bottom }`）も読む**——前の形は全ページ同じ置き方で、
 * 中身は余白の中央に刷っていたので、奇数・偶数とも中央の枠へ寄せる。
 * 2026-10-17 までの［PDF出力］は置き方を覚えていなかったので、この形の記録は
 * 手で書いたものしか無いはずだが、読めずに紙ごと捨てるより寄せるほうがよい
 */
export function parseHeaderFooter(raw: unknown): HeaderFooter | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.odd === undefined && raw.even === undefined) {
    const top = parseMarginContent(raw.top);
    const bottom = parseMarginContent(raw.bottom);
    if (!top || !bottom) return undefined;
    const margins = emptyHeaderFooter();
    for (const side of [margins.odd, margins.even]) {
      side.top.center = top;
      side.bottom.center = bottom;
    }
    return margins;
  }
  const odd = parsePageMargins(raw.odd);
  const even = parsePageMargins(raw.even);
  return odd && even ? { odd, even } : undefined;
}

function parsePageMargins(raw: unknown): PageMargins | undefined {
  if (!isRecord(raw)) return undefined;
  const top = parseMarginRow(raw.top);
  const bottom = parseMarginRow(raw.bottom);
  return top && bottom ? { top, bottom } : undefined;
}

function parseMarginRow(raw: unknown): MarginRow | undefined {
  if (!isRecord(raw)) return undefined;
  const left = parseMarginContent(raw.left);
  const center = parseMarginContent(raw.center);
  const right = parseMarginContent(raw.right);
  return left && center && right ? { left, center, right } : undefined;
}

function parseMarginContent(raw: unknown): MarginContent | undefined {
  return MARGIN_CONTENTS.find((item) => item.id === raw)?.id;
}

/** その紙の上下の余白の既定（読む紙は紙ごと、公募の納品用は下の中央にページ番号） */
export function defaultHeaderFooterFor(paper: WorkPdfExportConfig["paper"]): HeaderFooter {
  return paper.kind === "grid" ? gridHeaderFooter() : printPreset(paper.preset).headerFooter;
}

function parsePaper(raw: unknown): WorkPdfExportConfig["paper"] | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind === "preset") {
    const preset = PRINT_PRESETS.find((item) => item.id === raw.preset);
    return preset ? { kind: "preset", preset: preset.id } : undefined;
  }
  if (raw.kind !== "grid") return undefined;
  const gridPaper = GRID_PAPERS.find((item) => item.id === raw.paper);
  if (!gridPaper) return undefined;
  if (!isGridNumber(raw.columns) || !isGridNumber(raw.rows)) return undefined;
  if (typeof raw.hanging !== "boolean" || typeof raw.vertical !== "boolean") return undefined;
  // 余白は選べるもの（普通・狭く）だけ。それ以外の値で組むと字が帯と重なることがある
  const margin = GRID_MARGINS.find((item) => item.mm === raw.marginMm);
  if (!margin) return undefined;
  return {
    kind: "grid",
    paper: gridPaper.id satisfies GridPaper,
    columns: raw.columns,
    rows: raw.rows,
    hanging: raw.hanging,
    vertical: raw.vertical,
    marginMm: margin.mm,
  };
}

function parseRange(raw: unknown): WorkPdfExportConfig["range"] | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.scope === "all") return { scope: "all" };
  if (raw.scope !== "files" || !Array.isArray(raw.files)) return undefined;
  const files = [
    ...new Set(
      raw.files
        .filter((item: unknown): item is string => typeof item === "string")
        .map((item) => normalizeRelativePath(item.trim()))
        .filter((item) => item.length > 0)
    ),
  ];
  // 空の選択は「何も刷らない」ではなく壊れた記録として扱う（画面では空では書き出せない）
  return files.length > 0 ? { scope: "files", files } : undefined;
}

function isGridNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= GRID_MIN && value <= GRID_MAX;
}

/** 外部AIの依頼で使う設定（確認の窓に並べるものと、実際に組むものが同じになるように1つにする） */
export interface PdfExportRequestPlan {
  /** 前回の［PDF出力］の設定か、記録が無くて既定か */
  source: "last" | "default";
  paper: WorkPdfExportConfig["paper"];
  /** 組む話（作品フォルダーからの相対パス。今の本文の一覧の順） */
  files: string[];
  /** 前回選んだのに今は見つからない話 */
  missing: string[];
  /** 前回選んだ話が1つも見つからず、全話にした */
  rangeFellBack: boolean;
  /** 前回が全話（またはその既定）だった */
  allEpisodes: boolean;
  /** 上下の余白の置き方（前回の記録。無ければ紙の既定）。作者名の枠はまだ空けていない */
  headerFooter: HeaderFooter;
}

/**
 * 前回の設定と今の本文の一覧から、組むものを決める。
 *
 * - 前回が「全話」なら**今の全話**（あとから足した話も入る。作者が選んだのは
 *   「すべて」であって、そのときの話の並びではない）
 * - 前回が「選ぶ」なら、そのうち今もある話を**今の一覧の順**で。見つからない話は言う
 * - 1つも残らなければ全話にして、そう言う（何も刷らない依頼にしない）
 */
export function resolvePdfExportRequest(
  saved: WorkPdfExportConfig | undefined,
  available: readonly string[]
): PdfExportRequestPlan {
  const config = saved ?? DEFAULT_PDF_EXPORT;
  const source = saved ? "last" : "default";
  const all = available.map(normalizeRelativePath);
  const headerFooter = config.headerFooter ?? defaultHeaderFooterFor(config.paper);
  if (config.range.scope === "all") {
    return { source, paper: config.paper, files: all, missing: [], rangeFellBack: false, allEpisodes: true, headerFooter };
  }
  const wanted = config.range.files.map(normalizeRelativePath);
  const wantedSet = new Set(wanted);
  const files = all.filter((file) => wantedSet.has(file));
  const present = new Set(all);
  const missing = wanted.filter((file) => !present.has(file));
  if (files.length === 0) {
    return { source, paper: config.paper, files: all, missing, rangeFellBack: true, allEpisodes: true, headerFooter };
  }
  return { source, paper: config.paper, files, missing, rangeFellBack: false, allEpisodes: false, headerFooter };
}

/** 確認の窓と結果の断りに並べる文（紙・向き・範囲・どこから来た設定か） */
export interface PdfExportPlanLines {
  paper: string;
  direction: string;
  range: string;
  /** 上下の余白の置き方（`describeHeaderFooter`。作者名の枠を空ける前） */
  margins: string;
  source: string;
}

/** 範囲の文に並べる話の数の上限。19話を全部並べると確認の窓が読めなくなる */
const RANGE_LIST_MAX = 5;

export function describePdfExportPlan(plan: PdfExportRequestPlan): PdfExportPlanLines {
  return {
    paper: describePaper(plan.paper),
    direction: paperIsVertical(plan.paper) ? "縦書き" : "横書き",
    range: describeRange(plan),
    margins: describeHeaderFooter(plan.headerFooter),
    source:
      plan.source === "last"
        ? "前回の［PDF出力］で選んだ設定です"
        : "前回の［PDF出力］の記録が無いため、既定（文庫サイズ・縦書き・全話）です",
  };
}

function paperIsVertical(paper: WorkPdfExportConfig["paper"]): boolean {
  if (paper.kind === "grid") return paper.vertical;
  const preset = PRINT_PRESETS.find((item) => item.id === paper.preset);
  return preset?.vertical ?? true;
}

function describePaper(paper: WorkPdfExportConfig["paper"]): string {
  if (paper.kind === "preset") {
    const preset = PRINT_PRESETS.find((item) => item.id === paper.preset);
    if (!preset) return paper.preset;
    // 一覧の名前は「文庫サイズ・縦書き」の形。向きは別の行で言うので、紙の名前だけにする
    const name = preset.label.split("・")[0] ?? preset.label;
    return `${name}（${preset.size.replace(" ", " × ")}）`;
  }
  const gridPaper = GRID_PAPERS.find((item) => item.id === paper.paper);
  const margin = GRID_MARGINS.find((item) => item.mm === paper.marginMm);
  return (
    `${gridPaper?.label ?? paper.paper}・${paper.columns}字×${paper.rows}行（公募の納品用。` +
    `句読点を${paper.hanging ? "ぶら下げる" : "ぶら下げない"}・余白は${margin?.label ?? ""}${paper.marginMm}mm）`
  );
}

function describeRange(plan: PdfExportRequestPlan): string {
  const missing =
    plan.missing.length > 0
      ? `前回選んだうち ${listFiles(plan.missing)} は今は見つかりません`
      : "";
  if (plan.rangeFellBack) {
    return `全話（${plan.files.length}話。${missing}。前回選んだ話が1つも見つからないため全話にします）`;
  }
  if (plan.allEpisodes) return `全話（${plan.files.length}話）`;
  return `前回選んだ${plan.files.length}話（${listFiles(plan.files)}）${missing ? `。${missing}` : ""}`;
}

function listFiles(files: readonly string[]): string {
  const names = files.map((file) => file.split("/").pop() ?? file);
  if (names.length <= RANGE_LIST_MAX) return names.join("、");
  return `${names.slice(0, RANGE_LIST_MAX).join("、")} ほか${names.length - RANGE_LIST_MAX}話`;
}
