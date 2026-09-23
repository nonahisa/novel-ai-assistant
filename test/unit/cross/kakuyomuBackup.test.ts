import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isWorkInfoFile } from "../../src/core/workInfoFile";
import { workScan } from "../../src/mcp/tools/workScan";
import { orderedEpisodeBodies } from "../../src/mcp/tools/shared";
import { emptyDeviceStats, recordMeasurement } from "../../src/core/writingStats";

/**
 * カクヨムのバックアップを、そのまま作品フォルダーとして登録したとき
 * （作者の実データ、2026-09-19）。
 *
 * バックアップの形は2つの点で素の原稿と違う。
 *
 * 1. ファイル名が `episode_0001.txt` で、**題を持たない**
 *    ——題は中の頭書き（【タイトル】）にある
 * 2. `about.txt`（**作品情報**）が同じ場所に入っている
 *    ——題・キャッチコピー・紹介文・タグが並ぶだけで、本文ではない
 *
 * どちらも実データでしか出ない。**作り物の作品には `about.txt` を
 * 置いていなかったので、これまでの試験では出ようがなかった。**
 */

/** カクヨムのバックアップの `about.txt`（作者の実データと同じ並び） */
const ABOUT_TXT = [
  "【タイトル】",
  "灯をたどる",
  "",
  "【作者名】",
  "hisa",
  "",
  "【連載状態】",
  "連載中",
  "",
  "【ジャンル】",
  "現代ドラマ",
  "",
  "【キャッチコピー】",
  "その灯は、まだ消えていない。",
  "",
  "【紹介文（2行）】",
  "　夜の川べりを歩く話です。",
  "",
  "【タグ】",
  "- 現代",
  "- 短編",
  "",
  "【文字数】",
  "- 公開済のみ: 1,234文字",
  "",
  "【目次】",
  "1. 第1話　灯",
  "2. 第2話　川",
  "",
].join("\n");

/** 1話ぶんのバックアップ。**ファイル名に題が無く、頭書きにある** */
function episodeTxt(chapter: number, title: string, body: string): string {
  return [
    "【タイトル】",
    `第${chapter}話　${title}`,
    "",
    "【公開状態】",
    "公開済",
    "",
    "【文字数】",
    `${body.length}文字`,
    "",
    `【本文（1行）】`,
    body,
    "",
  ].join("\n");
}

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "novelai-kakuyomu-"));
  fs.writeFileSync(path.join(work, "about.txt"), ABOUT_TXT, "utf8");
  fs.writeFileSync(
    path.join(work, "episode_0001.txt"),
    episodeTxt(1, "灯", "　川べりに灯がひとつ残っていた。"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(work, "episode_0002.txt"),
    episodeTxt(2, "川", "　水の音だけが続いている。"),
    "utf8"
  );
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe("作品情報のファイルを見分ける", () => {
  test("カクヨムの about.txt は作品情報", () => {
    expect(isWorkInfoFile("about.txt", ABOUT_TXT)).toBe(true);
    // 大文字で保存し直されていても同じ
    expect(isWorkInfoFile("About.TXT", ABOUT_TXT)).toBe(true);
  });

  test("1話のバックアップは作品情報ではない（【本文】がある）", () => {
    const episode = episodeTxt(1, "灯", "　川べりに灯がひとつ残っていた。");
    expect(isWorkInfoFile("episode_0001.txt", episode)).toBe(false);
    // **名前が about.txt でも、【本文】があるなら1話である**
    expect(isWorkInfoFile("about.txt", episode)).toBe(false);
  });

  test("`about.txt` という題の掌編は落とさない", () => {
    /*
      **名前だけで決めない。** 作者が `about.txt` という名前で原稿を
      書いていることはありうる。落とすと、その話が作品から消えたように
      見える——作品情報を1つ余計に数えるより、ずっと重い失敗である。
    */
    const prose = "　看板には【立入禁止】と書かれていた。\n　それでも進んだ。\n";
    expect(isWorkInfoFile("about.txt", prose)).toBe(false);
  });

  test("名前が違えば、中身が作品情報の形でも本文として扱う", () => {
    // 見分けは名前と中身の両方が揃ったときだけ。片方では倒さない
    expect(isWorkInfoFile("設定メモ.txt", ABOUT_TXT)).toBe(false);
  });
});

describe("work.scan（カクヨムのバックアップ）", () => {
  test("ファイル名に題が無ければ、頭書きの題を使う", () => {
    /*
      **これが落ちていた**（`workScan.ts` は `parsed.subtitle` しか
      見ていなかった）。`episode_0001.txt` のような名前だと、外から見て
      全話の題が null になる。製品の走査（`core/scanner.ts`）は
      `parsed.subtitle ?? meta.title` で拾っている。
    */
    const result = workScan({ folder: work });
    expect(result.episodes.map((episode) => episode.title)).toEqual([
      "第1話　灯",
      "第2話　川",
    ]);
  });

  test("about.txt は話に数えず、作品情報として別に返す", () => {
    const result = workScan({ folder: work });

    // 話は2つ。**話数の読めない3つ目（about）が並ばない**
    expect(result.episodes).toHaveLength(2);
    expect(result.episodes.map((episode) => episode.chapter)).toEqual([1, 2]);
    // 読んだ本文のファイル数にも入らない
    expect(result.fileCount).toBe(2);
    // **黙って消さない。** 呼ぶ側が要るときに名指しで読めるようにする
    expect(result.workInfoFiles).toEqual(["about.txt"]);
  });

  test("材料（話数順の本文）にも作品情報は混ざらない", () => {
    // 並べ替えだけでは「先頭に来ない」だけで、プロット逆算や紹介文には
    // 作品説明が1話として残っていた
    const bodies = orderedEpisodeBodies(work);
    expect(bodies.map((body) => body.filePath)).toEqual([
      "episode_0001.txt",
      "episode_0002.txt",
    ]);
    expect(bodies.some((body) => body.body.includes("キャッチコピー"))).toBe(
      false
    );
  });
});

describe("作品情報を話から外しても、執筆量にはねない", () => {
  test("ファイル数が減った回は数えず、基準を置き直すだけ", () => {
    /*
      **これが今回いちばん確かめたかったこと**（設計書5.5.8）。

      `about.txt` を話から外すと、作品の総字数が719字ぶん減る。それが
      「マイナスの執筆量」として記録されると、作者が書いていない日に
      「-719字」が残る。

      `recordMeasurement` は**ファイル数が変わった回を数えない**
      （ダウンロードした本文を入れた・消したを執筆量にしないための
      仕組み）。作品情報を外すとファイル数も同時に減るので、
      この守りにそのまま乗る。
    */
    const before = recordMeasurement(emptyDeviceStats("dev-0001"), {
      net: 18198,
      gross: 18499,
      fileCount: 5,
      conflictedCount: 0,
      files: {},
    });
    // 初回は基準を置くだけ（差が出せない）
    expect(before.counted).toBe(false);
    expect(before.reason).toBe("baseline");

    const after = recordMeasurement(before.stats, {
      // 作品情報の540字ぶん減り、ファイルも1つ減った
      net: 17658,
      gross: 17938,
      fileCount: 4,
      conflictedCount: 0,
      files: {},
    });

    expect(after.counted).toBe(false);
    expect(after.reason).toBe("structure_changed");
    expect(after.delta).toBe(0);
    // **記録は1日も増えない**（マイナスの執筆量が残らない）
    expect(after.stats.days).toEqual([]);
    // 次からは新しい字数を基準に数える
    expect(after.stats.baseline?.net).toBe(17658);
    expect(after.stats.baseline?.fileCount).toBe(4);
  });
});
