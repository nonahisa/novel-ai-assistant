/**
 * 「大きいけれど速い型」——部品を分けて持ち、そのうち一部だけを使うモデル
 * （作者の指示、2026-09-19「見せてください」）。
 *
 * ## なぜ見せるか
 *
 * 作者の機械（RTX 4060 Ti・VRAM 8GB。実際に使えるのは6.3GB前後）で、同じ
 * 測定台を3回ずつ測った結果がこうだった。
 *
 * - `gemma4:26b`（17.3GB。VRAMに入らない）……165／168／181秒
 * - `gemma4:12b`（7.0GB）……347／349／390秒
 * - `qwen3:8b`（4.9GB）……411秒
 *
 * **17.3GB のモデルが、7.0GB のモデルより2倍速い。** 理由は `/api/show` の
 * `model_info` に出ていた——`gemma4:26b` だけが部品を128個持ち、そのうち
 * 8個だけを使う。全体がVRAMから溢れていても、**読むのはその一部**なので
 * 速い。部品を分けていないモデルは毎回ぜんぶを読むので、少し溢れただけで
 * 遅くなる。
 *
 * モデルを選ぶ画面はこれを見せていなかったので、作者は「大きい＝重い」と
 * 判断してしまい、**8GBのカードで25B級を実用速度で回せること**に気づけない。
 *
 * ## ここが持つもの
 *
 * **読み取りと文面の両方を、このファイル1つに置く**（`core/termColors.ts`
 * と同じ考え方）。読むのは `ai/ollamaProvider.ts`、出すのはモデルを選ぶ画面
 * （`ai/registry.ts`）と実測の一覧（`core/tuningStats.ts`）で、**写しを作ると
 * 片方だけ古くなる。**
 *
 * VS Code には触らない（`core` の純粋な部品）。
 */

/** 部品の内訳。**両方そろったときだけ作る**（片方では何も言えない） */
export interface ModelExperts {
  /** そのモデルが持っている部品の数 */
  readonly total: number;
  /** 一度に実際に使う部品の数 */
  readonly used: number;
}

/**
 * `/api/show` の `model_info` から部品の数を読む。分からなければ undefined。
 *
 * **アーキテクチャ名は固定しない**（CLAUDE.md 規則6）。項目名は
 * `gemma4.expert_count` / `qwen3.expert_count` のように前置きが変わるので、
 * `general.architecture` が名乗ったものを使う。名乗らない版のために末尾一致も
 * 見る（`showModel` がコンテキスト長を拾うときと同じ手）。
 *
 * **モデル名からは推測しない。** `26b` だから・`A3B` が付くから、で決めると、
 * 名前の付け方が変わった新しいモデルで必ず外れる。
 *
 * **迷ったら何も言わない。** 片方の数しか無い・数が揃わない（使う数が
 * 持っている数と同じ、など）ときは undefined を返す。ここで無理に答えると、
 * 画面に「大きいけれど速い型」という嘘が出る——**分からないのと、分かって
 * いて部品を分けていないのは違う。**
 */
export function readExpertCounts(
  modelInfo: Record<string, unknown> | undefined
): ModelExperts | undefined {
  if (!modelInfo) return undefined;

  const raw = modelInfo["general.architecture"];
  const architecture =
    typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;

  const total = readCount(modelInfo, architecture, "expert_count");
  const used = readCount(modelInfo, architecture, "expert_used_count");

  if (total === undefined || used === undefined) return undefined;
  /*
    **使う数が持っている数と同じなら、ふつうのモデルと変わらない。**
    部品を分けていても全部読むのなら「大きいけれど速い」にはならないので、
    札を出す理由が無い。0や1しか無いものも同じ（`positiveInteger` が弾く）。
  */
  if (used >= total) return undefined;
  return { total, used };
}

/**
 * 名乗ったアーキテクチャ名で引き、無ければ末尾一致で拾う。
 *
 * **名乗りを先に見るのは、別の前置きの項目を拾わないため**である。
 * 末尾一致は、名乗らない版・名乗りと項目の前置きが食い違う版のための逃げ道で、
 * そこまで外れるくらいなら「何も出さない」に倒れてよい。
 */
function readCount(
  modelInfo: Record<string, unknown>,
  architecture: string | undefined,
  name: string
): number | undefined {
  if (architecture !== undefined) {
    const declared = positiveInteger(modelInfo[`${architecture}.${name}`]);
    if (declared !== undefined) return declared;
  }
  return bySuffix(modelInfo, `.${name}`);
}

/** その項目が正の整数のときだけ返す。0・小数・文字列は読まずに捨てる */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** 末尾一致で拾う。**最初に見つかったものを使う**（1モデルに1つしか無い） */
function bySuffix(
  modelInfo: Record<string, unknown>,
  suffix: string
): number | undefined {
  for (const [key, value] of Object.entries(modelInfo)) {
    if (!key.endsWith(suffix)) continue;
    const parsed = positiveInteger(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * モデルを選ぶ画面の1行目に置く短い札（文脈長・有料かと並ぶ）。
 *
 * **仕組みの名前を出さない。** 作者はプログラマではないので、
 * 何が嬉しいのかがそのまま読める言葉にする。
 */
export const EXPERTS_BADGE = "大きいけれど速い型";

/**
 * モデルを選ぶ画面の説明行に置く一文（`core/tuningStats.ts` が組み立てる）。
 *
 * 札だけでは「なぜ速いのか」が分からないので、**数と、嬉しさの理由**を添える。
 */
export function expertsPickText(experts: ModelExperts): string {
  return (
    `${EXPERTS_BADGE}（部品${experts.total}個のうち、一度に使うのは` +
    `${experts.used}個だけ。メモリに全部載らなくても遅くなりにくい）`
  );
}

/**
 * 実測の一覧（表）の欄。**1つの欄で読み切れる長さにする。**
 *
 * 速さの列と並べて見るためにあるので、数だけでは足りない（128と8を見て
 * 意味が分かるのは、仕組みを知っている人だけである）。札を先に置く。
 */
export function expertsCellText(experts: ModelExperts): string {
  return `${EXPERTS_BADGE}（${experts.total}個中${experts.used}個ずつ）`;
}
