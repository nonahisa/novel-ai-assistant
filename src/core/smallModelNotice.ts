import { LARGE_MODEL_MIN_BILLIONS, parameterSizeInBillions } from "../ai/types";
import { SMALL_MODEL_PICK_NOTE } from "./requirements";

/**
 * 小さいモデルで検知の機能を動かす前に、1回だけ出す知らせの決まり
 * （作者の裁定 2026-10-10「モデルは多く出てくると思うので、4B以下にはまとめて
 * メッセージを出す等の工夫が必要」。設計書6.28.9）。
 *
 * 画面を出すのは `features/smallModelNotice.ts`。ここは「出すか」と「覚える鍵」だけを
 * 持つ（VS Code API に依存しない）。
 *
 * ## 大きさは API の申告で決める（モデル名で決め打ちしない）
 *
 * 新しいモデルは次々出るので、名前の表を持つと必ず古くなる（実装ルール6）。
 * 大きさは Ollama の `/api/show`（`details.parameter_size`）、LM Studio・さくらは
 * モデルIDから読んだ値（`ModelInfo.parameterSize`）だけを見る。
 *
 * **gemma の e4b のような「実効の大きさ」は取れない。** e4b を Ollama に問うと
 * `parameter_size` は "8.0B"、`general.parameter_count` は 7,518,069,290 で、
 * 実効の 4B を表す欄は無い（2026-10-10 に作者の機械で確かめた）。層ごとの埋め込みの
 * 欄から逆算する道はあるが、型ごとの作りに依った推測になるので採らない。
 * **全体の大きさで判定する。**
 *
 * ## 線は製品の「小さいモデル」の線と同じ（20B 未満）
 *
 * 作者の言葉は「4B以下」だが、上の理由で 4B の線では e4b（申告 8.0B）にも
 * 12b にも出ない。測定で見落としと誤検出が目立ったのは e4b と 12b の両方で、
 * 26b（申告 25.2B）は通った——製品が頼み方を小さいモデル向けに切り替える線
 * （`LARGE_MODEL_MIN_BILLIONS`）とちょうど同じ所に分かれ目がある。線を2つ持つと、
 * 同じモデルが「頼み方は小さいモデル向け、知らせは出さない」と食い違うので、
 * 同じ線を使う。
 *
 * **大きさが分からないモデルには出さない。** 大きさを答えないのはふつう
 * クラウドの大きいモデルで、そこへ「小さいため」と言うと嘘になる。
 */

/**
 * 知らせを出す機能（機能別AI割当のキー）と、その根拠の測定。
 *
 * **出来がモデルの大きさに強く左右されると測ったものだけ**を挙げる。生成（あらすじ・
 * 紹介文）と相談は入れない——相談は e4b のほうが作者に選ばれた回もあり
 * （会話の比べ 2026-10-05）、大きさで決まると言える測定が無い。
 */
export const SMALL_MODEL_NOTICE_FEATURES: Readonly<Record<string, string>> = {
  // 製品と同じ頼み方で e4b 3/17・2/12（2026-10-10）、12b 5/19（2026-09-26）
  typo: "誤字脱字",
  // 当て字の台で 12b 4/8・26b 6/8（2026-09-18・20）
  proofread: "推敲",
  // 仕込み4で e4b 0/4・12b 1/4 で罠にも掛かる、26b 4/4（2026-09-20）
  contradiction: "矛盾検知",
  // 事実の照合は矛盾検知の一部（場面の事実を抜き出す段）
  factExtract: "事実の照合",
  // e4b・12b は5回とも0件、26b は 3/3（2026-09-20）。単話プロットの判定も同じ割当
  deviation: "プロット逸脱",
  // 回収の確認で e4b 0/21、12b 5件、26b 12件（2026-09-26）
  foreshadow: "伏線",
  // 別名が qwen3:8b・12b で0件、26b で3件（2026-09-08）
  extract: "設定資料の抽出",
};

/** 申告の大きさから、知らせを出すほど小さいか。**分からなければ false** */
export function isSmallModelForNotice(
  parameterSize: string | null | undefined
): boolean {
  const billions = parameterSizeInBillions(parameterSize);
  if (billions === undefined) return false;
  return billions < LARGE_MODEL_MIN_BILLIONS;
}

/** この機能・この大きさで、知らせを出す対象か（覚えているかは見ない） */
export function needsSmallModelNotice(
  feature: string,
  parameterSize: string | null | undefined
): boolean {
  return (
    Object.prototype.hasOwnProperty.call(SMALL_MODEL_NOTICE_FEATURES, feature) &&
    isSmallModelForNotice(parameterSize)
  );
}

/**
 * 「今後出さない」を覚える鍵。**作品ごと・モデルごと**（機能ごとではない）。
 *
 * 機能ごとにすると、まとめ実行で誤字脱字・推敲・矛盾検知が続けて走ったとき
 * 同じ断りが3回出る——作者の言う「まとめて出す」にならない。
 *
 * 区切りは JSON の並びにする（区切り文字を自前で選ぶと、名前に同じ字が入ったとき
 * 鍵が衝突する。制御文字はソースに置かない決まりもある）。
 */
export function smallModelNoticeKey(
  workFolder: string,
  providerId: string,
  model: string
): string {
  return JSON.stringify([workFolder, providerId, model]);
}

/** 手元の保管庫（globalState）での置き場所。設定同期には乗せない */
export const SMALL_MODEL_NOTICE_STATE_KEY = "novelai.smallModelNotice.dismissed";

/** 保管庫から読んだ値を、鍵の並びとして読む（手で触られても落ちない） */
export function readDismissedKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

/**
 * 機能別AI割当のモデルを選ぶ画面で、行の説明（detail）を組む。
 *
 * **注意を先頭に置く。** 選ぶ画面は説明を1行しか出さず、長いと後ろが「…」で
 * 切れる（2026-10-09 の写真）。対応機能や測った速さより、こちらを先に読ませる。
 */
export function smallModelPickDetail(
  enabled: boolean,
  parameterSize: string | null | undefined,
  rest: string | undefined
): string | undefined {
  const note =
    enabled && isSmallModelForNotice(parameterSize) ? SMALL_MODEL_PICK_NOTE : undefined;
  const parts = [note, rest].filter((text): text is string => Boolean(text));
  return parts.length > 0 ? parts.join("　") : undefined;
}

/** 知らせの文。どのモデルの話かを頭に付ける */
export function describeSmallModelNotice(
  notice: string,
  model: string,
  parameterSize: string | null | undefined
): string {
  return parameterSize
    ? `${model}（${parameterSize}）：${notice}`
    : `${model}：${notice}`;
}
