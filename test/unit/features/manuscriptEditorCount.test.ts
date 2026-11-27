import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 原稿エディターの下段の字数（`sendCount`）を、同じ本文で二度数えない（動作の
 * 高速化、2026-11-27）。
 *
 * 打った1便につき、`sendCount` は2回呼ばれる——画面の「数えて」（"count" の便）と、
 * 文書が変わって本文を送り返すとき。覚えた結果を使い回しても、**画面へ送る便
 * （字数・目安）と送る回数は前と同じ**でなければならない。数えに効くもの
 * （本文・拡張子・メモの印・ルビの扱い・純／総・種類）を1つずつ変え、そのたびに
 * 数え直されること（覚えの穴が無いこと）を見る。
 */

const settings: Record<string, unknown> = {};
let markers: { ids: string[]; prefixes: string[]; comment: boolean } | undefined;

vi.mock("vscode", async () => {
  const stub = await import("../support/vscodeStub");
  return {
    ...stub,
    workspace: {
      ...stub.workspace,
      getConfiguration: () => ({
        get: <T>(key: string, defaultValue: T): T =>
          (key in settings ? settings[key] : defaultValue) as T,
      }),
    },
  };
});

vi.mock("../../../src/core/memoMarkerStore", async () => {
  const base = await import("../support/memoMarkerStoreStub");
  return { ...base, cachedMemoMarkersForPath: () => markers };
});

vi.mock("../../../src/core/episodeCharCount", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/core/episodeCharCount")>();
  return { ...real, countEpisodeChars: vi.fn(real.countEpisodeChars) };
});

import { ManuscriptEditorProvider, countForDisplay } from "../../../src/features/manuscriptEditor";
import { countEpisodeChars } from "../../../src/core/episodeCharCount";
import { measureKindText } from "../../../src/core/kindMeasure";
import { DEFAULT_MEMO_MARKERS } from "../../../src/core/memoMarkers";
import type { WorkKindKey } from "../../../src/core/workKind";

type Posted = { type: string; value?: number; measure?: string };

function setup() {
  const provider = new ManuscriptEditorProvider({} as never);
  const posted: Posted[] = [];
  const panel = {
    webview: {
      postMessage: async (message: Posted) => {
        posted.push(message);
        return true;
      },
    },
  };
  const send = (text: string, file: string, kind?: WorkKindKey): Promise<void> =>
    (provider as unknown as { sendCount: (...a: unknown[]) => Promise<void> }).sendCount(
      panel,
      text,
      { uri: { scheme: "file", fsPath: file, path: "/" + file } },
      kind
    );
  return { posted, send };
}

/** いまの設定で数えた、画面に出るはずの便（覚えを通らない、元の数え方） */
function expected(text: string, file: string, kind?: WorkKindKey): Posted {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  const memoMarkers = markers ?? DEFAULT_MEMO_MARKERS;
  const value = countForDisplay(text, ext, memoMarkers);
  const excludeRuby = (settings.excludeRubyFromCount as boolean | undefined) ?? true;
  const measure = kind
    ? measureKindText(kind, text, countEpisodeChars(text, { ext, excludeRuby, memoMarkers }), memoMarkers)?.short
    : undefined;
  return { type: "count", ...(measure ? { measure } : {}), value };
}

/** ルビ（.md の記法 `{親字|読み}`）・メモの行・空白を含む本文 */
const TEXT = "　{彼|かれ}は走った。\n// メモの行\n　夜 が 明けた。\n";

beforeEach(() => {
  for (const key of Object.keys(settings)) delete settings[key];
  markers = undefined;
  vi.mocked(countEpisodeChars).mockClear();
});

describe("同じ本文の2回目は、覚えた字数で同じ便を送る", () => {
  test("打った1便の2回とも、元の数え方と同じ字数・目安を送る", async () => {
    const { posted, send } = setup();
    await send(TEXT, "C:/作品/本文/001.md", "essay");
    await send(TEXT, "C:/作品/本文/001.md", "essay");
    const want = expected(TEXT, "C:/作品/本文/001.md", "essay");
    expect(posted).toEqual([want, want]);
    expect(want.measure).toBeTruthy();
  });

  test("本文が変われば数え直す", async () => {
    const { posted, send } = setup();
    await send(TEXT, "C:/作品/本文/001.md");
    await send(TEXT + "　足した。\n", "C:/作品/本文/001.md");
    expect(posted).toEqual([
      expected(TEXT, "C:/作品/本文/001.md"),
      expected(TEXT + "　足した。\n", "C:/作品/本文/001.md"),
    ]);
    expect(posted[0].value).not.toBe(posted[1].value);
  });

  test("純／総の設定が変われば数え直す", async () => {
    const { posted, send } = setup();
    await send(TEXT, "C:/作品/本文/001.md");
    settings.countMode = "gross";
    await send(TEXT, "C:/作品/本文/001.md");
    expect(posted[1]).toEqual(expected(TEXT, "C:/作品/本文/001.md"));
    expect(posted[0].value).not.toBe(posted[1].value);
  });

  test("ルビの扱いが変われば数え直す", async () => {
    const { posted, send } = setup();
    await send(TEXT, "C:/作品/本文/001.md");
    settings.excludeRubyFromCount = false;
    await send(TEXT, "C:/作品/本文/001.md");
    expect(posted[1]).toEqual(expected(TEXT, "C:/作品/本文/001.md"));
    expect(posted[0].value).not.toBe(posted[1].value);
  });

  test("拡張子が変われば数え直す（ルビの読みを外すのは .md だけ）", async () => {
    const { posted, send } = setup();
    await send(TEXT, "C:/作品/本文/001.md");
    await send(TEXT, "C:/作品/本文/001.txt");
    expect(posted[1]).toEqual(expected(TEXT, "C:/作品/本文/001.txt"));
    expect(posted[0].value).not.toBe(posted[1].value);
  });

  test("メモの印が変われば数え直す", async () => {
    const { posted, send } = setup();
    await send(TEXT, "C:/作品/本文/001.md");
    // `//` をメモにしない作品へ変えた（メモの行が本文として数えられる）
    markers = { ids: ["comment"], prefixes: [], comment: true };
    await send(TEXT, "C:/作品/本文/001.md");
    expect(posted[1]).toEqual(expected(TEXT, "C:/作品/本文/001.md"));
    expect(posted[0].value).not.toBe(posted[1].value);
  });

  test("種類が変われば目安を出し直す", async () => {
    const { posted, send } = setup();
    await send(TEXT, "C:/作品/本文/001.md");
    await send(TEXT, "C:/作品/本文/001.md", "essay");
    await send(TEXT, "C:/作品/本文/001.md");
    expect(posted).toEqual([
      expected(TEXT, "C:/作品/本文/001.md"),
      expected(TEXT, "C:/作品/本文/001.md", "essay"),
      expected(TEXT, "C:/作品/本文/001.md"),
    ]);
  });
});

describe("数えるのは1便につき1回", () => {
  test("同じ本文の2回目では数えない（目安の付く種類でも1回）", async () => {
    const { send } = setup();
    await send(TEXT, "C:/作品/本文/001.md", "essay");
    await send(TEXT, "C:/作品/本文/001.md", "essay");
    expect(vi.mocked(countEpisodeChars)).toHaveBeenCalledTimes(1);
  });
});
