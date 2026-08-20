import { describe, it, expect } from "vitest";
import {
  canRegisterWork,
  describeWorkLimit,
  EDITOR_WORK_LIMIT,
} from "../../src/core/editorMode";

/**
 * 編集者モードは1作品だけ（設計書5.7.4）。
 *
 * **これは守りではなく取り違え防止である。** 守るのはGitHubの招待範囲のほうで、
 * 手元にファイルがある以上は別のエディタで読めてしまう。テストで確かめるのは
 * 「作者の作業を邪魔しないこと」と「編集部が2作品目を抱え込まないこと」の2つ。
 */
describe("canRegisterWork", () => {
  it("作者は何作品でも登録できる", () => {
    expect(canRegisterWork("author", 0)).toBe(true);
    expect(canRegisterWork("author", 1)).toBe(true);
    // 作者は作品集を丸ごと登録する。ここで止めては本題が成り立たない
    expect(canRegisterWork("author", 50)).toBe(true);
  });

  it("編集者は1作品目だけ登録できる", () => {
    expect(canRegisterWork("editor", 0)).toBe(true);
    expect(canRegisterWork("editor", 1)).toBe(false);
    expect(canRegisterWork("editor", 2)).toBe(false);
  });

  it("上限は1である", () => {
    expect(EDITOR_WORK_LIMIT).toBe(1);
  });
});

describe("describeWorkLimit", () => {
  it("いま何が登録されているかと、次にどうすればよいかを言う", () => {
    const text = describeWorkLimit("いじめられっ子");
    expect(text).toContain("いじめられっ子");
    // 「できません」で終わらせない。抜け道を示す
    expect(text).toContain("解除");
    // 何のための仕切りかを言う
    expect(text).toContain("取り違え");
  });
});
