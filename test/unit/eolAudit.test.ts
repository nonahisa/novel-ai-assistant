import { describe, expect, test } from "vitest";
import {
  auditEol,
  describeEolAudit,
  describeEolMismatch,
  detectEol,
  planEolUnify,
  planFileEolWrite,
  type EolAuditEntry,
} from "../../src/core/eolAudit";

/**
 * 改行コードの監査（設計書5.4.2）。
 *
 * 作者の依頼（2026-09-12）：「改行コードが違う場合、他のツールで不具合が
 * 起こる可能性を指摘しつつ、変換を促したほうが良いのではないでしょうか」。
 *
 * **保持が原則なのは変わらない。** ここが決めるのは「違うものがどれか」
 * だけで、揃えるのは作者が押したときだけである。
 */
const lf = (filePath: string): EolAuditEntry => ({
  filePath,
  eol: "\n",
  hasMixedEol: false,
});
const crlf = (filePath: string): EolAuditEntry => ({
  filePath,
  eol: "\r\n",
  hasMixedEol: false,
});
const cr = (filePath: string): EolAuditEntry => ({
  filePath,
  eol: "\r",
  hasMixedEol: false,
});
const mixed = (filePath: string): EolAuditEntry => ({
  filePath,
  eol: "\r\n",
  hasMixedEol: true,
});
const unreadable = (filePath: string): EolAuditEntry => ({
  filePath,
  eol: null,
  hasMixedEol: false,
});

describe("多数派の決め方", () => {
  test("LFが多ければLF", () => {
    const audit = auditEol([lf("1.txt"), lf("2.txt"), crlf("3.txt")]);

    expect(audit.majority).toBe("\n");
    expect(audit.differing).toEqual(["3.txt"]);
  });

  test("CRLFが多ければCRLF", () => {
    const audit = auditEol([crlf("1.txt"), crlf("2.txt"), lf("3.txt")]);

    expect(audit.majority).toBe("\r\n");
    expect(audit.differing).toEqual(["3.txt"]);
  });

  test("同数ならLF", () => {
    // GitHub・他のツールとの相性でLFを既定にする。
    // 迷ったときに作者へ訊き直しても、判断の材料が増えない
    const audit = auditEol([lf("1.txt"), crlf("2.txt")]);

    expect(audit.majority).toBe("\n");
    expect(audit.differing).toEqual(["2.txt"]);
  });

  test("全部読めなければ null", () => {
    // **1件も材料が無いのに「LFが多数派」と言い切らない**
    const audit = auditEol([unreadable("1.txt"), unreadable("2.txt")]);

    expect(audit.majority).toBeNull();
    expect(audit.differing).toEqual([]);
    expect(audit.counts.unreadable).toBe(2);
  });

  test("1件も無ければ null", () => {
    expect(auditEol([]).majority).toBeNull();
  });

  test("混在ばかりの作品でも、多数派はLFにする", () => {
    // 混在はLF/CRLFのどちらにも数えない。数えると、混ざった
    // ファイルが多数派を決めてしまう
    const audit = auditEol([mixed("1.txt"), mixed("2.txt")]);

    expect(audit.majority).toBe("\n");
    expect(audit.counts.lf).toBe(0);
    expect(audit.counts.mixed).toBe(2);
  });
});

describe("多数派と違うもの", () => {
  test("混在しているファイルは、多数派と同じ改行でも「違う」に入れる", () => {
    const audit = auditEol([lf("1.txt"), lf("2.txt"), mixed("3.txt")]);

    expect(audit.majority).toBe("\n");
    expect(audit.differing).toEqual(["3.txt"]);
  });

  test("CRだけの古い形も「違う」に入れる", () => {
    const audit = auditEol([lf("1.txt"), lf("2.txt"), cr("3.txt")]);

    expect(audit.differing).toEqual(["3.txt"]);
    expect(audit.counts.cr).toBe(1);
  });

  test("読めなかったファイルは「違う」に入れない", () => {
    // 中身を知らないまま「違う」と言うと、書き換える対象に入ってしまう
    const audit = auditEol([lf("1.txt"), unreadable("2.txt")]);

    expect(audit.differing).toEqual([]);
  });
});

describe("揃える計画", () => {
  const files = [lf("1.txt"), lf("2.txt"), crlf("3.txt"), mixed("4.txt")];

  test("LFへ揃えるなら、CRLFと混在が対象", () => {
    expect(planEolUnify(files, "\n")).toEqual(["3.txt", "4.txt"]);
  });

  test("少数派のCRLFへ揃える道も残す", () => {
    // 外のツールがCRLFしか受け付けないことがある。こちらから決めない
    expect(planEolUnify(files, "\r\n")).toEqual(["1.txt", "2.txt", "4.txt"]);
  });

  test("読めなかったファイルは対象にしない", () => {
    expect(planEolUnify([unreadable("1.txt")], "\n")).toEqual([]);
  });
});

describe("作者への伝え方", () => {
  test("数を並べる", () => {
    const audit = auditEol([
      ...Array.from({ length: 18 }, (_, i) => lf(`${i}.txt`)),
      crlf("a.txt"),
      crlf("b.txt"),
      mixed("c.txt"),
    ]);

    expect(describeEolAudit(audit)).toBe("LF が18件、CRLF が2件、混在が1件。");
  });

  test("0件のものは並べない", () => {
    expect(describeEolAudit(auditEol([lf("1.txt")]))).toBe("LF が1件。");
  });

  test("読めなかったぶんを黙らせない", () => {
    const audit = auditEol([lf("1.txt"), unreadable("2.txt")]);

    expect(describeEolAudit(audit)).toContain("読めなかったファイルが1件");
  });

  test("数えられる本文が無ければ、そう言う", () => {
    expect(describeEolAudit(auditEol([]))).toContain("ありませんでした");
  });
});

describe("原稿エディタで開いたときの案内", () => {
  test("自分の改行と、ほかの件数を言う", () => {
    const message = describeEolMismatch({
      eol: "\r\n",
      hasMixedEol: false,
      majority: "\n",
      majorityCount: 18,
    });

    expect(message).toContain("CRLF");
    expect(message).toContain("他の18件（LF）");
    // **なぜ困るのかまで言う。** 「違います」だけでは動けない
    expect(message).toContain("他のツール");
  });

  test("混在しているときは、混ざっていることを言う", () => {
    const message = describeEolMismatch({
      eol: "\r\n",
      hasMixedEol: true,
      majority: "\n",
      majorityCount: 3,
    });

    expect(message).toContain("混ざっています");
  });

  test("CRだけの古い形も名前で呼ぶ", () => {
    const message = describeEolMismatch({
      eol: "\r",
      hasMixedEol: false,
      majority: "\n",
      majorityCount: 2,
    });

    expect(message).toContain("CR で");
  });
});

describe("1ファイルの書き換え計画", () => {
  const content = (
    overrides: Partial<{
      text: string;
      encoding: "utf8" | "utf8-bom" | "shift_jis";
      eol: "\n" | "\r\n" | "\r";
      hasTrailingNewline: boolean;
      hash: string;
      hasConflictMarkers: boolean;
      hasMixedEol: boolean;
    }> = {}
  ) => ({
    text: "灯は歩いた。\n澪は笑った。\n",
    encoding: "utf8" as "utf8" | "utf8-bom" | "shift_jis",
    eol: "\r\n" as "\n" | "\r\n" | "\r",
    hasTrailingNewline: true,
    hash: "abc",
    hasConflictMarkers: false,
    hasMixedEol: false,
    ...overrides,
  });

  test("本文は1文字も変えない", () => {
    const source = content();
    const plan = planFileEolWrite(source, "\n");

    expect(plan.kind).toBe("write");
    if (plan.kind !== "write") return;
    // **読んだままの本文をそのまま渡す。** 組み立て直さない
    expect(plan.text).toBe(source.text);
    expect(plan.expectedHash).toBe(source.hash);
  });

  test("Shift_JISは保たれる", () => {
    const plan = planFileEolWrite(content({ encoding: "shift_jis" }), "\n");

    expect(plan.kind === "write" && plan.format.encoding).toBe("shift_jis");
  });

  test("BOM付きは保たれる", () => {
    const plan = planFileEolWrite(content({ encoding: "utf8-bom" }), "\n");

    expect(plan.kind === "write" && plan.format.encoding).toBe("utf8-bom");
  });

  test("末尾改行の有無は保たれる", () => {
    const without = planFileEolWrite(
      content({ hasTrailingNewline: false }),
      "\n"
    );
    const with_ = planFileEolWrite(content({ hasTrailingNewline: true }), "\n");

    expect(without.kind === "write" && without.format.hasTrailingNewline).toBe(
      false
    );
    expect(with_.kind === "write" && with_.format.hasTrailingNewline).toBe(true);
  });

  test("変えるのは改行コードだけ", () => {
    const plan = planFileEolWrite(content(), "\n");

    expect(plan.kind === "write" && plan.format.eol).toBe("\n");
  });

  test("競合の印が残っていれば飛ばす", () => {
    // 両方の版が混ざったまま書き直すと、どちらが本物か分からなくなる
    const plan = planFileEolWrite(content({ hasConflictMarkers: true }), "\n");

    expect(plan).toEqual({ kind: "skip", reason: "conflict_markers" });
  });

  test("もう揃っていれば書かない", () => {
    const plan = planFileEolWrite(content({ eol: "\n" }), "\n");

    expect(plan).toEqual({ kind: "skip", reason: "already" });
  });

  test("改行が同じでも、混ざっていれば書き直す", () => {
    const plan = planFileEolWrite(
      content({ eol: "\n", hasMixedEol: true }),
      "\n"
    );

    expect(plan.kind).toBe("write");
  });
});

describe("改行コードの見分け", () => {
  test("CRLFだけならCRLF・混在なし", () => {
    expect(detectEol("灯\r\n澪\r\n")).toEqual({
      eol: "\r\n",
      hasMixedEol: false,
    });
  });

  test("LFだけならLF・混在なし", () => {
    expect(detectEol("灯\n澪\n")).toEqual({ eol: "\n", hasMixedEol: false });
  });

  test("CRLFと裸のLFが混ざっていれば混在", () => {
    expect(detectEol("灯\r\n澪\n")).toEqual({ eol: "\r\n", hasMixedEol: true });
  });

  test("CRLFと裸のCRが混ざっていれば混在", () => {
    expect(detectEol("灯\r\n澪\r澪")).toEqual({
      eol: "\r\n",
      hasMixedEol: true,
    });
  });

  test("先頭が裸のLFでも見つける", () => {
    expect(detectEol("\n灯\r\n").hasMixedEol).toBe(true);
  });

  test("改行が無ければLF・混在なし", () => {
    expect(detectEol("灯")).toEqual({ eol: "\n", hasMixedEol: false });
  });
});
