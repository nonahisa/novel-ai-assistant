import { tokenizeLine, type NotationMode } from "./manuscriptRender";
import { stripMemoLines } from "./sceneMemo";
import { tcyRuns } from "./tateChuYoko";
import { isHangable, isNoLineEnd, isNoLineStart } from "./kinsoku";
import {
  classifyScriptLine,
  SCRIPT_ROLE_WIDTH,
  SCRIPT_SPEECH_HANG,
  splitSerifu,
} from "./scriptLines";
import type { WorkKindKey } from "./workKind";

/**
 * 公募の納品用の組版——1字1マスで、字数×行数を指定どおりに組む
 * （設計書6.33.5 の3）。
 *
 * ## なぜコードで行を割るのか
 *
 * 作者の依頼：「公募の納品用にページ当たりの行数や文字数を指定したり、
 * 禁則処理等してほしい」。**「40字×40行」は、ブラウザに流し込んだだけでは
 * 揃わない。** 約物の幅・ルビ・縦中横・半角の英数字で1行に入る字数が
 * 行ごとに変わるうえ、ブラウザの禁則は字を詰めたり送ったりするので、
 * 何字目で折り返したかが外から決められない。そこで、
 *
 *   本文 → マスの部品（字・縦中横・半角・ルビのかたまり）→ 行 → ページ
 *
 * をここで決め、画面（`printGridHtml.ts`）は決まったマスを並べるだけにする。
 * 1行の字数と1ページの行数は、ここで決まった値がそのまま紙になる。
 *
 * ## 部品とマス
 *
 * - ふつうの字：1マス
 * - 縦書きの半角英数字1〜2字（`tateChuYoko.ts` の規則。原稿エディタ・EPUB と同じ）：縦中横で1マス
 * - 縦書きのそれ以外の半角：1字1マスで立てる
 * - 横書きの半角：2字で1マス（英数字を全角の幅で組むと、字間が開きすぎて読めない）
 * - ルビ：親文字の数だけのマスを取り、**途中で割らない**（読みが泣き別れる）。
 *   1行より長いルビだけは、行の長さで割って読みを字数の比で割り振る
 * - 傍点：1字ずつのマスに印を付ける
 *
 * VS Code API に依存しない（純粋な関数だけ）。
 */

export interface GridOptions {
  /** 1行の字数 */
  columns: number;
  /** 1ページの行数 */
  rows: number;
  /** 句読点を行末の外へぶら下げるか。しないときは前の字ごと次の行へ送る */
  hanging: boolean;
  /** 縦書きか（半角の組み方が変わる） */
  vertical: boolean;
}

/** マスの部品 */
export interface GridUnit {
  /** char：ふつうの字／tcy：縦中横／half：半角／ruby：ルビのかたまり */
  kind: "char" | "tcy" | "half" | "ruby";
  /** マスに入る字（ルビは親文字） */
  text: string;
  /** 取るマスの数（ルビ以外は1） */
  width: number;
  /** ルビの読み */
  reading?: string;
  /** 傍点 */
  emphasis?: true;
}

export interface GridLine {
  units: GridUnit[];
  /** 行末の外へぶら下げた句読点 */
  hang?: GridUnit;
  /**
   * 行頭の空きマスの数（台本のト書きの字下げ。作者の裁定、2026-10-09）。
   * `units` には数えない——字下げのぶんだけ、この行に入る字は少なくなる
   * （`indent + lineWidth ≤ 字数`）。省略は0
   */
  indent?: number;
  /**
   * ゴシックで組む行（台本のト書きと柱。作者の裁定、2026-10-17）。省略は明朝。
   * マスの寸法は字の大きさで決まっているので、書体を変えても升目は崩れない
   */
  gothic?: true;
}

export interface GridPage {
  /** この面が入っている話の見出し（上下の余白に刷る「話の見出し」） */
  heading: string;
  lines: GridLine[];
}

export interface GridEpisode {
  heading: string;
  body: string;
  notation: NotationMode;
}

/**
 * 行の切れ目を禁則に合わせるとき、前へさかのぼる部品の数の上限。
 *
 * **それ以上は禁則を破る。** 「……」」」」」のような並びを直しきろうと
 * すると行が極端に短くなり、指定の字数から大きく外れる。面の切れ目
 * （`printPaginate.ts`）と同じ4にしてある。
 */
const MAX_PULL = 4;

/** 行の中の字数（マスの数）。ぶら下げは数えない */
export function lineWidth(line: GridLine): number {
  return line.units.reduce((sum, unit) => sum + unit.width, 0);
}

/** 1行（1段落）を部品へ割る。ルビ・傍点の記法はここで読む */
export function unitsOfLine(
  line: string,
  notation: NotationMode,
  vertical: boolean
): GridUnit[] {
  const units: GridUnit[] = [];
  for (const token of tokenizeLine(line, notation)) {
    if (token.kind === "ruby") {
      units.push({
        kind: "ruby",
        text: token.base,
        width: [...token.base].length,
        reading: token.reading,
      });
    } else if (token.kind === "emphasis") {
      units.push(...unitsOfText(token.text, vertical, true));
    } else {
      units.push(...unitsOfText(token.text, vertical, false));
    }
  }
  return units;
}

/** 半角の字（ASCII の表示文字と空白、半角カナ） */
function isHalfWidth(ch: string): boolean {
  return /^[ -~｡-ﾟ]$/.test(ch);
}

/** 記法を含まない文字列を部品へ（見出しにも使う） */
export function unitsOfText(
  text: string,
  vertical: boolean,
  emphasis: boolean
): GridUnit[] {
  const units: GridUnit[] = [];
  const mark = emphasis ? { emphasis: true as const } : {};

  if (vertical) {
    const runs = tcyRuns(text);
    let next = 0;
    for (let at = 0; at < text.length; ) {
      const run = runs[next];
      if (run && run.start === at) {
        units.push({ kind: "tcy", text: text.slice(run.start, run.end), width: 1, ...mark });
        at = run.end;
        next += 1;
        continue;
      }
      const ch = String.fromCodePoint(text.codePointAt(at) ?? 0);
      at += ch.length;
      units.push({ kind: isHalfWidth(ch) ? "half" : "char", text: ch, width: 1, ...mark });
    }
    return units;
  }

  // 横書き：半角は2字で1マス。全角の字を挟んだら組み直す
  let pending: GridUnit | undefined;
  for (const ch of text) {
    if (isHalfWidth(ch)) {
      if (pending && [...pending.text].length === 1) {
        pending.text += ch;
        pending = undefined;
        continue;
      }
      pending = { kind: "half", text: ch, width: 1, ...mark };
      units.push(pending);
      continue;
    }
    pending = undefined;
    units.push({ kind: "char", text: ch, width: 1, ...mark });
  }
  return units;
}

/**
 * 1行より長いルビを、行の長さで割る。読みは親文字の字数の比で割り振る。
 *
 * 1行に収まらないものは、どう組んでも割るしかない。読みを最初の
 * かたまりにまとめると、後ろの親文字にルビが無いように見える。
 */
function splitWideRuby(unit: GridUnit, columns: number): GridUnit[] {
  const base = [...unit.text];
  const reading = [...(unit.reading ?? "")];
  const parts: GridUnit[] = [];
  for (let start = 0; start < base.length; start += columns) {
    const end = Math.min(base.length, start + columns);
    const from = Math.round((reading.length * start) / base.length);
    const to = Math.round((reading.length * end) / base.length);
    parts.push({
      kind: "ruby",
      text: base.slice(start, end).join(""),
      width: end - start,
      reading: reading.slice(from, to).join(""),
    });
  }
  return parts;
}

/**
 * 部品を、指定の字数の行へ割る（禁則つき）。
 *
 * 1. 入るだけ詰める
 * 2. 次の部品が入らないとき：
 *    - ぶら下げありで、次が句読点（しかも、その後ろが行頭禁則の字でない）なら、
 *      行末の外へぶら下げる
 *    - それ以外は、次の行の頭が行頭禁則の字にならず、この行の終わりが
 *      開き括弧にならない切れ目まで、前へさかのぼる（追い出し。4つまで）。
 *      さかのぼって送った部品は、次の行で組み直す
 *
 * **「。」」の並びでは「。」をぶら下げない。** ぶら下げると、次の行が
 * 「」」から始まる。前の字ごと送るのが原稿用紙の書き方である。
 */
export function breakIntoLines(
  source: readonly GridUnit[],
  options: GridOptions,
  /**
   * 1行目だけ字数を変えるとき（台本の台詞：1行目と、ぶら下げた2行目以降で
   * 入る字が違う）。省略なら全行 `options.columns`
   */
  firstColumns?: number
): GridLine[] {
  const columns = Math.max(1, Math.floor(options.columns));
  const first = firstColumns === undefined ? columns : Math.max(1, Math.floor(firstColumns));
  // 長いルビは、狭いほうの行にも入る長さで割る
  const narrowest = Math.min(columns, first);
  const units = source.flatMap((unit) =>
    unit.kind === "ruby" && unit.width > narrowest
      ? splitWideRuby(unit, narrowest)
      : [unit]
  );
  if (units.length === 0) return [{ units: [] }];

  const lines: GridLine[] = [];
  let line: GridUnit[] = [];
  let width = 0;
  let index = 0;

  while (index < units.length) {
    const unit = units[index];
    const limit = lines.length === 0 ? first : columns;
    if (width + unit.width <= limit) {
      line.push(unit);
      width += unit.width;
      index += 1;
      continue;
    }
    if (line.length === 0) {
      // 空の行にも入らない（割ったあとのルビでは起きないが、止まらないため）
      lines.push({ units: [unit] });
      index += 1;
      continue;
    }
    const following = units[index + 1];
    if (
      options.hanging &&
      unit.width === 1 &&
      isHangable(unit.text) &&
      !(following && isNoLineStart(following.text))
    ) {
      lines.push({ units: line, hang: unit });
      line = [];
      width = 0;
      index += 1;
      continue;
    }
    const cut = chooseCut(line, unit);
    lines.push({ units: line.slice(0, cut) });
    // 送った部品は、次の行の頭から組み直す
    index -= line.length - cut;
    line = [];
    width = 0;
  }
  if (line.length > 0) lines.push({ units: line });
  return lines;
}

/**
 * 行をどこで切るか（この行に残す部品の数）。
 *
 * 次の行の頭（`cut` 番目。行の外なら `next`）が行頭禁則の字でなく、
 * この行の終わり（`cut - 1` 番目）が開き括弧でない位置を、後ろから探す。
 * 見つからなければ切れ目を動かさない（禁則を破って先へ進む）。
 */
function chooseCut(line: readonly GridUnit[], next: GridUnit): number {
  const floor = Math.max(1, line.length - MAX_PULL);
  for (let cut = line.length; cut >= floor; cut--) {
    const head = cut < line.length ? line[cut] : next;
    const tail = line[cut - 1];
    if (!isNoLineStart(head.text) && !isNoLineEnd(tail.text)) return cut;
  }
  return line.length;
}

/**
 * 話を行に割り、ページに割る。
 *
 * - **話の頭は新しいページから。** 見出しの行と空き1行のあとに本文
 * - 本文の空行は1行ずつ残す（場面の切れ目。原稿用紙でも1行空ける）。
 *   ただし本文の頭と終わりの空行は詰める（見出しの空きと二重になる・
 *   最後のページに空の行だけが残る）
 * - シーンメモは紙に出さない（設計書6.40.2）
 */
export function layoutGrid(
  episodes: readonly GridEpisode[],
  options: GridOptions,
  kind?: WorkKindKey
): GridPage[] {
  const rows = Math.max(1, Math.floor(options.rows));
  const pages: GridPage[] = [];

  for (const episode of episodes) {
    const heading = episode.heading.trim();
    const lines: GridLine[] = [];
    if (heading) {
      lines.push(...breakIntoLines(unitsOfText(heading, options.vertical, false), options));
      lines.push({ units: [] });
    }

    const source = stripMemoLines(episode.body).replace(/\r\n?/g, "\n").split("\n");
    let first = 0;
    let last = source.length - 1;
    while (first <= last && source[first].trim() === "") first += 1;
    while (last >= first && source[last].trim() === "") last -= 1;
    for (const text of source.slice(first, last + 1)) {
      if (text.trim() === "") {
        lines.push({ units: [] });
        continue;
      }
      lines.push(...linesOfParagraph(text, episode.notation, options, kind));
    }

    for (let start = 0; start < lines.length; start += rows) {
      pages.push({ heading, lines: lines.slice(start, start + rows) });
    }
  }
  return pages;
}

/**
 * 台本のト書きの字下げ（マスの数）。作者の裁定（2026-10-09）：
 * **柱 0字・ト書き 3字下げ・台詞 0字。** 折り返した行も3字下げを続ける。
 */
export const SCRIPT_TOGAKI_INDENT = 3;

/**
 * 1段落を行へ割る。**台本だけ、行の種類で組み方を変える。**
 *
 * - 見分け方は `scriptLines.ts` の `classifyScriptLine`（原稿エディター・読む紙と
 *   同じ規則）。**`kindLineClass` は通さない**——漫画の原作も同じ「ト書き」の
 *   印を借りているので、そちらを通すと漫画まで変わる（今回は台本だけ）
 * - **ト書き**：3字下げ。行頭の全角空白で見分けるので、**頭の全角空白は字下げに
 *   置き換える**（残すと「空白1字＋字下げ3字」で4字下がる。紙だけの話で、原稿は
 *   変えない）。字下げのぶん、1行に入る字を減らして割る（1行の字数は指定どおり）
 * - **台詞**：人物名の欄と、「「」の次の字の下へのぶら下げ（`serifuLines`）
 * - **書体**：ト書きと柱はゴシック、台詞と、どれにも当たらない行は明朝
 */
function linesOfParagraph(
  text: string,
  notation: NotationMode,
  options: GridOptions,
  kind: WorkKindKey | undefined
): GridLine[] {
  if (kind !== "script") {
    return breakIntoLines(unitsOfLine(text, notation, options.vertical), options);
  }
  const lineKind = classifyScriptLine(text);
  if (lineKind === "togaki") {
    const columns = Math.max(1, Math.floor(options.columns));
    const indent = Math.min(SCRIPT_TOGAKI_INDENT, columns - 1);
    const body = text.replace(/^　+/, "");
    const narrowed = { ...options, columns: columns - indent };
    return breakIntoLines(unitsOfLine(body, notation, options.vertical), narrowed).map(
      (line) => ({ ...line, indent, gothic: true as const })
    );
  }
  if (lineKind === "hashira") {
    return breakIntoLines(unitsOfLine(text, notation, options.vertical), options).map(
      (line) => ({ ...line, gothic: true as const })
    );
  }
  if (lineKind === "serifu") {
    const serifu = splitSerifu(text);
    if (serifu) return serifuLines(serifu.role, serifu.speech, notation, options);
  }
  return breakIntoLines(unitsOfLine(text, notation, options.vertical), options);
}

/**
 * 台詞の行（作者の裁定、2026-10-17）。
 *
 * - 人物名を `SCRIPT_ROLE_WIDTH` 字の欄に入れ、足りない分を空きマスで埋めて、
 *   「「」を欄の次のマスにそろえる。**「「」はどの台詞の行でも同じ高さ**（作者の裁定、
 *   2026-10-17「「の高さをそろえて」）
 * - **欄に収まらない長い名前は、欄の中で折り返す**：欄の字数で機械的に割り、続きを
 *   次の行の欄に置く（`roleChunks`）。名前を切らない——台詞が先に終わっても、名前の
 *   行ぶん行を使う
 * - 台詞が2行以上になったら、折り返した行を**「「」の次の字（台詞の1字目）の下**に
 *   そろえる（「「」から `SCRIPT_SPEECH_HANG` 字下げる。作者の裁定、2026-10-17）
 * - 1行の字数は指定どおりのまま。1行目は「欄＋台詞」、2行目以降は「欄＋1字＋台詞」が
 *   ちょうど字数に収まるよう、台詞を行ごとの幅で割る（2行目以降は1行目より1字少ない）
 * - **字数の少ない升目（欄と下げ幅で行の半分を超える。5字の欄なら11字以下）だけは、
 *   欄もぶら下げもやめてふつうの行として割る**。2行目以降に台詞が数字ぶんしか入らない
 *   紙になるのを避けるため（最小の5字では台詞の入るマスが1つも残らない）
 */
function serifuLines(
  role: string,
  speech: string,
  notation: NotationMode,
  options: GridOptions
): GridLine[] {
  const columns = Math.max(1, Math.floor(options.columns));
  const hangIndent = SCRIPT_ROLE_WIDTH + SCRIPT_SPEECH_HANG;
  if (hangIndent > Math.floor(columns / 2)) {
    return breakIntoLines(unitsOfLine(role + speech, notation, options.vertical), options);
  }
  const chunks = roleChunks(unitsOfLine(role, notation, options.vertical), SCRIPT_ROLE_WIDTH);
  const narrowed = { ...options, columns: columns - hangIndent };
  const speechLines = breakIntoLines(
    unitsOfLine(speech, notation, options.vertical),
    narrowed,
    columns - SCRIPT_ROLE_WIDTH
  );
  const result: GridLine[] = [];
  const count = Math.max(chunks.length, speechLines.length);
  for (let index = 0; index < count; index++) {
    const chunk = chunks[index];
    const line = speechLines[index] ?? { units: [] };
    if (!chunk) {
      // 名前の続きが無い行：欄と下げ幅のぶんを空ける（今までの折り返し）
      result.push({ ...line, indent: hangIndent });
      continue;
    }
    // 欄に名前（の続き）を入れ、空きマスで欄の幅まで埋める。2行目以降は下げ幅の1字も空ける
    const filled = chunk.reduce((sum, unit) => sum + unit.width, 0);
    const pad = SCRIPT_ROLE_WIDTH - filled + (index === 0 ? 0 : SCRIPT_SPEECH_HANG);
    result.push({ ...line, units: [...chunk, ...emptyCells(pad), ...line.units] });
  }
  return result;
}

/** 字の無いマス（欄の空き）。行割りには通さない（禁則の判定に関わらない） */
function emptyCells(count: number): GridUnit[] {
  return Array.from({ length: Math.max(0, count) }, () => ({
    kind: "char" as const,
    text: "",
    width: 1,
  }));
}

/**
 * 人物名を、欄の字数ずつに割る（作者の裁定、2026-10-17：割り方は欄の字数で機械的に）。
 * 禁則は見ない。ルビは途中で割らず次の欄へ送る。欄より長いルビだけは欄の字数で割る
 * （読みは字数の比で割り振る。`splitWideRuby` と同じ）。名前が空なら空の欄を1つ
 */
function roleChunks(units: readonly GridUnit[], width: number): GridUnit[][] {
  const chunks: GridUnit[][] = [];
  let chunk: GridUnit[] = [];
  let filled = 0;
  const parts = units.flatMap((unit) =>
    unit.kind === "ruby" && unit.width > width ? splitWideRuby(unit, width) : [unit]
  );
  for (const unit of parts) {
    if (filled + unit.width > width && chunk.length > 0) {
      chunks.push(chunk);
      chunk = [];
      filled = 0;
    }
    chunk.push(unit);
    filled += unit.width;
  }
  chunks.push(chunk);
  return chunks;
}

/** マスと行の寸法（mm） */
export interface GridGeometry {
  /** 1マス（字の大きさ） */
  cell: number;
  /** 行送り（行と行の中心の間隔） */
  pitch: number;
  /** 行の長さのあまり（片側）。行を本文の範囲の真ん中に置く */
  inlineOffset: number;
}

/**
 * 紙の大きさと余白から、マスと行送りを決める。
 *
 * - 行送り＝本文の範囲の行方向の長さ ÷ 行数（行を範囲いっぱいに並べる）
 * - マス＝「行の長さ ÷ 字数」と「行送り ÷ 1.5」の小さいほう。
 *   **行間はマスの半分以上を空ける**——ルビと傍点が隣の行にかぶらないため
 * - 0.01mm 単位で切り捨てる（足し合わせたときに範囲を超えないように）
 */
export function gridGeometry(
  paperWidth: number,
  paperHeight: number,
  margin: number,
  options: GridOptions
): GridGeometry {
  const inline = (options.vertical ? paperHeight : paperWidth) - margin * 2;
  const block = (options.vertical ? paperWidth : paperHeight) - margin * 2;
  const pitch = floor2(block / Math.max(1, options.rows));
  const cell = floor2(Math.min(inline / Math.max(1, options.columns), pitch / 1.5));
  const inlineOffset = floor2((inline - cell * options.columns) / 2);
  return { cell, pitch, inlineOffset };
}

function floor2(value: number): number {
  return Math.floor(value * 100) / 100;
}
