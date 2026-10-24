import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * ［設定資料項目追加］が、外したキーを使い回さない道を通る（2026-10-24）。
 *
 * 採番の決まりそのものは `test/unit/models/customField.test.ts` で確かめる。
 * ここでは、画面の流れがその決まりを迂回していないことだけを見る——
 * 外すときに定義を `filter` で落とすだけに戻ると、外したキーの記録
 * （retiredKeys）が残らず、次に足す項目へ同じキーが振られる。
 */
describe("設定資料項目追加のキーの振り方", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/features/manageCustomFields.ts"),
    "utf8"
  );

  test("外すときは、外したキーを覚える関数を通す", () => {
    expect(source).toContain("withFieldRemoved(set, choice.kind, key)");
    expect(source).not.toMatch(/fields\.filter\(\(field\) => field\.key !== /);
  });

  test("戻すときは、外したキーから選ばせ、同じキーのまま戻す関数を通す", () => {
    // 新しく採番すると、各資料に残っている値と結び付かない（戻した意味が無い）
    expect(source).toContain("restorableKeysFor(set, choice.kind)");
    expect(source).toContain("withFieldRestored(set, choice.kind, restored)");
    expect(source).toContain("外した項目を戻す");
  });

  test("足すときは、外したキーとレコードに残るキーも渡して採番する", () => {
    expect(source).toContain("retiredKeysFor(set, choice.kind)");
    expect(source).toContain("collectUsedKeys(work, choice)");
    expect(source).toContain("nextCustomFieldKey(fields, usedKeys)");
  });
});
