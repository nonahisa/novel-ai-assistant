import { describe, expect, test } from "vitest";
import { buildExportDocument } from "../../../src/core/settingsExportProfiles";
import {
  buildExportCsvFiles,
  CSV_BOM,
  csvCell,
  mergeColumns,
} from "../../../src/core/settingsExportCsv";
import {
  FIXTURE_OPTIONS,
  fixtureData,
} from "../support/settingsExportFixture";

/**
 * 設定資料の CSV 書き出し（F6、設計書6.75.1）。
 *
 * Excel で開いて崩れないこと（BOM・逃がし・CRLF）と、種別ごとに1ファイルに
 * なることを確かめる。伏せる名前が漏れないことは
 * `cross/settingsExportFormats.test.ts` が全形式まとめて見ている。
 */

/** RFC 4180 の読み方で、CSV を行と列へ戻す（試験だけで使う素朴な読み手） */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
    } else {
      cell += ch;
    }
  }
  return rows;
}

function files(audience: "editorial" | "illustration" | "introduction" = "editorial") {
  return buildExportCsvFiles(
    buildExportDocument(audience, fixtureData(), { ...FIXTURE_OPTIONS, chapter: null })
  );
}

describe("セルの逃がし", () => {
  test("カンマ・引用符・改行を含むセルは引用符で囲み、引用符は重ねる", () => {
    expect(csvCell("ふつう")).toBe("ふつう");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('彼は"灯"と')).toBe('"彼は""灯""と"');
    expect(csvCell("一行目\n二行目")).toBe('"一行目\n二行目"');
    expect(csvCell("改行\r\nCRLF")).toBe('"改行\r\nCRLF"');
  });
});

describe("式の注入を防ぐ", () => {
  test("= + - @ と先頭のタブ・CR で始まる値は、頭に ' を付ける", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("-3")).toBe("'-3");
    expect(csvCell("@me")).toBe("'@me");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("\t=1")).toBe("'\t=1");
    // CR は引用符も要る
    expect(csvCell("\r=1")).toBe('"\'\r=1"');
  });

  test("ふつうの値は変わらない", () => {
    expect(csvCell("月島灯")).toBe("月島灯");
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("第3話-前編")).toBe("第3話-前編");
    expect(csvCell("")).toBe("");
  });
});

describe("Excel で文字化けしない形", () => {
  test("先頭に BOM、行の区切りは CRLF", () => {
    for (const file of files()) {
      expect(file.content.startsWith(CSV_BOM)).toBe(true);
      expect(file.content.charCodeAt(0)).toBe(0xfeff);
      expect(file.content.endsWith("\r\n")).toBe(true);
    }
  });

  test("読み戻すと、作者の値が1字も変わらずに戻る", () => {
    const characters = files().find((file) => file.kind === "characters")!;
    const rows = parseCsv(characters.content.slice(1));
    const header = rows[0];
    const main = rows.find((row) => row[0] === "月島灯")!;
    const cell = (column: string) => main[header.indexOf(column)];

    expect(cell("補足")).toBe('資料向けの補足, "引用"あり');
    expect(cell("AIの掘り下げ")).toBe(
      "【内面 / gemma】母への負い目が行動の軸になっている。\n二行目 <b>&</b>"
    );
    // 列の数がどの行もそろっている（逃がしの漏れで列がずれていない）
    for (const row of rows) expect(row.length).toBe(header.length);
  });
});

describe("種別ごとに1ファイル", () => {
  test("編集部向けは5種類", () => {
    expect(files().map((file) => file.kind)).toEqual([
      "characters",
      "locations",
      "abilities",
      "organizations",
      "world",
    ]);
  });

  test("その型が出さない種別は、ファイルを作らない", () => {
    expect(files("illustration").map((file) => file.kind)).toEqual([
      "characters",
      "locations",
    ]);
    expect(files("introduction").map((file) => file.kind)).toEqual([
      "characters",
      "world",
    ]);
  });

  test("主な列が並び、相手ごとの呼び方は1列にまとまる", () => {
    const characters = files().find((file) => file.kind === "characters")!;
    const header = parseCsv(characters.content.slice(1))[0];
    for (const column of ["名前", "読み", "所属", "紹介文", "別名", "登場話"]) {
      expect(header, column).toContain(column);
    }
    expect(header).toContain("相手ごとの呼び方");
    expect(header.some((column) => column.endsWith("への呼称"))).toBe(false);
  });

  test("まとめの受け皿（所属の記載なし）は値として書かない", () => {
    const locations = files().find((file) => file.kind === "locations")!;
    const rows = parseCsv(locations.content.slice(1));
    const header = rows[0];
    const harbor = rows.find((row) => row[0] === "港")!;
    expect(harbor[header.indexOf("地域")]).toBe("");
    expect(locations.content).not.toContain("地域未設定");
  });

  test("モブは区分の列で分ける", () => {
    const characters = files().find((file) => file.kind === "characters")!;
    const rows = parseCsv(characters.content.slice(1));
    const header = rows[0];
    const mob = rows.find((row) => row[0] === "通行人たち")!;
    expect(mob[header.indexOf("区分")]).toBe("モブ・集団");
    expect(mob[header.indexOf("登場話")]).toBe("第1、2話");
  });

  test("イラスト発注向けは、その型の項目だけが列になる", () => {
    const characters = files("illustration").find(
      (file) => file.kind === "characters"
    )!;
    const header = parseCsv(characters.content.slice(1))[0];
    expect(header).not.toContain("紹介文");
    expect(header).not.toContain("性格");
    expect(header).not.toContain("補足");
    expect(header).toContain("服装");
  });
});

describe("列の並び", () => {
  test("後から出た列は、直前の列のすぐ後ろへ入る", () => {
    expect(
      mergeColumns([
        ["別名", "登場話"],
        ["別名", "性別", "登場話", "補足"],
      ])
    ).toEqual(["別名", "性別", "登場話", "補足"]);
  });
});
