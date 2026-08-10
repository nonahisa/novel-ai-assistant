import { describe, expect, test } from "vitest";
import {
  describeConflict,
  parseConflicts,
  resolveConflicts,
  sanitizeLabel,
  sideFileName,
} from "../../src/core/conflictFile";

const CONFLICTED = [
  "　朝の光が差し込んだ。",
  "<<<<<<< HEAD",
  "　灯は歩き出した。",
  "=======",
  "　灯はゆっくりと歩き出した。",
  ">>>>>>> origin/main",
  "　外は静かだった。",
].join("\n");

describe("競合マーカーの解析", () => {
  test("両方の版とラベルを取り出す", () => {
    const parsed = parseConflicts(CONFLICTED);

    expect(parsed.malformed).toBe(false);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0]).toMatchObject({
      startLine: 1,
      oursLabel: "HEAD",
      theirsLabel: "origin/main",
      ours: ["　灯は歩き出した。"],
      theirs: ["　灯はゆっくりと歩き出した。"],
    });
  });

  test("複数箇所を拾う", () => {
    const text = [
      "<<<<<<< HEAD",
      "A",
      "=======",
      "B",
      ">>>>>>> origin/main",
      "間の地の文",
      "<<<<<<< HEAD",
      "C",
      "=======",
      "D",
      ">>>>>>> origin/main",
    ].join("\n");

    expect(parseConflicts(text).hunks).toHaveLength(2);
  });

  test("diff3形式の共通の祖先も読む", () => {
    const text = [
      "<<<<<<< HEAD",
      "新しいこちら",
      "||||||| base",
      "もとの文",
      "=======",
      "新しいあちら",
      ">>>>>>> origin/main",
    ].join("\n");

    const hunk = parseConflicts(text).hunks[0];

    expect(hunk.base).toEqual(["もとの文"]);
    expect(hunk.ours).toEqual(["新しいこちら"]);
    expect(hunk.theirs).toEqual(["新しいあちら"]);
  });

  test("閉じていないマーカーは、想像で補わず不正として報告する", () => {
    // 手で編集途中の可能性が高い。読み解こうとすると誤った版を採用させる
    const text = ["<<<<<<< HEAD", "書きかけ", "=======", "途中"].join("\n");
    const parsed = parseConflicts(text);

    expect(parsed.hunks).toHaveLength(0);
    expect(parsed.malformed).toBe(true);
  });

  test("競合の無い本文は0件", () => {
    const parsed = parseConflicts("　ただの本文。\n　二行目。");

    expect(parsed.hunks).toHaveLength(0);
    expect(parsed.malformed).toBe(false);
  });

  test("7個ちょうどでない記号を取り違えない", () => {
    // 小説本文に「=====」のような区切り線が出ることがある
    const text = ["=====", "======", "========", "　本文"].join("\n");

    expect(parseConflicts(text).hunks).toHaveLength(0);
  });
});

describe("選んだ側で本文を組み立てる", () => {
  test("この環境の版だけを残す", () => {
    expect(resolveConflicts(CONFLICTED, "ours")).toBe(
      ["　朝の光が差し込んだ。", "　灯は歩き出した。", "　外は静かだった。"].join(
        "\n"
      )
    );
  });

  test("別環境の版だけを残す", () => {
    expect(resolveConflicts(CONFLICTED, "theirs")).toBe(
      [
        "　朝の光が差し込んだ。",
        "　灯はゆっくりと歩き出した。",
        "　外は静かだった。",
      ].join("\n")
    );
  });

  test("マーカーが1つも残らない", () => {
    const resolved = resolveConflicts(CONFLICTED, "ours");

    expect(resolved).not.toContain("<<<<<<<");
    expect(resolved).not.toContain("=======");
    expect(resolved).not.toContain(">>>>>>>");
  });

  test("複数箇所すべてに同じ選択を適用する", () => {
    // 1ファイルの中で版が混ざると前後のつながりが壊れる
    const text = [
      "<<<<<<< HEAD",
      "A",
      "=======",
      "B",
      ">>>>>>> origin/main",
      "間",
      "<<<<<<< HEAD",
      "C",
      "=======",
      "D",
      ">>>>>>> origin/main",
    ].join("\n");

    expect(resolveConflicts(text, "theirs")).toBe(["B", "間", "D"].join("\n"));
  });

  test("片側が空の削除競合でも壊れない", () => {
    const text = [
      "前",
      "<<<<<<< HEAD",
      "=======",
      "追加された行",
      ">>>>>>> origin/main",
      "後",
    ].join("\n");

    expect(resolveConflicts(text, "ours")).toBe(["前", "後"].join("\n"));
    expect(resolveConflicts(text, "theirs")).toBe(
      ["前", "追加された行", "後"].join("\n")
    );
  });

  test("競合が無ければそのまま返す", () => {
    expect(resolveConflicts("　本文だけ。", "ours")).toBe("　本文だけ。");
  });
});

describe("両方を残すときのファイル名", () => {
  test("拡張子の手前に印を入れる", () => {
    expect(sideFileName("008.txt", "origin/main")).toBe(
      "008.conflict-origin-main.txt"
    );
  });

  test("サブタイトル付きの名前でも壊さない", () => {
    expect(sideFileName("007_湖畔の誓い.txt", "laptop")).toBe(
      "007_湖畔の誓い.conflict-laptop.txt"
    );
  });

  test("パス区切りをファイル名に持ち込まない", () => {
    expect(sanitizeLabel("origin/main")).toBe("origin-main");
    expect(sanitizeLabel("  ")).toBe("other");
  });
});

describe("競合の説明", () => {
  test("箇所数を伝える", () => {
    expect(describeConflict(parseConflicts(CONFLICTED))).toContain("1か所");
  });

  test("閉じていない場合は手で確認するよう促す", () => {
    const parsed = parseConflicts("<<<<<<< HEAD\n途中");

    expect(describeConflict(parsed)).toContain("手で確認");
  });
});
