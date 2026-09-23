import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { menuVersionLabel } from "../../src/core/versionLabel";

describe("menuVersionLabel（見出しの脇に出す版の札）", () => {
  it("版に v を付けて返す", () => {
    expect(menuVersionLabel("0.75.8")).toBe("v0.75.8");
  });

  it("すでに v が付いていれば二重にしない", () => {
    expect(menuVersionLabel("v0.75.8")).toBe("v0.75.8");
  });

  it("前後の空白は落とす", () => {
    expect(menuVersionLabel("  0.75.8  ")).toBe("v0.75.8");
  });

  // **読めなかったときに札を出さない**のが要点。
  // `v` だけ、`v（不明）` のような字が見出しの脇に残ると、
  // 版を知りたくて見た作者を迷わせる
  it("読めないときは札を出さない", () => {
    expect(menuVersionLabel(undefined)).toBeUndefined();
    expect(menuVersionLabel("")).toBeUndefined();
    expect(menuVersionLabel("   ")).toBeUndefined();
  });

  // **写しを作っていないことの見張り**（設計の要）。
  // この層が版の字を持ってしまうと、package.json を上げた日に
  // 画面だけが古い版を言い続ける
  it("この層は版の数字を持たない", () => {
    const source = readFileSync("src/core/versionLabel.ts", "utf8");
    // コメントの中の例（2026-09-21 などの日付）と区別するため、
    // 版の形（数字.数字.数字）だけを探す
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\d+\.\d+\.\d+/);
  });
});

describe("詳細メニューの見出しへ実際に渡していること", () => {
  // **口だけ開けて繋いでいない、を防ぐ**。
  // `extension.ts` は単体テストで起こせないので、繋ぎの一行が
  // 在ることをソースで見る（弱いテストにならないよう、
  // 「actionView.description へ」「packageJSON の version から」の
  // 両方が揃っていることを見る）
  it("actionView.description へ packageJSON の版を渡している", () => {
    const source = readFileSync("src/extension.ts", "utf8");
    expect(source).toContain("menuVersionLabel");
    expect(source).toMatch(/actionView\.description\s*=\s*menuVersionLabel\(/);
    expect(source).toMatch(/packageJSON as \{[\s\S]{0,120}version\?: string/);
  });
});
