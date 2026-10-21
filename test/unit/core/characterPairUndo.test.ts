import { describe, expect, test } from "vitest";
import {
  applyCharacterDistinct,
  applyCharacterUnify,
  describePendingAfterUnify,
} from "../../../src/core/characterPairDecision";
import { undoPairDecision } from "../../../src/core/characterPairUndo";
import { emptyCharacter, type Character } from "../../../src/models/character";
import { memoryCharacterStore, memoryPendingStore } from "../support/memoryCharacterStore";

/**
 * 重複の候補の帯の［戻す］（設計書6.5.4。作者の裁定 2026-10-20・10-22）。
 *
 * 戻す前に、いまの記録がその手の直後のままかを確かめ、変わっていたら当て推量で戻さず
 * 理由を返して何も書かない（校正・メモパネルの［済み］の［戻す］と同じ作り。6.40.4）。
 */

function person(id: string, name: string, overrides: Partial<Character> = {}): Character {
  return { ...emptyCharacter(id, name), ...overrides };
}

async function unifiedPair(options: { withPending?: boolean } = {}) {
  const keep = person("char_001", "三門太志", { appearedChapters: [1] });
  const absorb = person("char_002", "太志", { authorNotes: "作者のメモ", appearedChapters: [2] });
  const store = memoryCharacterStore([keep, absorb]);
  await store.loadAll();
  const pending = memoryPendingStore(
    options.withPending
      ? [
          { character: { ...keep, summary: "寡黙な青年" }, filePath: "pending/char_001.json", source: "chat" },
          { character: { ...absorb, summary: "眠そう" }, filePath: "pending/char_002.json" },
        ]
      : []
  );
  const pendingBefore = structuredClone([...pending.files.values()]);
  const filesBefore = new Map(store.files);
  const applied = await applyCharacterUnify(store, keep, absorb, [keep, absorb], { pending });
  return { keep, absorb, store, pending, pendingBefore, filesBefore, applied };
}

describe("まとめた手を戻す", () => {
  test("元の2つのファイルを中身そのままで戻し、まとめた内容は回復用の場所に残す", async () => {
    const { store, pending, filesBefore, applied, keep, absorb } = await unifiedPair();
    expect(applied.undo).toBeDefined();
    const unifiedBody = store.files.get("chars/char_001.json");

    const outcome = await undoPairDecision(store, pending, applied.undo!);

    expect(outcome.kind).toBe("done");
    expect(outcome.kind === "done" && outcome.band).toContain(
      "まとめる前に戻しました。「三門太志」と「太志」は別々の記録に戻り"
    );
    // 退避したときのバイトそのもの（更新日時も書き換わらない）
    expect(store.files.get("chars/char_001.json")).toBe(filesBefore.get("chars/char_001.json"));
    expect(store.files.get("chars/char_002.json")).toBe(filesBefore.get("chars/char_002.json"));
    expect(store.read(keep.id)?.aliases).toEqual([]);
    expect(store.read(absorb.id)?.authorNotes).toBe("作者のメモ");
    // まとめた内容は消さない（回復用の場所へ退避）
    const recovered = [...store.files.entries()].filter(([filePath]) =>
      filePath.startsWith("chars/.novelai-recovery/")
    );
    expect(recovered.map(([, body]) => body)).toContain(unifiedBody);
  });

  test("捨てた・寄せた反映待ちは、まとめる前の姿で積み直す（寄せた案で、まとめがまた入らない）", async () => {
    const { store, pending, pendingBefore, applied } = await unifiedPair({ withPending: true });
    expect(applied.pending).toMatchObject({ discarded: 1, rebased: 1 });

    const outcome = await undoPairDecision(store, pending, applied.undo!);

    expect(outcome.kind).toBe("done");
    expect(outcome.kind === "done" && outcome.band).toContain("反映待ちの更新 2件も、元の姿で積み直しました。");
    const after = [...pending.files.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
    const expected = [...pendingBefore].sort((a, b) => a.filePath.localeCompare(b.filePath));
    expect(after.map((update) => update.character)).toEqual(expected.map((update) => update.character));
    expect(after.find((update) => update.filePath === "pending/char_001.json")?.source).toBe("chat");
  });

  test("まとめたあとに残した人物が書き換えられていたら、戻さずに理由を返す（何も書かない）", async () => {
    const { store, pending, applied } = await unifiedPair();
    await store.loadAll();
    await store.saveOrUpdate({ ...store.read("char_001")!, summary: "作者が書き足した" });
    const filesAtUndo = new Map(store.files);
    const calls = store.calls.length;

    const outcome = await undoPairDecision(store, pending, applied.undo!);

    expect(outcome).toEqual({
      kind: "refused",
      band: "戻せませんでした。「三門太志」が、まとめたあとに書き換えられています。何も書き換えていません。",
    });
    expect(store.files).toEqual(filesAtUndo);
    expect(store.calls.length).toBe(calls);
  });

  test("パネルの外で書き換えられていても（控えが古いまま）、読み直して気づく", async () => {
    const { store, pending, applied } = await unifiedPair();
    store.tamper("char_001", { summary: "手で書いた" });

    const outcome = await undoPairDecision(store, pending, applied.undo!);

    expect(outcome.kind).toBe("refused");
  });

  test("取り下げた側の記録がまたできていたら、戻さない", async () => {
    const { store, pending, applied } = await unifiedPair();
    await store.loadAll();
    await store.save(person("char_002", "太志"));

    const outcome = await undoPairDecision(store, pending, applied.undo!);

    expect(outcome.kind === "refused" && outcome.band).toContain("「太志」の記録が、まとめたあとにまたできています。");
  });

  test("回復用の場所の元のファイルが消えていたら、戻さない", async () => {
    const { store, pending, applied } = await unifiedPair();
    store.files.delete(applied.undo!.absorb.recoveryPath);

    const outcome = await undoPairDecision(store, pending, applied.undo!);

    expect(outcome.kind === "refused" && outcome.band).toContain("「太志」の元のファイルが、見つからないか変わっています。");
  });

  test("その後に反映待ちが積まれていたら、戻さない（積まれた案はまとめたあとの姿の写し）", async () => {
    const { store, pending, applied } = await unifiedPair();
    await pending.stage([{ ...store.read("char_001")!, summary: "次の抽出" }]);

    const outcome = await undoPairDecision(store, pending, applied.undo!);

    expect(outcome.kind === "refused" && outcome.band).toContain("反映待ちの更新が変わっています");
  });

  test("読み込めない人物のファイルがあれば見合わせ、札は残す（直せばもう一度押せる）", async () => {
    const { store, pending, applied } = await unifiedPair();
    store.breakFile("char_009.json");

    const outcome = await undoPairDecision(store, pending, applied.undo!);

    expect(outcome.kind).toBe("blocked");
    expect(outcome.kind === "blocked" && outcome.message).toContain("char_009.json");
  });

  test("元のファイルを戻すところで止まったら、手で戻す先を3つとも出す", async () => {
    const { store, pending, applied } = await unifiedPair();
    store.failRestore(1);

    const outcome = await undoPairDecision(store, pending, applied.undo!);

    expect(outcome.kind).toBe("broken");
    const message = outcome.kind === "broken" ? outcome.message : "";
    expect(message).toContain(applied.undo!.keep.recoveryPath);
    expect(message).toContain(applied.undo!.absorb.recoveryPath);
    expect(message).toContain("まとめた内容: chars/.novelai-recovery/");
  });
});

describe("別人にした手を戻す", () => {
  async function distinctPair() {
    const a = person("char_001", "密倉文佳", { aliases: ["文佳さん", "お嬢様"] });
    const b = person("char_002", "文佳");
    const store = memoryCharacterStore([a, b]);
    await store.loadAll();
    const applied = await applyCharacterDistinct(store, a, b);
    return { a, b, store, applied };
  }

  test("互いを指す別人の記録を消し、外した別名を戻す", async () => {
    const { store, applied } = await distinctPair();
    expect(store.read("char_001")?.aliases).toEqual(["お嬢様"]);
    const pending = memoryPendingStore();
    const ticket = {
      ...applied.undo!,
      pendingBefore: [{ character: person("char_002", "文佳", { summary: "眠そう" }), filePath: "pending/char_002.json" }],
    };

    const outcome = await undoPairDecision(store, pending, ticket);

    expect(outcome.kind).toBe("done");
    expect(outcome.kind === "done" && outcome.band).toBe(
      "別人として覚えたのを取り消しました。「密倉文佳」と「文佳」は、また重複の候補に出ます。" +
        "「密倉文佳」の別名 「文佳さん」 も戻しました。" +
        "反映待ちの更新 1件も、元の姿で積み直しました。"
    );
    expect(store.read("char_001")?.aliases).toEqual(["文佳さん", "お嬢様"]);
    expect(store.read("char_001")?.distinctFrom ?? []).toEqual([]);
    expect(store.read("char_002")?.distinctFrom ?? []).toEqual([]);
    expect([...pending.files.keys()]).toEqual(["pending/char_002.json"]);
  });

  test("別人にしたあとに書き換えられていたら、戻さない", async () => {
    const { store, applied } = await distinctPair();
    store.tamper("char_002", { summary: "手で書いた" });

    const outcome = await undoPairDecision(store, memoryPendingStore(), applied.undo!);

    expect(outcome).toEqual({
      kind: "refused",
      band: "戻せませんでした。「文佳」が、別人として覚えたあとに書き換えられています。何も書き換えていません。",
    });
  });
});

describe("まとめたあとの反映待ちの文", () => {
  test("捨てた件数と寄せた件数を名指しで言う", () => {
    expect(
      describePendingAfterUnify(
        { discarded: 1, rebased: 2, unreadable: [], before: [], after: [] },
        "三門太志",
        "太志"
      )
    ).toBe("反映待ちの更新のうち、「太志」の 1件は捨て、「三門太志」の 2件はまとめたあとの姿に合わせました。");
  });

  test("何もしていなければ空", () => {
    expect(
      describePendingAfterUnify({ discarded: 0, rebased: 0, unreadable: [], before: [], after: [] }, "A", "B")
    ).toBe("");
  });
});
