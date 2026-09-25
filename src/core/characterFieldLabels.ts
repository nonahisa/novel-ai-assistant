/**
 * 人物の項目名を、作者が読める言葉にする。
 *
 * **キーから引ける表はここにしか無い。** `characterDiff.ts` にも似た一覧が
 * あるが、あちらは「値の取り出し方」と組で持っており、項目のキーから引けない。
 * 知らないキー（作者が足した項目）はそのまま出す——推測で言い換えると、
 * 作者が付けた名前と画面の言葉が食い違う。
 *
 * **年表の外からも使う**（`core/factsFromRecords.ts`。0.46.1）。写しを作ると、
 * 同じ項目が年表では「外見」、矛盾の候補では「appearance」と出る。
 *
 * ---
 *
 * **元は `core/chronicle.ts` にあった**（0.67.2 でここへ出した）。あちらは
 * 年表の組み立てのために `timelineEdit.ts` → `paths.ts` を指しており、
 * **`vscode` へ届く**。この表ひとつのために、外から呼ぶ束（MCP）が
 * 丸ごと `vscode` 依存になってしまう（`mcpReach.test.ts`）。
 * 値そのものは1文字も変えていない——`chronicle.ts` は再輸出するだけである。
 */
export const CHARACTER_FIELD_LABELS: Record<string, string> = {
  name: "名前",
  summary: "紹介",
  gender: "性別",
  affiliation: "所属",
  reading: "読み",
  role: "役割",
  personality: "性格",
  speechStyle: "口調",
  appearance: "外見",
  age: "年齢",
  height: "身長",
  build: "体格",
  hair: "髪",
  eyes: "目",
  skin: "肌",
  distinctive: "特徴",
  clothing: "服装",
};
