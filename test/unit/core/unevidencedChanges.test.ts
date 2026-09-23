import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { mergeExtractedCharacters } from "../../src/core/characterMerge";
import {
  changeMovesBody,
  confirmHeldChanges,
  describeHeldChanges,
  heldChangesOfField,
} from "../../src/core/recordChanges";
import { describeExtractionLog } from "../../src/core/runLog";
import { emptyCharacter, parseCharacter } from "../../src/models/character";
import {
  mergeConflicts,
  type RecordChange,
} from "../../src/models/jsonValidation";

/**
 * 根拠（本文の引用）の無い「変化」は、台帳の本体を動かさない
 * （作者の裁定、2026-09-23。残課題 A1）。
 *
 * ## 何が起きていたか
 *
 * 実データで、設定資料の抽出の「変化」214件のうち、根拠のあるものは19件
 * （9%）だった。変化は話数が違えば作中で変わったと読み、**いちばん後ろの話の
 * 値を本体へ入れる**（設計書6.18）。根拠が無いと、作者は取り違え（話し手の
 * 読み違いなど）を見抜けないまま、本体の値だけが入れ替わる。
 *
 * ## 裁定
 *
 * - 根拠の無い変化は**「要確認」として残し、本体の値は変えない**
 * - 根拠のある変化だけが、本体の値を動かす
 * - 値は消さない。作者が認めれば本体へ入る
 * - 抽出の完了報告に「根拠が無いので本体を変えなかった変化 N件」を出す
 */

/** 第1話で「黒髪」を根拠つきで読んだ人物（変化の履歴に話数が残る） */
function withBlackHair() {
  return mergeExtractedCharacters(
    [],
    [
      {
        data: { name: "灯", appearance: "黒髪", evidence: "灯の黒髪が揺れた" },
        chapters: [1],
      },
    ]
  ).characters;
}

describe("抽出のマージ：根拠の無い変化は本体を動かさない", () => {
  test("根拠のある変化は、これまでどおり本体を後ろの話の値へ動かす", () => {
    const result = mergeExtractedCharacters(withBlackHair(), [
      {
        data: { name: "灯", appearance: "銀髪", evidence: "銀の髪をかき上げた" },
        chapters: [7],
      },
    ]);

    expect(result.characters[0].appearance).toBe("銀髪");
    expect(result.heldChanges).toEqual([]);
  });

  test("根拠の無い変化は記録するが、本体は変えない（要確認として報告）", () => {
    const result = mergeExtractedCharacters(withBlackHair(), [
      { data: { name: "灯", appearance: "銀髪" }, chapters: [7] },
    ]);

    const character = result.characters[0];
    // 本体は第1話の黒髪のまま
    expect(character.appearance).toBe("黒髪");
    // 値は消えない。変化として残る
    expect(
      character.changes.map((change) => [change.value, change.chapters])
    ).toEqual([
      ["黒髪", [1]],
      ["銀髪", [7]],
    ]);
    // 要確認として数える
    expect(result.heldChanges).toEqual([
      { characterName: "灯", field: "appearance", value: "銀髪" },
    ]);
    expect(
      heldChangesOfField(character.changes, "appearance", character.appearance)
        .map((change) => change.value)
    ).toEqual(["銀髪"]);
  });

  test("根拠の無い値が既に本体にあっても、根拠のある古い値へ巻き戻さない", () => {
    // 以前の版で、根拠の無い「銀髪（第7話）」が本体へ入っていた
    const [character] = withBlackHair();
    character.appearance = "銀髪";
    character.changes.push({
      field: "appearance",
      value: "銀髪",
      chapters: [7],
      timepointId: null,
      note: null,
      evidence: null,
      source: "extracted",
    });

    const result = mergeExtractedCharacters([character], [
      { data: { name: "灯", appearance: "銀髪" }, chapters: [8] },
    ]);

    // 本体を勝手に変えないのは、戻す向きでも同じ
    expect(result.characters[0].appearance).toBe("銀髪");
  });

  test("根拠の無かった変化も、同じ値を根拠つきで読み直せば本体へ入る", () => {
    const first = mergeExtractedCharacters(withBlackHair(), [
      { data: { name: "灯", appearance: "銀髪" }, chapters: [7] },
    ]);
    const second = mergeExtractedCharacters(first.characters, [
      {
        data: { name: "灯", appearance: "銀髪", evidence: "銀の髪をかき上げた" },
        chapters: [9],
      },
    ]);

    expect(second.characters[0].appearance).toBe("銀髪");
    expect(second.heldChanges).toEqual([]);
    const silver = second.characters[0].changes.find(
      (change) => change.value === "銀髪"
    );
    expect(silver?.evidence).toBe("銀の髪をかき上げた");
  });

  test("食い違いを畳むとき、根拠のある値なら本体へ入る（根拠は食い違いの記録を通って運ばれる）", () => {
    // 本体の「黒髪」は話数の記録が無い（履歴の無い古いデータ）
    const existing = emptyCharacter("char_001", "灯");
    existing.appearance = "黒髪";

    const first = mergeExtractedCharacters([existing], [
      {
        data: { name: "灯", appearance: "銀髪", evidence: "銀の髪をかき上げた" },
        chapters: [7],
      },
    ]);
    const second = mergeExtractedCharacters(first.characters, [
      {
        data: { name: "灯", appearance: "赤髪", evidence: "赤く染めた髪" },
        chapters: [12],
      },
    ]);

    expect(second.characters[0].conflicts).toEqual([]);
    expect(second.characters[0].appearance).toBe("赤髪");
    expect(second.heldChanges).toEqual([]);
  });

  test("食い違いを畳むとき、根拠の無い値なら本体は変えず要確認にする", () => {
    const existing = emptyCharacter("char_001", "灯");
    existing.appearance = "黒髪";

    const first = mergeExtractedCharacters([existing], [
      { data: { name: "灯", appearance: "銀髪" }, chapters: [7] },
    ]);
    const second = mergeExtractedCharacters(first.characters, [
      { data: { name: "灯", appearance: "赤髪" }, chapters: [12] },
    ]);

    const character = second.characters[0];
    // 畳むこと自体（食い違いを変化へ移す）はこれまでどおり
    expect(character.conflicts).toEqual([]);
    expect(second.folded).toEqual([{ characterName: "灯", field: "appearance" }]);
    // 本体は変えない
    expect(character.appearance).toBe("黒髪");
    expect(second.heldChanges).toEqual([
      { characterName: "灯", field: "appearance", value: "銀髪" },
      { characterName: "灯", field: "appearance", value: "赤髪" },
    ]);
  });

  test("作者が確定させた人物（autoGenerated: false）は、これまでどおり触らない", () => {
    const [character] = withBlackHair();
    character.autoGenerated = false;
    const result = mergeExtractedCharacters([character], [
      { data: { name: "灯", appearance: "銀髪" }, chapters: [7] },
    ]);
    expect(result.characters[0].appearance).toBe("黒髪");
    expect(result.characters[0].changes).toEqual(character.changes);
    expect(result.heldChanges).toEqual([]);
  });
});

describe("本体を動かしてよい変化", () => {
  const base: RecordChange = {
    field: "appearance",
    value: "銀髪",
    chapters: [7],
    timepointId: null,
    note: null,
    evidence: null,
    source: "extracted",
  };

  test("根拠がある／作者が書いた／作者が認めた、のどれか", () => {
    expect(changeMovesBody(base)).toBe(false);
    expect(changeMovesBody({ ...base, evidence: "   " })).toBe(false);
    expect(changeMovesBody({ ...base, evidence: "銀の髪" })).toBe(true);
    expect(changeMovesBody({ ...base, source: "author" })).toBe(true);
    expect(changeMovesBody({ ...base, confirmed: true })).toBe(true);
  });
});

describe("要確認の変化を、作者が認める", () => {
  test("認めると本体へ入り、以後は要確認に出ない", () => {
    const merged = mergeExtractedCharacters(withBlackHair(), [
      { data: { name: "灯", appearance: "銀髪" }, chapters: [7] },
    ]);
    const outcome = confirmHeldChanges(merged.characters[0], "appearance");

    expect(outcome.confirmed).toBe(1);
    expect(outcome.character.appearance).toBe("銀髪");
    expect(
      heldChangesOfField(
        outcome.character.changes,
        "appearance",
        outcome.character.appearance
      )
    ).toEqual([]);
    // 元のレコードは書き換えない
    expect(merged.characters[0].appearance).toBe("黒髪");
  });

  test("要確認が無ければ何もしない", () => {
    const [character] = withBlackHair();
    const outcome = confirmHeldChanges(character, "appearance");
    expect(outcome.confirmed).toBe(0);
    expect(outcome.character).toBe(character);
  });
});

describe("抽出の完了報告", () => {
  test("根拠が無いので本体を変えなかった件数を出す（無ければ何も足さない）", () => {
    expect(describeHeldChanges(0)).toBe("");
    const line = describeHeldChanges(3);
    expect(line).toContain("根拠が無いので本体を変えなかった変化 3件");
    // どこで確かめられるかを添える
    expect(line).toContain("設定資料パネル");
  });

  test("記録の1行にも件数を残す（0件なら書かない）", () => {
    const counts = {
      added: 0,
      updated: 2,
      rejected: 0,
      conflicts: 0,
      folded: 1,
      failedChunks: 0,
      saved: 0,
      pendingUpdates: 2,
      cacheWarnings: 0,
    };
    expect(describeExtractionLog({ ...counts, heldChanges: 4 })).toContain(
      "根拠が無いので本体を変えなかった変化 4件"
    );
    expect(describeExtractionLog({ ...counts, heldChanges: 0 })).not.toContain(
      "根拠が無い"
    );
  });

  test("抽出の報告が件数を受け取っている（書き方で確かめる）", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/features/extractCharacters.ts"),
      "utf8"
    );
    expect(source).toContain("heldChanges: merged?.heldChanges.length ?? 0");
    expect(source).toContain("describeHeldChanges(counts.heldChanges)");
    expect(source).toContain("heldChanges: baseCounts.heldChanges");
  });
});

describe("設定資料パネル", () => {
  const source = readFileSync(
    resolve(__dirname, "../../src/features/settingsPanel.ts"),
    "utf8"
  );

  test("要確認の行と「変化として認める」操作を出す", () => {
    expect(source).toContain('kind: "confirmChanges" as const');
    expect(source).toContain('case "confirmChanges":');
    expect(source).toContain("confirmHeldChanges(character, field)");
  });

  test("画面から昇格させたときは、作者が認めた変化として記録する", () => {
    expect(source).toMatch(
      /promoteConflictToChanges\(character, field, \{\s*confirmedByAuthor: true,?\s*\}\)/
    );
  });
});

describe("保存の形", () => {
  test("作者が認めた印と、食い違いの値ごとの根拠は、読み直しても落ちない", () => {
    const character = emptyCharacter("char_001", "灯");
    const raw = JSON.parse(
      JSON.stringify({
        ...character,
        changes: [
          {
            field: "appearance",
            value: "銀髪",
            chapters: [7],
            timepointId: null,
            note: null,
            evidence: null,
            source: "extracted",
            confirmed: true,
          },
        ],
        conflicts: [
          {
            field: "role",
            values: ["騎士", "魔術師"],
            chapters: [],
            note: null,
            observations: [
              { value: "騎士", chapters: [1], evidence: "騎士の礼をとった" },
              { value: "魔術師", chapters: [2] },
            ],
          },
        ],
      })
    );
    const parsed = parseCharacter(raw);
    expect(parsed.changes[0].confirmed).toBe(true);
    expect(parsed.conflicts[0].observations?.[0].evidence).toBe(
      "騎士の礼をとった"
    );
  });

  test("食い違いをまとめても、値ごとの根拠は残る", () => {
    const merged = mergeConflicts(
      [
        {
          field: "role",
          values: ["騎士"],
          chapters: [],
          note: null,
          observations: [{ value: "騎士", chapters: [1], evidence: "騎士の礼" }],
        },
      ],
      [
        {
          field: "role",
          values: ["騎士", "魔術師"],
          chapters: [],
          note: null,
          observations: [
            { value: "騎士", chapters: [3] },
            { value: "魔術師", chapters: [2], evidence: "杖を掲げた" },
          ],
        },
      ]
    );
    expect(merged[0].observations).toEqual([
      { value: "騎士", chapters: [1, 3], evidence: "騎士の礼" },
      { value: "魔術師", chapters: [2], evidence: "杖を掲げた" },
    ]);
  });
});
