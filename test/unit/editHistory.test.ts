import { describe, expect, test } from "vitest";
import {
  dedupeHistory,
  parseHistory,
  sortNewestFirst,
  type EditHistoryEntry,
} from "../../src/core/editHistory";
import {
  ACTOR_MARKS,
  ACTOR_STYLES,
  actorLabel,
  parseActorKind,
} from "../../src/models/actor";
import {
  editorAllowedCommands,
  isCommandAllowed,
} from "../../src/core/editorMode";

/**
 * 編集履歴（設計書5.6）。
 *
 * **既存の操作ログとは別に要る。** あちらは `.aiwriter/logs/` にあり、
 * `.gitignore` で同期から外れているので、**作者には編集部の操作が届かない。**
 *
 * ここは `.aiwriter/history/` に置いて同期する。1行1件の追記だけにするのは、
 * 複数人が触っても競合しにくく、競合しても両方残せば正しい履歴になるためである。
 */
function entry(overrides: Partial<EditHistoryEntry> = {}): EditHistoryEntry {
  return {
    time: "2026-08-19T10:00:00.000Z",
    actor: "author",
    actorName: "nonahisa",
    action: "誤字を直した",
    file: "episode_0001.md",
    detail: "ｈっきりと → はっきりと",
    ...overrides,
  };
}

describe("履歴を読む", () => {
  test("1行1件で読める", () => {
    const text = [
      JSON.stringify(entry()),
      JSON.stringify(entry({ actor: "editor", actorName: "kmizu" })),
    ].join("\n");

    expect(parseHistory(text)).toHaveLength(2);
  });

  test("読めない行は捨てて、読める行は残す", () => {
    // **競合で行が壊れることがある。** そこで全部を諦めると、
    // 無事な履歴まで見えなくなる
    const text = [
      JSON.stringify(entry()),
      "{ここが壊れている",
      JSON.stringify(entry({ action: "推敲を反映した" })),
    ].join("\n");

    expect(parseHistory(text).map((e) => e.action)).toEqual([
      "誤字を直した",
      "推敲を反映した",
    ]);
  });

  test("競合マーカーの行を落とす", () => {
    // 解決前でも中身は読めたほうがよい
    const text = [
      "<<<<<<< HEAD",
      JSON.stringify(entry()),
      "=======",
      JSON.stringify(entry({ actor: "editor" })),
      ">>>>>>> origin/main",
    ].join("\n");

    expect(parseHistory(text)).toHaveLength(2);
  });

  test("誰が分からない行は履歴にしない", () => {
    // **取り違えるより、無いほうがよい**
    const text = JSON.stringify({ time: "x", action: "何かした" });

    expect(parseHistory(text)).toEqual([]);
  });

  test("何をしたか分からない行も履歴にしない", () => {
    const text = JSON.stringify({ actor: "author", time: "x" });

    expect(parseHistory(text)).toEqual([]);
  });

  test("空でも落ちない", () => {
    expect(parseHistory("")).toEqual([]);
    expect(parseHistory("\n\n")).toEqual([]);
  });
});

describe("並べ方", () => {
  test("新しいものが先", () => {
    const sorted = sortNewestFirst([
      entry({ time: "2026-08-17T00:00:00.000Z", action: "古い" }),
      entry({ time: "2026-08-19T00:00:00.000Z", action: "新しい" }),
    ]);

    expect(sorted.map((e) => e.action)).toEqual(["新しい", "古い"]);
  });

  test("時刻が読めない行は末尾へ回す（捨てない）", () => {
    const sorted = sortNewestFirst([
      entry({ time: "こわれた", action: "時刻不明" }),
      entry({ time: "2026-08-19T00:00:00.000Z", action: "正しい" }),
    ]);

    expect(sorted.map((e) => e.action)).toEqual(["正しい", "時刻不明"]);
  });
});

describe("二重に入った行をまとめる", () => {
  test("まったく同じ行は1つにする", () => {
    // **競合を「両方残す」で解決すると、同じ行が2つになる**
    expect(dedupeHistory([entry(), entry()])).toHaveLength(1);
  });

  test("誰かが違えば別の操作として残す", () => {
    expect(
      dedupeHistory([entry(), entry({ actor: "editor", actorName: "kmizu" })])
    ).toHaveLength(2);
  });

  test("中身が違えば残す", () => {
    expect(
      dedupeHistory([entry(), entry({ detail: "別の直し" })])
    ).toHaveLength(2);
  });
});

describe("操作者の種別", () => {
  test("3つある", () => {
    expect(Object.keys(ACTOR_STYLES)).toEqual(["author", "editor", "ai"]);
  });

  test("色が3つとも違う", () => {
    const colors = Object.values(ACTOR_STYLES).map((style) => style.color);
    expect(new Set(colors).size).toBe(3);
  });

  test("色以外の印も3つとも違う", () => {
    // **色が分からなくても区別できるようにする**
    expect(new Set(Object.values(ACTOR_MARKS)).size).toBe(3);
  });

  test("知らない値は種別として認めない", () => {
    // **取り違えるより「不明」のほうがよい**
    expect(parseActorKind("編集部")).toBeUndefined();
    expect(parseActorKind(undefined)).toBeUndefined();
    expect(parseActorKind("author")).toBe("author");
  });

  test("日本語の名前が付いている", () => {
    expect(actorLabel("editor")).toBe("編集者");
    expect(actorLabel("ai")).toBe("AI");
  });
});

describe("編集者モードで使える操作", () => {
  test("作者モードでは何でも使える", () => {
    expect(isCommandAllowed("novelai.extractCharacters", "author")).toBe(true);
  });

  test("校正・校閲は編集者も使える", () => {
    for (const command of [
      "novelai.checkTypos",
      "novelai.checkNotation",
      "novelai.checkProofread",
    ]) {
      expect(isCommandAllowed(command, "editor")).toBe(true);
    }
  });

  test("設定資料を変える操作は編集者に開かない", () => {
    // **押せてしまうと、いつか押される**
    for (const command of [
      "novelai.extractCharacters",
      "novelai.extractSettings",
      "novelai.applyPendingUpdates",
    ]) {
      expect(isCommandAllowed(command, "editor")).toBe(false);
    }
  });

  test("執筆の機能も開かない", () => {
    for (const command of [
      "novelai.startWork",
      "novelai.generateCatchphrases",
      "novelai.showWritingStats",
    ]) {
      expect(isCommandAllowed(command, "editor")).toBe(false);
    }
  });

  test("原稿の受け渡しに要るものは開く", () => {
    for (const command of ["novelai.syncWork", "novelai.resolveConflicts"]) {
      expect(isCommandAllowed(command, "editor")).toBe(true);
    }
  });

  test("知らないコマンドは、足すまで編集者に開かない", () => {
    // **許すものを並べる作りにしてある。**
    // 機能を足したときに、うっかり編集部へ開かないため
    expect(isCommandAllowed("novelai.someNewFeature", "editor")).toBe(false);
  });

  test("一覧が取り出せる（画面の説明で使う）", () => {
    expect(editorAllowedCommands()).toContain("novelai.checkTypos");
  });
});
