import { describe, expect, test } from "vitest";
import { LockedPlainEditReverter, type LockedEditRevertDeps } from "../../../src/features/editorLockRevert";

/**
 * 素のエディターで、作者が自分で読み取り専用を外して校閲中の話に打ったとき（0.141.1。作者の答え
 * 2026-11-07「打った時点で戻す」）。打った字を控えへ回し、文書をファイルの中身へ戻し、
 * 読み取り専用を掛け直し、右下に知らせる。原稿のファイルには書かない。
 *
 * VS Code に依らない係を、偽の口で動かす（つなぎ方は `reviewLockNames.test.ts` で見る）。
 */

const URI = "file:///c%3A/novels/001.txt";
const FILE_TEXT = "朝の駅は静かだった。\n";
const DETAIL = "編集者 kmizu・11月7日 18:30 から";

function harness(options: { locked?: boolean; active?: string | undefined; now?: () => number } = {}) {
  const calls: string[] = [];
  const rescued: Array<{ uri: string; text: string; base: string }> = [];
  const notices: string[] = [];
  let documentText = FILE_TEXT;
  const deps: LockedEditRevertDeps = {
    lockDetail: async () => ((options.locked ?? true) ? DETAIL : undefined),
    activePlainEditorUri: () => ("active" in options ? options.active : URI),
    readFileText: async () => FILE_TEXT,
    rescue: async (uri, text, base) => {
      rescued.push({ uri, text, base });
    },
    revert: async (uri) => {
      calls.push(`revert ${uri}`);
      // 戻すと文書が変わる。その変化の知らせが、もう一度係へ届く
      documentText = FILE_TEXT;
      await reverter.onChange(URI, "001.txt", () => documentText);
    },
    reapplyReadonly: async (uri) => {
      calls.push(`readonly ${uri}`);
    },
    notify: (message) => notices.push(message),
    now: options.now,
  };
  const reverter = new LockedPlainEditReverter(deps);
  return {
    reverter,
    calls,
    rescued,
    notices,
    type: async (text: string) => {
      documentText = text;
      await reverter.onChange(URI, "001.txt", () => documentText);
    },
    text: () => documentText,
  };
}

describe("校閲中の話に素のエディターで打ったとき", () => {
  test("打った字を控え、文書をファイルの中身へ戻し、読み取り専用を掛け直し、GitHub の名前で知らせる", async () => {
    const h = harness();
    await h.type("朝の駅は静かだった。あ\n");
    expect(h.rescued).toEqual([{ uri: URI, text: "朝の駅は静かだった。あ\n", base: FILE_TEXT }]);
    expect(h.text()).toBe(FILE_TEXT);
    // 戻したことで鳴った知らせでは、二度目は走らない（控えも戻しも1回）
    expect(h.calls).toEqual([`revert ${URI}`, `readonly ${URI}`]);
    expect(h.notices).toEqual([
      `「001.txt」は編集者が校閲中のため、書けません（${DETAIL}）。打った字は控えました。`,
    ]);
  });

  test("知らせは1分に1回まで（戻すのと控えるのは毎回）", async () => {
    let now = 1_000_000;
    const h = harness({ now: () => now });
    await h.type("朝の駅は静かだった。あ\n");
    now += 30_000;
    await h.type("朝の駅は静かだった。い\n");
    expect(h.notices).toHaveLength(1);
    expect(h.rescued).toHaveLength(2);
    now += 31_000;
    await h.type("朝の駅は静かだった。う\n");
    expect(h.notices).toHaveLength(2);
  });

  test("鍵の無い話では何もしない", async () => {
    const h = harness({ locked: false });
    await h.type("朝の駅は静かだった。あ\n");
    expect(h.calls).toEqual([]);
    expect(h.rescued).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.text()).toBe("朝の駅は静かだった。あ\n");
  });

  test("素のエディターが前にいない（原稿エディターなど）ときは何もしない", async () => {
    const h = harness({ active: undefined });
    await h.type("朝の駅は静かだった。あ\n");
    expect(h.calls).toEqual([]);
    expect(h.rescued).toEqual([]);
  });

  test("ファイルの中身と同じ（打って消した）なら何もしない", async () => {
    const h = harness();
    await h.type(FILE_TEXT);
    expect(h.calls).toEqual([]);
    expect(h.rescued).toEqual([]);
  });
});
