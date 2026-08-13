import { describe, expect, test } from "vitest";
import { buildPlotTemplate } from "../../src/core/plotTemplate";

describe("プロットのテンプレート", () => {
  test("作品名を見出しにして、書く項目を並べる", () => {
    const template = buildPlotTemplate("こちら冒険者ギルド生活保護課!!");
    const lines = template.split("\n");

    expect(lines[0]).toBe("# こちら冒険者ギルド生活保護課!!");
    // 設計書6.4がプロットモードで扱う項目。あとから入力画面を付けても、
    // 作者が書いた内容をそのまま使えるように見出しを固定する
    for (const heading of [
      "## タイトル",
      "## ログライン",
      "## テーマ",
      "## モチーフ",
      "## 世界観",
      "## 舞台",
      "## 人称",
      "## 主人公の行動原理",
      "## あらすじ",
      "## 主要登場人物",
    ]) {
      expect(lines).toContain(heading);
    }
  });

  test("書き方に迷う項目には注釈を添える", () => {
    // 「ログライン」と言われて何を書くか分かる作者ばかりではない
    const template = buildPlotTemplate("無題");

    expect(template).toContain("誰が / どんな状況で / 何を目指し / 何が障害か");
    expect(template).toContain("一人称 / 三人称一元 / 三人称多元");
  });
});
