import { PLOT_SECTIONS, isBlankPlotSection, type PlotSectionKey, type PlotSections } from "./plotDoc";
import {
  PLOT_DIALOGUE_SECTIONS,
  PLOT_END_OPTION,
  PLOT_IDEA_TOPIC,
  PLOT_START_FROM_PLOT_OPTION,
  PLOT_WRITE_OPTION,
  type PlotAskedPoint,
  type PlotDialogueSection,
} from "./plotInterview";

/**
 * 対話式プロット作成の「型」（設計書6.4.7「問答は『型の一つ』」）。
 *
 * 0.86.2 の問答（着想から掘る）を作者は最後まで回して気に入ったうえで、
 * **「これはプロット作成のパターンの一つ。これだけに固定しないで」**と言い、
 * 次の4つを足すと選んだ（2026-09-25）。入り方は作品と作者の状態で違う。
 *
 * - 場面から広げる：書きたい場面が1つだけあるとき
 * - 結末から逆算する：終わり方だけ決まっているとき
 * - 型に当てはめる：三幕・起承転結などの枠を順に埋める
 * - 項目を順に埋める：以前（0.86.1 まで）の決まった順。**ただし候補は着想から出す**
 *
 * ## 2つの系統
 *
 * - **AIが次の1点を選ぶ型**（着想・場面・結末）：向き（どこから広げるか）だけを
 *   プロンプトで変える
 * - **コードが次の1点を決める型**（型に当てはめる・項目を順に埋める）：
 *   何を尋ねるかはコードが持ち（`nextFixedPoint`）、AIには問いの言い回しと
 *   候補だけを出させる。**順を AI に任せると、飛ばしたり戻ったりする**
 *
 * どの型でも「候補を出すのはAI、決めるのは作者」「書くのは押したときだけ」
 * 「書かなくても次へ進む」「同じ問いを繰り返さない」は変わらない（検算は
 * 全型で `validatePlotDialogueAnswer` を通す）。
 *
 * VS Code API に依存しない。
 */

export type PlotDialogueStyle = "idea" | "scene" | "ending" | "structure" | "fields";

export interface PlotDialogueStyleDef {
  key: PlotDialogueStyle;
  /** 札の文言。押すとこの文がそのまま届く */
  label: string;
  /** 1行の説明。**くどくしない**（作者の指示） */
  summary: string;
  /** 最初の返事を「決まったこと」に載せるときの名前 */
  seedTopic: string;
  /** AIへ渡すときの、最初の返事の見出し */
  seedHeading: string;
  /** 最初の返事を頼む一言 */
  seedAsk: string;
  /**
   * 「プロットに書いてあることから始める」を出すか。
   * 場面・結末は、その場面・結末が無いと始まらないので出さない
   */
  fromPlot: boolean;
  /** 次の1点をコードが決める型か */
  fixed: boolean;
}

export const PLOT_DIALOGUE_STYLES: readonly PlotDialogueStyleDef[] = [
  {
    key: "idea",
    label: "着想から掘る",
    summary: "思いついていることから、話が一番広がる点を1つずつ尋ねます",
    seedTopic: PLOT_IDEA_TOPIC,
    seedHeading: "作者の着想",
    seedAsk:
      "思いついていることを自由に書いてください（着想・人物・設定など。断片でかまいません）。\n" +
      "AIが、いま決めると話が一番広がる1点を選んで、候補を添えて1つずつ尋ねます。",
    fromPlot: true,
    fixed: false,
  },
  {
    key: "scene",
    label: "場面から広げる",
    summary: "書きたい場面が1つあるとき。その前後と、そこに至る理由を尋ねます",
    seedTopic: "書きたい場面",
    seedHeading: "作者が書きたい場面",
    seedAsk:
      "書きたい場面を書いてください（誰が・どこで・何が起きるか。断片でかまいません）。\n" +
      "その場面の直前・そこに至る理由・その後、と外へ広げて1つずつ尋ねます。",
    fromPlot: false,
    fixed: false,
  },
  {
    key: "ending",
    label: "結末から逆算する",
    summary: "終わり方だけ決まっているとき。そこへ至る出来事をさかのぼって尋ねます",
    seedTopic: "結末",
    seedHeading: "作者が決めている結末",
    seedAsk:
      "決まっている終わり方を書いてください。\n" +
      "その結末に至るのに要る出来事を、結末の直前からさかのぼって1つずつ尋ねます。結末は変えません。",
    fromPlot: false,
    fixed: false,
  },
  {
    key: "structure",
    label: "型に当てはめる",
    summary: "三幕構成・起承転結などの枠を選び、順に埋めます",
    seedTopic: PLOT_IDEA_TOPIC,
    seedHeading: "作者の着想",
    seedAsk:
      "着想を書いてください（断片でかまいません）。\n" +
      "枠を前から順に、着想から出した候補を添えて1つずつ尋ねます。",
    fromPlot: true,
    fixed: true,
  },
  {
    key: "fields",
    label: "項目を順に埋める",
    summary: "ログライン・テーマ・世界観…と決まった順に尋ねます",
    seedTopic: PLOT_IDEA_TOPIC,
    seedHeading: "作者の着想",
    seedAsk:
      "着想を書いてください（断片でかまいません）。\n" +
      "ログライン → テーマ → 世界観 …の順に、着想から出した候補を添えて1つずつ尋ねます。",
    fromPlot: true,
    fixed: true,
  },
];

export function plotStyleDef(style: PlotDialogueStyle): PlotDialogueStyleDef {
  return PLOT_DIALOGUE_STYLES.find((item) => item.key === style) ?? PLOT_DIALOGUE_STYLES[0];
}

/** 枠の1つ。`name` は決まったことの名前にも使う（`composeSectionContents` の「名前：答え」） */
export interface PlotFrameBeat {
  name: string;
  /** その枠に何が入るか。AIへ渡す。**答えとして返ってきたら中身が無い**（検算で落とす） */
  note: string;
}

export type PlotFrameKey = "threeAct" | "kishotenketsu" | "herosJourney" | "johakyu";

export interface PlotFrame {
  key: PlotFrameKey;
  label: string;
  /** 選ぶ画面の1行。枠の並びを見せる */
  summary: string;
  beats: readonly PlotFrameBeat[];
}

/**
 * 当てはめる型。**名前に「：」を使わない**——書くときに「名前：答え」で並べるので、
 * 名前に「：」があると読み返したときに区切りが分からない。
 */
export const PLOT_FRAMES: readonly PlotFrame[] = [
  {
    key: "threeAct",
    label: "三幕構成",
    summary: "発端 → 転換点 → 葛藤 → 中間点 → 最大の危機 → クライマックス → 結末",
    beats: [
      { name: "第一幕・発端", note: "主人公の日常と、話が動き出すきっかけ" },
      { name: "第一幕・転換点", note: "主人公が後戻りできない形で話に踏み込む出来事" },
      { name: "第二幕・葛藤", note: "目的へ向かう主人公に、試練と対立が積み重なる" },
      { name: "第二幕・中間点", note: "状況や見え方がひっくり返る出来事" },
      { name: "第二幕・最大の危機", note: "主人公がすべてを失いかける" },
      { name: "第三幕・クライマックス", note: "最後の対決・いちばんの山場" },
      { name: "第三幕・結末", note: "決着と、そのあと主人公と世界がどうなったか" },
    ],
  },
  {
    key: "kishotenketsu",
    label: "起承転結",
    summary: "起 → 承 → 転 → 結",
    beats: [
      { name: "起", note: "登場人物と状況の紹介、話の始まり" },
      { name: "承", note: "始まった出来事が展開し、深まる" },
      { name: "転", note: "大きな転換・意外な展開" },
      { name: "結", note: "決着と、そのあと" },
    ],
  },
  {
    key: "herosJourney",
    label: "ヒーローズジャーニー",
    summary: "日常の世界から、宝を持っての帰還までの12段",
    beats: [
      { name: "日常の世界", note: "旅に出る前の主人公と、その暮らし" },
      { name: "冒険への誘い", note: "日常を破る出来事や知らせ" },
      { name: "冒険の拒否", note: "主人公がためらう理由" },
      { name: "賢者との出会い", note: "主人公を導く人や物" },
      { name: "戸口の通過", note: "主人公が日常を出て、未知の世界へ踏み込む" },
      { name: "試練・仲間・敵", note: "未知の世界で出会う試練と、仲間と敵" },
      { name: "最も危険な場所への接近", note: "最大の試練が待つところへ近づく" },
      { name: "最大の試練", note: "死や敗北に直面する、いちばん苦しい局面" },
      { name: "報酬", note: "試練を越えて手に入れたもの" },
      { name: "帰路", note: "日常へ戻る道と、そこでの追っ手や代償" },
      { name: "復活", note: "最後の試練を越えて、主人公が生まれ変わる" },
      { name: "宝を持っての帰還", note: "得たものを持って日常へ戻り、何が変わったか" },
    ],
  },
  {
    key: "johakyu",
    label: "序破急",
    summary: "序 → 破 → 急",
    beats: [
      { name: "序", note: "ゆっくりした導入と、状況の提示" },
      { name: "破", note: "展開と揺さぶり。話が大きく動く" },
      { name: "急", note: "一気に決着へ向かう" },
    ],
  },
];

/** 選んだ型を「決まったこと」に載せるときの名前 */
export const PLOT_FRAME_TOPIC = "型";

/**
 * 「項目を順に埋める」の順。**0.86.1 までの `PLOT_QUESTIONS` と同じ順**
 * （ログラインを先に置く。話を一言で言えると、テーマも世界観もそこから決まる）。
 * タイトル・形式・ジャンルは尋ねない（`PlotDialogueSection` に無い）。
 */
export const PLOT_FIELD_ORDER: readonly PlotDialogueSection[] = [
  "logline",
  "theme",
  "worldview",
  "setting",
  "narrativePerson",
  "protagonistMotive",
  "outline",
  "mainCharacters",
  "motif",
];

/** コードが決めた「次に尋ねる1点」 */
export interface PlotFixedPoint {
  topic: string;
  note: string;
  section: PlotDialogueSection;
  /** 何番目か（1から） */
  index: number;
  total: number;
}

function unquote(text: string): string {
  return text.trim().replace(/^[「『]|[」』]$/gu, "").trim();
}

/** 返事が型の札か。**ゆるく当てない**（「場面から広げる話です」を型の選択にしない） */
export function styleOfReply(text: string): PlotDialogueStyleDef | undefined {
  const body = unquote(text);
  return PLOT_DIALOGUE_STYLES.find((item) => item.label === body);
}

export function frameOfReply(text: string): PlotFrame | undefined {
  const body = unquote(text);
  return PLOT_FRAMES.find((item) => item.label === body);
}

export function plotFrame(key: PlotFrameKey | undefined): PlotFrame | undefined {
  return PLOT_FRAMES.find((item) => item.key === key);
}

/**
 * コードが決める型の、次に尋ねる1点。尋ね終えたら undefined。
 *
 * - 型に当てはめる：枠を前から順に。**尋ねた（飛ばした）枠は除く**
 * - 項目を順に埋める：`PLOT_FIELD_ORDER` の順に。**作者がもう書いている項目は
 *   尋ねない**（0.86.1 までと同じ）。ただし**この問答が書いた項目は作者の記述に
 *   数えない**——着想を「あらすじ」の頭へ書いたあと、「あらすじ」を尋ねなくなる
 *
 * @param written この問答が `plot.md` に書いた中身（項目 → 書いた文）
 */
export function nextFixedPoint(
  style: PlotDialogueStyle,
  frame: PlotFrame | undefined,
  asked: readonly PlotAskedPoint[],
  sections: PlotSections,
  written: ReadonlyMap<PlotSectionKey, string>
): PlotFixedPoint | undefined {
  const askedTopics = new Set(asked.map((point) => point.topic));
  if (style === "structure") {
    if (!frame) return undefined;
    const index = frame.beats.findIndex((beat) => !askedTopics.has(beat.name));
    if (index < 0) return undefined;
    const beat = frame.beats[index];
    return {
      topic: beat.name,
      note: beat.note,
      section: "outline",
      index: index + 1,
      total: frame.beats.length,
    };
  }
  if (style === "fields") {
    for (let i = 0; i < PLOT_FIELD_ORDER.length; i++) {
      const key = PLOT_FIELD_ORDER[i];
      const heading = PLOT_SECTIONS.find((item) => item.key === key)?.heading ?? key;
      if (askedTopics.has(heading)) continue;
      const now = sections[key] ?? "";
      const ours = written.get(key);
      const authorWrote =
        !isBlankPlotSection(now) && !(ours !== undefined && ours.trim() === now.trim());
      if (authorWrote) continue;
      return {
        topic: heading,
        note: PLOT_DIALOGUE_SECTIONS.find((item) => item.key === key)?.note ?? heading,
        section: key,
        index: i + 1,
        total: PLOT_FIELD_ORDER.length,
      };
    }
    return undefined;
  }
  return undefined;
}

/**
 * 始めたときに1回だけ言うこと。**型を選ぶ札を出す**（説明は1行ずつ）。
 * 書くのはいつかも、ここで1度だけ言う。
 */
export function describePlotStyleChoice(workTitle: string): string {
  return [
    `「${workTitle}」のプロットを、問答で一緒に考えます。始め方を選んでください。`,
    ...PLOT_DIALOGUE_STYLES.map((item) => `・${item.label}：${item.summary}`),
    `どの型でも、AIは候補を出すだけで、決めるのはあなたです。plot.md に書くのは「${PLOT_WRITE_OPTION}」を押したときだけです。`,
  ].join("\n");
}

/** 型を選ぶ札。型 → 終える */
export function plotStyleOptions(): string[] {
  return [...PLOT_DIALOGUE_STYLES.map((item) => item.label), PLOT_END_OPTION];
}

/** 「型に当てはめる」を選んだあとの、枠を選ぶ一言 */
export function describePlotFrameChoice(retry = false): string {
  return [
    retry ? "型を下の札から選んでください。" : "どの型に当てはめますか。",
    ...PLOT_FRAMES.map((item) => `・${item.label}：${item.summary}`),
  ].join("\n");
}

export function plotFrameOptions(): string[] {
  return [...PLOT_FRAMES.map((item) => item.label), PLOT_END_OPTION];
}

/**
 * 型を選んだあと、最初の返事（着想・場面・結末）を頼む一言。
 * 候補の扱いは最初の問いに添えるので、ここでは言わない（くどくしない）。
 */
export function describePlotSeedAsk(
  style: PlotDialogueStyle,
  hasPlot: boolean,
  frame?: PlotFrame
): string {
  const def = plotStyleDef(style);
  const lines = [
    ...(frame ? [`${frame.label}（${frame.summary}）で進めます。`] : []),
    def.seedAsk,
  ];
  if (hasPlot && def.fromPlot) {
    lines.push(
      `プロットにすでに書いてあることも読んでから尋ねます。そこから始めるなら「${PLOT_START_FROM_PLOT_OPTION}」を押してください。`
    );
  }
  return lines.join("\n");
}

/** 最初の返事を頼むときの札 */
export function plotSeedOptions(style: PlotDialogueStyle, hasPlot: boolean): string[] {
  return hasPlot && plotStyleDef(style).fromPlot
    ? [PLOT_START_FROM_PLOT_OPTION, PLOT_END_OPTION]
    : [PLOT_END_OPTION];
}

/** コードが決める型の、いまどこか（「起承転結 2/4」）。終わりが見えないと、どこで切り上げてよいか分からない */
export function describeFixedProgress(
  style: PlotDialogueStyle,
  frame: PlotFrame | undefined,
  point: PlotFixedPoint
): string {
  const name = style === "structure" ? (frame?.label ?? "型") : "項目";
  return `［${name} ${point.index}/${point.total}］`;
}

/** コードが決める型で、尋ねる枠・項目が尽きたときの一言（AIは呼ばない） */
export function describeFixedDone(style: PlotDialogueStyle, frame: PlotFrame | undefined): string {
  const what = style === "structure" ? `${frame?.label ?? "型"}の枠` : "プロットの項目";
  return [
    `${what}は、すべて尋ねました。`,
    `「${PLOT_WRITE_OPTION}」で書くか、「${PLOT_END_OPTION}」で終えてください。`,
  ].join("\n");
}
