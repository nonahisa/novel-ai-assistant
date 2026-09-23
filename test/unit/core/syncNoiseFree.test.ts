import { describe, expect, test } from "vitest";
import { rebaseline, sameBaseline } from "../../src/core/writingStats";
// 型そのものは models 側にある（core は使うだけで再輸出していない）
import type { DeviceWritingStats } from "../../src/models/writingStats";
import {
  bodyChangePaths,
  isBodyChangePath,
} from "../../src/core/manuscriptChangePaths";

/**
 * **何も触っていないのに、同期するたびに差分が出ていた**
 * （作者の実機報告、2026-09-15。設計書5.5.8）。
 *
 * > まったく何も触っていない状態から、ノートPCの作品一覧からすべて同期すると、
 * > 一か所更新が検出され、その後更新すると11作品読み直しがポップアップされます。
 * > デスクトップでも同期後再度同期するとスクショのようなものがでます。
 * > **同期はないはずです**
 *
 * 作者のリポジトリを見たら、変わっていたのは本文ではなく
 * **全13作品の `.aiwriter/stats/<端末>.json` の `at`（測った時刻）だけ**だった。
 * 字数は1文字も動いていない。
 *
 * これが**止まらない循環**を作る。
 *
 * 1. 同期のたびに基準を置き直し、字数が同じでも新しい時刻で保存する
 * 2. ファイルが変わるのでGitの差分になり、記録・送信される
 * 3. 別の機械で取り込むと、そこでも同じことが起きる
 *
 * 作者のリポジトリには「2026-09-15 21:56 の執筆（13件）」のようなコミットが
 * 積み上がっていた。**本文は1文字も書いていない。**
 */

const BASE: DeviceWritingStats = {
  schemaVersion: "1",
  deviceId: "test-device",
  // 日ごとの記録は空（ここで見るのは基準＝`baseline` の置き直しだけ）
  days: [],
  baseline: {
    net: 18198,
    gross: 18499,
    fileCount: 5,
    conflictedCount: 0,
    at: "2026-09-15T12:55:19.274Z",
    files: { "episode_0001.md": { net: 5529, gross: 5600 } },
  },
};

const SAME_MEASUREMENT = {
  net: 18198,
  gross: 18499,
  fileCount: 5,
  conflictedCount: 0,
  files: { "episode_0001.md": { net: 5529, gross: 5600 } },
};

describe("基準が同じなら、書き直さない", () => {
  test("**時刻だけが違う基準は、同じとみなす**", () => {
    // ここが false になると、同期のたびにファイルが変わる
    const next = rebaseline(BASE, SAME_MEASUREMENT, new Date("2026-09-15T12:56:17.085Z"));
    expect(next.baseline?.at).not.toBe(BASE.baseline?.at);
    expect(sameBaseline(BASE.baseline, next.baseline)).toBe(true);
  });

  test("字数が変われば、違うとみなす", () => {
    const next = rebaseline(
      BASE,
      { ...SAME_MEASUREMENT, net: 18199 },
      new Date()
    );
    expect(sameBaseline(BASE.baseline, next.baseline)).toBe(false);
  });

  test("ファイル数が変われば、違うとみなす", () => {
    const next = rebaseline(
      BASE,
      { ...SAME_MEASUREMENT, fileCount: 6 },
      new Date()
    );
    expect(sameBaseline(BASE.baseline, next.baseline)).toBe(false);
  });

  test("内訳のファイルが増えれば、違うとみなす", () => {
    const next = rebaseline(
      BASE,
      {
        ...SAME_MEASUREMENT,
        files: {
          "episode_0001.md": { net: 5529, gross: 5600 },
          "episode_0002.md": { net: 100, gross: 100 },
        },
      },
      new Date()
    );
    expect(sameBaseline(BASE.baseline, next.baseline)).toBe(false);
  });

  test("内訳の字数が変われば、違うとみなす", () => {
    const next = rebaseline(
      BASE,
      {
        ...SAME_MEASUREMENT,
        files: { "episode_0001.md": { net: 5530, gross: 5600 } },
      },
      new Date()
    );
    expect(sameBaseline(BASE.baseline, next.baseline)).toBe(false);
  });

  test("「内訳を持たない」と「空の内訳」は分ける", () => {
    // toBaseline が項目ごと置かないのと同じ理由（取り違えると素通りする）
    const withoutFiles = { ...BASE.baseline!, files: undefined };
    expect(sameBaseline(withoutFiles, BASE.baseline)).toBe(false);
  });

  test("片方が無ければ、同じとはみなさない", () => {
    expect(sameBaseline(undefined, BASE.baseline)).toBe(false);
    expect(sameBaseline(BASE.baseline, undefined)).toBe(false);
  });
});

/**
 * **管理ファイルを「本文」と呼ばない**（同じ報告の2つ目）。
 *
 * 「13作品で本文が更新されました（合計169件）。設定資料の抽出をやり直すと、
 * 増えた内容を取り込めます」——数えていたのは `git diff` の**全ファイル**で、
 * 執筆量の記録まで入っていた。この案内は**本文が増えたときにだけ**意味がある
 * （管理ファイルの変更で勧めると、作者にAIの費用と時間を使わせる）。
 */
describe("本文だけを数える", () => {
  test("**執筆量の記録は本文ではない**", () => {
    expect(isBodyChangePath(".aiwriter/stats/gamingpc-16cd.json")).toBe(false);
  });

  test("設定資料は本文ではない", () => {
    expect(isBodyChangePath("設定/characters/char_0001.json")).toBe(false);
    // **`.md` でも、設定の下なら本文ではない**（抽出の結果であって材料ではない）
    expect(isBodyChangePath("設定/characters.md")).toBe(false);
    expect(isBodyChangePath("設定/plot.md")).toBe(false);
  });

  test("履歴・キャッシュ・回復用の控えも本文ではない", () => {
    expect(isBodyChangePath(".aiwriter/history/edits.jsonl")).toBe(false);
    expect(isBodyChangePath(".aiwriter/cache/chunk.json")).toBe(false);
    expect(isBodyChangePath(".novelai-recovery/001.txt")).toBe(false);
  });

  test("本文は数える（フォルダーの有無を問わない）", () => {
    // **本文フォルダーの名前では絞らない**——直下に置く作者もいる
    expect(isBodyChangePath("本文/001.txt")).toBe(true);
    expect(isBodyChangePath("episode_0001.md")).toBe(true);
    expect(isBodyChangePath("本文/第12話 再会.md")).toBe(true);
  });

  test("本文でない拡張子は数えない", () => {
    expect(isBodyChangePath("本文/挿絵.png")).toBe(false);
    expect(isBodyChangePath("README.pdf")).toBe(false);
  });

  test("区切りがバックスラッシュでも同じに読む", () => {
    // Windows の git は `/` で返すが、呼ぶ側が変えることがある
    expect(isBodyChangePath(".aiwriter\\stats\\pc.json")).toBe(false);
    expect(isBodyChangePath("本文\\001.txt")).toBe(true);
  });

  test("作者の実データの並びから、本文だけが残る", () => {
    const changed = [
      ".aiwriter/stats/gamingpc-16cd.json",
      "設定/characters/char_0001.json",
      "本文/episode_0001.md",
      ".aiwriter/history/edits.jsonl",
      "episode_0002.txt",
    ];
    expect(bodyChangePaths(changed)).toEqual([
      "本文/episode_0001.md",
      "episode_0002.txt",
    ]);
  });

  test("統計ファイルだけが変わった同期では、1件も残らない", () => {
    // **作者が踏んだ形そのもの**（13作品の stats だけが変わっていた）
    const onlyStats = [
      "note記事/.aiwriter/stats/gamingpc-16cd.json",
      "いじめられっ子/.aiwriter/stats/gamingpc-16cd.json",
      "たゆたう鉛/.aiwriter/stats/gamingpc-16cd.json",
    ];
    expect(bodyChangePaths(onlyStats)).toEqual([]);
  });
});
