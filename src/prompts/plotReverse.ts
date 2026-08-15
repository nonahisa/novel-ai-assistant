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
export const PLOT_REVERSE_VERSION = "3.0";

/**
 * **解釈を禁じない。** v1.0は「読み取れないものは推測で埋めるな」
 * 「テーマとモチーフを断定するな」と強く縛った結果、実機ではログラインと
 * あらすじ以外がすべて空になった（世界観が19件も抽出済みなのに空だった）。
 *
 * テーマ・モチーフ・行動原理は**そもそも解釈**であり、断定を禁じると
 * AIは出力自体をやめる。プロットは作者が直す前提の下書きなので、
 * 既存の「AIに相談する」（P-18）と同じ方針に揃えた——
 * **禁じるのではなく、推測だと分かる形で出させる。**
 */
export const PLOT_REVERSE_SYSTEM_PROMPT = `あなたは小説の構成を読み解く編集者です。
既に書かれた作品から、その作品のプロットを再構成します。

【この作業の位置づけ】
出力は完成品ではなく、作者が手を入れるための下書きです。
作者は各項目を読んで、直すか・捨てるかを自分で決めます。
ですから、確信が持てない項目も**空にせず、読み取れる範囲での解釈を書いてください。**

【書き方】
1. 本文・あらすじに書かれている事実（出来事、人物、舞台）は、事実として書くこと。
2. 本文から直接は書かれていないもの（テーマ、モチーフ、主人公の行動原理）は、
   **解釈として書いてよい。** ただし断定せず、「〜と読める」「〜が繰り返し描かれる」
   のように、読み取った結果だと分かる書き方にすること。
3. 手掛かりが本当に何も無い項目だけ、空にすること。
   「あらすじが1話ぶんしかない」のように材料が足りない場合が該当します。
4. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
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

/**
 * 構造化出力に渡すJSONスキーマ。
 *
 * **全項目を必須にし、nullを許す。** 省略可能にすると、小さいモデルは
 * 面倒な項目を黙って落とす。これはP-20（設定項目の充実）で既に分かって
 * いたことだが、v1.0・v2.0では `logline` と `outline` だけを必須に
 * していたため、**実機ではまさにその2つ以外がすべて空になった**
 * （2026-08-15）。プロンプトの書き方の問題だと考えて文面を直したが
 * （v2.0）変わらず、原因はスキーマの側だった。
 *
 * nullを返させれば「読み取れなかった」と明示させられる。黙って落とされると、
 * 読み取れなかったのか手を抜かれたのかが区別できない。
 */
export const PLOT_REVERSE_SCHEMA = {
  type: "object",
  properties: {
    logline: { type: ["string", "null"] },
    theme: { type: ["string", "null"] },
    motif: { type: ["array", "null"], items: { type: "string" } },
    worldview: { type: ["string", "null"] },
    setting: { type: ["string", "null"] },
    narrativePerson: { type: ["string", "null"] },
    protagonistMotive: { type: ["string", "null"] },
    outline: { type: ["array", "null"], items: { type: "string" } },
    mainCharacters: {
      type: ["array", "null"],
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          summary: { type: "string" },
        },
        required: ["name", "summary"],
      },
    },
    notes: { type: ["string", "null"] },
  },
  required: [
    "logline",
    "theme",
    "motif",
    "worldview",
    "setting",
    "narrativePerson",
    "protagonistMotive",
    "outline",
    "mainCharacters",
    "notes",
  ],
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
