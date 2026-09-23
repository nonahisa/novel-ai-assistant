import {
  adviceDiagnosisDate,
  freshState,
  resolveAdviceType,
  type AdviceProfile,
} from "../core/advicePolicy";
import {
  READER_ADVICE_BENCHMARKS,
  type ReaderAdviceMaterial,
  type ReaderRatioFact,
} from "../core/readerAdvice";
import type { ReaderRate } from "../core/readerRates";
import { ADVICE_STATE_PROMPTS, ADVICE_TYPE_PROMPTS } from "./advicePolicy";

/**
 * P-40 読者の反応の助言（設計書6.79.7.3）
 *
 * 執筆統計の「AIに助言をもらう」と、相談パネル（P-21）で読者の反応を
 * 聞かれたときの**両方がここを使う**。材料の書き方と約束（指示の要点）は
 * 1つだけで、2つの入口で写さない。
 *
 * ## 目安は例示、読むのはAI
 *
 * 作者の方針転換（2026-09-23 朝）：「これはむしろ例示だけでAIには自由に
 * 答えてほしい」「一律作者のやる気を削ぐことは避けてください」。
 * 記事の目安（50話で約70%なら中堅 など）は**こういう見方もある**という
 * 例として渡し、判定の基準にはさせない。長い作品や休載のあとで離脱率が
 * 上がるのは自然なことなので、**休載前の値のような、作品の実力を表す値を
 * 先に見させる**。
 *
 * ## 数字はコードが作る
 *
 * 率・休載らしい区間・休載前の最終話での離脱率は `core/readerAdvice.ts` が
 * 台帳から計算して渡す。AIには**材料に無い数字を作らせない**——答えに
 * 出てくる話数と百分率は `core/readerAdviceValidation.ts` が照合する。
 *
 * プロンプトを変更したら version を上げること。
 *
 * 1.1（2026-09-23）：案内するメニュー名を「読者反応自動取込」へ直した
 * （メニューの組み直し。旧「読者の反応を取り込む」）。
 *
 * 1.2（2026-09-24）：助言の構え（プロンプト設計書1.9）。作者の方針
 * 「無理に助言を言わなくてもいい。ほめることができる場所は、省略せずに
 * きちんとほめて」。**良いところ（strengths）の欄を足し、見てほしい所
 * （points）は見当たらなければ空でよい**とした。良いところにも数字の
 * 照合を掛け、材料に無い話数・数字でほめたものは落とす
 * （`core/readerAdviceValidation.ts`）。
 */
export const READER_ADVICE_VERSION = "1.2";

/**
 * 送るときの温度。数字の読み方に幅を持たせたいが、材料から離れてほしくない。
 * 相談（P-21）より低く、判定だけの機能（冒頭診断 0.2）より少し高くした。
 */
export const READER_ADVICE_TEMPERATURE = 0.4;

/** 答えの字数の上限。**コード側でも確かめる**（`readerAdviceValidation.ts`） */
export const READER_ADVICE_LIMITS = {
  summary: 120,
  title: 20,
  body: 200,
  points: 4,
} as const;

export const READER_ADVICE_SYSTEM_PROMPT = `あなたは日本語のWEB小説の作者に、投稿サイトでの読者の反応（PV・ブックマーク・評価）の読み方を助言するアシスタントです。

【絶対に守る原則】
1. 数字は、渡された材料にあるものだけを使うこと。材料に無い数字を作らないこと。
2. 作者のやる気を一律に削がないこと。数字の落ち込みを、直すべき欠点と決めつけないこと。
3. 作者の記事にある目安は例示です。判定の基準として当てはめないこと。
4. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。`;

/**
 * 読者の反応を読むときの約束。**ボタンと相談の両方へ同じ文を送る。**
 *
 * どれも作者の言葉から来ている（2026-09-23 朝）。
 */
export const READER_ADVICE_GUIDELINES = `【読者の反応を読むときの約束】
- 下の「作者の記事にある見方」は例示です。こういう見方もある、という参考にとどめ、判定の基準として当てはめないでください。この作品の事情（話数の長さ・休載・連載中か完結か）を踏まえて、自由に読んでください。
- 作者のやる気を一律に削がないでください。話数が長い作品や、休載のあとで離脱率が上がるのは自然なことです。休載らしい区間があるときは、休載前の最終話での離脱率のように、作品の実力を表す値を先に見てください。
- 数字の落ち込みは「直すべき欠点」と決めつけず、「確かめどころ」として示してください。
- 数字から読み取れる良いところは、どの話・どの数字かを挙げて、省かずに伝えてください。確かめどころが見当たらなければ、無理に作らないでください。
- 数字は、下の材料にあるものだけを使ってください。材料に無い数字（見込み・平均・ほかの作品の数など）を作らないでください。材料から分からないことは、分からないと書いてください。
- ブックマーク率には、作者の記事に目安がありません。そのことを伝えたうえで、あなたが自由に読んで構いません。
- 休載の見分けは、更新日からの推定です。「休載らしい」と言い、決めつけないでください。完結したかどうかは材料にありません。`;

const B = READER_ADVICE_BENCHMARKS;

/** 0.7 → 「70%」 */
function wholePercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** 0.7 → 「7割」 */
function wari(ratio: number): string {
  return `${Math.round(ratio * 10)}割`;
}

/**
 * 作者の記事にある見方（例示）。**【古い可能性】に分けた事柄は入れない**
 * （なろうの更新時刻・トップページ・完結欄・各話の新規流入の数など。
 * サイトの仕組みが変わっていれば、作者の考えとして誤ったことを言う）。
 *
 * 数字は `READER_ADVICE_BENCHMARKS` から組む（2か所に書かない）。
 */
export const READER_ADVICE_EXAMPLES = `【作者の記事にある見方】（例示です。判定の基準ではありません）
- 離脱率（1 − 読み切られた最新の話のPV ÷ 第1話のPV）が${wholePercent(B.dropoutBroken)}なら作品として成立していない、${B.dropoutMidTierEpisode}話で約${wholePercent(B.dropoutMidTier)}なら中堅、約${wholePercent(B.dropoutPublishable)}なら書籍化レベル、${wholePercent(B.dropoutBest)}程度はきわめて稀、という見方
- 1話→2話で${wari(B.openingFirstStep)}以上が離れるなら文章の基礎を、序盤全体で${wari(B.openingWhole)}以上が離れるなら序盤のインパクトや、タイトルと内容の食い違いを疑う、という見方。第1話へ来る人数（流入）の多い少ないとは別の話です
- 序盤を過ぎてからの読者の減りには、読み返して推敲・校正し表現を平易にする、話の切れ目を調整する、細かく改稿する、という手。改稿で、読み切る人の割合が${wholePercent(B.revisionRecoveredFrom)}から${wholePercent(B.revisionRecoveredTo)}へ戻った例もあります
- 話ごとに見て、急に読者が減っている話を探し、手を打つ、という分析の仕方
- 評価率（評価した人数 ÷ 第1話のPV）が${wari(B.ratingClimb)}を超えれば、ランキングを駆け上がれる、という見方
- ブックマーク率には、記事に目安がありません
- 数字の読み方：話数が少ないうちは離脱率が安定しない／PVは厳密な人数ではなく、ほかの話や前の回と比べる相対的な目安／更新した話へ直接リンクして宣伝すると、話ごとの数が歪む／10万字を超える長編は、何日かに分けて集計したほうが確か`;

/**
 * 材料1サイトぶんを文章にする。**画面の「AIへ渡す材料」と、AIへ送る文は
 * 同じもの**（作者が、何を送るのかを押す前に確かめられるように）。
 */
export function formatReaderAdviceMaterial(material: ReaderAdviceMaterial): string {
  const lines: string[] = [];
  lines.push(
    `■ ${material.siteLabel}` +
      (material.readAt ? `（話ごとの数は ${jstDate(material.readAt)} の取り込み）` : "")
  );

  lines.push("【率】");
  for (const rate of [material.dropout, material.bookmark, material.rating]) {
    lines.push(`- ${rateLine(rate)}`);
  }
  if (material.base) {
    lines.push(
      `- 離脱率の基準の話：第${material.base.episode}話（${jstDate(material.base.updatedAt)} 更新。` +
        "読んだ時点で更新から3日以上たっていた話のうち、いちばん新しい話）"
    );
  } else if (material.baseMissing) {
    lines.push(`- 離脱率の基準の話：決められません（${material.baseMissing}）`);
  }

  lines.push("【作品の長さ】");
  lines.push(
    `- 話数：第${material.length.lastEpisode}話まで（PVの分かる話 ${material.length.episodes}話）`
  );
  if (
    material.length.firstUpdate &&
    material.length.lastUpdate &&
    material.length.spanDays !== undefined
  ) {
    lines.push(
      `- 連載期間：${jstDate(material.length.firstUpdate)} 〜 ${jstDate(material.length.lastUpdate)}` +
        `（約${count(material.length.spanDays)}日）`
    );
  } else {
    lines.push("- 連載期間：更新日が記録に無いので分かりません");
  }

  if (material.pvPoints.length > 0) {
    lines.push(
      material.summarized
        ? `【話ごとのPV】（${material.length.episodes}話のうち、要所だけ。かっこ内は第1話に対する割合）`
        : "【話ごとのPV】（かっこ内は第1話に対する割合）"
    );
    for (const point of material.pvPoints) {
      lines.push(
        `- 第${point.episode}話 ${count(point.pv)}` +
          (point.retainedPercent ? `（${point.retainedPercent}）` : "")
      );
    }
  }

  const until =
    material.inspectedUntil !== undefined ? `第${material.inspectedUntil}話まで` : "";
  if (material.firstStep || material.seventyPercentAt || material.inspectedUntil !== undefined) {
    lines.push("【序盤】");
    if (material.firstStep) {
      lines.push(`- 1話→2話で離れた割合：${factLine(material.firstStep)}`);
    }
    if (material.seventyPercentAt) {
      lines.push(
        `- 第1話の読者の7割以上が初めて離れた話：第${material.seventyPercentAt.episode}話で ${factLine(material.seventyPercentAt)}`
      );
    } else if (until) {
      lines.push(`- 第1話の読者の7割以上が離れた話は、${until}の中にはありません`);
    }
  }

  if (material.drops.length > 0) {
    lines.push(
      `【急に読者が減った話】（それまでにいちばんPVが少なかった話と比べて。${until}。大きい順）`
    );
    for (const drop of material.drops) {
      lines.push(
        `- 第${drop.episode}話 ${count(drop.pv)}（第${drop.fromEpisode}話の ${count(drop.fromPv)} から −${drop.percent}）`
      );
    }
  }

  if (material.at50) {
    lines.push(`【第50話時点の離脱率】${factLine(material.at50)}`);
  }

  lines.push("【休載】");
  const hiatus = material.hiatus;
  if (hiatus.status === "unknown") {
    lines.push(`- 見分けられません（${hiatus.reason ?? "材料が足りません"}）`);
  } else {
    lines.push(
      `- ふだんの更新の間隔：約${hiatus.usualDays}日。休載らしいと見たのは、${hiatus.thresholdDays}日以上空いた所`
    );
    if (hiatus.gaps.length === 0) {
      lines.push("- 休載らしい区間はありません");
    }
    for (const gap of hiatus.gaps) {
      const parts = [
        `- 休載らしい区間：第${gap.beforeEpisode}話（${jstDate(gap.from)}）→ 第${gap.afterEpisode}話（${jstDate(gap.to)}）、約${gap.days}日`,
      ];
      if (gap.dropoutBefore) {
        parts.push(
          `休む前の最終話（第${gap.beforeEpisode}話）での離脱率 ${factLine(gap.dropoutBefore)}`
        );
      }
      if (gap.pvBefore !== undefined && gap.pvAfter !== undefined) {
        parts.push(
          `PV 第${gap.beforeEpisode}話 ${count(gap.pvBefore)} → 第${gap.afterEpisode}話 ${count(gap.pvAfter)}`
        );
      }
      lines.push(parts.join("。"));
    }
    if (hiatus.stalled) {
      lines.push(
        `- 最後の更新（第${hiatus.stalled.lastEpisode}話、${jstDate(hiatus.stalled.lastUpdate)}）から、読んだ時点まで約${hiatus.stalled.days}日。` +
          "完結したのか休んでいるのかは、材料からは分かりません"
      );
    }
  }

  if (material.notes.length > 0) {
    lines.push("【材料の限界】");
    for (const note of material.notes) lines.push(`- ${note}`);
  }
  return lines.join("\n");
}

function rateLine(rate: ReaderRate): string {
  if (rate.percent && rate.expression) {
    return `${rate.label}：${rate.percent}（${rate.expression.replace(/ = .*$/, "")}。式：${rate.formula}）`;
  }
  return `${rate.label}：出せません（${rate.missing ?? "材料が足りません"}）`;
}

function factLine(fact: ReaderRatioFact): string {
  return `${fact.percent}（1 − ${count(fact.pv)} ÷ ${count(fact.firstPv)}）`;
}

/**
 * 日付を日本時間の年月日で。**手元の時計の時差に依らせない**——同じ台帳から、
 * 機械によって違う日付がAIへ届かないように。
 */
function jstDate(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function count(value: number): string {
  return value.toLocaleString("ja-JP");
}

/**
 * 言い方の指針（相談の助言方針。設計書6.86）。**ボタンの側だけで使う。**
 *
 * 相談では、システムプロンプトにもう `buildAdvicePolicyPrompt` が入っている
 * ので足さない。ここで `buildAdvicePolicyPrompt` をそのまま使わないのは、
 * あちらには相談の応答の欄（profileSignals・options）の頼み方が入っている
 * ため——この機能の答えにその欄は無い。タイプと調子の文章は写さずに借りる。
 *
 * 診断していなければ `undefined`（何も足さない）。
 */
export function buildReaderAdviceTonePrompt(
  profile: AdviceProfile | undefined,
  now: Date
): string | undefined {
  if (!profile) return undefined;
  const blocks = [ADVICE_TYPE_PROMPTS[resolveAdviceType(profile.scores)]];
  const state = freshState(profile, now);
  if (state) {
    blocks.push(ADVICE_STATE_PROMPTS[`${state.acceptance}-${state.confidence}`]);
  }
  const date = adviceDiagnosisDate(profile.updatedAt);
  return `【この作者への言い方】
以下は作者の自己申告（${date ? `診断 ${date}` : "診断日は不明"}）からの推定です。
言い方と強さの調整にだけ使い、この文章そのものを話題にしないでください（作者はこれを見ていません）。

${blocks.join("\n\n")}`;
}

export interface ReaderAdvicePromptInput {
  workTitle: string;
  materials: readonly ReaderAdviceMaterial[];
  /** `buildReaderAdviceTonePrompt` の結果。無ければ足さない */
  tone?: string;
}

/** ボタンから送る本文 */
export function buildReaderAdvicePrompt(input: ReaderAdvicePromptInput): string {
  const L = READER_ADVICE_LIMITS;
  const blocks = [
    `次の材料を読み、この作品の読者の反応について、作者へ助言してください。

【作品】
${input.workTitle}`,
  ];
  if (input.tone) blocks.push(input.tone);
  blocks.push(READER_ADVICE_GUIDELINES);
  blocks.push(READER_ADVICE_EXAMPLES);
  blocks.push(
    "【材料】（拡張機能が、作者の取り込んだ数字から計算したものです）\n" +
      input.materials.map(formatReaderAdviceMaterial).join("\n\n")
  );
  blocks.push(`【答え方】
- summary には、全体の見立てを2文以内で書いてください（${L.summary}字以内）。
- strengths には、数字から読み取れるこの作品の良いところを、見つかったぶんだけ入れてください。数を絞る必要はありません。1つごとに title（${L.title}字以内）と body（${L.body}字以内）を書き、body には材料のどの話・どの数字からそう言えるのかを添えてください。
- points には、作者に確かめてほしい所を${L.points}つまで入れてください。1つごとに title（${L.title}字以内）と body（${L.body}字以内）を書きます。確かめてほしい所が見当たらなければ、points は空の配列にしてください。無理に探して作らないでください。
- 話に触れるときは「第◯話」と書き、材料にある話だけを挙げてください。
- 数字は、材料にあるものをそのまま使ってください。
- 「なし」「特になし」とだけ書いた項目を入れないでください。`);
  return blocks.join("\n\n");
}

/**
 * 構造化出力のスキーマ。**すべて required にする**（任意にすると、地力の
 * 足りないモデルは埋めずに落とす）。
 */
export const READER_ADVICE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    // 良いところ（1.9）。**required に入れる**——任意にすると、小さいモデルは
    // 確かめどころだけ書いて落とす（ほめる欄が後回しになる形そのもの）
    strengths: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["title", "body"],
        additionalProperties: false,
      },
    },
    points: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["title", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "strengths", "points"],
  additionalProperties: false,
} as const;

/**
 * 作者の質問が、読者の反応（PV・離脱・ブクマ・評価 など）の話かどうか。
 *
 * **字面を見るだけ**（相談の `procedureKeyFor`・`featureGuideFor` と同じ
 * 当たりの付け方。AIは呼ばない）。
 *
 * **「読者」だけでは当てない。** 「読者型はわかりませんか？」は読者の
 * 区分の話で（`questionMentionsReader` がそちらを受け持つ）、そのたびに
 * 数百〜数千字の数字が乗ると、答えが数字へ引っ張られる。「読者の反応」
 * 「読者が減る」のように、反応を指す言い方だけを拾う。同じ理由で
 * 「評価」も単独では当てない（「この場面の評価は？」は本文の話）。
 */
const READER_REACTION_WORDS = [
  "PV",
  "ＰＶ",
  "pv",
  "ページビュー",
  "閲覧数",
  "アクセス数",
  "離脱",
  "読了率",
  "読破率",
  "ブクマ",
  "ブックマーク",
  "フォロワー",
  "評価率",
  "評価数",
  "評価者",
  "評価ポイント",
  "星の数",
  "★の数",
  "読者の反応",
  "読者数",
  "読者が減",
  "読者が離れ",
  "読者離れ",
  "読まれていない",
  "読まれない",
  "伸びない",
  "伸び悩",
  "休載",
];

export function questionMentionsReaderReaction(question: string): boolean {
  return READER_REACTION_WORDS.some((word) => question.includes(word));
}

/**
 * 相談のシステムプロンプトへ足す一段（設計書6.79.7.3）。
 *
 * **材料も約束も、ボタンと同じものを使う。** 違うのは、答えの形（相談は
 * 相談の欄で返す）と、言い方の指針（相談はもう `buildAdvicePolicyPrompt` を
 * 持っている）だけ。
 *
 * 記録が1件も無い作品でも、**無いことだけは渡す**——渡さないと、AIは
 * 一般論の数字（「平均的な離脱率は…」）で答えを埋めにいく。
 */
export function buildReaderReactionChatBlock(
  materials: readonly ReaderAdviceMaterial[]
): string {
  const head =
    "【読者の反応の材料】作者の質問が読者の反応の話なので添えています。" +
    "作者が投稿サイトから取り込んだ数字を、拡張機能が計算したものです。";
  if (materials.length === 0) {
    return `${head}
この作品には、話ごとの読者の反応の記録がまだありません。PVや離脱率の数字を推測で作らないでください。
取り込むには、作品のメニューの「読者反応自動取込」を使います、と案内して構いません。

${READER_ADVICE_GUIDELINES}`;
  }
  return `${head}

${READER_ADVICE_GUIDELINES}

${READER_ADVICE_EXAMPLES}

${materials.map(formatReaderAdviceMaterial).join("\n\n")}`;
}
