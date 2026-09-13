import {
  describeReaderGap,
  readerAxesOf,
  readerGaps,
  readerLevel,
  READER_AGE_NOTE,
  READER_AXIS_ENDS,
  READER_AXIS_LABELS,
  READER_AXIS_ORDER,
  READER_TYPES,
  resolveReaderType,
  type ReaderTypeId,
} from "./readerTarget";
import type { ReaderProfile, ReaderScores } from "../models/readerProfile";

/**
 * ターゲット読者診断の紙（設計書6.91）。
 *
 * **作家タイプ診断の紙（`writerGuideDoc.ts`）と同じ並びにする**——
 * 名前・一行・目盛り・なぜこの名前か。作者が「スクリーンショットで
 * SNSに上げたくなるような」と言ったのはあちらの画面だが、
 * **同じ作者が続けて見る2枚目**である。並びが違うと、比べられない。
 *
 * ## あちらと違うのは、2枚あること
 *
 * 宣言（作者が答えた宛先）と実像（本文から読んだ向き先）を**並べて出す**。
 * ズレがこの診断の値打ちなので、片方だけを大きく出さない。
 *
 * **どちらが正しいとも言わない。** 宣言が本当のこともあれば
 * （まだ書けていないだけ）、実像が本当のこともある（気づかずにそう
 * 書いていた）。決めるのは作者である。
 *
 * VS Code APIに依存しない。
 */

export const READER_GUIDE_TITLE = "この作品は、誰に向いていますか";

/** 目盛り1本。作家タイプの紙と同じ形にする（並べて見るため） */
function axisTable(scores: ReaderScores, heading: string): string[] {
  const rows = READER_AXIS_ORDER.map((axis) => {
    const score = scores[axis];
    const filled = Math.max(0, Math.min(6, Math.round(score)));
    const bar = "●".repeat(filled) + "○".repeat(6 - filled);
    const level = { low: "低", mid: "中", high: "高" }[readerLevel(score)];
    const ends = READER_AXIS_ENDS[axis];
    return (
      `| ${READER_AXIS_LABELS[axis]} | ${bar} | ${score}／6（${level}） | ` +
      `${ends.low} ←→ ${ends.high} |`
    );
  });

  return [`| ${heading} | | 点 | 端から端まで |`, "|---|---|---|---|", ...rows];
}

/**
 * **なぜその名前になったか。**
 *
 * 名前だけ出されても、当たっているかを確かめようがない。
 * どの軸が主で、どれが副か——ここが読めれば、作者は自分で
 * 「合っている」「これは違う」と言える。
 */
function whyThisName(scores: ReaderScores): string {
  const { main, sub } = readerAxesOf(scores);
  if (!main) {
    return "3つの軸が**同じ帯にそろっている**ので、どれか一つを主とは呼びません。この名前は、そのそろい方から来ています。";
  }
  const mainLabel = READER_AXIS_LABELS[main];
  if (!sub) {
    return (
      `この名前は、**${mainLabel}**がただ一つ抜けていることから来ています。` +
      "ほかの2つは、いまのところ向き先を変えていません。"
    );
  }
  return (
    `この名前は、**${READER_AXIS_LABELS[main]}**（主）と ` +
    `**${READER_AXIS_LABELS[sub]}**（副）の組み合わせから来ています。`
  );
}

/** タイプの見出しひとかたまり（名前・一行・目盛り・理由） */
function typeBlock(
  lead: string,
  scores: ReaderScores,
  heading: string
): string[] {
  const type = READER_TYPES[resolveReaderType(scores)];
  return [
    `## ${lead} **${type.label}**`,
    "",
    `> ${type.summary}`,
    "",
    ...axisTable(scores, heading),
    "",
    whyThisName(scores),
    "",
    `- **効くこと**：${type.works}`,
    `- **離れるところ**：${type.loses}`,
    "",
  ];
}

/**
 * ズレの節。**この診断でいちばん値打ちのあるところ。**
 *
 * ズレが無ければ「無い」と言う（黙って飛ばすと、比べたのかどうかが
 * 分からない）。
 */
function gapSection(profile: ReaderProfile): string[] {
  const { declared, actual } = profile;
  if (!declared || !actual) return [];

  const gaps = readerGaps(declared.scores, actual.scores);
  const lines = ["## 向けているつもりと、書けているもの", ""];

  if (gaps.length === 0) {
    lines.push(
      "**3つとも、ずれていません。** 向けようとしている先へ、書けているものが向いています。",
      ""
    );
    return lines;
  }

  lines.push(
    "**どちらが正しいとも言いません。** 向けている先が本当で書き方がまだ追いついていないこともあれば、書けているもののほうが本当で、気づかずにそう書いていることもあります。決めるのは作者です。",
    ""
  );
  for (const gap of gaps) lines.push(`- ${describeReaderGap(gap)}`);
  lines.push("");
  return lines;
}

/** 根拠の節。**引用は本文に実在するものだけが来る**（検算済み） */
function evidenceSection(profile: ReaderProfile): string[] {
  const evidence = profile.actual?.evidence ?? [];
  if (evidence.length === 0) return [];

  const lines = ["## そう読んだ根拠", "", "本文・プロット・紹介文から、そのまま引いています。", ""];
  for (const item of evidence) {
    const where = item.from ? `（${item.from}）` : "";
    lines.push(`- **${READER_AXIS_LABELS[item.axis]}**${where}　「${item.quote}」`);
  }
  lines.push("");
  return lines;
}

/** ほかの10タイプ。**いまの位置に印を付ける**（作家タイプの紙と同じ） */
function otherTypes(current: ReaderTypeId | undefined): string[] {
  const lines = [
    "## ほかの読者層",
    "",
    "3つの軸の組み合わせで、11通りに分かれます。**上下はありません**——どの層にもその層なりの読み方があり、狙う先が違うだけです。",
    "",
  ];
  for (const [id, info] of Object.entries(READER_TYPES)) {
    const mark = id === current ? "　**← この作品**" : "";
    lines.push(`- **${info.label}**${mark}　${info.summary}`);
  }
  lines.push("", READER_AGE_NOTE, "");
  return lines;
}

export function buildReaderGuide(input: {
  workTitle: string;
  profile: ReaderProfile;
  /** 実像を読めなかった軸の呼び名。**黙って埋めない** */
  unmeasured?: readonly string[];
}): string {
  const { workTitle, profile } = input;
  const parts: string[] = [`# ${READER_GUIDE_TITLE}`, "", `**${workTitle}**`, ""];

  /*
    **実像を先に置く。** 作者が知りたいのは「書けているものは誰に
    向いているか」であって、自分がさっき答えたことではない。
    宣言を先頭に置くと、1枚目の見出しが「自分の答えの復唱」になる。
  */
  if (profile.actual) {
    parts.push(...typeBlock("この作品は", profile.actual.scores, "実像"));
    const basis = profile.actual.basis
      ? `${profile.actual.basis}から読みました。`
      : "";
    parts.push(
      `${basis}読んだ日：${profile.actual.updatedAt.slice(0, 10)}` +
        (profile.actual.model ? `（${profile.actual.model}）` : ""),
      ""
    );
  }

  if (input.unmeasured && input.unmeasured.length > 0) {
    parts.push(
      `**${input.unmeasured.join("・")}** は読み取れませんでした（どちらとも言えない位置に置いてあります）。話数が増えると読めるようになります。`,
      ""
    );
  }

  if (profile.declared) {
    parts.push(...typeBlock("向けているつもりは", profile.declared.scores, "宣言"));
  } else {
    parts.push(
      "## 向けているつもりは、まだお聞きしていません",
      "",
      "9問お答えいただくと、**向けているつもりと、書けているもののズレ**が出ます。ここがこの診断でいちばん役に立つところです。",
      ""
    );
  }

  parts.push(...gapSection(profile));
  parts.push(...evidenceSection(profile));

  const current = profile.actual
    ? resolveReaderType(profile.actual.scores)
    : profile.declared
      ? resolveReaderType(profile.declared.scores)
      : undefined;
  parts.push(...otherTypes(current));

  parts.push(
    "## この紙について",
    "",
    "答えは作品の `設定/読者像.json` に入ります。GitHubへ送っていれば、ほかの端末でも同じ結果が出ます。作品ごとに別の答えを持てます（同じ作者でも、作品が変われば向き先は変わるためです）。",
    ""
  );

  return parts.join("\n");
}
