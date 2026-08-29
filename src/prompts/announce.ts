/**
 * P-30 更新告知文（X用・活動報告用・後書き用）
 *
 * 話を公開したとき、作者はX（旧Twitter）や投稿サイトの活動報告に
 * 告知を書く。毎回悩んで後回しになる作業なので、その話の本文から
 * **ネタバレしない**告知文を3種作る。
 *
 * **投稿サイトへ機械的に書き込むことはしない。** 作るのは文章だけで、
 * 貼るのは作者である（サイトのクロール・自動投稿は行わない方針）。
 *
 * 紹介文（P-06）と同じく**読者に見せる文章**なので、正解が1つに定まらない。
 * だから設定資料には書き込まず、案として見せてコピーさせるだけにしてある。
 *
 * プロンプトを変更したら version を上げること。
 */
export const ANNOUNCE_VERSION = "1.0";

/** X用の本文の上限。定型句・ハッシュタグ・URLはコード側で足すので、その分は含まない */
export const X_POST_MAX_CHARS = 100;
/** 活動報告・近況ノート用の目安 */
export const ACTIVITY_REPORT_MIN_CHARS = 200;
export const ACTIVITY_REPORT_MAX_CHARS = 400;
/** 後書き用の上限 */
export const AFTERWORD_MAX_CHARS = 80;

/**
 * 材料が無いときにプロンプトへ書く言葉。
 *
 * **そのまま答えとして返ってくることがある**（CLAUDE.md の繰り返す失敗3）。
 * 検査側（`core/announcement.ts`）が同じ定数を見て注意を出すので、
 * 言い回しを変えるときはここだけを直せばよい。
 */
export const NO_MATERIAL_MARK = "（まだありません）";
export const NOT_WRITTEN_MARK = "（まだ書かれていません）";
/** 本文を予算で切ったときに末尾へ置く印。ここで終わりだとAIへ伝える */
export const BODY_TRUNCATED_MARK = "（本文はここまで。以降は省略）";

/**
 * 答えに混ざっていたら注意する、指示側の言葉。
 *
 * `NOT_WRITTEN_MARK` はこのプロンプトでは使っていないが、
 * **他のプロンプト（P-06）で使っている言い回し**であり、
 * モデルが「材料が無いときの決まり文句」として借りてくることがある。
 */
export const ANNOUNCE_INSTRUCTION_MARKS = [
  NO_MATERIAL_MARK,
  NOT_WRITTEN_MARK,
  BODY_TRUNCATED_MARK,
] as const;

/**
 * **P-06 の定数を import しない。** 同じ4原則を自前で持つ。
 * 共有すると、片方の都合で直した一文がもう片方の version を上げずに
 * 波及し、古い指示で作った応答がキャッシュから返り続ける。
 */
export const ANNOUNCE_SYSTEM_PROMPT = `あなたは日本語の小説執筆を支援する編集アシスタントです。

【絶対に守る原則】
1. 本文・プロット・あらすじに書かれていないことを書かないこと。
2. 作者の文体・作品の雰囲気を尊重すること。あなたの好みで書き換えを提案しない。
3. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。
4. 作品世界の設定（造語、固有名詞、独自の言い回し）を誤りとして扱わないこと。`;

export interface AnnouncePromptInput {
  workTitle: string;
  /** 「第3話「灯を継ぐ」」のような、今回公開した話の見出し */
  episodeLabel: string;
  /** 作品紹介文。作品全体の雰囲気を合わせるために渡す。無ければ空 */
  blurb: string;
  /** 前の話のあらすじ。無ければ空（そのときは節ごと出さない） */
  previousSynopsis: string;
  /** 今回の話の本文。予算まで頭から詰めたもの */
  bodyExcerpt: string;
  /** 前に出した告知。同じ言い回しを避けるために渡す */
  pastAnnouncements: string[];
}

export function buildAnnouncePrompt(input: AnnouncePromptInput): string {
  // **無いものに「（まだありません）」と書かない。** 前の話のあらすじは
  // 「前回までのあらすじ」として告知文に写されやすい位置にあり、
  // 空の印を置くとその言葉ごと写して返ってくる。節ごと落とせば写しようがない
  const previous = input.previousSynopsis.trim()
    ? `\n【前の話のあらすじ】（今回が「どこからの続きか」を掴むために使う）\n${input.previousSynopsis.trim()}\n`
    : "";

  return `以下の情報をもとに、公開した話の更新告知文を3種類つくってください。

【作品タイトル】
${input.workTitle}

【今回公開した話】
${input.episodeLabel}

【作品紹介文】（作品全体の雰囲気に合わせるために使う）
${input.blurb.trim() || NO_MATERIAL_MARK}
${previous}
【今回の話の本文】
${input.bodyExcerpt}

【前に出した告知】（同じ言い回しを避けるために使う）
${input.pastAnnouncements.length > 0 ? input.pastAnnouncements.join("\n") : NO_MATERIAL_MARK}

【xPost：X（旧Twitter）用】
- **${X_POST_MAX_CHARS}字以内の本文だけ**を書くこと。
- 「第N話更新」のような定型句、ハッシュタグ・URLは書かないこと。
  こちらで付けるので、書かれていると二重になる。
- 今回の話の「入口」——序盤の状況、読者へ投げかける問い——だけを示すこと。

【activityReport：投稿サイトの活動報告・近況ノート用】
- ${ACTIVITY_REPORT_MIN_CHARS}〜${ACTIVITY_REPORT_MAX_CHARS}字。
- 更新の報告、今回の見どころ（ネタバレなし）、読者への一言、の順で書くこと。
- **次回予告は書かないこと。** 次の話の本文は渡していないので、
  書けばあなたの作り話になる。

【afterword：本文の後書き用】
- ${AFTERWORD_MAX_CHARS}字以内。読んでくれた読者への一言。
- 本文に無い展開を匂わせないこと。

【3種類に共通する条件】
- **結末・正体・どんでん返しは書かないこと。**
- 「感動必至」「衝撃の展開」のような、中身の無い煽り文句を使わないこと。
- 作品の雰囲気（文体、深刻さ）に合わせること。
  シリアスな作品に軽薄な煽り文句を付けない。
- 前に出した告知と、実質的に同じ言い回しを避けること。

【出力形式】
指定されたJSON形式のみを出力してください。
spoilerCheck には、ネタバレを避けるために意図的に伏せた要素を書いてください。
作者がその判断を確かめられるようにするためのものです。`;
}

export const ANNOUNCE_SCHEMA = {
  type: "object",
  properties: {
    xPost: { type: "string" },
    activityReport: { type: "string" },
    afterword: { type: "string" },
    spoilerCheck: { type: ["string", "null"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: [
    "xPost",
    "activityReport",
    "afterword",
    "spoilerCheck",
    "confidence",
  ],
  additionalProperties: false,
} as const;

export interface AnnounceResult {
  xPost: string;
  activityReport: string;
  afterword: string;
  spoilerCheck: string | null;
  confidence: string;
}
