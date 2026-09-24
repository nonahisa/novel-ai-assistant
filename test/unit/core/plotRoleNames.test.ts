import { describe, expect, it } from "vitest";
import {
  classifyRoleName,
  formatRoleAnnotation,
  splitRoleAnnotation,
} from "../../../src/core/plotRoleNames";

/**
 * 役名か名前かの見分け（設計書6.4.8「名前の候補を出す」）。
 *
 * **見逃し（役名なのに名前と見る）と、誤検出（名前なのに役名と見る）の
 * 両方を見る**（CLAUDE.md「繰り返し起きた失敗」2番）。片方だけだと、
 * 何でも役名と言う実装が満点になる。
 */
describe("役名を拾う（見逃さない）", () => {
  // 作者の実例（現代ダンジョンのインフラ担当、2026-09-25）の5人
  it.each(["主人公", "ヒロイン", "魔物", "班長", "向こうの業者"])(
    "「%s」は役名",
    (name) => {
      expect(classifyRoleName(name)?.kind).toBe("role");
    }
  );

  it.each(["先輩", "師匠", "冒険者", "新人配信者", "受付係", "謎の男", "女騎士", "作業員"])(
    "「%s」も役名",
    (name) => {
      expect(classifyRoleName(name)?.kind).toBe("role");
    }
  );

  it("強調の印があっても見分ける", () => {
    expect(classifyRoleName("**主人公**")?.kind).toBe("role");
  });

  it("迷うもの（名前にもある語尾・英数字で終わる）は unsure で返す", () => {
    expect(classifyRoleName("男A")?.kind).toBe("unsure");
    expect(classifyRoleName("信長")?.kind).toBe("unsure");
  });
});

describe("名前を役名と見ない（誤検出しない）", () => {
  it.each([
    "相馬 誠",
    "月島灯",
    "灯",
    "アレン",
    "ステファン", // 「ファン」で終わるが名前
    "ヴォイド・コンストラクタ",
    "このみ", // ひらがなの名前に「の」が入る
    "白瀬澪",
  ])("「%s」は名前", (name) => {
    expect(classifyRoleName(name)).toBeUndefined();
  });
});

describe("役名（名前）の形", () => {
  it("外側が役名なら、中を名前として割る", () => {
    expect(splitRoleAnnotation("主人公（相馬 誠）")).toEqual({
      role: "主人公",
      name: "相馬 誠",
    });
    expect(splitRoleAnnotation("向こうの業者(ガルド)")).toEqual({
      role: "向こうの業者",
      name: "ガルド",
    });
  });

  it("外側が名前なら割らない（括弧の中は読みか注記）", () => {
    expect(splitRoleAnnotation("灯（あかり）")).toBeUndefined();
    expect(splitRoleAnnotation("アレン（仮）")).toBeUndefined();
  });

  it("中身も役名なら割らない", () => {
    expect(splitRoleAnnotation("魔物（ファン）")).toBeUndefined();
  });

  it("書き足す形と、読む形が対になる", () => {
    expect(splitRoleAnnotation(formatRoleAnnotation("班長", "鬼塚 剛"))).toEqual({
      role: "班長",
      name: "鬼塚 剛",
    });
  });
});
