import { describe, expect, test } from "vitest";
import { findNarratorMoves, narratorMoveKey } from "../../../src/core/narratorMoves";
import {
  MOVE_DESTINATION_KEY_PREFIX,
  MOVE_REMOVE_ONLY,
  assembleNarratorMoveReview,
  buildPendingNarratorMovePayload,
  describeNarratorMoveReviewItem,
  destinationFromKeys,
  narratorMoveValueForLog,
  planNarratorMoveStaging,
  readPendingNarratorMoveFile,
} from "../../../src/core/pendingNarratorMoves";
import { describeNarratorMoveLog } from "../../../src/core/recordUpdateLog";
import type { WorkNarratorContext } from "../../../src/core/sceneNarrators";
import { emptyCharacter, type Character } from "../../../src/models/character";
import type { RecordChange } from "../../../src/models/jsonValidation";

/**
 * 語り手の取り違えの移す案を、提案パネルの承認待ちに出す（作者の裁定 2026-10-10
 * 「提案パネルにも出す」。設計書6.5.12、0.102.3）。形・積み方・組み立て・ログの1行。
 */

const PRINCE_SCENE =
  "　広い部屋にポツンと置かれた机で、余は先生の話をただ聞いていた。\n" +
  "「これは経済の基本です。殿下、聞いていますか」\n" +
  "　余もいつか、この退屈な皇宮から出ることができるのだろうか。\n";
const HERO_SCENE = "　俺は串焼きを頬張った。旨い。\n　俺はもう一本頼むことにした。\n";
const SOURCES = [
  { label: "第10話", text: HERO_SCENE, chapter: 10 },
  { label: "第12話", text: PRINCE_SCENE, chapter: 12 },
];

function change(field: string, value: string, chapters: number[]): RecordChange {
  return { field, value, chapters, timepointId: null, note: null, evidence: null, source: "extracted" };
}

function hero(overrides: Partial<Character> = {}): Character {
  return {
    ...emptyCharacter("char_007", "アジャーノ"),
    role: "冒険者",
    firstPerson: { default: "俺", variants: [] },
    changes: [change("role", "冒険者", [10]), change("role", "皇子", [12])],
    appearedChapters: [10, 12],
    ...overrides,
  };
}

const PRINCE: Character = { ...emptyCharacter("char_016", "殿下"), firstPerson: { default: "余", variants: [] } };
const TEACHER: Character = emptyCharacter("char_020", "先生");

function contextOf(people: Character[]): WorkNarratorContext {
  return { narrator: { firstPerson: "俺", name: "アジャーノ" }, narratorNames: ["アジャーノ"], people };
}

function movesOf(record: Character, people: Character[]) {
  return findNarratorMoves(record, contextOf(people), SOURCES);
}

describe("鍵", () => {
  test("同じ値・同じ話数なら同じ鍵、移し先が変わっても同じ鍵", () => {
    const [first] = movesOf(hero(), [hero(), PRINCE]).filter((item) => item.kind === "change");
    const [second] = movesOf(hero(), [hero(), PRINCE, TEACHER]).filter((item) => item.kind === "change");
    expect(first.destination).not.toEqual(second.destination);
    expect(narratorMoveKey("char_007", first)).toBe(narratorMoveKey("char_007", second));
  });

  test("話数が違えば別の鍵、主人公が違えば別の鍵", () => {
    const [item] = movesOf(hero(), [hero(), PRINCE]).filter((entry) => entry.kind === "change");
    const other = { ...item, change: { ...item.change!, chapters: [12, 13] } };
    expect(narratorMoveKey("char_007", item)).not.toBe(narratorMoveKey("char_007", other));
    expect(narratorMoveKey("char_007", item)).not.toBe(narratorMoveKey("char_008", item));
  });
});

describe("積む案を決める", () => {
  const items = movesOf(hero(), [hero(), PRINCE]);
  const found = [{ source: hero(), items }];
  const now = "2026-10-10T00:00:00.000Z";

  test("見つけた案をすべて積む", () => {
    const staged = planNarratorMoveStaging(found, { pendingKeys: new Set(), dismissedKeys: new Set(), now });
    expect(staged.map((payload) => payload.item.kind)).toEqual(items.map((item) => item.kind));
    expect(staged.every((payload) => payload.sourceId === "char_007")).toBe(true);
  });

  test("承認待ちに同じ案があれば積み直さない", () => {
    const pendingKeys = new Set(items.map((item) => narratorMoveKey("char_007", item)));
    expect(planNarratorMoveStaging(found, { pendingKeys, dismissedKeys: new Set(), now })).toEqual([]);
  });

  test("見送った案は積まない", () => {
    const role = items.find((item) => item.kind === "change")!;
    const staged = planNarratorMoveStaging(found, {
      pendingKeys: new Set(),
      dismissedKeys: new Set([narratorMoveKey("char_007", role)]),
      now,
    });
    expect(staged.some((payload) => payload.item.kind === "change")).toBe(false);
    expect(staged.length).toBe(items.length - 1);
  });
});

describe("承認待ちのファイル", () => {
  test("書いた形をそのまま読める（鍵は中身から組み直す）", () => {
    const [item] = movesOf(hero(), [hero(), PRINCE]);
    const payload = buildPendingNarratorMovePayload(hero(), item, "2026-10-10T00:00:00.000Z");
    const parsed: unknown = JSON.parse(JSON.stringify({ ...payload, key: "書き換えた鍵" }));
    const read = readPendingNarratorMoveFile(parsed, "x.json");
    expect(read.key).toBe(payload.key);
    expect(read.item).toEqual(item);
    expect(read.filePath).toBe("x.json");
  });

  test("壊れたものは直さずに例外", () => {
    expect(() => readPendingNarratorMoveFile({ kind: "narratorMove" }, "x.json")).toThrow();
    expect(() => readPendingNarratorMoveFile({ ...hero() }, "x.json")).toThrow();
  });
});

describe("並べる形", () => {
  function pendingOf(record: Character, people: Character[]) {
    return movesOf(record, people).map((item, index) => ({
      ...buildPendingNarratorMovePayload(record, item, "2026-10-10T00:00:00.000Z"),
      filePath: `move_${index}.json`,
    }));
  }

  test("名指しできた案は既定の移し先を持ち、候補はいまの台帳の人だけ", () => {
    const moves = pendingOf(hero(), [hero(), PRINCE]);
    const { items, stale } = assembleNarratorMoveReview(moves, [hero(), PRINCE]);
    expect(stale).toEqual([]);
    const role = items.find((item) => item.move.item.kind === "change")!;
    expect(role.defaultId).toBe("char_016");
    expect(role.options).toEqual([{ id: "char_016", name: "殿下" }]);
  });

  test("名指しできない案は既定では選ばない", () => {
    // 「余」の持ち主が台帳に居ない＝語り手を名指しできない
    const people = [hero(), emptyCharacter("char_016", "殿下")];
    const moves = pendingOf(hero(), people);
    const { items } = assembleNarratorMoveReview(moves, people);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.defaultId === null)).toBe(true);
  });

  test("主人公が居ない案・値がもう無い案は片付けてよいものへ", () => {
    const moves = pendingOf(hero(), [hero(), PRINCE]);
    const fixed = hero({ changes: [change("role", "冒険者", [10])] });
    const gone = assembleNarratorMoveReview(moves, [PRINCE]);
    expect(gone.items).toEqual([]);
    expect(gone.stale.every((entry) => entry.reason === "missing")).toBe(true);
    const edited = assembleNarratorMoveReview(moves, [fixed, PRINCE]);
    expect(edited.stale.map((entry) => entry.move.item.kind)).toEqual(["change"]);
    expect(edited.stale[0].reason).toBe("noChange");
  });

  test("行の説明は設定資料パネルと同じ文", () => {
    const moves = pendingOf(hero(), [hero(), PRINCE]);
    const { items } = assembleNarratorMoveReview(moves, [hero(), PRINCE]);
    const role = items.find((item) => item.move.item.kind === "change")!;
    const view = describeNarratorMoveReviewItem(role);
    expect(view.source).toBe("移す案：役割「皇子」（第12話）");
    expect(view.changes[0]).toBe("いまの値：皇子（第12話）");
  });
});

describe("移し先の選び", () => {
  const named = { options: [{ id: "char_016", name: "殿下" }], defaultId: "char_016" };
  const choose = { options: [{ id: "char_016", name: "殿下" }], defaultId: null };

  test("選んだ人・外すだけ・名指しの既定", () => {
    expect(destinationFromKeys([`${MOVE_DESTINATION_KEY_PREFIX}char_016`], choose)).toBe("char_016");
    expect(destinationFromKeys([`${MOVE_DESTINATION_KEY_PREFIX}${MOVE_REMOVE_ONLY}`], named)).toBeNull();
    expect(destinationFromKeys([], named)).toBe("char_016");
    // ✕ の印が混ざっていても、移し先の印だけを読む
    expect(destinationFromKeys(["relation:x", `${MOVE_DESTINATION_KEY_PREFIX}char_016`], choose)).toBe("char_016");
  });

  test("名指しできない案は、選ばないと反映できない", () => {
    expect(() => destinationFromKeys(undefined, choose)).toThrow("移し先を選んでください");
  });

  test("候補に無い人は選べない", () => {
    expect(() => destinationFromKeys([`${MOVE_DESTINATION_KEY_PREFIX}char_999`], choose)).toThrow();
  });
});

describe("ログの1行", () => {
  const [role] = movesOf(hero(), [hero(), PRINCE]).filter((item) => item.kind === "change");

  test("反映（移し先あり・外すだけ）と見送り", () => {
    const value = narratorMoveValueForLog(role);
    expect(
      describeNarratorMoveLog({ verdict: "applied", sourceName: "アジャーノ", value, destinationName: "殿下", via: "提案パネル" })
    ).toBe("設定資料の更新を適用：移す 人物「アジャーノ」役割「皇子」（第12話）→「殿下」（提案パネル）");
    expect(
      describeNarratorMoveLog({ verdict: "applied", sourceName: "アジャーノ", value, destinationName: null, via: "提案パネル" })
    ).toBe("設定資料の更新を適用：移す 人物「アジャーノ」役割「皇子」（第12話）→（外すだけ）（提案パネル）");
    expect(
      describeNarratorMoveLog({ verdict: "dismissed", sourceName: "アジャーノ", value, via: "提案パネル" })
    ).toBe("設定資料の更新を見送り：移す 人物「アジャーノ」役割「皇子」（第12話）（提案パネル）");
  });
});
