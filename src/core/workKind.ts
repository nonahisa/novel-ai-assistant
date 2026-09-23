import type { WorkKindKey } from "../models/types";
import type { PlotSectionKey } from "./plotDoc";
import type { WorkFormatKey } from "./workFormat";

/**
 * 作品の「種類」（設計書6.109）。
 *
 * **形式（`core/workFormat.ts`）とは別の軸である。** 形式は「どれだけの
 * 長さを、どう並べるか」（短編・長編・SNS記事・創作メモ集）、種類は
 * 「何を書くか」（小説・台本・漫画の原作・エッセイ・歌詞）。長編の台本も
 * 短編の台本もあり、SNSに並べるエッセイも短編集にまとめるエッセイもある。
 * 1つの軸に混ぜると、組み合わせの数だけ選択肢が要る。
 *
 * 種類で変わるのは、**雛形・数え方の目安・原稿エディタの組み方・出力の
 * 組み方**の4つだけ。AI機能の読み方は変えない（作者の裁定、2026-09-23）。
 *
 * **原稿は書き換えない。** 組み方は表示と出力の側だけで変える（規則1）。
 *
 * VS Code APIに依存しない。
 */

// 型の実体は `models/types.ts`（作品の設定 `WorkConfig` が持つため。
// `models` は `core` を引けない——`Eol` と同じ事情）
export type { WorkKindKey };

/** 種類が決まっていない作品の扱い。**これまでの振る舞いそのもの** */
export const DEFAULT_WORK_KIND: WorkKindKey = "novel";

/** プロットの書き出しに、種類のぶんだけ足す見出し（作者の文書なので案内つき） */
export interface KindPlotHeading {
  heading: string;
  hint: string;
}

export interface WorkKindDef {
  key: WorkKindKey;
  /** 選ぶ画面に出す名前 */
  label: string;
  /** 選ぶときの説明（1行） */
  description: string;
  /**
   * 新しい話を作るときの最初の中身。
   *
   * **小説は空のまま**（これまでの振る舞い）。白紙に何か書かれていると、
   * 作者はまずそれを消すところから始めることになる。ほかの種類は
   * **形そのものを知らせるほうが早い**ので、3〜5行の見本を置く。
   */
  episodeTemplate: string;
  /** プロットの書き出しに置く既存の見出し（`PLOT_SECTIONS` の鍵） */
  plotStarters: readonly PlotSectionKey[];
  /** プロットの書き出しに足す、種類ならではの見出し */
  plotExtras: readonly KindPlotHeading[];
  /**
   * 原稿エディタの既定の向き。**台本だけ縦書き**（設計書6.70 からの決まり）。
   * 開いている画面の向きが最優先なのは、これまでどおり。
   */
  vertical: boolean;
}

/*
  雛形の行。**見た目で区別の付かない字は符号で書く**（`core/scriptLines.ts` と
  同じ作法）。`　`（U+3000、全角空白）は目に見えず、`○`（U+25CB）と
  `〇`（U+3007）は画面では同じに見える。
*/
const IDEOGRAPHIC_SPACE = "　";

/**
 * 台本の雛形（設計書6.70 の形を引き継ぐ）。
 *
 * 柱は「○場所（時）」、ト書きは全角空白で字下げ、台詞は「役名「…」」。
 * 日本のシナリオで広く使われている書き方で、行の見分け方は
 * `core/scriptLines.ts` が持っている。
 */
const SCRIPT_TEMPLATE = [
  "○場所（時）",
  "",
  `${IDEOGRAPHIC_SPACE}ト書き`,
  "",
  "役名「台詞」",
  "",
].join("\n");

/**
 * 漫画の原作（ネーム前）の雛形。
 *
 * ページは行頭の `■`、コマは行頭の `□`。絵の説明は全角空白で字下げし、
 * 台詞は台本と同じ「人物名「…」」。**ルビ（`{漢字|かんじ}`・`｜漢字《かんじ》`）・
 * 傍点（`{{強調}}`・`《《強調》》`）・柱（`○`）のどれとも重ならない字**を選んだ
 * ——IMEで「しかく」と打てば出る。
 */
const MANGA_TEMPLATE = [
  "■1ページ",
  "□コマ1",
  `${IDEOGRAPHIC_SPACE}絵の説明`,
  "人物名「台詞」",
  "",
].join("\n");

/**
 * エッセイ・記事の雛形。**見出しの置き場だけ**を示す。
 *
 * 行頭の `■` を見出しにする（`.txt` でも使える。`.md` なら `#` の見出しも効く）。
 */
const ESSAY_TEMPLATE = ["■見出し", "", "本文", ""].join("\n");

/**
 * 歌詞・詩の雛形。**節の名前は 【】 で囲む。**
 *
 * 【】の行は本文ではなく節の札として組む（小さく・前を空ける）。
 * 行数・連数の目安では札を数えない。
 */
const LYRICS_TEMPLATE = [
  "【Aメロ】",
  "",
  "",
  "【サビ】",
  "",
].join("\n");

/** この順に選択肢へ出す。**先頭が既定（小説）** */
export const WORK_KINDS: readonly WorkKindDef[] = [
  {
    key: "novel",
    label: "小説",
    description: "これまでどおりの原稿。雛形も組み方も変えない",
    episodeTemplate: "",
    plotStarters: ["logline", "outline"],
    plotExtras: [],
    vertical: false,
  },
  {
    key: "script",
    label: "台本（脚本・シナリオ）",
    description:
      "柱・ト書き・台詞の形で書く。縦書きで開き、400字詰めの枚数と分数の目安が出る",
    episodeTemplate: SCRIPT_TEMPLATE,
    plotStarters: ["logline", "outline"],
    plotExtras: [
      {
        heading: "登場人物表",
        hint: "役名と年齢・立場を1行ずつ。台本の頭に付ける人物表になる",
      },
      {
        heading: "箱書き",
        hint: "シーンごとに「柱（場所・時）／何が起きるか」を1行ずつ",
      },
    ],
    vertical: true,
  },
  {
    key: "manga",
    label: "漫画の原作（ネーム前）",
    description:
      "ページ（■）とコマ（□）に分けて、絵の説明と台詞を書く。ページ数とコマ数が出る",
    episodeTemplate: MANGA_TEMPLATE,
    plotStarters: ["logline", "outline"],
    plotExtras: [
      {
        heading: "ページ配分",
        hint: "どの場面に何ページ使うか（例: 1〜4ページ 導入）",
      },
      {
        heading: "見せ場",
        hint: "大ゴマ・見開きにしたい場面",
      },
    ],
    vertical: false,
  },
  {
    key: "essay",
    label: "エッセイ・記事",
    description:
      "見出し（行頭の■）と本文で書く。読み終えるまでの時間の目安が出る",
    episodeTemplate: ESSAY_TEMPLATE,
    plotStarters: [],
    plotExtras: [
      { heading: "伝えたいこと", hint: "読み終えた人に残したい一言" },
      { heading: "読み手", hint: "誰に向けて書くか" },
      { heading: "構成", hint: "導入 / 本題 / 結び" },
    ],
    vertical: false,
  },
  {
    key: "lyrics",
    label: "歌詞・詩",
    description:
      "節の名前（【サビ】など）と行で書く。連の数と行の数が出る",
    episodeTemplate: LYRICS_TEMPLATE,
    plotStarters: ["theme", "motif"],
    plotExtras: [
      { heading: "語り手", hint: "誰が、誰に向けて歌う（語る）のか" },
      { heading: "構成", hint: "Aメロ / Bメロ / サビ、または連の並び" },
    ],
    vertical: false,
  },
];

export function workKindDef(key: WorkKindKey): WorkKindDef {
  const found = WORK_KINDS.find((kind) => kind.key === key);
  // 型で閉じているので来ないが、来たら小説として振る舞う（開けなくしない）
  return found ?? WORK_KINDS[0];
}

/** 作品の設定に書かれた値を読む。**知らない値は無かったことにする** */
export function parseWorkKind(raw: unknown): WorkKindKey | undefined {
  if (typeof raw !== "string") return undefined;
  return WORK_KINDS.find((kind) => kind.key === raw)?.key;
}

/**
 * 作品の種類を決める。
 *
 * 1. 作品の設定（`.aiwriter/config.json` の `kind`）に書かれていればそれ
 * 2. 無ければ、**形式が「脚本」の作品は台本**（0.30.7〜0.80 の作り方。
 *    種類の軸ができる前は、脚本を形式の1つとして持っていた）
 * 3. どちらも無ければ小説——**これまでの振る舞いそのもの**
 */
export function resolveWorkKind(
  configured: WorkKindKey | undefined,
  format: WorkFormatKey | undefined
): WorkKindKey {
  if (configured) return configured;
  if (format === "script") return "script";
  return DEFAULT_WORK_KIND;
}

/** 新しい話の最初の中身。種類が分からなければ空（これまでどおり） */
export function kindEpisodeTemplate(kind: WorkKindKey | undefined): string {
  return kind ? workKindDef(kind).episodeTemplate : "";
}
