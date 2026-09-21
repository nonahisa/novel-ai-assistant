import {
  READER_AXIS_ENDS,
  READER_AXIS_LABELS,
  READER_AXIS_ORDER,
  READER_TYPES,
  type ReaderChatSource,
  type ReaderTypeId,
} from "./readerTarget";
import { READER_TYPE_IDS } from "./readerTypeNeighbors";
import {
  TARGET_SHEET_HISTORY_ROWS,
  type TargetSheetHistoryEntry,
} from "./targetSheetHistory";
import { formatDayTime } from "./timestampedFileName";
import type {
  TargetSheet,
  TargetSheetDirection,
  TargetSheetGap,
} from "./targetSheet";

/**
 * ターゲットシートの紙（設計書6.108.2）。
 *
 * ## 作者の欄を、作り直しで消さない
 *
 * この紙は**生成物**だが、「狙い」と「理由」だけは**作者が手で書く欄**で
 * ある。印（`<!-- 作者の欄 ここから -->`）で挟み、作り直すときは中身を
 * そのまま運び直す——`authorNotes` を自動更新しないのと同じ約束
 * （CLAUDE.md 実装ルール2）。
 *
 * **印の無いファイルには書かない。** 作者が自分で `ターゲットシート.md` を
 * 書いていた場合に、それを上書きしてしまうためである（設定資料の
 * `GENERATED_MARKER` と同じ考え方。上書きしてから謝っても文章は戻らない）。
 *
 * ## 狙いは、作者の欄の1行目から読む
 *
 * 「狙い：考察層、没入層」と書いてあれば、その2つが狙いである。
 * **読めなければ狙い無しとして進む**（推測で型を当てない）。設問で
 * 選ばせる形は第3段以降で考える——まず手で書ける形にしておけば、
 * 作者は今日から使える。
 *
 * VS Code API にも AI にも依存しない。
 */

export const TARGET_SHEET_TITLE = "ターゲットシート";
export const TARGET_SHEET_FILE = `${TARGET_SHEET_TITLE}.md`;

/** 生成物である印。**これが無いファイルには書き込まない** */
export const TARGET_SHEET_MARKER =
  "このファイルは「ターゲットシート」で作り直されます。";

/** 作者の欄を挟む印。**この間だけが作り直しを越えて残る** */
export const AUTHOR_BLOCK_BEGIN = "<!-- 作者の欄 ここから -->";
export const AUTHOR_BLOCK_END = "<!-- ここまで -->";

/** 狙いの型はいくつまで書けるか（設計書6.108.2） */
export const TARGET_SHEET_AIM_LIMIT = 2;

/** 作者の欄の初期値。**1行目が「狙い」であることが、読み取りの約束** */
export const DEFAULT_AUTHOR_BLOCK = ["狙い：", "", "理由：", ""].join("\n");

/** この紙が作った（または作者が使ってよい）ファイルか */
export function isTargetSheetDoc(existing: string): boolean {
  return (
    existing.includes(TARGET_SHEET_MARKER) ||
    (existing.includes(AUTHOR_BLOCK_BEGIN) &&
      existing.includes(AUTHOR_BLOCK_END))
  );
}

/**
 * 作者の欄を取り出す。**無ければ `undefined`**（空文字と区別する）。
 *
 * 空文字は「欄はあるが、まだ何も書かれていない」で、`undefined` は
 * 「この紙には欄そのものが無い」である。前者は運び直し、後者は
 * 初期値を置く——混ぜると、作者が消した欄に毎回ひな形が戻ってくる。
 */
export function extractAuthorBlock(existing: string): string | undefined {
  const begin = existing.indexOf(AUTHOR_BLOCK_BEGIN);
  if (begin < 0) return undefined;
  const from = begin + AUTHOR_BLOCK_BEGIN.length;
  const end = existing.indexOf(AUTHOR_BLOCK_END, from);
  if (end < 0) return undefined;
  // 印の直後・直前の改行は印のものなので落とす（中身だけを運ぶ）
  return existing.slice(from, end).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

/**
 * 作者の欄から狙いの型を読む。
 *
 * 「狙い：考察層、没入項」のように**読めない名前が混じっても、読めた
 * ぶんだけ**を採る。全部読めなければ空（狙い無し）。
 */
export function readAimTypes(authorBlock: string): ReaderTypeId[] {
  const line = authorBlock
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => /^狙い\s*[:：]/.test(entry));
  if (!line) return [];

  const body = line.replace(/^狙い\s*[:：]/, "");
  const found: ReaderTypeId[] = [];
  for (const part of body.split(/[、,／/・]/)) {
    const name = part.replace(/[「」\s]/g, "");
    if (!name) continue;
    const type = READER_TYPE_IDS.find(
      (id) => READER_TYPES[id].label === name
    );
    if (type && !found.includes(type)) found.push(type);
    if (found.length >= TARGET_SHEET_AIM_LIMIT) break;
  }
  return found;
}

/** 点数の出どころの言い方（作者向け） */
const SOURCE_PHRASES: Record<ReaderChatSource, string> = {
  actual: "書けているもの",
  declared: "向けているつもり",
};

export interface TargetSheetDocInput {
  readonly workTitle: string;
  readonly sheet: TargetSheet;
  /** 運び直す作者の欄。無ければ初期値を置く */
  readonly authorBlock?: string;
  /** 点数の出どころ。**実態が無いときは要らない** */
  readonly source?: ReaderChatSource;
  /** 控え（新しい順）。推移の表に出す */
  readonly history?: readonly TargetSheetHistoryEntry[];
  /** 断り書き（読めなかった控えなど）。**黙って落とさない** */
  readonly notices?: readonly string[];
  readonly generatedAt: Date;
}

export function buildTargetSheetDoc(input: TargetSheetDocInput): string {
  const { sheet } = input;
  const lines: string[] = [
    `# ${TARGET_SHEET_TITLE}`,
    "",
    `**${input.workTitle}**`,
    "",
    `<!-- ${TARGET_SHEET_MARKER}`,
    "     「作者の欄」の中だけは、作り直しても残ります。",
    "     ほかの欄に書き足した文は、次の作り直しで失われます。 -->",
    "",
    ...aimSection(input.authorBlock ?? DEFAULT_AUTHOR_BLOCK),
    ...actualSection(sheet, input.source),
    ...matchSection(sheet),
    ...directionSection(sheet),
    ...historySection(input.history ?? []),
    ...adviceSection(),
    ...noticeSection(input.notices ?? []),
    `作り直した日時：${formatDayTime(input.generatedAt)}`,
    "",
  ];
  return lines.join("\n");
}

/**
 * 狙い——**作者が書く欄**。ここだけが作り直しを越える。
 *
 * 書き方の案内は**印の外**に置く。中へ入れると、案内の文まで作者の欄と
 * して運ばれ続け、言い回しを直しても古いままの紙が残る。
 */
function aimSection(authorBlock: string): string[] {
  const names = READER_TYPE_IDS.map((id) => READER_TYPES[id].label).join("・");
  return [
    "## 狙い（作者が書く欄）",
    "",
    "**この欄だけは、作り直しても残ります。** 狙う読者層を" +
      `${TARGET_SHEET_AIM_LIMIT}つまで、名前で書いてください（${names}）。` +
      "理由は自由に書けます。",
    "",
    AUTHOR_BLOCK_BEGIN,
    authorBlock,
    AUTHOR_BLOCK_END,
    "",
  ];
}

/** 実態——11型との一致度 */
function actualSection(
  sheet: TargetSheet,
  source: ReaderChatSource | undefined
): string[] {
  const lines = ["## 実態", ""];
  const actual = sheet.actual;
  if (!actual) {
    lines.push(
      "**まだ測っていません。** 先に「ターゲット読者診断」を済ませると、" +
        "11の読者層それぞれとの一致度がここに出ます。",
      ""
    );
    return lines;
  }

  const where = source ? `（${SOURCE_PHRASES[source]}の点から）` : "";
  lines.push(
    `いちばん高いのは **${READER_TYPES[actual.top].label}** です${where}。`,
    ""
  );

  lines.push("| 軸 | 点 | 端から端まで |", "|---|---|---|");
  for (const axis of READER_AXIS_ORDER) {
    const ends = READER_AXIS_ENDS[axis];
    lines.push(
      `| ${READER_AXIS_LABELS[axis]} | ${actual.scores[axis]}／6 | ` +
        `${ends.low} ←→ ${ends.high} |`
    );
  }
  lines.push("");

  lines.push("| 読者層 | 一致度 | どんな読者か |", "|---|---|---|");
  for (const entry of actual.ranking) {
    const info = READER_TYPES[entry.type];
    // いちばん高い型（診断が決めた型）だけを太字にする。同率の型は
    // 同じ数字のまま並べる——**数字を動かして順位を作らない**
    const name = entry.type === actual.top ? `**${info.label}**` : info.label;
    lines.push(`| ${name} | ${entry.affinity} | ${info.summary} |`);
  }
  lines.push(
    "",
    "一致度は、3つの軸の**段階**（低・中・高）がその層の中心とどれだけ" +
      "そろっているかで出しています。AIは使っていません。",
    ""
  );
  return lines;
}

/** 一致とずれ */
function matchSection(sheet: TargetSheet): string[] {
  const lines = ["## 一致とずれ", ""];

  if (sheet.aim.length === 0) {
    lines.push(
      "**狙いが書かれていません。** 上の「狙い」の欄へ読者層の名前を書いて、" +
        "もう一度この操作を押すと、狙いとの一致度とずれがここに出ます。",
      ""
    );
    return lines;
  }
  if (!sheet.actual) {
    lines.push(
      "実態がまだ測れていないので、狙いと突き合わせられません。",
      ""
    );
    return lines;
  }

  for (const aim of sheet.aims) {
    const info = READER_TYPES[aim.type];
    lines.push(`### 狙い：${info.label}（一致度 ${aim.affinity}）`, "");
    if (aim.isTop) {
      lines.push(
        "**狙いと、いちばん高い層が同じです。** 向けたい先へ、書けているものが向いています。",
        ""
      );
    } else {
      lines.push(
        `いちばん高いのは「${READER_TYPES[sheet.actual.top].label}」です。` +
          "**どちらが正しいとも言いません**——狙いが本当で書き方が追いついて" +
          "いないこともあれば、書けているもののほうが本当のこともあります。",
        ""
      );
    }
    if (aim.gaps.length === 0) {
      lines.push("軸のずれは、どれも2点未満です。", "");
    } else {
      for (const gap of aim.gaps) lines.push(`- ${describeGap(gap)}`);
      lines.push("");
    }
  }
  return lines;
}

/** ずれ1件の言い方。**上下を作らない**（どちらが良いとも言わない） */
function describeGap(gap: TargetSheetGap): string {
  const ends = READER_AXIS_ENDS[gap.axis];
  const toward = gap.diff > 0 ? ends.high : ends.low;
  return (
    `${READER_AXIS_LABELS[gap.axis]}：狙いの中心は${gap.center}、いまは${gap.scored}。` +
    `本文は「${toward}」の側に寄っています。`
  );
}

/** 向かう先（拡大・収束）。**どちらを選ぶかは作者** */
function directionSection(sheet: TargetSheet): string[] {
  if (!sheet.expand && !sheet.converge) return [];
  const lines = [
    "## 向かう先",
    "",
    "**動かすのは軸1本だけ**にしてあります。3つ同時に動かすと、作品が" +
      "別物になります。どちらへ進むか（あるいは進まないか）は作者が決めます。",
    "",
  ];
  if (sheet.expand) {
    lines.push(
      ...directionBlock("### 広げる（拡大）", sheet.expand, "隣の層も取る")
    );
  }
  if (sheet.converge) {
    lines.push(
      ...directionBlock("### 絞る（収束）", sheet.converge, "狙いの層へ寄せる")
    );
  }
  return lines;
}

function directionBlock(
  heading: string,
  direction: TargetSheetDirection,
  what: string
): string[] {
  const toward = READER_TYPES[direction.toward];
  const lines = [heading, "", `**${toward.label}**へ——${what}。`, ""];
  if (!direction.move) {
    lines.push(direction.note ?? "動かす軸はありません。", "");
    return lines;
  }
  lines.push(`- ${direction.move.summary}`);
  for (const example of direction.move.examples) {
    lines.push(`  - ${example}`);
  }
  lines.push("", `この層に効くのは、${toward.works}`, "");
  return lines;
}

/**
 * 推移（設計書6.108.5）。
 *
 * **控えのあるぶんだけ**出す。1件しか無くても表にするのは、
 * 次に押したときに増える場所だと分かるようにするためである。
 */
function historySection(
  history: readonly TargetSheetHistoryEntry[]
): string[] {
  const lines = ["## 推移", ""];
  if (history.length === 0) {
    lines.push(
      "控えはまだありません。この紙を作り直すたびに、そのときの狙いと" +
        "一致度が控えとして残り、ここに並びます。",
      ""
    );
    return lines;
  }

  lines.push(
    "| 日時 | 狙いの一致度 | いちばん高い層 | 上位3つ |",
    "|---|---|---|---|"
  );
  for (const entry of history.slice(0, TARGET_SHEET_HISTORY_ROWS)) {
    lines.push(
      `| ${historyWhen(entry)} | ${aimColumn(entry)} | ` +
        `${READER_TYPES[entry.top].label} | ${topThree(entry)} |`
    );
  }
  if (history.length > TARGET_SHEET_HISTORY_ROWS) {
    lines.push(
      "",
      `新しいものから${TARGET_SHEET_HISTORY_ROWS}件だけ出しています` +
        `（控えは${history.length}件あります。消してはいません）。`
    );
  }
  lines.push("");
  return lines;
}

function historyWhen(entry: TargetSheetHistoryEntry): string {
  const at = new Date(entry.recordedAt);
  // 読めない時刻は、そのまま出す（推測で今日にしない）
  return Number.isNaN(at.getTime()) ? entry.recordedAt : formatDayTime(at);
}

/** 狙いの型と、そのときの一致度。**狙いを変えた日が分かるように出す** */
function aimColumn(entry: TargetSheetHistoryEntry): string {
  if (entry.aim.length === 0) return "（狙い未記入）";
  return entry.aim
    .map((type) => {
      const affinity = entry.affinities[type];
      const label = READER_TYPES[type].label;
      return typeof affinity === "number" ? `${label} ${affinity}` : label;
    })
    .join("／");
}

function topThree(entry: TargetSheetHistoryEntry): string {
  const ranked = READER_TYPE_IDS.filter(
    (type) => typeof entry.affinities[type] === "number"
  ).sort(
    (left, right) =>
      entry.affinities[right] - entry.affinities[left] ||
      READER_TYPE_IDS.indexOf(left) - READER_TYPE_IDS.indexOf(right)
  );
  if (ranked.length === 0) return "—";
  return ranked
    .slice(0, 3)
    .map((type) => `${READER_TYPES[type].label} ${entry.affinities[type]}`)
    .join("・");
}

/** 助言——**第3段（AI）は次の版**。空欄のまま置かず、そう書く */
function adviceSection(): string[] {
  return [
    "## 助言",
    "",
    "**助言は次の版で入ります。** ここには、上の欄を材料にしたAIの助言が" +
      "入る予定です（数字はこの紙から写し、言い換えません）。",
    "",
  ];
}

function noticeSection(notices: readonly string[]): string[] {
  if (notices.length === 0) return [];
  return ["## 読めなかったもの", "", ...notices.map((note) => `- ${note}`), ""];
}
