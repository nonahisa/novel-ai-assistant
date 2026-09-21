import {
  compareAuthorReader,
  type AuthorReaderComparison,
} from "./authorReaderGap";
import type { AuthorReaderProfile } from "./authorReaderType";
import {
  describeReaderGap,
  readerGaps,
  READER_AGE_NOTE,
  READER_TYPES,
  resolveReaderType,
  type ReaderTypeId,
} from "./readerTarget";
import { neighborToward, readerTypeNeighbors } from "./readerTypeNeighbors";
import {
  READER_PROFILE_SCHEMA_VERSION,
  type ReaderProfile,
} from "../models/readerProfile";
import {
  POSTING_SITES,
  readerStatsForSite,
  type PostingLedger,
} from "../models/posting";
import { formatReaderStatsMetrics } from "./postingSiteRecords";

/**
 * 3つの輪の1枚（設計書6.101、実装の順「3」と「4」）。
 *
 * **すでに書けたもの・書きたいもの・読者が読みたいもの**を並べて、
 * 重なっているところを見る読み物である。**AIを1度も呼ばない**——
 * 材料はどれも台帳と実績から数えられるものだけで、待たせる理由が無い。
 * 材料を集めるのは `features/threeCircles.ts` の仕事で、ここは
 * **渡されたものを並べるだけ**である（`resumeSheet.ts` と同じ置き方）。
 *
 * ## 「書けるもの」とは書かない（作者の裁定、2026-09-19）
 *
 * ここがいちばん角が立つ。実績から「あなたに書けるのはここまで」と
 * 読まれうる。**「すでに書けたもの」——実績の記述に留め、限界の宣告に
 * しない。**
 *
 * ## 材料の無い行は出さない
 *
 * 推測で埋めない（この製品の一貫した作法）。空の作品で、でっち上げの
 * 数字が並ぶことがあってはならない。
 *
 * ## 上下を作らない
 *
 * 「あなたの読み癖は的外れ」と読まれたら終わりである。**どちらも
 * 正しい。効く相手が違うだけ**という形を崩さない。
 *
 * VS Code APIにも AI にも依存しない。
 */

/**
 * 生成文書の種類（ファイル名の前置き。設計書6.17.7）。
 *
 * ファイル名・見出し・メニューで使い回す。**写しを作らない。**
 */
export const THREE_CIRCLES_KIND = "3つの輪";

export function threeCirclesTitle(workTitle: string): string {
  return `${THREE_CIRCLES_KIND}——${workTitle}`;
}

/** すでに書けたもの（実績から数えられるものだけ） */
export interface ThreeCirclesWritten {
  /** 書き切った話数（合本は中の話を数える）。**0なら行ごと出さない** */
  episodes?: number;
  /** 合計字数 */
  chars?: number;
  /** 1話の長さの癖。合本は母集団から外したうえで渡す */
  length?: {
    /** ふだんの長さ（中央値） */
    typical: number;
    shortest: number;
    longest: number;
  };
  /** 書いた日数と、いま続いている日数 */
  days?: { active: number; streak: number };
  /** 設定資料の厚み。**0件の種類は呼び出し側で落とす** */
  settings?: readonly { label: string; count: number }[];
  /** `plot.md` の人称。書かれていなければ空 */
  narrativePerson?: string;
  /** 地の文から数えた語り手の一人称。決められなければ空 */
  firstPerson?: string;
  /** 文語体で書かれているとみられるか */
  archaic?: boolean;
}

/** 書きたいもの（診断と、作者の書いたもの） */
export interface ThreeCirclesWanted {
  /** 作家タイプ（設計書6.86）。**受容度・自信度は渡さない**（6.86の裁定） */
  writerType?: { label: string; summary: string };
  /** プロットのジャンル */
  genre?: string;
  /** プロットのモチーフ */
  motif?: string;
}

/** 届いている反応1件（サイトごとの最新） */
export interface ThreeCirclesReaction {
  /** サイトの呼び名（「小説家になろう」） */
  site: string;
  /** 「PV 1,234／ブックマーク 89」。**呼び名は台帳の定義から作る** */
  metrics: string;
  /** 読み取った日（`YYYY-MM-DD`） */
  readAt: string;
}

/**
 * 投稿の台帳から、**サイトごとに最新の1件**を選ぶ（設計書6.79.7／6.101）。
 *
 * **見るのは `scope: "work"`（作品全体）の行だけである。** 話ごとの数字を
 * 混ぜると、「この作品はどれくらい読まれているか」に1話ぶんの数字が出て、
 * 作品の勢いを読み違える。並びは `readerStatsForSite` が新しい順に揃えて
 * いるので、**最初に見つかった作品全体の行**が最新である。
 *
 * **数字の言い方は `formatReaderStatsMetrics` に任せる**——サイトごとの
 * 呼び名（なろうの「評価者数」など）を、ここで言い換えない。
 *
 * **欄が1つも読めなかった行は落とす。** 「（サイト名）：」だけの行を
 * 出しても何も伝わらない。
 *
 * 台帳を読むのは呼び出し側（`features/threeCircles.ts`）の仕事で、
 * ここは**渡された台帳から選ぶだけ**——0.75.4 に切り出した（それまでは
 * 画面側の関数の中にあり、`vscode` を通さないと測れなかった）。
 */
export function collectReactions(
  ledger: PostingLedger
): ThreeCirclesReaction[] {
  const reactions: ThreeCirclesReaction[] = [];
  for (const info of POSTING_SITES) {
    const latest = readerStatsForSite(ledger, info.id).find(
      (record) => record.scope === "work"
    );
    if (!latest) continue;
    const metrics = formatReaderStatsMetrics(latest.metrics);
    if (!metrics) continue;
    reactions.push({
      site: info.label,
      metrics,
      readAt: latest.readAt.slice(0, 10),
    });
  }
  return reactions;
}

export interface ThreeCirclesInput {
  workTitle: string;
  written: ThreeCirclesWritten;
  wanted: ThreeCirclesWanted;
  /** この作品の読者像（宣言・実像）。**無ければ節も辺も出ない** */
  profile?: ReaderProfile;
  /** 届いている反応（サイトごとに最新1件） */
  reactions?: readonly ThreeCirclesReaction[];
  /** 作者自身の読者タイプ（設計書6.101の1）。未診断なら渡さない */
  authorReader?: AuthorReaderProfile;
  /** 読めなかった材料の断り書き。**黙って落とさない** */
  notices?: readonly string[];
}

/* ───────────────────────────────────────────────────────────────
   3本の辺
   ─────────────────────────────────────────────────────────────── */

export type ThreeCirclesEdgeKey =
  | "wanted-readers"
  | "readers-written"
  | "wanted-written";

export interface ThreeCirclesEdge {
  key: ThreeCirclesEdgeKey;
  heading: string;
  lines: string[];
  /**
   * 離れているか。
   *
   * **「近い」も突き合わせたうちに数える。** 数えずに落とすと、
   * 「近い」と出た辺があるのに「2本以上が離れている」と判定して
   * 近づける道を出すことになる。
   */
  apart: boolean;
}

/** 宣言だけを入れた読者像（辺Aのために作る） */
function declaredOnly(profile: ReaderProfile): ReaderProfile | undefined {
  if (!profile.declared) return undefined;
  return {
    schemaVersion: profile.schemaVersion || READER_PROFILE_SCHEMA_VERSION,
    declared: profile.declared,
  };
}

/**
 * 実像だけを入れた読者像（辺Cのために作る）。
 *
 * **`chatReaderBasis` は宣言を優先する。** 台帳をそのまま渡すと、
 * 宣言があるときは辺Cまで宣言を見てしまい、辺Aと同じ突き合わせが
 * 2つの見出しで出る（2本あるように見えて、近づける道を出す条件まで狂う）。
 */
function actualOnly(profile: ReaderProfile): ReaderProfile | undefined {
  if (!profile.actual) return undefined;
  return {
    schemaVersion: profile.schemaVersion || READER_PROFILE_SCHEMA_VERSION,
    actual: profile.actual,
  };
}

/**
 * 「層の名前は違うが、どの軸も2点未満しか離れていない」ときの言い方。
 *
 * `compareAuthorReader` はここで黙る（当たらない指摘で信用を失わない
 * ため）。だが**材料はある**ので、この紙では黙らずにそう書く——
 * 黙ると、突き合わせたのかどうかが作者に分からない。
 */
function closeLines(
  authorType: ReaderTypeId,
  otherType: ReaderTypeId,
  otherPhrase: string
): string[] {
  return [
    `読者としてのあなたは「${READER_TYPES[authorType].label}」、` +
      `${otherPhrase}は「${READER_TYPES[otherType].label}」です。` +
      "名前は違いますが、3つの軸はどれも選択肢1つぶんしか離れていません。",
    "この幅は問いの読み方でも動くので、離れているとは見ていません。",
  ];
}

/** 作者自身の読み方と、読者像の片側（宣言か実像）を突き合わせる */
function compareEdge(
  author: AuthorReaderProfile | undefined,
  side: ReaderProfile | undefined,
  otherPhrase: string
): { lines: string[]; apart: boolean } | undefined {
  if (!author || !side) return undefined;

  const comparison: AuthorReaderComparison | undefined = compareAuthorReader(
    author,
    side
  );
  if (comparison) {
    return { lines: comparison.lines, apart: comparison.kind === "gap" };
  }

  const scores = side.declared?.scores ?? side.actual?.scores;
  if (!scores) return undefined;
  return {
    lines: closeLines(
      resolveReaderType(author.scores),
      resolveReaderType(scores),
      otherPhrase
    ),
    apart: false,
  };
}

/**
 * 3本の辺を組む。**材料の無い辺は返さない**（小見出しごと出ない）。
 *
 * 突き合わせは、すでにある道具でだけ行う——新しい物差しを作ると、
 * 同じ2つを比べているのに機能ごとに違う答えが出る。
 */
export function threeCirclesEdges(
  input: Pick<ThreeCirclesInput, "profile" | "authorReader">
): ThreeCirclesEdge[] {
  const { profile, authorReader } = input;
  if (!profile) return [];

  const edges: ThreeCirclesEdge[] = [];

  const wantedReaders = compareEdge(
    authorReader,
    declaredOnly(profile),
    "この作品の宛先"
  );
  if (wantedReaders) {
    edges.push({
      key: "wanted-readers",
      heading: "書きたいもの ↔ 読者が読みたいもの",
      ...wantedReaders,
    });
  }

  // 読者が読みたいもの ↔ すでに書けたもの（宣言と実像のズレ。6.91）
  if (profile.declared && profile.actual) {
    const gaps = readerGaps(profile.declared.scores, profile.actual.scores);
    edges.push({
      key: "readers-written",
      heading: "読者が読みたいもの ↔ すでに書けたもの",
      apart: gaps.length > 0,
      lines:
        gaps.length > 0
          ? [
              "どちらが正しいとも言いません。向けている先が本当で書き方がまだ追いついていないこともあれば、書けているもののほうが本当で、気づかずにそう書いていることもあります。",
              ...gaps.map((gap) => `- ${describeReaderGap(gap)}`),
            ]
          : [
              "3つの軸とも、ずれていません。向けようとしている先へ、書けているものが向いています。",
            ],
    });
  }

  const wantedWritten = compareEdge(
    authorReader,
    actualOnly(profile),
    "書けているものの向き先"
  );
  if (wantedWritten) {
    edges.push({
      key: "wanted-written",
      heading: "書きたいもの ↔ すでに書けたもの",
      ...wantedWritten,
    });
  }

  return edges;
}

/**
 * 「近づける道」を出す条件（設計書6.101、実装の順「4」）。
 *
 * **突き合わせられた辺が2本以上あり、そのすべてが離れているとき。**
 * 1本しか出せないときは出さない——**「重なりが空」と言い切れない**
 * からである。1本の食い違いだけで3つの輪の置き直しを勧めるのは、
 * 判定として重すぎる。
 */
export const THREE_CIRCLES_MIN_EDGES = 2;

export function needsBridge(edges: readonly ThreeCirclesEdge[]): boolean {
  return (
    edges.length >= THREE_CIRCLES_MIN_EDGES &&
    edges.every((edge) => edge.apart)
  );
}

/* ───────────────────────────────────────────────────────────────
   紙を組む
   ─────────────────────────────────────────────────────────────── */

export function buildThreeCirclesSheet(input: ThreeCirclesInput): string {
  const lines: string[] = [`# ${threeCirclesTitle(input.workTitle)}`, ""];

  // 読めなかったものは先に断る。あとに回すと「まだありません」を
  // 本当だと読んでしまう（再開の1枚と同じ）
  for (const notice of input.notices ?? []) {
    lines.push(`> ${notice}`, "");
  }

  lines.push(
    "この紙は品定めではありません。3つの輪のいまの位置を並べて、**次に何を動かせるか**を見るためのものです。",
    ""
  );

  lines.push(...writtenSection(input.written));
  lines.push(...wantedSection(input));
  lines.push(...readersSection(input));
  lines.push(...overlapSection(input));
  lines.push(...howToRead());

  return lines.join("\n");
}

/**
 * すでに書けたもの。
 *
 * **「書けるもの」とは書かない**（作者の裁定、2026-09-19）。実績の
 * 記述に留めるため、節の頭で「ここに無いものが書けない、という意味では
 * ない」と断る。
 */
function writtenSection(written: ThreeCirclesWritten): string[] {
  const lines = [
    "## すでに書けたもの",
    "",
    "ここに並ぶのは、原稿と台帳から**数えられたこと**だけです。ここに無いものが書けない、という意味ではありません。",
    "",
  ];

  const rows: string[] = [];

  if (written.episodes !== undefined && written.episodes > 0) {
    const chars =
      written.chars === undefined
        ? ""
        : `、合計${written.chars.toLocaleString("ja-JP")}字`;
    rows.push(`書き切ったのは${written.episodes.toLocaleString("ja-JP")}話${chars}。`);
  }

  if (written.length) {
    const { typical, shortest, longest } = written.length;
    rows.push(
      `1話の長さは、ふだん${typical.toLocaleString("ja-JP")}字ほど` +
        `（いちばん短い話が${shortest.toLocaleString("ja-JP")}字、` +
        `いちばん長い話が${longest.toLocaleString("ja-JP")}字）。`
    );
  }

  if (written.days && written.days.active > 0) {
    const streak =
      written.days.streak > 0
        ? `いまは${written.days.streak}日続いています。`
        : "";
    rows.push(`書いた日は${written.days.active}日。${streak}`.trim());
  }

  const settings = (written.settings ?? []).filter((entry) => entry.count > 0);
  if (settings.length > 0) {
    rows.push(
      "設定資料は、" +
        settings
          .map((entry) => `${entry.label}${entry.count}件`)
          .join("・") +
        "。"
    );
  }

  const style = styleRow(written);
  if (style) rows.push(style);

  if (rows.length === 0) {
    lines.push(
      "まだ数えられるものがありません。本文が増えると、ここに出ます。",
      ""
    );
    return lines;
  }

  for (const row of rows) lines.push(`- ${row}`);
  lines.push("");
  return lines;
}

/** 人称と文体。**分かっているものだけ**をつなぐ */
function styleRow(written: ThreeCirclesWritten): string {
  const parts: string[] = [];
  if (written.narrativePerson?.trim()) {
    parts.push(`人称は「${written.narrativePerson.trim()}」`);
  }
  if (written.firstPerson?.trim()) {
    parts.push(`地の文の一人称は「${written.firstPerson.trim()}」`);
  }
  if (written.archaic) parts.push("文語体・旧字旧かなで書かれています");
  return parts.length === 0 ? "" : `${parts.join("、")}。`;
}

/**
 * 書きたいもの。
 *
 * **6.86 の受容度・自信度は出さない**（設計書6.86。見せると、それ自体が
 * ラベルになる）。出すのはタイプの呼び名と説明だけである。
 */
function wantedSection(input: ThreeCirclesInput): string[] {
  const lines = ["## 書きたいもの", ""];
  const rows: string[] = [];

  const { writerType, genre, motif } = input.wanted;
  if (writerType) {
    rows.push(`作家タイプは「${writerType.label}」。${writerType.summary}`);
  }
  if (genre?.trim()) rows.push(`ジャンル：${oneLine(genre)}`);
  if (motif?.trim()) rows.push(`モチーフ：${oneLine(motif)}`);

  if (input.authorReader) {
    const type = READER_TYPES[resolveReaderType(input.authorReader.scores)];
    rows.push(
      `読者としてのあなたは「${type.label}」。${type.summary}` +
        `あなたに効くのは、${type.works}`
    );
  }

  if (rows.length === 0) {
    lines.push(
      "まだお聞きしていません。「作家タイプ診断」と「あなた自身の読者タイプ」にお答えいただくと、ここに出ます。",
      ""
    );
    return lines;
  }

  for (const row of rows) lines.push(`- ${row}`);
  lines.push("");
  return lines;
}

/**
 * 読者が読みたいもの。
 *
 * 3つの輪のうち、**ここだけは作者が直接観測できない**（だから作者は
 * 無意識に自分の読み癖で代用する）。届いている反応は、その代用でない
 * 唯一の材料なので、あれば必ず並べる。
 */
function readersSection(input: ThreeCirclesInput): string[] {
  const lines = ["## 読者が読みたいもの", ""];
  const rows: string[] = [];

  const declared = input.profile?.declared;
  if (declared) {
    const type = READER_TYPES[resolveReaderType(declared.scores)];
    rows.push(
      `向けているつもりの宛先は「${type.label}」。${type.summary}` +
        `この層に効くのは、${type.works}　離れるのは、${type.loses}`
    );
  }

  const actual = input.profile?.actual;
  if (actual) {
    const type = READER_TYPES[resolveReaderType(actual.scores)];
    rows.push(
      `書けているものが向いているのは「${type.label}」。${type.summary}`
    );
  }

  for (const reaction of input.reactions ?? []) {
    rows.push(
      `届いている反応（${reaction.site}）：${reaction.metrics}` +
        `（${reaction.readAt} 時点）`
    );
  }

  if (rows.length === 0) {
    lines.push(
      "まだ分かりません。「ターゲット読者診断」でお答えいただくと、ここに出ます。投稿サイトの数字を控えていれば、届いている反応もここに並びます。",
      ""
    );
    return lines;
  }

  for (const row of rows) lines.push(`- ${row}`);
  lines.push("");
  return lines;
}

/**
 * 重なっているところ（3本の辺）と、近づける道。
 *
 * **1本も出せないときは、何が足りないかを書く。** 見出しだけが並ぶと、
 * 「ここには何も無い」ではなく「壊れている」ように見える。
 */
function overlapSection(input: ThreeCirclesInput): string[] {
  const edges = threeCirclesEdges(input);
  const lines = ["## 重なっているところ", ""];

  if (edges.length === 0) {
    lines.push(...missingLines(input), "");
    return lines;
  }

  for (const edge of edges) {
    lines.push(`### ${edge.heading}`, "", ...edge.lines, "");
  }

  if (needsBridge(edges)) lines.push(...bridgeSection(input, edges));
  return lines;
}

/** 何を済ませると突き合わせが出るか（診断への誘い） */
function missingLines(input: ThreeCirclesInput): string[] {
  const missing: string[] = [];
  if (!input.authorReader) {
    missing.push("あなた自身の読者タイプ（9問。「あなた自身の読者タイプ」）");
  }
  if (!input.profile?.declared && !input.profile?.actual) {
    missing.push("この作品の宛先と実像（「ターゲット読者診断」）");
  }

  if (missing.length === 0) {
    // 材料はあるのに辺が1本も立たない（宣言だけ・実像だけで、
    // 作者自身の読者タイプが無いときなど）。**足りないものを言えない
    // ときに、当てずっぽうの案内を出さない**
    return ["いまはまだ、3つを突き合わせられません。"];
  }

  return [
    "いまはまだ、3つを突き合わせられません。次のどちらかが済むと、ここに突き合わせが出ます。",
    ...missing.map((item) => `- ${item}`),
  ];
}

/**
 * 近づける道（設計書6.101、実装の順「4」）。
 *
 * **「重なっていません」とは書かない**（作者の裁定、2026-09-19）。
 * 空だと告げるのは酷だが、重なっていないのに「ここが狙い目」と言うのは
 * 嘘である。**判定ではなく手段を渡す形**なら、どちらも避けられる。
 *
 * **名指しできない手段は、その項目ごと落とす。** 材料が無いまま
 * 「隣へ寄せましょう」とだけ言っても、どこへ寄せるのか分からない。
 */
function bridgeSection(
  input: ThreeCirclesInput,
  edges: readonly ThreeCirclesEdge[]
): string[] {
  const authorType = input.authorReader
    ? resolveReaderType(input.authorReader.scores)
    : undefined;
  const declaredType = input.profile?.declared
    ? resolveReaderType(input.profile.declared.scores)
    : undefined;
  const actualType = input.profile?.actual
    ? resolveReaderType(input.profile.actual.scores)
    : undefined;

  const routes: string[] = [];

  // ① 読者が読みたいものを動かす（ターゲットを寄せる）
  if (declaredType && authorType) {
    const neighbors = readerTypeNeighbors(declaredType);
    if (neighbors.length > 0) {
      const names = neighbors
        .map((id) => `「${READER_TYPES[id].label}」`)
        .join("・");
      const nearest = neighborToward(declaredType, authorType);
      const detail = nearest
        ? `そのうち、読者としてのあなた（「${READER_TYPES[authorType].label}」）にいちばん近いのは「${READER_TYPES[nearest].label}」です。この層に効くのは、${READER_TYPES[nearest].works}`
        : "";
      routes.push(
        [
          `**読者が読みたいものを動かす（ターゲットを寄せる）**　` +
            `いまの宛先「${READER_TYPES[declaredType].label}」の隣は、${names}です。`,
          detail,
        ]
          .filter(Boolean)
          .join("")
      );
    }
  }

  // ② すでに書けたものを動かす（書ける範囲を広げる）。**いきなり飛ばさない**
  const step =
    actualType && declaredType
      ? neighborToward(actualType, declaredType)
      : undefined;
  if (actualType && declaredType && step) {
    routes.push(
      `**すでに書けたものを動かす（書ける範囲を広げる）**　` +
        `書けているものは「${READER_TYPES[actualType].label}」に向いています。` +
        `宛先の「${READER_TYPES[declaredType].label}」へいきなり寄せず、隣の「${READER_TYPES[step].label}」まで一歩。` +
        `この層に効くのは、${READER_TYPES[step].works}`
    );
  }

  // ③ 書きたいものを動かす（題材を選び直す）
  if (declaredType) {
    const type = READER_TYPES[declaredType];
    routes.push(
      `**書きたいものを動かす（題材を選び直す）**　` +
        `宛先の「${type.label}」に効くのは、${type.works}　離れるのは、${type.loses}` +
        `　書きたいものの中で、これに当たる題材を選び直す道があります。`
    );
  }

  if (routes.length === 0) return [];

  return [
    "## 近づける道",
    "",
    `いま突き合わせられた${edges.length}本は、どれも離れています。動かせるところは3つあります。`,
    "",
    ...routes.map((route) => `- ${route}`),
    "",
    "どれを動かすかは作者が決めることです。どれも動かさない、という選び方もあります。",
    "",
  ];
}

/**
 * この紙の読み方。
 *
 * **上下が無いことを必ず書く。** ここが格付けとして読まれたら、
 * 製品が一貫して守ってきた書き方ごと壊れる。
 *
 * 年齢層を軸にしない理由は `READER_AGE_NOTE` を使い回す（写しを作らない）。
 */
function howToRead(): string[] {
  return [
    "## この紙の読み方",
    "",
    "**上下はありません。** どの読者層にもその層なりの読み方があり、作家タイプにもそのタイプなりの書き方があります。違うのは効く相手だけです。",
    "「書きたいもの」と「読者が読みたいもの」が離れていても、どちらかが間違っているわけではありません。**離れているところが、作者からいちばん見えにくい場所**だというだけです。",
    "",
    READER_AGE_NOTE,
    "",
    "この紙はAIを1度も使わずに、原稿と台帳から組み立てています。原稿も台帳も書き換えていません。",
    "",
  ];
}

/** 箇条書きの節（ジャンルなど）を1行に畳む。改行がそのまま出ると崩れる */
function oneLine(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .join("／");
}
