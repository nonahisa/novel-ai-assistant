import { describe, expect, test } from "vitest";
import {
  canFoldAutomatically,
  describeMergePreview,
  isAutoWrittenPath,
  mergeTreeArgs,
  parseMergeTree,
} from "../../src/core/mergePreview";
import {
  containsConflictMarkers,
  describeGuardFailure,
  guardResult,
  unexpectedChanges,
} from "../../src/core/mergeGuard";

/**
 * 分岐したときに畳めるか（設計書5.5.16）。
 *
 * 作者の置き場で実際に起きた分岐では、**重なった6件のうち5件は中身まで同じ**で、
 * 衝突したのは自動生成の1件だけだった。**名前の重なりで判定していたら、
 * 畳める分岐が行き止まりになっていた。**
 */

/** Windowsの区切り。エスケープを重ねると読みにくいので符号で書く */
const BS = String.fromCharCode(92);

/** gitの出力の形。1件目はツリー、そのあと空欄まで衝突したファイル */
function output(tree: string, conflicts: string[], info = "Auto-merging"): string {
  return [tree, ...conflicts, "", info].join("\0");
}

describe("畳めるかの判定", () => {
  test("衝突が無ければ clean", () => {
    const preview = parseMergeTree({
      code: 0,
      stdout: "8f4160e6151807d171489775f860afd989e47ff5\0",
      stderr: "",
    });

    expect(preview.kind).toBe("clean");
    expect(preview.conflicts).toEqual([]);
    expect(preview.tree).toBe("8f4160e6151807d171489775f860afd989e47ff5");
  });

  test("衝突したファイルを取り出す", () => {
    // 作者の置き場で実際に出た形（config.json 1件）
    const preview = parseMergeTree({
      code: 1,
      stdout: output("42e45f8", ["コールドスリープ/.aiwriter/config.json"]),
      stderr: "",
    });

    expect(preview.kind).toBe("conflicted");
    expect(preview.conflicts).toEqual(["コールドスリープ/.aiwriter/config.json"]);
  });

  test("ファイル名に何が入っていても壊れない", () => {
    // NUL区切りで受けるのは、原稿のファイル名に空白も約物も入るためである
    const names = [
      "短編/第1話　夏の、終わり（改稿）.txt",
      "教科書チート/設定/characters/char_001_三門太志.json",
    ];
    const preview = parseMergeTree({
      code: 1,
      stdout: output("abc1234", names),
      stderr: "",
    });

    expect(preview.conflicts).toEqual(names);
  });

  test("古いGitでは、判定できないと答える", () => {
    // --write-tree は Git 2.38 以降。**動いたふりをしない**
    const preview = parseMergeTree({
      code: 129,
      stdout: "",
      stderr: "error: unknown option `write-tree'",
    });

    expect(preview.kind).toBe("unsupported");
    expect(describeMergePreview(preview)).toContain("2.38");
  });

  test("走らせられなかったときは failed", () => {
    const preview = parseMergeTree({
      code: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    });

    expect(preview.kind).toBe("failed");
    expect(preview.detail).toContain("not a git repository");
  });

  test("結果のツリーを作るだけで、作業ツリーには触らない指定にする", () => {
    // ここが変わると、押す前に見るつもりが畳んでしまう
    expect(mergeTreeArgs("HEAD", "origin/main")).toEqual([
      "merge-tree",
      "--write-tree",
      "--name-only",
      "-z",
      "HEAD",
      "origin/main",
    ]);
  });
});

describe("自動で書かれるファイルの見分け", () => {
  test("執筆量・キャッシュ・作品の設定は畳める", () => {
    expect(isAutoWrittenPath("短編/.aiwriter/stats/gamingpc-16cd.json")).toBe(true);
    expect(isAutoWrittenPath("短編/.aiwriter/cache/abc.json")).toBe(true);
    expect(isAutoWrittenPath("短編/.aiwriter/config.json")).toBe(true);
  });

  test("追記型の記録は畳めない", () => {
    // 片方を残すと、もう片方の環境で書かれた記録が消える（設計書5.6）
    expect(isAutoWrittenPath("短編/.aiwriter/history/edits.jsonl")).toBe(false);
    expect(isAutoWrittenPath("短編/.aiwriter/proposals/p1.jsonl")).toBe(false);
  });

  test("抽出済みの記録は畳めない", () => {
    // 正しくは両方の和集合で、片方を残すと再抽出が走る
    expect(isAutoWrittenPath("短編/.aiwriter/extracted.json")).toBe(false);
  });

  test("承認待ちの提案は畳める（0.45.0）", () => {
    // **AIの提案で、まだ資料になっていない**（設計書5.5.18）。
    // 作者の手は入っていないので、再抽出で同じものが出てくる。
    // ここを作者への問いに数えていたため、同期のたびに
    // 「自分が書いたものではないもの」の解決を求められていた
    expect(
      isAutoWrittenPath("短編/.aiwriter/pending-characters/char_001.json")
    ).toBe(true);
  });

  test("原稿と設定資料は畳めない", () => {
    expect(isAutoWrittenPath("短編/本文/第1話.txt")).toBe(false);
    expect(isAutoWrittenPath("短編/設定/characters/char_001_太志.json")).toBe(false);
  });

  test("設定資料の生成物（_schema と設定資料集の .md）は畳める（0.45.1）", () => {
    // 作者の手元で本物の分岐が起きたとき、20件のうち11件がこれらで、
    // 1件ずつ見比べさせられた（2026-09-11）。次の生成で作り直されるもの
    expect(isAutoWrittenPath("いじめられっ子/設定/_schema/README.md")).toBe(true);
    expect(isAutoWrittenPath("いじめられっ子/設定/_schema/character.schema.json")).toBe(true);
    for (const name of ["abilities", "characters", "locations", "organizations", "world"]) {
      expect(isAutoWrittenPath(`いじめられっ子/設定/${name}.md`)).toBe(true);
    }
  });

  test("あらすじなど、作者が手で直す .md は名指しの5つに入れない", () => {
    expect(isAutoWrittenPath("いじめられっ子/設定/synopsis.md")).toBe(false);
    expect(isAutoWrittenPath("いじめられっ子/設定/plot.md")).toBe(false);
    expect(isAutoWrittenPath("いじめられっ子/設定/synopses.md")).toBe(false);
  });

  test("Windowsの区切りでも同じに見る", () => {
    expect(
      isAutoWrittenPath(`短編${BS}.aiwriter${BS}stats${BS}pc.json`)
    ).toBe(true);
  });
});

describe("自動で畳んでよいか", () => {
  test("衝突が無ければ畳む", () => {
    expect(canFoldAutomatically(parseMergeTree({ code: 0, stdout: "abc\0", stderr: "" })))
      .toBe(true);
  });

  test("自動で書かれるものだけなら畳める", () => {
    const preview = parseMergeTree({
      code: 1,
      stdout: output("abc", ["短編/.aiwriter/stats/pc.json"]),
      stderr: "",
    });

    expect(canFoldAutomatically(preview)).toBe(true);
    expect(describeMergePreview(preview)).toContain("この端末の側を残して");
  });

  test("作者のものが1件でもあれば畳まない", () => {
    // 「原稿以外なら自動で」という例外は作らない。
    // 判定を1回間違えたら原稿が消える（設計書5.5.16）
    const preview = parseMergeTree({
      code: 1,
      stdout: output("abc", ["短編/.aiwriter/stats/pc.json", "短編/本文/第1話.txt"]),
      stderr: "",
    });

    expect(canFoldAutomatically(preview)).toBe(false);
    expect(preview.authored).toEqual(["短編/本文/第1話.txt"]);
    expect(describeMergePreview(preview)).toContain("自動で決められません");
  });

  test("判定できなかったときは畳まない", () => {
    expect(
      canFoldAutomatically(
        parseMergeTree({ code: 129, stdout: "", stderr: "unknown option" })
      )
    ).toBe(false);
  });
});

describe("畳んだあとの検査", () => {
  test("取り込んだファイル以外が変わっていたら見つける", () => {
    // 改行コードの自動変換が効く経路。目では気づけない
    const before = new Map([
      ["短編/本文/第1話.txt", "aaa"],
      ["短編/本文/第2話.txt", "bbb"],
    ]);
    const after = new Map([
      ["短編/本文/第1話.txt", "aaa"],
      ["短編/本文/第2話.txt", "変わってしまった"],
    ]);

    expect(unexpectedChanges(before, after, [])).toEqual(["短編/本文/第2話.txt"]);
  });

  test("取り込んだファイルは変わってよい", () => {
    const before = new Map([["短編/本文/第1話.txt", "aaa"]]);
    const after = new Map([["短編/本文/第1話.txt", "新しい中身"]]);

    expect(unexpectedChanges(before, after, ["短編/本文/第1話.txt"])).toEqual([]);
  });

  test("区切りが違っても同じファイルとして見る", () => {
    const windowsPath = `短編${BS}本文${BS}第1話.txt`;
    const before = new Map([[windowsPath, "aaa"]]);
    const after = new Map([[windowsPath, "新しい中身"]]);

    expect(unexpectedChanges(before, after, ["短編/本文/第1話.txt"])).toEqual([]);
  });

  test("消えたファイルも見つける", () => {
    // 中身が変わるより重い
    const before = new Map([["短編/本文/第1話.txt", "aaa"]]);

    expect(unexpectedChanges(before, new Map(), [])).toEqual(["短編/本文/第1話.txt"]);
  });

  test("競合マーカーを見つける", () => {
    expect(containsConflictMarkers("　灯は歩き出した。")).toBe(false);
    expect(containsConflictMarkers("あ\n<<<<<<< HEAD\nい")).toBe(true);
    expect(containsConflictMarkers("あ\n=======\nい")).toBe(true);
  });

  test("落ちた理由を、両方まとめて出す", () => {
    const result = guardResult(["短編/本文/第1話.txt"], ["短編/本文/第2話.txt"]);

    expect(result.ok).toBe(false);
    expect(describeGuardFailure(result)).toContain("競合マーカー");
    expect(describeGuardFailure(result)).toContain("変わっていました");
  });

  test("何も落ちなければ通す", () => {
    expect(guardResult([], []).ok).toBe(true);
  });
});
