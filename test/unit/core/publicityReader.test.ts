import { describe, expect, test } from "vitest";
import {
  READER_TYPES,
  readerTypeCacheMark,
  resolveReaderType,
  type ReaderTypeId,
} from "../../../src/core/readerTarget";
import {
  AUTHOR_BLOCK_BEGIN,
  AUTHOR_BLOCK_END,
  TARGET_SHEET_MARKER,
} from "../../../src/core/targetSheetDoc";
import {
  findReaderTypeLabels,
  publicityReaderFromSheet,
  publicityReaderMark,
  publicityReaderNotice,
  resolvePublicityReader,
} from "../../../src/core/publicityReader";
import type { ReaderProfile } from "../../../src/models/readerProfile";

/**
 * 紹介文・キャッチコピー・告知文へ添える「狙いの読者」の材料（設計書6.6.5・6.41.2）。
 *
 * 作者の問い（2026-09-23）「キャッチコピーや作品紹介文は、読者層を
 * 反映させているでしょうか？」「告知文もですね」への答え。
 *
 * **材料の優先順位**：ターゲット読者の「狙い」→ 読者像（書き方の判断・
 * 本文の実像。サブタイトルと同じ出どころ）→ 無し（添えない）。
 */

const DECLARED: ReaderProfile = {
  schemaVersion: "1",
  declared: {
    scores: { familiarity: 6, posture: 1, craving: 1 },
    answers: [],
    updatedAt: "2026-09-20T00:00:00.000Z",
  },
};
const DECLARED_TYPE = resolveReaderType(DECLARED.declared!.scores);

const ACTUAL_ONLY: ReaderProfile = {
  schemaVersion: "1",
  actual: {
    scores: { familiarity: 1, posture: 6, craving: 6 },
    evidence: [],
    basis: "第1〜3話",
    model: "gemma4:e4b",
    updatedAt: "2026-09-20T00:00:00.000Z",
  },
};

function sheetWith(block: string): string {
  return [
    "# ターゲットシート",
    "",
    `<!-- ${TARGET_SHEET_MARKER} -->`,
    AUTHOR_BLOCK_BEGIN,
    block,
    AUTHOR_BLOCK_END,
    "",
  ].join("\n");
}

describe("材料の優先順位", () => {
  test("狙いがあれば狙い（理由も運ぶ）。読者像があっても狙いが勝つ", () => {
    const reader = resolvePublicityReader({
      authorBlock: "狙い：考察層、没入層\n理由：伏線を拾ってくれる人に読んでほしい",
      profile: DECLARED,
    });

    expect(reader).toEqual({
      source: "aim",
      types: ["lore_deep", "deep_pure"],
      reason: "伏線を拾ってくれる人に読んでほしい",
    });
  });

  test("狙いが無ければ読者像（書き方の判断を先に見る）", () => {
    const reader = resolvePublicityReader({
      authorBlock: "狙い：\n\n理由：\n",
      profile: DECLARED,
    });

    expect(reader?.source).toBe("declared");
    expect(reader?.types).toEqual([DECLARED_TYPE]);
  });

  test("書き方の判断が無ければ本文の実像", () => {
    const reader = resolvePublicityReader({ profile: ACTUAL_ONLY });

    expect(reader?.source).toBe("actual");
    expect(reader?.types).toEqual([resolveReaderType(ACTUAL_ONLY.actual!.scores)]);
  });

  test("どちらも無ければ undefined（未診断で既定を押し付けない）", () => {
    expect(resolvePublicityReader({})).toBeUndefined();
    expect(
      resolvePublicityReader({
        authorBlock: "狙い：\n理由：",
        profile: { schemaVersion: "1" },
      })
    ).toBeUndefined();
  });

  test("狙いの名前が読めなければ、狙い無しとして読者像へ進む（推測で型を当てない）", () => {
    const reader = resolvePublicityReader({
      authorBlock: "狙い：なんとなく広く\n理由：",
      profile: DECLARED,
    });

    expect(reader?.source).toBe("declared");
  });
});

describe("シートの文面から読む（MCP の道）", () => {
  test("作者の欄の狙いを読む", () => {
    const reader = publicityReaderFromSheet(
      sheetWith("狙い：すきま層\n理由：通勤中に読める話にしたい"),
      undefined
    );

    expect(reader).toEqual({
      source: "aim",
      types: ["light"],
      reason: "通勤中に読める話にしたい",
    });
  });

  test("印の無い（作者が自分で置いた）同名のファイルからは狙いを読まない", () => {
    // 製品の `readTargetSheetState` と同じ扱い（作者の欄が無い紙＝狙い無し）
    const reader = publicityReaderFromSheet(
      "狙い：考察層\n理由：自分のメモ",
      DECLARED
    );

    expect(reader?.source).toBe("declared");
  });

  test("シートが無ければ読者像だけで決める", () => {
    expect(publicityReaderFromSheet(undefined, undefined)).toBeUndefined();
    expect(publicityReaderFromSheet(undefined, DECLARED)?.source).toBe(
      "declared"
    );
  });
});

describe("キャッシュの鍵に混ぜる印", () => {
  test("無ければ none（空文字にしない）", () => {
    expect(publicityReaderMark(undefined)).toBe("none");
  });

  test("読者像のときは、サブタイトルと同じ印（写しを作らない）", () => {
    const reader = resolvePublicityReader({ profile: DECLARED });
    expect(publicityReaderMark(reader)).toBe(readerTypeCacheMark(DECLARED));
  });

  test("狙いの層を変えたら印が変わる", () => {
    const a = resolvePublicityReader({ authorBlock: "狙い：考察層" });
    const b = resolvePublicityReader({ authorBlock: "狙い：没入層" });
    const ab = resolvePublicityReader({ authorBlock: "狙い：考察層、没入層" });

    expect(publicityReaderMark(a)).not.toBe(publicityReaderMark(b));
    expect(publicityReaderMark(a)).not.toBe(publicityReaderMark(ab));
    // 狙いと読者像が同じ型でも、プロンプトの文面は違うので印も分ける
    expect(publicityReaderMark(a)).not.toBe("lore_deep");
  });

  test("理由を書き換えても印が変わる（理由はそのままプロンプトへ入る）", () => {
    const a = resolvePublicityReader({ authorBlock: "狙い：考察層\n理由：A" });
    const b = resolvePublicityReader({ authorBlock: "狙い：考察層\n理由：B" });

    expect(publicityReaderMark(a)).not.toBe(publicityReaderMark(b));
  });

  test("印に区切り（|）を含めない（版の文字列の中で区切りが潰れる）", () => {
    const reader = resolvePublicityReader({
      authorBlock: "狙い：考察層、没入層\n理由：a|b",
    });
    expect(publicityReaderMark(reader)).not.toContain("|");
  });
});

describe("画面に添える1行", () => {
  test("狙いなら層の名前を並べる", () => {
    const reader = resolvePublicityReader({ authorBlock: "狙い：考察層、没入層" });
    expect(publicityReaderNotice(reader)).toBe(
      "狙いの読者（考察層・没入層）に向けて書きました。"
    );
  });

  test("読者像なら、どこから来た層かを添えて、狙いを選べることを案内する", () => {
    const notice = publicityReaderNotice(
      resolvePublicityReader({ profile: DECLARED })
    );
    expect(notice).toContain(READER_TYPES[DECLARED_TYPE].label);
    expect(notice).toContain("書き方の判断");
    expect(notice).toContain("狙い");
  });

  test("無ければ「ターゲット読者」を案内する", () => {
    expect(publicityReaderNotice(undefined)).toContain("「ターゲット読者」");
    expect(publicityReaderNotice(undefined)).toContain("その層に向けて書けます");
  });

  test("画面の文言に強調（**）を入れない", () => {
    for (const reader of [
      undefined,
      resolvePublicityReader({ authorBlock: "狙い：考察層" }),
      resolvePublicityReader({ profile: ACTUAL_ONLY }),
    ]) {
      expect(publicityReaderNotice(reader)).not.toContain("**");
    }
  });
});

describe("層の名前が出力に出ていないかを見る", () => {
  test("11層のどの名前でも見つける", () => {
    for (const id of Object.keys(READER_TYPES) as ReaderTypeId[]) {
      const label = READER_TYPES[id].label;
      expect(findReaderTypeLabels(`この物語は${label}に贈る物語です。`)).toEqual([
        label,
      ]);
    }
  });

  test("出ていなければ空（誤検出しない）", () => {
    expect(
      findReaderTypeLabels(
        "港町に流れ着いた少女は、錆びた灯台の鍵を拾う。読者を選ぶ物語ではない。"
      )
    ).toEqual([]);
  });
});
