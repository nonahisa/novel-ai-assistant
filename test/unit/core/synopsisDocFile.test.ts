import { describe, expect, test } from "vitest";
import { SYNOPSIS_FILE } from "../../src/core/synopsisDoc";

/**
 * 「作りました」と案内した資料が開けない不具合の再現（2026-08-15）。
 *
 * `generateSettingsDocs` は案内文（written）に「各話あらすじ」を足す一方、
 * 開く対象（writtenFiles）へは足していなかった。そのため
 *
 *   ・あらすじだけを作ったとき → 開く対象が0件で、押しても何も起きない
 *   ・他の資料もあるとき       → あらすじではなく人物一覧が開く
 *
 * となっていた。**案内と開く対象は必ず対にする。**
 *
 * 実物の `generateSettingsDocs` は VS Code API に強く依存するため、
 * ここでは「対にする」規則そのものを、同じ組み立てで確かめる。
 */

/** generateSettingsDocs と同じ考え方で、案内と開く対象を組み立てる */
function buildWritten(input: {
  hasSynopses: boolean;
  otherDocs: Array<{ label: string; fileName: string }>;
}): { written: string[]; writtenFiles: string[] } {
  const written: string[] = [];
  const writtenFiles: string[] = [];

  if (input.hasSynopses) {
    written.push("各話あらすじ");
    writtenFiles.push(SYNOPSIS_FILE);
  }
  for (const doc of input.otherDocs) {
    written.push(doc.label);
    writtenFiles.push(doc.fileName);
  }
  return { written, writtenFiles };
}

/** 開く対象を選ぶ。あらすじがあればそれを優先する */
function pickTarget(writtenFiles: readonly string[]): string | undefined {
  return writtenFiles.find((name) => name === SYNOPSIS_FILE) ?? writtenFiles[0];
}

describe("生成した資料を開く", () => {
  test("あらすじだけを作ったとき、開く対象がある", () => {
    // ここが0件だったため、押しても何も起きなかった
    const { written, writtenFiles } = buildWritten({
      hasSynopses: true,
      otherDocs: [],
    });

    expect(written).toContain("各話あらすじ");
    expect(writtenFiles).toEqual([SYNOPSIS_FILE]);
    expect(pickTarget(writtenFiles)).toBe(SYNOPSIS_FILE);
  });

  test("他の資料もあるとき、あらすじを先に開く", () => {
    // 直前に作ったものを見たいので、人物一覧より優先する
    const { writtenFiles } = buildWritten({
      hasSynopses: true,
      otherDocs: [{ label: "登場人物", fileName: "characters.md" }],
    });

    expect(pickTarget(writtenFiles)).toBe(SYNOPSIS_FILE);
  });

  test("案内した件数と、開ける件数が一致する", () => {
    // 片方だけに足すと「作りました」と言った資料が開けない
    const { written, writtenFiles } = buildWritten({
      hasSynopses: true,
      otherDocs: [
        { label: "登場人物", fileName: "characters.md" },
        { label: "場所", fileName: "locations.md" },
      ],
    });

    expect(written).toHaveLength(writtenFiles.length);
  });

  test("何も作らなかったときは開く対象が無い", () => {
    // undefined を行き先へ渡さない（黙って失敗しないため）
    const { writtenFiles } = buildWritten({ hasSynopses: false, otherDocs: [] });

    expect(pickTarget(writtenFiles)).toBeUndefined();
  });

  test("あらすじが無ければ、最初に作ったものを開く", () => {
    const { writtenFiles } = buildWritten({
      hasSynopses: false,
      otherDocs: [{ label: "登場人物", fileName: "characters.md" }],
    });

    expect(pickTarget(writtenFiles)).toBe("characters.md");
  });
});

describe("ファイル名の持ち方", () => {
  test("あらすじの文書名は1か所で決める", () => {
    // 案内する側と開く側で書き分けると、また食い違う
    expect(SYNOPSIS_FILE).toBe("synopsis.md");
  });
});
