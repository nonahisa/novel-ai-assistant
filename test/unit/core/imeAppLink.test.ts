import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  IME_APP_ID,
  IME_LINK_LINE_MAX_BYTES,
  IME_LINK_RETRY,
  ImeLinkLineSplitter,
  buildAppContext,
  buildAppJson,
  buildAppWorks,
  imeLinkHelloLine,
  imeLinkPipeName,
  ImeTypingMerge,
  type ImeTypingItem,
  nextImeLinkDelay,
  parseImeLinkCommit,
  parseImeLinkWelcome,
  pipePreviousCommit,
  routeImePipeCommit,
  sidFromWhoami,
} from "../../../src/core/imeAppLink";
import { buildCurrentWorkNotice, buildWorksList } from "../../../src/core/imeCurrentWork";
import { sha256Text } from "../../../src/core/hash";

/**
 * 六徳 IME のアプリ連動の口（novel-ime `docs/アプリ連動の口_設計の案.md` 2章・5.2）の、
 * 統合の側の純粋な部分。形の正はエンジンの `core/src/link.rs`・`core/src/pick.rs`。
 */

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

describe("パイプの名前", () => {
  test("SID の UTF-8 の SHA-256 の頭6バイトを小文字16進（12字）で付ける", () => {
    const name = imeLinkPipeName({ sid: SID });
    // エンジンは Sha256::digest(sid.as_bytes()) の頭6バイトを {:02x} で並べる
    expect(name).toBe(`\\\\.\\pipe\\rittoku-ime-link-${sha256Text(SID).slice(0, 12)}`);
    expect(name?.endsWith(sha256Text(SID).slice(0, 12))).toBe(true);
    expect(sha256Text(SID).slice(0, 12)).toMatch(/^[0-9a-f]{12}$/);
  });

  test("決まった SID からは決まった12字（値を固定して、作り方の取り違えを止める）", () => {
    // 自前のハッシュと比べるだけでは、作り方を取り違えても通る。Node の SHA-256 で出した値を固定する
    const expected = "a8c06b3027d3";
    expect(createHash("sha256").update(SID, "utf8").digest("hex").slice(0, 12)).toBe(expected);
    expect(imeLinkPipeName({ sid: SID })).toBe(`\\\\.\\pipe\\rittoku-ime-link-${expected}`);
  });

  test("試しの名前（RITTOKU_LINK_PIPE）があればそれを使う", () => {
    expect(imeLinkPipeName({ override: "\\\\.\\pipe\\試し", sid: SID })).toBe("\\\\.\\pipe\\試し");
    expect(imeLinkPipeName({ override: "  ", sid: SID })).toBe(
      imeLinkPipeName({ sid: SID })
    );
  });

  test("SID が無ければ名前を作らない", () => {
    expect(imeLinkPipeName({ sid: undefined })).toBeUndefined();
    expect(imeLinkPipeName({ sid: "誰か" })).toBeUndefined();
  });

  test("whoami の出力から SID を抜く（ユーザー名が日本語でも崩れない）", () => {
    expect(sidFromWhoami(`"desktop\\作者","${SID}"\r\n`)).toBe(SID);
    expect(sidFromWhoami("���\\??,S-1-5-21-9-8-7-500")).toBe("S-1-5-21-9-8-7-500");
    expect(sidFromWhoami("エラー")).toBeUndefined();
  });
});

describe("hello と welcome", () => {
  test("hello は1行で、確定の知らせだけを欲しがる", () => {
    const line = imeLinkHelloLine();
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(JSON.parse(line)).toEqual({ hello: { appId: "novel-ai-assistant", wants: ["commit"] } });
  });

  test("welcome の grants に commit があれば許された", () => {
    expect(parseImeLinkWelcome('{"welcome":{"grants":["commit"],"denied":[]}}')).toEqual({
      granted: true,
    });
    expect(parseImeLinkWelcome('{"welcome":{"grants":[],"denied":["commit"]}}')).toEqual({
      granted: false,
    });
    // 知らない欄は読み飛ばす
    expect(
      parseImeLinkWelcome('{"welcome":{"grants":["commit","x"],"denied":[],"ime":"六徳 IME"}}')
    ).toEqual({ granted: true });
  });

  test("形の違う welcome は読まない", () => {
    expect(parseImeLinkWelcome("こんにちは")).toBeUndefined();
    expect(parseImeLinkWelcome('{"welcome":{"grants":"commit"}}')).toBeUndefined();
    expect(parseImeLinkWelcome('{"commit":{"text":"灯","reading":"あかり"}}')).toBeUndefined();
  });
});

describe("確定の行の確かめ", () => {
  test("字と読みの形が通れば受ける", () => {
    expect(
      parseImeLinkCommit('{"commit":{"text":"灯","reading":"あかり","at":"2026-11-18T09:08:56+09:00"}}')
    ).toEqual({ text: "灯", reading: "あかり" });
    // カタカナ・長音の読みも読みとして通す
    expect(parseImeLinkCommit('{"commit":{"text":"ルーナ","reading":"ルーナ"}}')).toEqual({
      text: "ルーナ",
      reading: "ルーナ",
    });
    // 末尾の改行は付いていてもよい
    expect(parseImeLinkCommit('{"commit":{"text":"白樺","reading":"しらかば"}}\r\n')).toEqual({
      text: "白樺",
      reading: "しらかば",
    });
  });

  test("読みでない reading（漢字・英字・空）は捨てる", () => {
    expect(parseImeLinkCommit('{"commit":{"text":"灯","reading":"灯"}}')).toBeUndefined();
    expect(parseImeLinkCommit('{"commit":{"text":"key","reading":"key"}}')).toBeUndefined();
    expect(parseImeLinkCommit('{"commit":{"text":"灯","reading":"あ かり"}}')).toBeUndefined();
  });

  test("読みが空の確定（変換を通らない確定）は読みを空のまま返す（控えへ渡さないのは受け手）", () => {
    expect(parseImeLinkCommit('{"commit":{"text":"abc","reading":"","at":"x"}}')).toEqual({
      text: "abc",
      reading: "",
    });
    expect(parseImeLinkCommit('{"commit":{"text":"灯","reading":"あ かり"}}')).toBeUndefined();
  });

  test("長すぎる字・読みは捨てる", () => {
    const long = "あ".repeat(65);
    expect(
      parseImeLinkCommit(JSON.stringify({ commit: { text: "灯", reading: long } }))
    ).toBeUndefined();
    expect(
      parseImeLinkCommit(JSON.stringify({ commit: { text: "灯".repeat(65), reading: "あかり" } }))
    ).toBeUndefined();
  });

  test("形の違う行・制御文字を含む字は捨てる", () => {
    expect(parseImeLinkCommit("{")).toBeUndefined();
    expect(parseImeLinkCommit('{"commit":"灯"}')).toBeUndefined();
    expect(parseImeLinkCommit('{"commit":{"text":1,"reading":"あ"}}')).toBeUndefined();
    expect(
      parseImeLinkCommit(
        JSON.stringify({ commit: { text: `灯${String.fromCharCode(7)}`, reading: "あかり" } })
      )
    ).toBeUndefined();
    expect(parseImeLinkCommit('{"welcome":{"grants":["commit"]}}')).toBeUndefined();
  });
});

describe("行の切り出し", () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  test("改行ごとに切り、途中で切れた行は次の塊とつなぐ", () => {
    const splitter = new ImeLinkLineSplitter();
    expect(splitter.push(bytes('{"a":1}\n{"b"'))).toEqual(['{"a":1}']);
    expect(splitter.push(bytes(':2}\n'))).toEqual(['{"b":2}']);
  });

  test("字の途中で塊が切れても字化けしない", () => {
    const splitter = new ImeLinkLineSplitter();
    const all = bytes("灯あかり\n");
    expect(splitter.push(all.slice(0, 2))).toEqual([]);
    expect(splitter.push(all.slice(2))).toEqual(["灯あかり"]);
  });

  test("64KB を超える行は次の改行まで捨て、溜め続けない", () => {
    const splitter = new ImeLinkLineSplitter();
    const huge = new Uint8Array(IME_LINK_LINE_MAX_BYTES + 10).fill(0x61);
    expect(splitter.push(huge)).toEqual([]);
    expect(splitter.pendingBytes()).toBe(0);
    expect(splitter.push(bytes('aaaa\n{"ok":1}\n'))).toEqual(['{"ok":1}']);
  });
});

describe("つなぎ直しの間", () => {
  test("IME が居なければ30秒から倍にして5分で止める", () => {
    let delay = nextImeLinkDelay("absent", undefined);
    expect(delay).toBe(IME_LINK_RETRY.absentFirstMs);
    const seen = [delay];
    for (let i = 0; i < 6; i++) {
      delay = nextImeLinkDelay("absent", delay);
      seen.push(delay);
    }
    expect(seen.slice(0, 4)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(seen.at(-1)).toBe(IME_LINK_RETRY.maxMs);
    expect(IME_LINK_RETRY.maxMs).toBe(5 * 60_000);
  });

  test("許されなかったら長めに（5分）待つ。許されたあとで切れたら初めの間から", () => {
    expect(nextImeLinkDelay("denied", 30_000)).toBe(IME_LINK_RETRY.deniedMs);
    expect(nextImeLinkDelay("lost", 240_000)).toBe(IME_LINK_RETRY.absentFirstMs);
  });
});

describe("同じ確定を二重に数えない（パイプと composition の突き合わせ）", () => {
  const pipe = (committed: string, kana = "あかり", filePath = "a"): ImeTypingItem => ({
    source: "pipe",
    filePath,
    kana,
    committed,
  });
  const comp = (committed: string, kana = "あかり", filePath = "a"): ImeTypingItem => ({
    source: "composition",
    filePath,
    kana,
    committed,
    before: "は",
  });

  test("パイプだけ：すぐ出す", () => {
    const merge = new ImeTypingMerge(1500);
    expect(merge.offer(pipe("灯"), 0)).toEqual({ emit: [pipe("灯")] });
    expect(merge.flush(5000)).toEqual([]);
  });

  test("composition だけ：預かって、間が過ぎたら今までどおり出す", () => {
    const merge = new ImeTypingMerge(1500);
    expect(merge.offer(comp("灯"), 0)).toEqual({ emit: [], flushAfterMs: 1500 });
    expect(merge.flush(1000)).toEqual([]);
    expect(merge.flush(1500)).toEqual([comp("灯")]);
    expect(merge.flush(3000)).toEqual([]);
  });

  test("composition が先・パイプが後：預かった方を捨ててパイプを1回だけ", () => {
    const merge = new ImeTypingMerge(1500);
    merge.offer(comp("灯", "あか"), 0);
    expect(merge.offer(pipe("灯"), 300).emit).toEqual([pipe("灯")]);
    expect(merge.flush(2000)).toEqual([]);
  });

  test("パイプが先・composition が後：パイプを1回だけ", () => {
    const merge = new ImeTypingMerge(1500);
    expect(merge.offer(pipe("灯"), 0).emit).toEqual([pipe("灯")]);
    expect(merge.offer(comp("灯"), 200)).toEqual({ emit: [] });
    expect(merge.flush(2000)).toEqual([]);
    // 突き合わせたパイプは使い切る。次の同じ字の composition は預かる
    expect(merge.offer(comp("灯"), 300).flushAfterMs).toBe(1500);
  });

  test("字が違う・話が違う・間を過ぎた：別々に数える", () => {
    const merge = new ImeTypingMerge(1500);
    merge.offer(pipe("灯"), 0);
    expect(merge.offer(comp("白樺"), 100).flushAfterMs).toBe(1500);
    expect(merge.offer(comp("灯", "あかり", "b"), 100).flushAfterMs).toBe(1500);
    expect(merge.flush(1600).map((one) => one.committed)).toEqual(["白樺", "灯"]);
    // パイプから間を過ぎて来た composition は別の確定
    merge.offer(pipe("森", "もり"), 2000);
    expect(merge.offer(comp("森", "もり"), 4000).flushAfterMs).toBe(1500);
    // 預かってから間を過ぎて来たパイプは、預かった方と突き合わせない
    const late = new ImeTypingMerge(1500);
    late.offer(comp("湖", "みずうみ"), 0);
    expect(late.offer(pipe("湖", "みずうみ"), 1600).emit).toHaveLength(1);
    expect(late.flush(1600)).toHaveLength(1);
  });
});

describe("パイプの確定を、どの原稿へ当てるか", () => {
  const front = { filePath: "C:/作品/本文/001.txt", vertical: false, active: true };

  test("窓に焦点があり、前の原稿エディターが active のときだけ当てる", () => {
    expect(routeImePipeCommit({ windowFocused: true, front })).toBe("C:/作品/本文/001.txt");
  });

  test("焦点の無い窓・原稿エディターが前に無い・閉じているときは捨てる", () => {
    expect(routeImePipeCommit({ windowFocused: false, front })).toBeUndefined();
    expect(routeImePipeCommit({ windowFocused: true, front: { ...front, active: false } })).toBeUndefined();
    expect(routeImePipeCommit({ windowFocused: true, front: undefined })).toBeUndefined();
  });

  test("同じ話で間を置かずに続いた確定だけを、前の確定としてつなぐ", () => {
    const last = { filePath: "a", kana: "しらかば", committed: "白樺", at: 1000 };
    expect(pipePreviousCommit(last, "a", 1000 + 7000)).toEqual({ kana: "しらかば", committed: "白樺" });
    expect(pipePreviousCommit(last, "b", 1000 + 7000)).toBeUndefined();
    expect(pipePreviousCommit(last, "a", 1000 + 60_000)).toBeUndefined();
    expect(pipePreviousCommit(undefined, "a", 0)).toBeUndefined();
  });
});

describe("ファイルの口の中身", () => {
  const now = new Date("2026-11-18T09:00:00+09:00");

  test("名乗り（app.json）は appId・名前・プロセス・版・時刻", () => {
    const app = buildAppJson({ version: "1.0.27", now });
    expect(app).toMatchObject({
      v: 1,
      appId: IME_APP_ID,
      name: "統合小説執筆環境",
      processes: ["Code.exe"],
      version: "1.0.27",
    });
    expect(typeof app.at).toBe("string");
    expect(Object.keys(app)).toEqual(["v", "appId", "name", "processes", "version", "at"]);
  });

  test("context.json はいまの作品の知らせと同じ欄に appId を足したもの（本文は入らない）", () => {
    const notice = buildCurrentWorkNotice({
      work: { workUid: "c-abc12345", title: "題", workDir: "C:\\作品", dictionary: "C:\\作品\\d.tsv" },
      dictionaryHash: "sha256:00",
      vertical: true,
      window: 42,
      now,
    });
    const context = buildAppContext(notice);
    expect(context.appId).toBe(IME_APP_ID);
    const { appId: _appId, ...rest } = context;
    void _appId;
    expect(rest).toEqual(notice);
    expect(Object.keys(context).sort()).toEqual(
      [...Object.keys(notice), "appId"].sort()
    );
  });

  test("works.json は作品の一覧と同じ欄に appId を足したもの", () => {
    const list = buildWorksList({
      works: [{ workUid: "c-abc12345", title: "題", workDir: "C:/作品", dictionary: "C:/作品/d.tsv" }],
      window: 42,
      now,
    });
    const works = buildAppWorks(list);
    expect(works.appId).toBe(IME_APP_ID);
    expect(works.works).toEqual(list.works);
  });
});
