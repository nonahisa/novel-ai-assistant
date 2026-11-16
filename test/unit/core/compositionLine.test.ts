/**
 * 設定「変換中の線」の名前と値（`core/compositionLine.ts`。設計書6.25.2 の【裁定】2026-11-16 夜）。
 *
 * 名前と値はコードの1か所に置き、package.json の定義と食い違わないことをここで見張る
 * （package.json は import できないので、あとでモバイル版の名前にそろえるとき、片方だけ直すと落ちる）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPOSITION_LINE_DEFAULT,
  COMPOSITION_LINE_SETTING,
  COMPOSITION_LINE_VALUES,
  readCompositionLine,
} from "../../../src/core/compositionLine";

const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
  contributes: {
    configuration: {
      properties: Record<string, { type?: string; enum?: string[]; enumItemLabels?: string[]; default?: unknown }>;
    };
  };
};

describe("設定「変換中の線」", () => {
  it("package.json の鍵・値・既定が、コードの定数と同じ", () => {
    const property = manifest.contributes.configuration.properties[COMPOSITION_LINE_SETTING];
    expect(property, `${COMPOSITION_LINE_SETTING} が package.json に無い`).toBeDefined();
    expect(property.type).toBe("string");
    expect(property.enum).toEqual([...COMPOSITION_LINE_VALUES]);
    expect(property.default).toBe(COMPOSITION_LINE_DEFAULT);
  });

  it("既定は左。右は「テスト中」と断る", () => {
    expect(COMPOSITION_LINE_DEFAULT).toBe("left");
    const property = manifest.contributes.configuration.properties[COMPOSITION_LINE_SETTING];
    expect(property.enumItemLabels).toEqual(["左", "右（テスト中）"]);
  });

  it("知らない値・値が無いときは左（テスト中の入力欄へ黙って切り替えない）", () => {
    expect(readCompositionLine("right")).toBe("right");
    expect(readCompositionLine("left")).toBe("left");
    expect(readCompositionLine(undefined)).toBe("left");
    expect(readCompositionLine("Right")).toBe("left");
    expect(readCompositionLine(true)).toBe("left");
  });
});
