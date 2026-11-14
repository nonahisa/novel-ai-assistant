import { describe, expect, it } from "vitest";
import { chapterRangeText } from "../../../src/core/chapterRange";
import { buildChroniclePanelHtml } from "../../../src/views/chroniclePanelHtml";
import { buildRelationGraphPanelHtml } from "../../../src/views/relationGraphPanelHtml";

/**
 * 話数のつまみ（第M〜N話）の、画面の側の写し（設計書6.38.2「第M〜N話の相関図」）。
 *
 * WebView のスクリプトは core を import できないので、数字の読み方
 * （`chapterRangeText`）を写して持つ。写しがずれると、つまみの横の数字と
 * 拡張機能が返す範囲の言い方が食い違う。ここで同じ答えを出すかを見る。
 *
 * もう1つ、**つまみを追い越して放したあと、送る前に2本を入れ替えること**を
 * 見る。放したつまみには焦点が残り、拡張機能が返した値を書き戻せないので、
 * 入れ替えないと次にほかの絞りを触ったとき範囲が勝手に狭まる。
 */

const SCREENS = {
  相関図: buildRelationGraphPanelHtml("NONCE123", "vscode-resource:"),
  年表: buildChroniclePanelHtml("NONCE123", "vscode-resource:"),
};

function scriptOf(html: string): string {
  const found = html.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
}

/** 中括弧の対応を数えて関数を1つ取り出す（年表の画面の検査と同じ手） */
function extractFunction(source: string, name: string): string {
  const head = source.indexOf("function " + name + "(");
  expect(head, name + " が見つからない").toBeGreaterThanOrEqual(0);
  let depth = 0;
  let started = false;
  for (let index = head; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
      started = true;
    } else if (source[index] === "}") {
      depth--;
      if (started && depth === 0) return source.slice(head, index + 1);
    }
  }
  throw new Error(name + " の終わりが見つからない");
}

function load<T>(html: string, name: string): T {
  return new Function(
    [extractFunction(scriptOf(html), name), "return " + name + ";"].join("\n")
  )() as T;
}

describe("話数のつまみの写し", () => {
  for (const [screen, html] of Object.entries(SCREENS)) {
    it(`${screen}：数字の読み方が core と同じ`, () => {
      const text = load<(a: number, b: number) => string>(html, "chapterRangeText");
      for (const [from, to] of [
        [1, 19],
        [3, 8],
        [5, 5],
      ]) {
        expect(text(from, to)).toBe(chapterRangeText(from, to));
      }
      // 追い越していても小さいほうから読む
      expect(text(8, 3)).toBe(chapterRangeText(3, 8));
    });

    it(`${screen}：追い越した2本は、送る前に入れ替える`, () => {
      const order = load<(from: { value: string }, to: { value: string }) => void>(
        html,
        "orderRangeSliders"
      );
      const from = { value: "8" };
      const to = { value: "3" };
      order(from, to);
      expect([from.value, to.value]).toEqual(["3", "8"]);

      const same = { value: "4" };
      const later = { value: "9" };
      order(same, later);
      expect([same.value, later.value]).toEqual(["4", "9"]);
    });

    it(`${screen}：送るときに入れ替えを通す`, () => {
      expect(extractFunction(scriptOf(html), "sendFilter")).toContain(
        "orderRangeSliders("
      );
    });
  }
});
