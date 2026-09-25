import type { TuningWriteOutcome } from "../core/modelTuning";
import { TUNING_STORE_FILE } from "../core/modelTuningStore";

/**
 * 台帳へ書けなかった理由を、作者の言葉にする（作者の報告、2026-09-19）。
 *
 * **札をそのまま出さない。** `unreadable` と `lost` では打つ手がまるで
 * 違う——前者は台帳のファイルを直すまで何度測っても入らないし、後者は
 * 開いている窓を1つにすれば入る。区別を伝えないと、作者は「また12分
 * 測る」以外の手を思いつけない。
 *
 * **読める長さの測定（`features/measureContext.ts`）と、仕事に近い形の
 * 測定（`features/tuningStageRunners.ts`）の両方が使う**ので、ここへ出した
 * （写すと、片方だけ言い回しが古くなる）。
 */
export function describeTuningWriteFailure(outcome: TuningWriteOutcome): string {
  switch (outcome) {
    case "written":
      return "";
    case "unreadable":
      return (
        `AIチューニングの記録（拡張機能の保管庫の ${TUNING_STORE_FILE}）が` +
        "読めない形になっているため、上書きせずに止めました。" +
        "中身を直すか、詳細メニューの「AIチューニング記録削除」で" +
        "作り直してから測り直してください。"
      );
    case "no_store":
      return (
        "AIチューニングの記録の置き場が使えないため、書けませんでした。" +
        "拡張機能を入れ直すか、VS Code を開き直してから測り直してください。"
      );
    case "lost":
      return (
        "AIチューニングの記録へ書いても残りませんでした。" +
        "ほかの VS Code の窓が同じ記録を書いている可能性があります。" +
        "窓を1つにしてから測り直してください。"
      );
  }
}
