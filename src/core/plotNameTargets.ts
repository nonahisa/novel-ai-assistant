import type { Character } from "../models/character";
import {
  PLOT_CHARACTER_BULLET,
  findCharactersByAppellation,
  parsePlotCharacterLine,
} from "./plotCharacterSync";
import {
  classifyRoleName,
  formatRoleAnnotation,
  splitRoleAnnotation,
  type RoleNameKind,
} from "./plotRoleNames";
import { PLOT_SECTIONS, isBlankPlotSection, parsePlotMarkdown } from "./plotDoc";

/**
 * プロットの「主要登場人物」から、**名前がまだ無く役名だけの人物**を拾い、
 * 選んだ名前をその行へ書き足す（設計書6.4.8「名前の候補を出す」。
 * 作者の依頼、2026-09-25）。
 *
 * ## 書き足す形は「役名（名前）」
 *
 * 「主人公：〜」は「主人公（相馬 誠）：〜」になる。**名前を前に出す形
 * （「相馬 誠（主人公）：〜」）にしなかった理由**：
 *
 * 1. **行の頭が変わらない。** 作者はこの欄を役割で並べて考えており、
 *    あらすじの節も「主人公」「ヒロイン」「班長」と役名で書いてある。
 *    行の頭が役名のままなら、あらすじとの対応が崩れない
 * 2. **消せば元に戻る。** 書き足すのは「（相馬 誠）」の1か所だけで、
 *    元の文字は1字も動かさない。要らなければ括弧ごと消せば、元の行と1字も違わない
 * 3. **読み違えない。** 「名前（〜）」は「灯（あかり）」のように読み仮名を
 *    添える書き方と同じ形になる。「役名（〜）」なら、外側が役名なので
 *    括弧の中を名前と読める（`splitRoleAnnotation`。プロットからの反映も
 *    この形を名前と役名に分けて読む）
 *
 * VS Code API に依存しない（単体テストの対象）。
 */

/** 名前を付ける対象の1人 */
export interface PlotRoleTarget {
  /** 画面とAIの答えで人物を指す番号（"1" から） */
  id: string;
  /** plot.md の中の行（0始まり） */
  lineIndex: number;
  /** その行の文字そのもの。**書き足す直前に、行が変わっていないかを照らす** */
  lineText: string;
  /** 行頭の役名（「主人公」） */
  role: string;
  /** 説明。字下げした細目も含める（AIへ渡す材料） */
  summary: string;
  /** 役名と言い切れるか、名前かもしれないか */
  kind: RoleNameKind;
  /** そう見た理由（作者へ見せる） */
  reason: string;
  /**
   * 設定資料にいる、**名前が役名だけの**同じ人物（「主人公」という名前の人物）。
   *
   * いれば、選んだ名前は新規の人物でなく、この人物の名前を直す更新案になる
   * （作者の裁定、2026-09-25 午前）。無ければ undefined（新規の人物として置く）
   */
  ledger?: { id: string; name: string };
}

/** 拾わなかった行と、その理由 */
export interface PlotRoleSkip {
  name: string;
  reason: string;
}

export interface PlotRoleScan {
  targets: PlotRoleTarget[];
  skipped: PlotRoleSkip[];
  /** 「主要登場人物」の節があったか */
  hasSection: boolean;
}

const MAIN_CHARACTERS_HEADING =
  PLOT_SECTIONS.find((section) => section.key === "mainCharacters")?.heading ??
  "主要登場人物";

/**
 * 役名だけの人物を拾う。
 *
 * 行の読み方は、プロットからの反映（`parsePlotCharacterLine`）と同じ1本を通す。
 * **読み方が2つに分かれると、反映では人物として読むのに、ここでは拾わない
 * （あるいはその逆）行が生まれる。**
 *
 * @param existing 設定資料の人物。**名前か別名で当たる呼び名は、もう名前のある人**
 *   として拾わない（依頼の決まり）。**ただし当たった人物の名前も役名だけなら拾い**、
 *   その人物を `ledger` に覚える（作者の裁定、2026-09-25 午前。プロットからの
 *   反映や抽出で「主人公」という名前の人物が資料にできていると、0.87.0 では
 *   名前を付ける手が無かった）
 */
export function findRoleOnlyCharacters(
  plotText: string,
  existing: readonly Character[]
): PlotRoleScan {
  const lines = plotText.split(/\r\n|\n|\r/);
  const targets: PlotRoleTarget[] = [];
  const skipped: PlotRoleSkip[] = [];
  let hasSection = false;
  let inSection = false;
  let inComment = false;
  /** 字下げした細目を足す先（直前の人物の行）。対象でなければ undefined */
  let last: PlotRoleTarget | undefined;
  let lastWasEntry = false;

  lines.forEach((line, lineIndex) => {
    // 節の見出しは `##`（`parsePlotMarkdown` と同じ）。`#` の題でも節は終わる
    const heading = /^(#{1,2})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      inSection = heading[1] === "##" && heading[2] === MAIN_CHARACTERS_HEADING;
      if (inSection) hasSection = true;
      last = undefined;
      lastWasEntry = false;
      return;
    }
    if (!inSection) return;

    // 案内のコメント（`<!-- … -->`）は書かれた中身ではない。行をまたぐものもある
    let body = line;
    if (inComment) {
      const close = body.indexOf("-->");
      if (close < 0) return;
      body = body.slice(close + 3);
      inComment = false;
    }
    body = body.replace(/<!--[\s\S]*?-->/g, "");
    const open = body.indexOf("<!--");
    if (open >= 0) {
      body = body.slice(0, open);
      inComment = true;
    }

    const trimmed = body.trim();
    if (!trimmed) return;
    if (/^#{3,6}\s/.test(trimmed)) return;
    if (/^([-*_])\1{2,}$/.test(trimmed) || /^[-*+・]$/.test(trimmed)) return;

    const indented = /^[ \t　]/.test(body);
    const bulletMatch = PLOT_CHARACTER_BULLET.exec(trimmed);
    const content = bulletMatch ? trimmed.slice(bulletMatch[0].length).trim() : trimmed;
    if (bulletMatch && !content) return;

    // 字下げした箇条書きは直前の人物の細目（`parsePlotCharacters` と同じ読み方）
    if (indented && bulletMatch && lastWasEntry) {
      if (last) last.summary = `${last.summary} ${content}`.trim();
      return;
    }

    const entry = parsePlotCharacterLine(content, Boolean(bulletMatch));
    if (!entry) return;
    lastWasEntry = true;
    last = undefined;

    // 「主人公（相馬 誠）」はもう名前がある（反映の読みでは role を持つ）
    if (entry.role || splitRoleAnnotation(entry.name)) {
      skipped.push({ name: entry.name, reason: "名前が入っています" });
      return;
    }
    const verdict = classifyRoleName(entry.name);
    if (!verdict) {
      skipped.push({ name: entry.name, reason: "名前に見えます" });
      return;
    }
    const matches = findCharactersByAppellation(existing, entry.name);
    let ledger: PlotRoleTarget["ledger"];
    if (matches.length > 1) {
      // どれを直すか決められない（プロットからの反映 6.4.9 と同じく当てない）
      skipped.push({
        name: entry.name,
        reason: "設定資料に、この呼び名の人物が複数います",
      });
      return;
    }
    if (matches.length === 1) {
      const match = matches[0];
      if (!classifyRoleName(match.name)) {
        skipped.push({
          name: entry.name,
          reason: "設定資料に、この呼び名の人物がいます",
        });
        return;
      }
      // 集団の呼び名（「作業員」「冒険者たち」）に1人の名前を付けると、
      // 資料の上で群れが1人の人物になってしまう
      if (match.isMob) {
        skipped.push({
          name: entry.name,
          reason: "設定資料では集団の呼び名（モブ）として登録されています",
        });
        return;
      }
      ledger = { id: match.id, name: match.name };
    }
    // 行の中で役名が見つからないなら、書き足す場所が決まらない（強調の印の
    // 内側などで形が崩れている）。拾っても入れられないので拾わない
    if (roleOffset(line, entry.name) === undefined) {
      skipped.push({ name: entry.name, reason: "行の中で役名の場所が分かりません" });
      return;
    }

    last = {
      id: String(targets.length + 1),
      lineIndex,
      lineText: line,
      role: entry.name,
      summary: entry.summary,
      kind: verdict.kind,
      reason: verdict.reason,
      ...(ledger ? { ledger } : {}),
    };
    targets.push(last);
  });

  return { targets, skipped, hasSection };
}

/**
 * 行の中で、役名の終わる位置（そこへ「（名前）」を差し込む）。
 *
 * 箇条書きの印のあとで最初に現れる役名を採る（説明の中に同じ語が
 * もう一度出ても、そちらではない）。
 */
function roleOffset(line: string, role: string): number | undefined {
  const indent = /^[ \t　]*/.exec(line)?.[0].length ?? 0;
  const rest = line.slice(indent);
  const bullet = PLOT_CHARACTER_BULLET.exec(rest)?.[0].length ?? 0;
  const at = line.indexOf(role, indent + bullet);
  if (at < 0) return undefined;
  // 印の直後から役名までに、強調の印（`**`）より多くの字が挟まっていたら、
  // それは説明の中の同じ語である
  const between = line.slice(indent + bullet, at);
  if (!/^\**$/.test(between)) return undefined;
  return at + role.length;
}

/** 書き足す1人分 */
export interface PlotNamePick {
  lineIndex: number;
  lineText: string;
  role: string;
  name: string;
}

export interface PlotNameInsertResult {
  text: string;
  applied: PlotNamePick[];
  /** 行が変わっていて書き足せなかったもの */
  missing: PlotNamePick[];
}

/**
 * 選んだ名前を plot.md の行へ書き足す。**書き足すのは「（名前）」だけ。**
 *
 * - 行の区切り（CRLF／LF）は元のまま返す。書き足した行のほかは1字も変えない
 * - **行が拾ったときと違っていれば、その行には書かない**（`missing` に返す）。
 *   ハッシュの照合（呼び出し側）が通っていれば起きないが、二重の守りにする
 */
export function insertNamesIntoPlot(
  text: string,
  picks: readonly PlotNamePick[]
): PlotNameInsertResult {
  const parts = text.split(/(\r\n|\n|\r)/);
  const applied: PlotNamePick[] = [];
  const missing: PlotNamePick[] = [];

  for (const pick of picks) {
    const at = pick.lineIndex * 2;
    const line = parts[at];
    const offset = line === pick.lineText ? roleOffset(line, pick.role) : undefined;
    if (line === undefined || offset === undefined || !pick.name.trim()) {
      missing.push(pick);
      continue;
    }
    parts[at] =
      line.slice(0, offset - pick.role.length) +
      formatRoleAnnotation(pick.role, pick.name.trim()) +
      line.slice(offset);
    applied.push(pick);
  }

  return { text: parts.join(""), applied, missing };
}

/**
 * 資料の役名の人物を、選んだ名前に直す更新案（設計書6.4.8）。
 *
 * **実体は `plotCharacterSync.ts` へ移した。** プロットからの反映（6.4.9）も
 * 同じ形の案を置くようになり、あちらからこのファイルを読むと輪になる
 * （このファイルは `plotCharacterSync.ts` を import している）。
 * 今までどおりこのファイルから読んでよい。
 */
export { buildRoleRenameProposal } from "./plotCharacterSync";

/**
 * 作品の世界観・舞台（`plot.md` の該当の節）。無ければ空文字。
 *
 * 名前の候補（P-29・P-45）の材料。**名前の点検と同じ読み方**にする
 * （`features/nameCheck.ts` もここを通る）。
 */
export function settingFromPlotText(plotText: string): string {
  const sections = parsePlotMarkdown(plotText).sections;
  return [sections.worldview, sections.setting]
    .filter((body) => body && !isBlankPlotSection(body))
    .map((body) => body.trim())
    .join("\n");
}
