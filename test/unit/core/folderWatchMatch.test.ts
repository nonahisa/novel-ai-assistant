import { describe, expect, it } from "vitest";
import {
  isDirectChildWithExtension,
  isUnderFolder,
  isUnderFolderWithExtension,
} from "../../../src/core/folderWatchMatch";
import { isWindowsHost } from "../../../src/core/runtime";

/**
 * 束ねた見張りの絞り込みが、**束ねる前の各見張りの glob と同じ結果になるか**
 * （残課題 C2、0.84.4）。
 *
 * 束ねる前は、機能ごとに VS Code へ glob を渡していた：
 *
 * | 機能 | 基点 | glob |
 * |---|---|---|
 * | 本文（`workFolderWatch.ts`） | 作品フォルダー | 「**」「/」「*.{txt,md}」 |
 * | 同期（`gitSync.ts`） | 作品フォルダー | 「**」「/」「*」 |
 * | 設定資料（`watchSettings.ts`） | 設定資料の置き場 | 「**」「/」「*.json」 |
 * | 単話プロット（`episodePlotWatch.ts`） | 置き場の1つ上 | 「episode-plots」「/」「*.md」 |
 *
 * 束ねたあとは作品フォルダーの下すべてを1本で受け、ここの関数で絞る。
 * **拾いすぎより、取りこぼしのほうが困る**——どちらの向きの食い違いも
 * 表で押さえる。
 */

const WORK = "C:/小説/作品";
const SETTINGS = `${WORK}/設定`;
const PLOTS = `${SETTINGS}/episode-plots`;

describe("「下のすべて」（同期の見張り）", () => {
  it.each([
    [`${WORK}/第1話.txt`, true],
    [`${WORK}/本文/第1章/第1話.txt`, true],
    [`${WORK}/.git/index`, true],
    [`${WORK}/.aiwriter/logs/a.log`, true],
    // 作品フォルダーそのものは含まない（glob は基点の下だけを見る）
    [WORK, false],
    // 名前が前方一致するだけの隣のフォルダーは外
    [`${WORK}2/第1話.txt`, false],
    ["C:/小説/別の作品/第1話.txt", false],
  ])("%s → %s", (filePath, expected) => {
    expect(isUnderFolder(WORK, filePath)).toBe(expected);
  });

  it("区切りが円記号でも同じに見る", () => {
    expect(isUnderFolder("C:\\小説\\作品", "C:\\小説\\作品\\第1話.txt")).toBe(true);
  });
});

describe("「下のどこかの .txt / .md」（本文の見張り）", () => {
  it.each([
    [`${WORK}/第1話.txt`, true],
    [`${WORK}/第1話.md`, true],
    [`${WORK}/本文/第1章/第1話.md`, true],
    // `*.md` は「0文字以上＋.md」なので、`.md` という名前も通る
    [`${WORK}/.md`, true],
    [`${WORK}/設定/characters/c1.json`, false],
    [`${WORK}/第1話.txt.bak`, false],
    [`${WORK}/第1話.mdx`, false],
    [`${WORK}/表紙.png`, false],
    ["C:/小説/別の作品/第1話.txt", false],
  ])("%s → %s", (filePath, expected) => {
    expect(
      isUnderFolderWithExtension(WORK, filePath, ["txt", "md"])
    ).toBe(expected);
  });

  it("拡張子の大文字小文字は VS Code と同じ扱い（Windows では同一視する）", () => {
    // VS Code の見張りは、大文字小文字を区別しないファイルシステムでは
    // 場所もパターンも小文字にしてから比べる
    expect(
      isUnderFolderWithExtension(WORK, `${WORK}/第1話.TXT`, ["txt", "md"])
    ).toBe(isWindowsHost());
  });
});

describe("「下のどこかの .json」（設定資料の見張り）", () => {
  it.each([
    [`${SETTINGS}/characters/c1.json`, true],
    [`${SETTINGS}/custom_fields.json`, true],
    [`${SETTINGS}/_schema/character.json`, true],
    [`${SETTINGS}/characters/c1.json.tmp`, false],
    [`${SETTINGS}/メモ.md`, false],
    // 設定資料の置き場の外の .json は、作品フォルダーの中でも拾わない
    [`${WORK}/.aiwriter/config.json`, false],
    [`${WORK}/設定2/c1.json`, false],
  ])("%s → %s", (filePath, expected) => {
    expect(isUnderFolderWithExtension(SETTINGS, filePath, ["json"])).toBe(
      expected
    );
  });
});

describe("「置き場の直下の .md」（単話プロットの見張り）", () => {
  it.each([
    [`${PLOTS}/第1話.md`, true],
    [`${PLOTS}/.md`, true],
    // 1つ下の階層は、以前の glob（`*` は区切りをまたがない）でも拾わなかった
    [`${PLOTS}/古い/第1話.md`, false],
    [`${PLOTS}/第1話.txt`, false],
    [`${SETTINGS}/第1話.md`, false],
    [PLOTS, false],
    [`${SETTINGS}/episode-plots2/第1話.md`, false],
  ])("%s → %s", (filePath, expected) => {
    expect(isDirectChildWithExtension(PLOTS, filePath, ["md"])).toBe(expected);
  });

  it("ブラウザ版の場所（URI）でも同じに見る", () => {
    const base = "vscode-vfs://github/owner/repo/作品/設定/episode-plots";
    expect(isDirectChildWithExtension(base, `${base}/第1話.md`, ["md"])).toBe(true);
    expect(isDirectChildWithExtension(base, `${base}/古い/第1話.md`, ["md"])).toBe(
      false
    );
  });
});
