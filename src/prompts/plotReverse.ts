/**
 * P-02 プロット逆算生成（既存作から）
 *
 * **プロンプト設計書のMap-Reduceのうち、Map段階は行わない。**
 * P-02のMapは「チャンクごとに出来事・人物・場所を取り出す」ものだが、
 * それは各話あらすじ（P-07）と設定資料の抽出（P-04a）で既に済んでいる。
 * もう一度本文全体をAIに読ませると、同じ material を作るために
 * 料金と時間を二重に払うことになる。世界観抽出（P-03）を独立の呼び出しに
 * せずP-04aへ相乗りさせたのと同じ判断である。
 *
 * したがってこのプロンプトはReduce段階だけを担う。**AIの呼び出しは1回**。
 *
 * プロンプトを変更したら version を上げること。
 */
export const PLOT_REVERSE_VERSION = "1.0";

export const PLOT_REVERSE_SYSTEM_PROMPT = `あなたは小説の構成を読み解く編集者です。
既に書かれた作品から、その作品のプロットを再構成します。

【絶対に守る原則】
1. 本文・あらすじから読み取れないものを、推測で埋めないこと。
   読み取れない項目は null または空配列にすること。
2. とくにテーマとモチーフは、作者の意図を勝手に断定しないこと。
3. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。`;

export interface PlotReverseInput {
  workTitle: string;
  /** 各話あらすじ。話数順 */
  chapterSynopses: string[];
  /** 冒頭の本文。人称や語り口を読み取るために渡す */
  openingExcerpt: string;
  /** 抽出済みの主要人物名 */
  characterNames: string[];
  /** 抽出済みの世界観の見出し */
  worldItems: string[];
  /** 抽出済みの場所名 */
  locationNames: string[];
}

export function buildPlotReversePrompt(input: PlotReverseInput): string {
  const section = (label: string, body: string): string =>
    body.trim() ? `【${label}】\n${body.trim()}\n` : "";

  return `既に書かれた小説から、作品全体のプロットを再構成してください。

【作品タイトル】
${input.workTitle}

${section("各話あらすじ（話数順）", input.chapterSynopses.join("\n"))}
${section("冒頭の本文（人称・語り口を読み取るため）", input.openingExcerpt)}
${section("登場人物", input.characterNames.join("、"))}
${section("世界観として抽出済みの事項", input.worldItems.join("、"))}
${section("場所", input.locationNames.join("、"))}
【出力する項目】
- logline: 作品全体を一文で表す（80字以内）
- theme: この作品が問いかけている主題（100字以内）
- motif: 繰り返し現れる象徴・題材（配列、最大5件、各20字以内）
- worldview: 世界の成り立ち・法則（200字以内）
- setting: 主な舞台（100字以内）
- narrativePerson: 語りの人称（「一人称」「三人称一元」「三人称多元」のいずれか。
  一人称なら主人公の自称も添える。読み取れなければ null）
- protagonistMotive: 主人公の行動原理（100字以内）
- outline: あらすじの箇条書き（配列、各60字以内、最大20件、時系列順）
- mainCharacters: 主要人物（配列、最大10件。name と summary。summaryは60字以内）
- notes: テーマやモチーフに複数の解釈がある場合、選ばなかった可能性（120字以内。無ければ null）

【注意】
- あらすじが少ない作品では、無理に20件へ増やさないこと。
- 主要人物は、筋を追うのに要る人物だけにすること。一度だけ出た人物は入れない。

【出力形式】JSONのみ
{
  "logline": "...",
  "theme": "...",
  "motif": ["..."],
  "worldview": "...",
  "setting": "...",
  "narrativePerson": "...",
  "protagonistMotive": "...",
  "outline": ["..."],
  "mainCharacters": [{"name": "...", "summary": "..."}],
  "notes": null
}`;
}

/** 構造化出力に渡すJSONスキーマ */
export const PLOT_REVERSE_SCHEMA = {
  type: "object",
  properties: {
    logline: { type: "string" },
    theme: { type: "string" },
    motif: { type: "array", items: { type: "string" } },
    worldview: { type: "string" },
    setting: { type: "string" },
    narrativePerson: { type: "string" },
    protagonistMotive: { type: "string" },
    outline: { type: "array", items: { type: "string" } },
    mainCharacters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          summary: { type: "string" },
        },
        required: ["name", "summary"],
      },
    },
    notes: { type: "string" },
  },
  required: ["logline", "outline"],
} as const;

export interface ExtractedPlot {
  logline?: unknown;
  theme?: unknown;
  motif?: unknown;
  worldview?: unknown;
  setting?: unknown;
  narrativePerson?: unknown;
  protagonistMotive?: unknown;
  outline?: unknown;
  mainCharacters?: unknown;
  notes?: unknown;
}
