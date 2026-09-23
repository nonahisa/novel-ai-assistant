import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * アクティビティバーのアイコン（`media/icon.svg`）の約束ごと。
 *
 * VS Codeはこのアイコンを**1色に塗り直して**表示する。色で描き分けることも、
 * 外部の画像を読み込むこともできない。見た目は目で確かめるしかないが、
 * 「そもそも表示できない書き方」だけは機械で止められる。
 */
const icon = readFileSync(
  path.join(__dirname, "..", "..", "media", "icon.svg"),
  "utf8"
);

describe("拡張機能のアイコン", () => {
  test("24×24の枠で描く", () => {
    // アクティビティバーは24pxで表示する。別の寸法で描くと縮尺がずれる
    expect(icon).toContain('viewBox="0 0 24 24"');
  });

  test("色を決め打ちしない", () => {
    // VS Codeが選択状態やテーマに合わせて塗り直す。
    // 色を書くと、暗いテーマで見えなくなる組み合わせが必ず出る
    expect(icon).not.toMatch(/fill="#/);
    expect(icon).not.toMatch(/fill="(?!currentColor)[a-z]+"/);
    expect(icon).toContain('fill="currentColor"');
  });

  test("外部のものを読み込まない", () => {
    // 配布物には icon.svg しか入らない（scripts/releaseSupport.mjs の許可リスト）。
    // 参照先が無いアイコンは、インストール先で何も表示されない
    expect(icon).not.toMatch(/<image\b/);
    expect(icon).not.toMatch(/<script\b/);
    expect(icon).not.toMatch(/url\(/);
    expect(icon).not.toMatch(/xlink:href/);
  });

  test("線ではなく塗りで描く", () => {
    // 線幅は縮小で潰れる。24pxでは輪郭の形だけが残る
    expect(icon).not.toMatch(/\bstroke=/);
  });
});
