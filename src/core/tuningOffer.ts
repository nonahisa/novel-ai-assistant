import { TUNING_STORE_FILE } from "./tuningStoreNames";

/**
 * AIチューニングの「設定に反映」を訊く知らせの文（実機確認リスト D-1、
 * 0.96.15）。
 *
 * **要点を先頭に置く。** 通知は先頭の数行しか見えない。以前は測った経過が
 * 先に並び、どのモデルへ何を反映するのかが10行目あたりにあったので、
 * 作者は通知センターを開かないと「押すと何が変わるのか」を読めなかった。
 *
 * 経過（`summary`）と断り書き（`notes`）は削らずに後ろへ回す。どれも
 * 作者の報告で足した文である。書き先が VS Code の設定ではなく保管庫だと
 * 言うのも残す——作者が settings.json を見に行き「何も起きていない」と
 * 受け取ったため（2026-09-19）。
 *
 * VS Code API には依存しない（`measureContext.ts`・`tuningStageRunners.ts`
 * の2か所から呼ぶ）。
 */
export function tuningOfferMessage(input: {
  /** 途中で中止した測定か */
  cancelled: boolean;
  /** 台帳の鍵（`プロバイダ/モデル`） */
  modelKey: string;
  /** 押すと台帳へ入る値（「待ち時間 300秒」の形） */
  apply: readonly string[];
  /**
   * 押さなくても既に記録した値（「書ける量 約N トークン（記録済み）」の形。
   * 作者の裁定、2026-10-03）。**1文目に並べる**——書ける量は数値として
   * 先頭に要るが、押すと入る値ではないので、項目の中で記録済みと断る。
   * 省略または空なら出さない
   */
  recorded?: readonly string[];
  /** 測った経過 */
  summary: string;
  /** 反映の仕方についての断り書き（プロバイダごとの違いなど） */
  notes: readonly string[];
}): string {
  const prefix = input.cancelled ? "（途中で中止しました）" : "";
  const items = [...input.apply, ...(input.recorded ?? [])];
  return (
    `${prefix}${input.modelKey} に反映しますか：${items.join("・")}。` +
    input.summary +
    `記録先は拡張機能の保管庫の ${TUNING_STORE_FILE} です（VS Code の設定ではありません）。` +
    "ほかのモデルには影響しません。" +
    input.notes.join("")
  );
}
