/**
 * P-31 章立ての提案（設計書6.66.4）。
 *
 * **章分けと章名を1本のプロンプトで同時に出す。** 分け方だけ提案されても、
 * 名前が無いと作者は判断の材料が足りない（「第6話から新しい章」とだけ
 * 言われても、それが良い区切りかどうかは名前を見て初めて分かる）。
 *
 * **材料は話のサブタイトル一覧と各話あらすじだけ。** 本文は送らない——
 * 章分けは構成の判断であって、全文は要らない（入力も料金も膨れる）。
 *
 * **既にある章立ては「土台」として渡す。** 壊す提案ではなく直す提案を
 * させるためで、作者が付けた章名を、AIの思いつきで丸ごと置き換えさせない。
 *
 * ## 見本の値の選び方
 *
 * **指示の言葉は、そのまま答えとして返ってくる**（CLAUDE.md の
 * 「繰り返し起きた失敗3」。`"suggestion": "空文字"` が実データで返った）。
 * そこで、出力例に置く値は2つに分けてある。
 *
 *   - `startEpisode` の見本は **実在する最初の話数**。そのまま返ってきても
 *     「最初の話から章が始まる」という、ごく普通の提案にしかならない
 *     （固定値の `1` を書くと、第11話から始まる作品では実在しない話数の
 *     見本になり、返ってきた提案が全部捨てられる）
 *   - `name`・`reason` の見本は**項目の言い換え**。これが返ってきたら
 *     中身が無いので、検証側（`core/chapterProposalValidation.ts`）が
 *     `CHAPTER_PROPOSE_HINTS` と突き合わせて弾く
 *
 * プロンプトを変更したら version を上げること。
 */
export const CHAPTER_PROPOSE_VERSION = "1.0";

/**
 * 章の名前の長さ。**作品一覧の1行に出る見出し**なので、長いと折り返す。
 *
 * 検証側は、これを超えた名前を捨てずに切り詰める（名前が長いだけで
 * 落とすと、開始の話数と理由まで一緒に消える）。
 */
export const CHAPTER_NAME_MAX_CHARS = 20;

/**
 * 出力例に書く、項目の言い換え。
 *
 * **プロンプトの文言と検証の定数を別々に書かない。** 別々に書くと、
 * 例文を直したときに検査だけが古い言葉を見張り続ける
 * （P-25 と同じ作り）。
 */
const NAME_HINT = "章の名前";
const REASON_HINT = "ここで区切る理由";

export const CHAPTER_PROPOSE_HINTS: readonly string[] = [
  NAME_HINT,
  REASON_HINT,
];

/** 章が1つも無いときに書く言葉。**無いものを埋めさせない** */
export const NO_CHAPTERS_MARK = "（まだ章はありません）";

export const CHAPTER_PROPOSE_SYSTEM_PROMPT = `あなたは日本語の小説の構成を読む編集アシスタントです。

【絶対に守る原則】
1. 渡された一覧（話数・サブタイトル・あらすじ）に書かれていることだけを扱うこと。
   本文は渡していないので、書かれていない出来事を推測して書かないこと。
2. **話の順番を入れ替えないこと。** 提案するのは「どの話から章が始まるか」だけである。
3. 作者が既に付けている章の区切りと名前を尊重すること。
   直す必要のないものは、そのまま残すこと。
4. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。`;

export interface ChapterProposeEpisode {
  /**
   * 話数の番号。
   *
   * **番号の読めない話（日付で名付けたSNS記事など）は渡さない。**
   * 開始点として指せないので、渡すと存在しない番号を作られるだけである。
   */
  number: number;
  /** 見出し（「第3話」「投稿3」）。作品の形式で言い方が変わる */
  label: string;
  /** サブタイトル。無ければ空 */
  subtitle: string;
  /** その話のあらすじ。無ければ空（**節ごと落とす**） */
  synopsis: string;
}

export interface ChapterProposeInput {
  workTitle: string;
  /** 話の一覧。**話数の順に並べて渡す**（区切りの判断がこの並びに乗る） */
  episodes: readonly ChapterProposeEpisode[];
  /** いまの章立て。無ければ空 */
  current: ReadonlyArray<{ name: string; startEpisode: number | null }>;
  /**
   * 章名だけが欲しいとき（章ノードの右クリック、設計書6.66.4）。
   *
   * **範囲は `episodes` が表す。** 渡すのはその章に入る話だけで、
   * 区切りは動かさない。
   */
  nameOnly?: { maxSuggestions: number };
}

export function buildChapterProposePrompt(input: ChapterProposeInput): string {
  const episodes = input.episodes;
  // 見本の開始話数。**実在する最初の話**にする（上の「見本の値の選び方」）
  const sampleStart = episodes[0]?.number ?? 1;

  const list = episodes
    .map((episode) => {
      const head = [episode.label, episode.subtitle].filter(Boolean).join("　");
      // **あらすじが無い話に印を置かない。** 印を置くと、その言葉ごと
      // 写して返してくる（P-30で実際に起きた形）。節ごと落とせば写しようがない
      return episode.synopsis.trim()
        ? `${head}\n　あらすじ：${episode.synopsis.trim()}`
        : head;
    })
    .join("\n");

  const nameRules = [
    `- **${CHAPTER_NAME_MAX_CHARS}字以内。** 作品一覧の1行に出る見出しです。`,
    "- **一覧（サブタイトル・あらすじ）に出てくる言葉を使うこと。**" +
      "一覧に無い固有名詞を作らないこと。",
    "- 先頭に「第一章」のような番号を付け、続けて内容を表す言葉を書くこと" +
      "（番号は提案の順に振ること）。",
    "- **その章より後で起きることを書かないこと**（読者への予告にしない）。",
  ].join("\n");

  if (input.nameOnly) {
    const currentName = input.current[0]?.name;
    return `以下は小説「${input.workTitle}」の中の、ひとつながりの範囲です。
この範囲**全体**にふさわしい章の名前を、${input.nameOnly.maxSuggestions}案まで挙げてください。

【この章に入る話】
${list}
${
  currentName
    ? `\n【いまの名前】（別の言い方の案を出すこと）\n${currentName}\n`
    : ""
}
【名前の条件】
${nameRules}
- 同じ意味の名前を並べないこと。**違う切り口の案**を出すこと。

【出力形式】JSONのみ
{
  "chapters": [
    {
      "name": "${NAME_HINT}",
      "startEpisode": ${sampleStart},
      "reason": "${REASON_HINT}（この案が何を捉えているか、1文）"
    }
  ]
}
- **区切りは変えないこと。** startEpisode はすべて ${sampleStart} にしてください。
- 案は${input.nameOnly.maxSuggestions}件までです。`;
  }

  const current =
    input.current.length > 0
      ? input.current
          .map(
            (chapter) =>
              `- ${
                chapter.startEpisode === null
                  ? "（開始の話が分かりません）"
                  : `第${chapter.startEpisode}話から`
              }「${chapter.name}」`
          )
          .join("\n")
      : NO_CHAPTERS_MARK;

  return `以下は小説「${input.workTitle}」の話の一覧です。
**どこで章に区切るか**と、**その章の名前**を提案してください。

【話の一覧】
${list}

【いまの章立て】（これを土台にして、直すところだけ提案すること）
${current}

【区切り方】
- 場面・目的・舞台が大きく変わるところで区切ること。
- 1つの章は3話以上を目安にすること。**話ごとに章を作らないこと。**
- 章の数は作品の長さに見合わせること（全${episodes.length}話に対して、多くても${maxChapters(
    episodes.length
  )}章まで）。
- 最初の章が最初の話から始まらなくてもよい
  （導入をどの章にも入れない書き方を妨げないため）。
- **startEpisode は上の一覧にある話数の数字**です。一覧に無い数字を書かないこと。
- 章は**話数の小さい順**に並べること。同じ話から始まる章を2つ作らないこと。

【章の名前】
${nameRules}

【出力形式】JSONのみ
{
  "chapters": [
    {
      "name": "${NAME_HINT}",
      "startEpisode": ${sampleStart},
      "reason": "${REASON_HINT}（1文）"
    }
  ]
}`;
}

/**
 * 提案してよい章の数の上限。
 *
 * **話ごとに章を作らせない**ための目安である。3話で1章を下限としつつ、
 * 短い作品でも2章までは出せるようにする（19話なら6章）。
 * 検証側はこの数で捨てない——多すぎる提案は作者が選べばよく、
 * 数だけを理由に良い区切りまで落とすほうが害が大きい。
 */
function maxChapters(episodeCount: number): number {
  return Math.max(2, Math.floor(episodeCount / 3));
}

/**
 * 出力の形。
 *
 * **3つとも required にする。** 任意項目にすると、小さいモデルは
 * 埋めずに落とす（この作品で繰り返し起きた）。プロバイダごとの方言へは
 * `ai/jsonSchema.ts` が変換する。
 */
export const CHAPTER_PROPOSE_SCHEMA = {
  type: "object",
  properties: {
    chapters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          // **整数として渡す。** 文字列で返ると「第3話」のような形が
          // 混ざり、実在の話数かどうかを見る前に読み取れなくなる
          startEpisode: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["name", "startEpisode", "reason"],
      },
    },
  },
  required: ["chapters"],
} as const;
