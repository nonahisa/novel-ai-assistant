import { describe, expect, it } from "vitest";
import {
  buildWindowCard,
  createWindowCardWriteGate,
  describeWindowCards,
  parseWindowCard,
  serializeWindowCard,
  windowCardChangeKey,
  type WindowCard,
} from "../../../src/core/windowCard";
import {
  MANUSCRIPT_STATE_UNKNOWN_NOTE,
  buildManuscriptEditorsCard,
  manuscriptLocation,
  parseManuscriptStatusMessage,
  type ManuscriptEditorSnapshot,
} from "../../../src/core/manuscriptEditorStatus";

/**
 * 原稿エディターの未送信の状態を、窓の札（MCP の `windows.list`）に出す
 * （作者の裁定、2026-10-01）。
 *
 * 背景：ノートPCで拡張機能ホストが起動し直したあと、打った約100字が原稿に
 * 届かず、作者が気づくまで外から分からなかった。見張りたいのは4つ。
 *
 * 1. **状態が札に載る**（知らせ・段・秒数・返事の来ない便の数・字数の差・
 *    最後に「入った」と返した時刻・控えの有無）
 * 2. **本文は載らない**（札は保管庫に平文で置かれ、外のセッションが読む）
 * 3. **状態が変わったときだけ書く**（打鍵のたびに保管庫へ書かない）
 * 4. **古い札は欠けた項目を null で埋める**（2台で版がずれていても一覧から消さない）
 */

const NOW = new Date("2026-10-01T12:00:00.000Z");
const BODY = "港の灯りが消えたあと、彼女はまだ桟橋に立っていた。";

function snapshot(
  overrides: Partial<ManuscriptEditorSnapshot> = {}
): ManuscriptEditorSnapshot {
  return {
    work: "灯台",
    location: "本文/第3話.txt",
    report: {
      unsent: true,
      stage: 1,
      shownMs: 12_000,
      pendingEdits: 3,
      lengthGap: 98,
      rescueKept: true,
    },
    reportedAt: new Date("2026-10-01T11:59:50.000Z"),
    lastAppliedAt: new Date("2026-10-01T11:59:30.000Z"),
    lastHeardAt: new Date("2026-10-01T11:59:58.000Z"),
    ...overrides,
  };
}

function card(overrides: Partial<WindowCard> = {}): WindowCard {
  return {
    ...buildWindowCard({
      pid: 77,
      extensionVersion: "0.94.8",
      vscodeVersion: "1.138.0",
      appName: "Visual Studio Code",
      workspaceName: "書庫",
      developmentHost: false,
      folders: ["C:/書庫"],
      manuscripts: buildManuscriptEditorsCard({
        editors: [snapshot()],
        tabs: [{ key: "c:/書庫/灯台/本文/第3話.txt", location: "本文/第3話.txt", work: "灯台", visible: true }],
        ownedKeys: ["c:/書庫/灯台/本文/第3話.txt"],
        lastHeardAt: new Date("2026-10-01T11:59:58.000Z"),
      }),
      startedAt: new Date("2026-10-01T09:00:00.000Z"),
      now: NOW,
    }),
    ...overrides,
  };
}

describe("原稿エディターの状態が札に載る", () => {
  it("知らせ・段・出た時刻・便の数・字数の差・入った時刻・控えが載る", () => {
    const built = card();
    expect(built.manuscripts).not.toBeNull();
    const [editor] = built.manuscripts!.editors;
    expect(editor).toEqual({
      work: "灯台",
      location: "本文/第3話.txt",
      unsent: true,
      stage: 1,
      // 画面が知らせてきた時刻から、出ていた長さ（12秒）ぶん戻した時刻
      unsentSince: "2026-10-01T11:59:38.000Z",
      pendingEdits: 3,
      lengthGap: 98,
      lastAppliedAt: "2026-10-01T11:59:30.000Z",
      rescueKept: true,
      lastHeardAt: "2026-10-01T11:59:58.000Z",
    });
    expect(built.manuscripts!.lastHeardAt).toBe("2026-10-01T11:59:58.000Z");
    expect(built.manuscripts!.stateUnknown).toBe(false);
    expect(built.manuscripts!.orphanTabs).toEqual([]);
    expect(built.manuscripts!.note).toBeNull();
  });

  it("書いた札をそのまま読み戻せる", () => {
    const built = card();
    expect(parseWindowCard(serializeWindowCard(built))).toEqual(built);
  });

  it("画面からまだ何も届いていない原稿は、知らせ無し・段0・分からない値は null", () => {
    const built = buildManuscriptEditorsCard({
      editors: [
        snapshot({ report: undefined, reportedAt: undefined, lastAppliedAt: undefined, lastHeardAt: undefined }),
      ],
      tabs: [],
      ownedKeys: [],
      lastHeardAt: undefined,
    });
    expect(built.editors[0]).toEqual({
      work: "灯台",
      location: "本文/第3話.txt",
      unsent: false,
      stage: 0,
      unsentSince: null,
      pendingEdits: null,
      lengthGap: null,
      lastAppliedAt: null,
      rescueKept: null,
      lastHeardAt: null,
    });
    expect(built.lastHeardAt).toBeNull();
  });

  it("windows.list の見せ方に、知らせが出てからの秒数と最後に届いてからの秒数を添える", () => {
    const [view] = describeWindowCards([card()], NOW);
    expect(view.manuscripts?.editors[0].unsentSeconds).toBe(22);
    expect(view.manuscripts?.editors[0].silentSeconds).toBe(2);
    expect(view.manuscripts?.silentSeconds).toBe(2);
  });
});

describe("本文は札に載らない", () => {
  it("画面からの知らせに本文が混ざっていても、決めた数だけを拾う", () => {
    const parsed = parseManuscriptStatusMessage({
      type: "unsentStatus",
      unsent: true,
      stage: 2,
      shownMs: 31_000,
      pendingEdits: 9,
      lengthGap: 120,
      rescueKept: true,
      // 書き手が誤って足しても札へ流れないこと
      text: BODY,
      screenText: BODY,
    });
    expect(parsed).toEqual({
      unsent: true,
      stage: 2,
      shownMs: 31_000,
      pendingEdits: 9,
      lengthGap: 120,
      rescueKept: true,
    });
  });

  it("形の違う知らせは受け取らない（段が範囲外・数でない）", () => {
    expect(parseManuscriptStatusMessage(null)).toBeUndefined();
    expect(
      parseManuscriptStatusMessage({ type: "unsentStatus", unsent: true, stage: 5, shownMs: 0, pendingEdits: 0, lengthGap: 0, rescueKept: false })
    ).toBeUndefined();
    expect(
      parseManuscriptStatusMessage({ type: "unsentStatus", unsent: "yes", stage: 1, shownMs: 0, pendingEdits: 0, lengthGap: 0, rescueKept: false })
    ).toBeUndefined();
  });

  it("書いた札のどこにも本文が無い", () => {
    const text = serializeWindowCard(card());
    expect(text).not.toContain("港の灯り");
    expect(text).not.toContain("桟橋");
  });
});

describe("状態が変わったときだけ書く", () => {
  it("打ち直しの時刻と「最後に届いた時刻」だけが違う札は、同じ札とみなす", () => {
    const a = card();
    const b = card({
      updatedAt: "2026-10-01T12:03:00.000Z",
      manuscripts: {
        ...a.manuscripts!,
        lastHeardAt: "2026-10-01T12:02:59.000Z",
        editors: a.manuscripts!.editors.map((editor) => ({
          ...editor,
          lastHeardAt: "2026-10-01T12:02:59.000Z",
        })),
      },
    });
    expect(windowCardChangeKey(b)).toBe(windowCardChangeKey(a));
  });

  it("知らせの出し下げ・段・控え・便の数が変われば、別の札", () => {
    const a = card();
    const editorsOf = (patch: Record<string, unknown>): WindowCard => ({
      ...a,
      manuscripts: {
        ...a.manuscripts!,
        editors: a.manuscripts!.editors.map((editor) => ({ ...editor, ...patch })),
      },
    });
    for (const patch of [{ unsent: false }, { stage: 2 }, { rescueKept: false }, { pendingEdits: 4 }]) {
      expect(windowCardChangeKey(editorsOf(patch))).not.toBe(windowCardChangeKey(a));
    }
  });

  it("書き込みの門：同じ札は通さず、変われば通す。打ち直し（force）は必ず通す", () => {
    const gate = createWindowCardWriteGate();
    const a = card();
    expect(gate.shouldWrite(a)).toBe(true);
    gate.wrote(a);
    // 時刻だけ違う
    expect(gate.shouldWrite(card({ updatedAt: "2026-10-01T12:01:00.000Z" }))).toBe(false);
    // 5分ごとの打ち直しは、中身が同じでも書く（updatedAt を新しくするため）
    expect(gate.shouldWrite(a, { force: true })).toBe(true);
    const changed: WindowCard = {
      ...a,
      manuscripts: {
        ...a.manuscripts!,
        editors: a.manuscripts!.editors.map((editor) => ({ ...editor, unsent: false, stage: 0 })),
      },
    };
    expect(gate.shouldWrite(changed)).toBe(true);
  });
});

describe("古い札は欠けた項目を null で埋める", () => {
  it("原稿エディターの項目が無い札（古い版）は manuscripts: null", () => {
    const old = JSON.parse(serializeWindowCard(card())) as Record<string, unknown>;
    delete old.manuscripts;
    const parsed = parseWindowCard(JSON.stringify(old));
    expect(parsed).toBeDefined();
    expect(parsed?.manuscripts).toBeNull();
    // 見せ方でも落ちない
    const [view] = describeWindowCards([parsed!], NOW);
    expect(view.manuscripts).toBeNull();
  });

  it("原稿ごとの項目が欠けていれば null で埋める", () => {
    const raw = JSON.parse(serializeWindowCard(card())) as {
      manuscripts: { editors: Array<Record<string, unknown>> };
    };
    delete raw.manuscripts.editors[0].lastAppliedAt;
    delete raw.manuscripts.editors[0].rescueKept;
    delete raw.manuscripts.editors[0].lengthGap;
    const parsed = parseWindowCard(JSON.stringify(raw));
    expect(parsed?.manuscripts?.editors[0].lastAppliedAt).toBeNull();
    expect(parsed?.manuscripts?.editors[0].rescueKept).toBeNull();
    expect(parsed?.manuscripts?.editors[0].lengthGap).toBeNull();
  });

  it("有るのに形が違えば壊れた札", () => {
    expect(parseWindowCard(JSON.stringify({ ...card(), manuscripts: "あり" }))).toBeUndefined();
    const raw = JSON.parse(serializeWindowCard(card())) as {
      manuscripts: { editors: Array<Record<string, unknown>> };
    };
    raw.manuscripts.editors[0].stage = "二段目";
    expect(parseWindowCard(JSON.stringify(raw))).toBeUndefined();
  });
});

describe("拡張機能が受け持っていない原稿エディター（ホストが起動し直したあと）", () => {
  it("タブはあるのに受け手になっていない原稿があれば、状態は不明と書く", () => {
    const built = buildManuscriptEditorsCard({
      editors: [],
      tabs: [
        { key: "c:/書庫/灯台/本文/第3話.txt", location: "本文/第3話.txt", work: "灯台", visible: true },
        { key: "c:/書庫/灯台/本文/第4話.txt", location: "本文/第4話.txt", work: "灯台", visible: false },
      ],
      ownedKeys: [],
      lastHeardAt: undefined,
    });
    expect(built.stateUnknown).toBe(true);
    expect(built.note).toBe(MANUSCRIPT_STATE_UNKNOWN_NOTE);
    expect(built.note).toContain("原稿エディターの状態は不明");
    expect(built.orphanTabs).toEqual([
      { work: "灯台", location: "本文/第3話.txt", visible: true },
      { work: "灯台", location: "本文/第4話.txt", visible: false },
    ]);
  });

  it("受け持っている原稿のタブは、受け持っていない側へ数えない", () => {
    const built = buildManuscriptEditorsCard({
      editors: [snapshot()],
      tabs: [{ key: "c:/a.txt", location: "本文/第3話.txt", work: "灯台", visible: true }],
      ownedKeys: ["c:/a.txt"],
      lastHeardAt: undefined,
    });
    expect(built.stateUnknown).toBe(false);
    expect(built.orphanTabs).toEqual([]);
  });

  it("同じ文書のタブが2つのグループにあっても、1件にまとめる（見えているほうを優先）", () => {
    const built = buildManuscriptEditorsCard({
      editors: [],
      tabs: [
        { key: "c:/a.txt", location: "a.txt", work: null, visible: false },
        { key: "c:/a.txt", location: "a.txt", work: null, visible: true },
      ],
      ownedKeys: [],
      lastHeardAt: undefined,
    });
    expect(built.orphanTabs).toEqual([{ work: null, location: "a.txt", visible: true }]);
  });
});

describe("文書の場所（作品からの相対か URI）", () => {
  it("作品の中なら作品からの相対", () => {
    expect(
      manuscriptLocation("C:/書庫/灯台/本文/第3話.txt", "file:///c%3A/x", {
        title: "灯台",
        folderPath: "C:/書庫/灯台",
      })
    ).toEqual({ work: "灯台", location: "本文/第3話.txt" });
  });

  it("作品の外・作品が分からなければ URI", () => {
    expect(manuscriptLocation("C:/メモ/下書き.txt", "file:///c%3A/メモ/下書き.txt", undefined)).toEqual({
      work: null,
      location: "file:///c%3A/メモ/下書き.txt",
    });
    expect(
      manuscriptLocation("C:/メモ/下書き.txt", "file:///c%3A/メモ/下書き.txt", {
        title: "灯台",
        folderPath: "C:/書庫/灯台",
      })
    ).toEqual({ work: null, location: "file:///c%3A/メモ/下書き.txt" });
  });
});
