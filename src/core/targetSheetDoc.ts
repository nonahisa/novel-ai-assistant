import {
  describeReaderGap,
  readerGaps,
  READER_AXIS_ENDS,
  READER_AXIS_LABELS,
  READER_AXIS_ORDER,
  READER_TYPES,
  type ReaderChatSource,
  type ReaderTypeId,
} from "./readerTarget";
import type { ReaderProfile } from "../models/readerProfile";
import type {
  TargetSheetBridge,
  TargetSheetCircles,
} from "./targetSheetCircles";
import {
  reactionRows,
  writtenRows,
  type TargetSheetWrittenRecord,
} from "./targetSheetWritten";
import { titleFitCandidates, type TitleFitRecord } from "./titleFit";
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
 * **読めなければ狙い無しとして進む**（推測で型を当てない）。
 *
 * 0.82.0 から、「ターゲット読者」の1段目（狙い）で**選ばせる形**も入った
 * （設計書6.108.6）。選んだ答えは `applyAimToAuthorBlock` がこの欄の
 * 「狙い：」「理由：」の2行へ書き込む——手で書く道と同じ場所に落とすので、
 * どちらで決めても読み方は1つである。
 *
 * VS Code API にも AI にも依存しない。
 */

export const TARGET_SHEET_TITLE = "ターゲットシート";
export const TARGET_SHEET_FILE = `${TARGET_SHEET_TITLE}.md`;

/**
 * 生成物である印。**これが無いファイルには書き込まない**。
 *
 * **いまの入口の名前を書く**（2026-09-23）。旧「ターゲットシート」の命令は
 * 「ターゲット読者」への転送になったので、紙の上で古い名前を案内すると、
 * 作者は詳細メニューでそれを見つけられない。
 */
export const TARGET_SHEET_MARKER =
  "このファイルは「ターゲット読者」で作り直されます。";

/**
 * 0.82.2 までの紙が持つ印。**読むときは今の印と同じに扱う**——印を変えた
 * だけで、この拡張機能が作った紙が「作者の手書き」に見えると、作り直しを
 * 断るようになる（作者の欄の印が残っていれば区別できるが、欄を消した紙もある）。
 */
const LEGACY_TARGET_SHEET_MARKER =
  "このファイルは「ターゲットシート」で作り直されます。";

/** 作者の欄を挟む印。**この間だけが作り直しを越えて残る** */
export const AUTHOR_BLOCK_BEGIN = "<!-- 作者の欄 ここから -->";
export const AUTHOR_BLOCK_END = "<!-- ここまで -->";

/** 狙いの型はいくつまで書けるか（設計書6.108.2） */
export const TARGET_SHEET_AIM_LIMIT = 2;

/** 作者の欄の初期値。**1行目が「狙い」であることが、読み取りの約束** */
export const DEFAULT_AUTHOR_BLOCK = ["狙い：", "", "理由：", ""].join("\n");

/** 作者の欄で、狙いと理由を読む行の頭 */
const AIM_LINE = /^狙い\s*[:：]/;
const REASON_LINE = /^理由\s*[:：]/;

/** この紙が作った（または作者が使ってよい）ファイルか */
export function isTargetSheetDoc(existing: string): boolean {
  return (
    existing.includes(TARGET_SHEET_MARKER) ||
    existing.includes(LEGACY_TARGET_SHEET_MARKER) ||
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
    .find((entry) => AIM_LINE.test(entry));
  if (!line) return [];

  const body = line.replace(AIM_LINE, "");
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

/**
 * 1段目（狙い）の答えを、作者の欄へ書き込む（設計書6.108.6）。
 *
 * **書き換えるのは「狙い：」と「理由：」の行だけ。** 作者が手で足した
 * ほかの行（メモなど）は1字も動かさない——この欄は作者のもので
 * （実装ルール2）、選ぶ画面を通ったからといって欄ごと作り直してよい
 * 理由にはならない。
 *
 * - 渡さなかったほう（`aims` か `reason` が `undefined`）は、その行を変えない
 * - 行が無ければ、欄の先頭へ足す（読み取りは「狙いの行を探す」なので
 *   どこにあっても読めるが、作者が見つけやすいよう上に置く）
 * - 理由は**1行に畳む**。2行目以降は読み取りの外へこぼれ、作者の目には
 *   理由の続きに見えるのに、次の書き込みで取り残される
 * - 改行の形（LF／CRLF）は欄のものを保つ
 */
export function applyAimToAuthorBlock(
  block: string,
  change: { aims?: readonly ReaderTypeId[]; reason?: string }
): string {
  const eol = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);

  const aimLine =
    change.aims === undefined
      ? undefined
      : "狙い：" +
        [...new Set(change.aims)]
          .slice(0, TARGET_SHEET_AIM_LIMIT)
          .map((type) => READER_TYPES[type].label)
          .join("、");
  const reasonLine =
    change.reason === undefined
      ? undefined
      : "理由：" + change.reason.replace(/\s*\r?\n\s*/g, " ").trim();

  const aimIndex = lines.findIndex((line) => AIM_LINE.test(line.trim()));
  const reasonIndex = lines.findIndex((line) => REASON_LINE.test(line.trim()));

  if (aimLine !== undefined && aimIndex >= 0) lines[aimIndex] = aimLine;
  if (reasonLine !== undefined && reasonIndex >= 0) {
    lines[reasonIndex] = reasonLine;
  }

  // 無かった行は先頭へ（狙い → 理由の順）。中身の無い欄は置き換える
  const added: string[] = [];
  if (aimLine !== undefined && aimIndex < 0) added.push(aimLine);
  if (reasonLine !== undefined && reasonIndex < 0) added.push(reasonLine);
  if (added.length === 0) return lines.join(eol);
  const rest = lines.length === 1 && lines[0] === "" ? [] : lines;
  return [...added, ...rest].join(eol);
}

/** 作者の欄の「理由：」の行の中身。無ければ空文字 */
export function readAimReason(authorBlock: string): string {
  const line = authorBlock
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => REASON_LINE.test(entry));
  return line ? line.replace(REASON_LINE, "").trim() : "";
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
  /**
   * 読者像の台帳（2段目の宣言と3段目の実像）。
   *
   * 渡されれば「書き方の判断と本文の実像」の突き合わせと、実像の根拠を
   * 載せる（設計書6.108.6。診断の紙に分かれていたものを1枚へ寄せる）。
   */
  readonly profile?: ReaderProfile;
  /** 3段目で読み取れなかった軸の呼び名。**黙って埋めない** */
  readonly unmeasured?: readonly string[];
  /** 3つの輪（作者の読者タイプ × 狙い × 実像）。渡されなければ節ごと出さない */
  readonly circles?: TargetSheetCircles;
  /**
   * 書けたものの実績（話数・字数・書いた日・設定資料・文体と、届いている
   * 反応）。渡されなければ節ごと出さない（古い呼び出し元のため）。
   */
  readonly written?: TargetSheetWrittenRecord;
  /**
   * タイトルとサブタイトルの適合度（P-41）。**測っていなければ `undefined`**
   * ——その場合は測り方を案内する（空の表を出さない）。
   */
  readonly titleFit?: TitleFitRecord;
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
    ...actualSection(sheet, input.source, input.unmeasured ?? []),
    ...matchSection(sheet),
    ...judgementSection(input.profile),
    ...evidenceSection(input.profile),
    ...directionSection(sheet),
    ...circlesSection(input.circles),
    ...bridgeSection(input.circles?.bridge),
    ...writtenSection(input.written),
    ...titleFitSection(input.titleFit),
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
    "**この欄だけは、作り直しても残ります。** 「ターゲット読者」の1段目で" +
      "選ぶと、ここへ書き込まれます。手で書くときは、狙う読者層を" +
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
  source: ReaderChatSource | undefined,
  unmeasured: readonly string[]
): string[] {
  const lines = ["## 実態", ""];
  const actual = sheet.actual;
  if (!actual) {
    lines.push(
      "**まだ測っていません。** 「ターゲット読者」の2段目（書き方の判断）か" +
        "3段目（本文の実像）を済ませると、11の読者層それぞれとの一致度が" +
        "ここに出ます。",
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
  if (unmeasured.length > 0) {
    lines.push(
      `**${unmeasured.join("・")}** は本文から読み取れませんでした` +
        "（どちらとも言えない位置に置いてあります）。",
      ""
    );
  }
  return lines;
}

/**
 * 書き方の判断（2段目の宣言）と本文の実像（3段目）の突き合わせ。
 *
 * 0.81 までは診断の紙（`readerTargetDoc.ts`）だけに出ていた節である。
 * 統合した1枚では、**作者が答えた判断と、書けているもののずれ**を
 * 狙いとのずれの隣に置く。言い回しは `describeReaderGap` を借りる
 * ——2か所で書くと、上下を作らない書き方を片方だけ直す日が来る。
 *
 * 台帳を渡されなければ節ごと出さない（古い呼び出し元のため）。
 */
function judgementSection(profile: ReaderProfile | undefined): string[] {
  if (!profile) return [];
  const lines = ["## 書き方の判断と本文の実像", ""];
  const { declared, actual } = profile;

  if (!declared || !actual) {
    if (!declared) {
      lines.push(
        "書き方の判断（2段目）にまだ答えていません。答えると、" +
          "向けているつもりと書けているもののずれがここに出ます。"
      );
    }
    if (!actual) {
      lines.push(
        "本文の実像（3段目）をまだ読んでいません。読むと、" +
          "向けているつもりと書けているもののずれがここに出ます。"
      );
    }
    lines.push("");
    return lines;
  }

  const gaps = readerGaps(declared.scores, actual.scores);
  if (gaps.length === 0) {
    lines.push(
      "**3つとも、ずれていません。** 向けようとしている先へ、書けているものが向いています。",
      ""
    );
    return lines;
  }
  lines.push(
    "**どちらが正しいとも言いません。** 向けている先が本当で書き方がまだ" +
      "追いついていないこともあれば、書けているもののほうが本当で、" +
      "気づかずにそう書いていることもあります。",
    ""
  );
  for (const gap of gaps) lines.push(`- ${describeReaderGap(gap)}`);
  lines.push("");
  return lines;
}

/** 本文の実像の根拠。**引用は本文に実在するものだけが来る**（検算済み） */
function evidenceSection(profile: ReaderProfile | undefined): string[] {
  const actual = profile?.actual;
  if (!actual || actual.evidence.length === 0) return [];
  const basis = actual.basis ? `${actual.basis}から読みました。` : "";
  const model = actual.model ? `（${actual.model}）` : "";
  const lines = [
    "## 本文の実像の根拠",
    "",
    `${basis}読んだ日：${actual.updatedAt.slice(0, 10)}${model}`,
    "",
  ];
  for (const item of actual.evidence) {
    const where = item.from ? `（${item.from}）` : "";
    lines.push(
      `- **${READER_AXIS_LABELS[item.axis]}**${where}　「${item.quote}」`
    );
  }
  lines.push("");
  return lines;
}

/** 一致とずれ */
function matchSection(sheet: TargetSheet): string[] {
  const lines = ["## 一致とずれ", ""];

  if (sheet.aim.length === 0) {
    lines.push(
      "**狙いが書かれていません。** 「ターゲット読者」の1段目（狙い）で選ぶか、" +
        "上の「狙い」の欄へ読者層の名前を書いて作り直すと、" +
        "狙いとの一致度とずれがここに出ます。",
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
 * 3つの輪（設計書6.108.6）。**作者の読者タイプ × 狙い × 本文の実像。**
 *
 * 行は `targetSheetCircles.ts` が組む（ここは並べるだけ）。足りない輪は
 * 埋め方を1行ずつ書く——黙って落とすと、突き合わせたのかどうかが
 * 作者に分からない。
 */
function circlesSection(circles: TargetSheetCircles | undefined): string[] {
  if (!circles) return [];
  const lines = [
    "## 3つの輪",
    "",
    "**書きたいもの**（読者としてのあなた）・**読んでもらいたい読者**（狙い）・" +
      "**書けているもの**（本文の実像）を突き合わせます。上下はありません" +
      "——効く相手が違うだけです。",
    "",
  ];
  for (const edge of circles.edges) {
    lines.push(`### ${edge.heading}`, "", ...edge.lines, "");
  }
  if (circles.missing.length > 0) {
    lines.push("まだ突き合わせられない輪があります。", "");
    for (const note of circles.missing) lines.push(`- ${note}`);
    lines.push("");
  }
  // 単独の3つの輪の紙へは案内しない（2026-09-23。シートの中に一本化した）
  return lines;
}

/**
 * 近づける道（0.82.2 まで単独の3つの輪の紙にあった。2026-09-23 に移した）。
 *
 * 出す条件（辺が2本以上あり、どれも離れている）は `targetSheetCircles.ts`
 * の `needsBridge` が決める。ここは並べるだけ。**どれも動かさない道も
 * あると必ず書く**——手段の一覧が「直せ」という指示に読まれないように。
 */
function bridgeSection(bridge: TargetSheetBridge | undefined): string[] {
  if (!bridge) return [];
  return [
    "## 近づける道",
    "",
    `いま突き合わせられた${bridge.edgeCount}本は、どれも離れています。` +
      "動かせるところは、3つの輪のそれぞれにあります。",
    "",
    ...bridge.routes.map((route) => `- **${route.label}**　${route.text}`),
    "",
    "どれを動かすかは作者が決めることです。どれも動かさない、という選び方もあります。",
    "",
  ];
}

/**
 * 書けたものの実績（0.82.2 まで単独の3つの輪の紙にあった。2026-09-23 に移した）。
 *
 * **「書けるもの」とは書かない**（作者の裁定、2026-09-19）。節の頭で、
 * ここに無いものが書けないという意味ではないと断る。
 *
 * **材料の無いものは「まだ記録がありません」と書く**——0話・0字や空の表を
 * 並べると、でっち上げの数字に見える。反応の台帳を**読めなかった**ときは
 * 「まだ記録がありません」とは書かない（控えた数字が消えたように見える）。
 */
function writtenSection(record: TargetSheetWrittenRecord | undefined): string[] {
  if (!record) return [];
  const lines = [
    "## 書けたものの実績",
    "",
    "ここに並ぶのは、原稿と作品の記録から**数えられたこと**だけです。" +
      "ここに無いものが書けない、という意味ではありません。",
    "",
  ];

  const rows = writtenRows(record.facts);
  if (rows.length === 0) {
    lines.push(
      "まだ記録がありません。本文が増えると、ここに出ます。",
      ""
    );
  } else {
    for (const row of rows) lines.push(`- ${row}`);
    lines.push("");
  }

  lines.push("### 届いている反応", "");
  if (record.reactions === undefined) {
    lines.push(
      "投稿の記録を読めませんでした（下の「読めなかったもの」にあります）。",
      ""
    );
  } else if (record.reactions.length === 0) {
    lines.push(
      "まだ記録がありません。投稿サイトの数字を「読者反応手動入力」か" +
        "「読者反応自動取込」で控えると、サイトごとの最新がここに並びます。",
      ""
    );
  } else {
    for (const row of reactionRows(record.reactions)) lines.push(`- ${row}`);
    lines.push("");
  }
  return lines;
}

/**
 * タイトルとサブタイトルの適合度（設計書6.108.6、P-41）。
 *
 * **数字は目安である。** AI が返した点で、順位づけには使わない——
 * 低い順に並べて「直す候補」を示すだけにする（規則3）。表は話の順の
 * まま出す（点で並べ替えると、目安の数字が序列に見える）。
 */
function titleFitSection(record: TitleFitRecord | undefined): string[] {
  const lines = ["## タイトルとサブタイトルの適合度", ""];
  if (!record) {
    lines.push(
      "**まだ測っていません。** 「ターゲット読者」の選択肢" +
        "「タイトルとサブタイトルの適合度を測る」で、狙いの読者層" +
        "（無ければ実像の層）に引かれる言い方かを、AIが題ごとに見立てます。",
      ""
    );
    return lines;
  }

  const type = READER_TYPES[record.readerType].label;
  const basis = TITLE_FIT_BASIS_PHRASES[record.basis];
  const model = record.model ? `（${record.model}）` : "";
  lines.push(
    `**${type}**（${basis}）に向けて、` +
      `${formatDayTime(new Date(record.measuredAt))}に測りました${model}。`,
    "",
    "**点は目安です。** AIの見立てで、同じ題でも測り直すと動きます。" +
      "題の良し悪しの判定ではなく、その読者層に引かれる言い方かどうかの見当です。",
    ""
  );

  if (record.items.length === 0) {
    lines.push("見立てを読み取れた題がありませんでした。", "");
  } else {
    lines.push("| どこ | 題 | 点 | 一言 |", "|---|---|---|---|");
    for (const item of record.items) {
      lines.push(
        `| ${cell(item.label)} | ${cell(item.text)} | ${item.score} | ` +
          `${cell(item.comment)} |`
      );
    }
    lines.push("", "### 直す候補（点の低い順）", "");
    for (const item of titleFitCandidates(record.items)) {
      lines.push(
        `- ${item.label}「${item.text}」（${item.score}）${item.comment}`
      );
    }
    lines.push(
      "",
      "直すかどうかは作者が決めます。題を変える案が欲しいときは、" +
        "「各話あらすじ」のサブタイトルの提案が読者像を考えて出します。",
      ""
    );
  }

  if (record.unmeasured > 0) {
    lines.push(
      `見立てが返らなかった題が${record.unmeasured}件あります（表には出していません）。`,
      ""
    );
  }
  return lines;
}

const TITLE_FIT_BASIS_PHRASES: Record<TitleFitRecord["basis"], string> = {
  aim: "狙いの層",
  actual: "本文の実像の層",
  declared: "書き方の判断の層",
};

/** 表の升に入れる文字。**縦棒と改行で表を壊さない** */
function cell(text: string): string {
  return text.replace(/\|/g, "｜").replace(/\r?\n/g, " ");
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
    // 狙いだけの日（設計書6.108.6）は、点数の欄を「まだ測っていません」にする
    const top = entry.top
      ? READER_TYPES[entry.top].label
      : "（まだ測っていません）";
    lines.push(
      `| ${historyWhen(entry)} | ${aimColumn(entry)} | ` +
        `${top} | ${topThree(entry)} |`
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
      const affinity = entry.affinities?.[type];
      const label = READER_TYPES[type].label;
      return typeof affinity === "number" ? `${label} ${affinity}` : label;
    })
    .join("／");
}

function topThree(entry: TargetSheetHistoryEntry): string {
  const affinities = entry.affinities;
  if (!affinities) return "—";
  const ranked = READER_TYPE_IDS.filter(
    (type) => typeof affinities[type] === "number"
  ).sort(
    (left, right) =>
      affinities[right] - affinities[left] ||
      READER_TYPE_IDS.indexOf(left) - READER_TYPE_IDS.indexOf(right)
  );
  if (ranked.length === 0) return "—";
  return ranked
    .slice(0, 3)
    .map((type) => `${READER_TYPES[type].label} ${affinities[type]}`)
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
