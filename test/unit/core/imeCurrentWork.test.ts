import { describe, expect, test } from "vitest";
import {
  IME_TSV_HEADER,
  IME_TSV_KINDS,
  buildCurrentWorkNotice,
  buildImeTsv,
  buildWorksList,
  decideImeFront,
  imeNoticeKey,
  imeStateDir,
  imeTsvPath,
  isValidWorkUid,
  noticeWindowOf,
  serializeImeJson,
  shouldWriteImeNotice,
  withoutExcluded,
  workUidStateOf,
  type ImeFront,
} from "../../../src/core/imeCurrentWork";
import {
  buildDictionary,
  type DictionaryEntry,
  type DictionaryKind,
} from "../../../src/core/imeDictionary";
import { parseWorkConfig } from "../../../src/core/workRegistry";
import type { Character } from "../../../src/models/character";

/**
 * オリジナルIME へ渡す知らせ・一覧・核向けの辞書の形（設計書6.13.7）。
 *
 * 形の正は IME のリポジトリの計画書（novel-ime の docs/作品ごとの辞書の切り替え_計画.md、
 * bf35962 の 3.1〜3.5）。**欄の名前と並びは計画書の例と同じにする**——IME の核が
 * その名前で読むので、1字違えば作品の語が出ない。
 */

const ref = {
  workUid: "0f8c2a54-1b9e-4c1d-9a7e-3d2f6b8e1c40",
  title: "いじめられっ子",
  workDir: "C:\\Users\\a\\novel\\いじめられっ子",
  dictionary: "C:\\Users\\a\\novel\\いじめられっ子\\.aiwriter\\exports\\ime\\novel-ime.tsv",
};
const now = new Date(2026, 10, 15, 1, 23, 45, 0);

describe("いまの作品の知らせ（integration-current-work.json）", () => {
  test("欄の名前と並びが計画書の例と同じ", () => {
    const notice = buildCurrentWorkNotice({
      work: ref,
      dictionaryHash: "sha256:abc",
      vertical: true,
      window: 12345,
      now,
    });
    expect(Object.keys(notice)).toEqual([
      "v",
      "sender",
      "workUid",
      "title",
      "workDir",
      "dictionary",
      "dictionaryHash",
      "window",
      "vertical",
      "at",
    ]);
    expect(notice.v).toBe(1);
    expect(notice.sender).toBe("novel-ai-assistant");
    expect(notice.workUid).toBe(ref.workUid);
    expect(notice.title).toBe("いじめられっ子");
    // 道は `/` 区切り（計画書の例 `C:/Users/…`）
    expect(notice.workDir).toBe("C:/Users/a/novel/いじめられっ子");
    expect(notice.dictionary).toBe(
      "C:/Users/a/novel/いじめられっ子/.aiwriter/exports/ime/novel-ime.tsv"
    );
    expect(notice.dictionaryHash).toBe("sha256:abc");
    expect(notice.window).toBe(12345);
    // 時差つき（`toISOString` の Z ではない）
    expect(notice.at).toMatch(/^2026-11-15T01:23:45\.000[+-]\d{2}:\d{2}$/);
  });

  test("vertical は true・false・null の3つ", () => {
    const of = (vertical: boolean | null) =>
      buildCurrentWorkNotice({ work: ref, dictionaryHash: null, vertical, window: 1, now })
        .vertical;
    expect(of(true)).toBe(true);
    expect(of(false)).toBe(false);
    expect(of(null)).toBeNull();
  });

  test("作品の外・閉じたときは workUid も向きも null", () => {
    const notice = buildCurrentWorkNotice({
      work: null,
      dictionaryHash: "sha256:古い",
      vertical: true,
      window: 7,
      now,
    });
    expect(notice.workUid).toBeNull();
    expect(notice.title).toBeNull();
    expect(notice.workDir).toBeNull();
    expect(notice.dictionary).toBeNull();
    expect(notice.dictionaryHash).toBeNull();
    expect(notice.vertical).toBeNull();
    expect(notice.window).toBe(7);
  });

  test("ファイルの中身は JSON で LF・末尾に改行。窓の番号を読み返せる", () => {
    const text = serializeImeJson(
      buildCurrentWorkNotice({ work: ref, dictionaryHash: null, vertical: false, window: 42, now })
    );
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.includes("\r")).toBe(false);
    expect(JSON.parse(text).vertical).toBe(false);
    expect(noticeWindowOf(text)).toBe(42);
    expect(noticeWindowOf("{壊れた")).toBeUndefined();
  });

  test("同じ中身かを比べる鍵は時刻を見ない", () => {
    const a = buildCurrentWorkNotice({ work: ref, dictionaryHash: null, vertical: true, window: 1, now });
    const b = buildCurrentWorkNotice({
      work: ref,
      dictionaryHash: null,
      vertical: true,
      window: 1,
      now: new Date(now.getTime() + 60_000),
    });
    const c = buildCurrentWorkNotice({ work: ref, dictionaryHash: null, vertical: false, window: 1, now });
    expect(imeNoticeKey(a)).toBe(imeNoticeKey(b));
    expect(imeNoticeKey(a)).not.toBe(imeNoticeKey(c));
  });
});

describe("作品の一覧（integration-works.json）", () => {
  test("欄の名前が計画書と同じ（書いた窓は window）", () => {
    const list = buildWorksList({ works: [ref], window: 99, now });
    expect(Object.keys(list)).toEqual(["v", "sender", "window", "works", "at"]);
    expect(list.sender).toBe("novel-ai-assistant");
    expect(list.works).toEqual([
      {
        workUid: ref.workUid,
        title: "いじめられっ子",
        workDir: "C:/Users/a/novel/いじめられっ子",
        dictionary: "C:/Users/a/novel/いじめられっ子/.aiwriter/exports/ime/novel-ime.tsv",
      },
    ]);
  });

  test("同じ番号の作品は1つだけ載せる（写しを登録したとき）", () => {
    const list = buildWorksList({
      works: [ref, { ...ref, title: "写し", workDir: "D:\\写し" }],
      window: 1,
      now,
    });
    expect(list.works.map((work) => work.title)).toEqual(["いじめられっ子"]);
  });
});

describe("核向けの辞書（novel-ime.tsv）", () => {
  const entry = (
    surface: string,
    reading: string,
    kind: DictionaryKind,
    baseName?: string
  ): DictionaryEntry => ({
    surface,
    reading,
    kind,
    partOfSpeech: "名詞",
    ...(baseName ? { baseName } : {}),
  });

  test("1行目・4列・BOM 無し・LF", () => {
    const text = buildImeTsv([
      entry("月島灯", "つきしまあかり", "character"),
      entry("アカリ", "あかり", "character", "月島灯"),
    ]);
    const bytes = new TextEncoder().encode(text);
    // BOM（EF BB BF）が無い
    expect([...bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(text.includes("\r")).toBe(false);
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.split("\n");
    expect(lines[0]).toBe(IME_TSV_HEADER);
    expect(lines[0]).toBe("#novel-ime-dictionary v1");
    expect(lines[1].split("\t")).toEqual(["月島灯", "つきしまあかり", "character", ""]);
    expect(lines[2].split("\t")).toEqual(["アカリ", "あかり", "character", "月島灯"]);
  });

  test("種類は計画書の5つ", () => {
    expect(IME_TSV_KINDS).toEqual(["character", "location", "organization", "ability", "term"]);
  });

  test("タブ・改行を含む語と、64字を超える語は書かない", () => {
    const text = buildImeTsv([
      entry("割れ\tた", "われた", "term"),
      entry("長い", "な".repeat(65), "term"),
      entry("聖言", "せいげん", "term"),
    ]);
    expect(text.split("\n").filter(Boolean)).toEqual([IME_TSV_HEADER, "聖言\tせいげん\tterm\t"]);
  });

  test("語の選び方は IME 辞書出力と同じ（別名に本体の名前・モブを外す）", () => {
    const character = (name: string, extra: Partial<Character>): Character =>
      ({
        id: name,
        name,
        reading: null,
        aliases: [],
        isMob: false,
        ...extra,
      }) as unknown as Character;
    const built = buildDictionary({
      characters: [
        character("月島灯", { reading: "つきしまあかり", aliases: ["アカリ"] }),
        character("通行人", { reading: "つうこうにん", isMob: true }),
      ],
      abilities: [],
      locations: [],
    });
    const rows = buildImeTsv(built.entries).split("\n").slice(1).filter(Boolean);
    expect(rows).toEqual([
      "アカリ\tあかり\tcharacter\t月島灯",
      "月島灯\tつきしまあかり\tcharacter\t",
    ]);
  });

  test("作者が外した語を外す", () => {
    const entries = [entry("月島灯", "つきしまあかり", "character"), entry("聖言", "せいげん", "term")];
    expect(withoutExcluded(entries, ["聖言"]).map((one) => one.surface)).toEqual(["月島灯"]);
  });

  test("置き場は作品の .aiwriter/exports/ime/novel-ime.tsv", () => {
    expect(imeTsvPath("C:\\novel\\作品")).toBe("C:\\novel\\作品\\.aiwriter\\exports\\ime\\novel-ime.tsv");
    expect(imeTsvPath("/Users/a/novel/作品/")).toBe("/Users/a/novel/作品/.aiwriter/exports/ime/novel-ime.tsv");
  });
});

describe("書かない4つの条件", () => {
  const all = {
    canRunProcesses: true,
    remoteName: undefined,
    enabled: true,
    stateDirExists: true,
  };

  test("4つそろえば書く", () => {
    expect(shouldWriteImeNotice(all)).toBe(true);
  });

  test("ブラウザ版では書かない", () => {
    expect(shouldWriteImeNotice({ ...all, canRunProcesses: false })).toBe(false);
  });

  test("リモート（WSL・SSH）では書かない", () => {
    expect(shouldWriteImeNotice({ ...all, remoteName: "wsl" })).toBe(false);
  });

  test("設定が off なら書かない", () => {
    expect(shouldWriteImeNotice({ ...all, enabled: false })).toBe(false);
  });

  test("置き場のフォルダーが無ければ書かない（IME の無い機械）", () => {
    expect(shouldWriteImeNotice({ ...all, stateDirExists: false })).toBe(false);
  });

  test("置き場は Windows が LOCALAPPDATA、Mac が Application Support。ほかは無し", () => {
    expect(
      imeStateDir({ platform: "win32", localAppData: "C:\\Users\\a\\AppData\\Local\\" })
    ).toBe("C:\\Users\\a\\AppData\\Local\\novel-ime");
    expect(imeStateDir({ platform: "darwin", home: "/Users/a" })).toBe(
      "/Users/a/Library/Application Support/novel-ime"
    );
    expect(imeStateDir({ platform: "win32" })).toBeUndefined();
    expect(imeStateDir({ platform: "linux", home: "/home/a" })).toBeUndefined();
    expect(imeStateDir({ platform: undefined })).toBeUndefined();
  });
});

describe("作品の番号（workUid）", () => {
  test("ある番号は present、無ければ absent、形が悪ければ invalid", () => {
    expect(workUidStateOf({ workUid: ref.workUid })).toEqual({
      kind: "present",
      workUid: ref.workUid,
    });
    expect(workUidStateOf({ workTitle: "x" })).toEqual({ kind: "absent" });
    // IME はファイル名に使うので、区切り文字の混じった値は使わない
    expect(workUidStateOf({ workUid: "..\\学習" })).toEqual({ kind: "invalid" });
    expect(workUidStateOf({ workUid: 12 })).toEqual({ kind: "invalid" });
    expect(workUidStateOf([])).toEqual({ kind: "invalid" });
    expect(isValidWorkUid("short")).toBe(false);
  });

  test("作品設定を読み直しても番号が残る（ほかの欄を書くたびに消えない）", () => {
    const config = parseWorkConfig({
      schemaVersion: "1.0",
      workTitle: "作品",
      manuscriptDir: "本文",
      settingsDir: "設定",
      createdAt: "2026-11-16T00:00:00.000Z",
      workUid: ref.workUid,
    });
    expect(config.workUid).toBe(ref.workUid);
  });
});

describe("いまの作品と向きを決める（計画書 3.4）", () => {
  type W = { id: string };
  const a: W = { id: "a" };
  const b: W = { id: "b" };
  const find = (filePath: string): W | undefined =>
    filePath.startsWith("/a/") ? a : filePath.startsWith("/b/") ? b : undefined;

  test("原稿エディターが前に来たらその作品と向き", () => {
    expect(
      decideImeFront<W>(undefined, {
        kind: "front",
        front: { source: "manuscript", filePath: "/a/001.txt", vertical: true },
      }, find)
    ).toEqual({ work: a, vertical: true });
    expect(
      decideImeFront<W>(undefined, {
        kind: "front",
        front: { source: "manuscript", filePath: "/a/001.txt", vertical: false },
      }, find)
    ).toEqual({ work: a, vertical: false });
  });

  test("ふつうのエディターでは向きが分からない（null）", () => {
    const previous: ImeFront<W> = { work: a, vertical: true };
    expect(
      decideImeFront<W>(previous, { kind: "front", front: { source: "text", filePath: "/b/x.md" } }, find)
    ).toEqual({ work: b, vertical: null });
  });

  test("作品の外のファイル・パネルでは替えない", () => {
    const previous: ImeFront<W> = { work: a, vertical: true };
    expect(
      decideImeFront<W>(previous, { kind: "front", front: { source: "text", filePath: "/外/x.md" } }, find)
    ).toBe(previous);
    expect(decideImeFront<W>(previous, { kind: "front", front: { source: "none" } }, find)).toBe(previous);
  });

  test("起動で前に何も無ければ、開いている作品が1つのときだけそれ", () => {
    expect(
      decideImeFront<W>(undefined, { kind: "startup", front: { source: "none" }, openWorks: [a] }, find)
    ).toEqual({ work: a, vertical: null });
    expect(
      decideImeFront<W>(undefined, { kind: "startup", front: { source: "none" }, openWorks: [a, b] }, find)
    ).toBeUndefined();
  });

  test("焦点が来たら、その窓の最後の前面の作品", () => {
    const previous: ImeFront<W> = { work: a, vertical: null };
    expect(
      decideImeFront<W>(previous, {
        kind: "focus",
        front: { source: "manuscript", filePath: "/b/002.txt", vertical: true },
      }, find)
    ).toEqual({ work: b, vertical: true });
  });
});
