import { describe, expect, it, vi } from "vitest";
import iconv = require("iconv-lite");
import * as vscode from "vscode";
import {
  createUnencodableWarner,
  handleWillSave,
  recordMarkFindings,
  type ShiftJisSaveDeps,
  type UnencodableSave,
  type UnencodableWarnerDeps,
} from "../../../src/features/shiftJisSave";
import type { Finding, FindingDecision, FindingView } from "../../../src/models/finding";

/**
 * 作者が VS Code で打って保存する道の、Shift_JIS の字の置き換え（設計書5.4.2、0.148.1・0.148.3）。
 *
 * **再現したいこと**：0.148.0 の置き換えは拡張機能が書き戻す道（`writeTextFilePreservingFormat`）
 * だけに効き、作者が素のエディター・原稿エディターで打って保存すると、VS Code 自身が
 * Shift_JIS で書いて「〜」「♡」を黙って「?」（0x3f）にする。保存の直前の受け口
 * （`onWillSaveTextDocument` の `waitUntil`）で、表の字を字ごとに置き換える。
 *
 * 0.148.3（作者の答え 2026-11-09「目印に置き換えた上で、メモ校正パネルに説明を残して、ポップアップも
 * あげてください」）：表に無く書けない字（♡）は「?」にさせず、目印の「〓」に置き換えて保存する。
 */

const WORK = "C:\\小説\\作品";
const EPISODE = `${WORK}\\本文\\001.txt`;

interface FakeDocumentInit {
  text: string;
  /** VS Code 1.90 には無い欄。省くと 1.90 の道（先頭のバイトで決める）を通る */
  encoding?: string;
  filePath?: string;
}

function fakeDocument(init: FakeDocumentInit): vscode.TextDocument {
  const text = init.text;
  const document = {
    uri: vscode.Uri.file(init.filePath ?? EPISODE),
    getText: () => text,
    positionAt: (offset: number) => {
      const before = text.slice(0, offset);
      const lines = before.split("\n");
      return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
    },
    ...(init.encoding === undefined ? {} : { encoding: init.encoding }),
  };
  return document as unknown as vscode.TextDocument;
}

interface Harness {
  deps: ShiftJisSaveDeps;
  logs: string[];
  unencodable: UnencodableSave[];
  clean: string[];
  /** 書き先の作品（undefined＝保管庫）。logs と同じ順 */
  logTargets: Array<string | undefined>;
  /** 登録していない原稿の置き換えの知らせ */
  notices: Array<{ key: string; signature: string; message: string }>;
}

function harness(overrides: Partial<ShiftJisSaveDeps> = {}): Harness {
  const logs: string[] = [];
  const logTargets: Array<string | undefined> = [];
  const unencodable: UnencodableSave[] = [];
  const clean: string[] = [];
  const notices: Array<{ key: string; signature: string; message: string }> = [];
  const deps: ShiftJisSaveDeps = {
    // 作り物の Uri.file はドライブ名を小文字にするので、大文字小文字を無視して比べる
    workFolderOf: (filePath) =>
      filePath.toLowerCase().startsWith(`${WORK}\\本文\\`.toLowerCase()) ? WORK : undefined,
    isUnregisteredManuscript: (filePath) =>
      !filePath.toLowerCase().startsWith(WORK.toLowerCase()) && /\.(txt|md)$/i.test(filePath),
    readBytes: async () => {
      throw new Error("この件ではファイルを読まない");
    },
    configuredEncoding: () => undefined,
    log: (work, message) => {
      logTargets.push(work);
      logs.push(message);
    },
    notifyUnregistered: (document, signature, message) =>
      notices.push({ key: document.uri.toString(), signature, message }),
    onUnencodable: async (report) => {
      unencodable.push(report);
    },
    onClean: (document) => clean.push(document.uri.toString()),
    ...overrides,
  };
  return { deps, logs, logTargets, unencodable, clean, notices };
}

/** 受け口を鳴らし、`waitUntil` に渡された約束を返す（呼ばれなければ undefined） */
function fireRaw(
  document: vscode.TextDocument,
  deps: ShiftJisSaveDeps
): Thenable<readonly vscode.TextEdit[]> | undefined {
  let waited: Thenable<readonly vscode.TextEdit[]> | undefined;
  handleWillSave(
    {
      document,
      waitUntil: (thenable: Thenable<readonly vscode.TextEdit[]>) => {
        waited = thenable;
      },
    },
    deps
  );
  return waited;
}

/** 受け口を鳴らし、`waitUntil` に渡された書き換えを返す（呼ばれなければ undefined） */
async function fire(document: vscode.TextDocument, deps: ShiftJisSaveDeps): Promise<vscode.TextEdit[] | undefined> {
  const waited = fireRaw(document, deps);
  return waited ? [...(await waited)] : undefined;
}

function rangeOf(edit: vscode.TextEdit): string {
  const { start, end } = edit.range;
  return `${start.line}:${start.character}-${end.line}:${end.character}`;
}

describe("保存の直前の Shift_JIS の置き換え（onWillSaveTextDocument）", () => {
  it("Shift_JIS の話では、表の字を字ごとの書き換えで返し、ログに何を何に何個かを残す", async () => {
    const h = harness();
    const edits = await fire(fakeDocument({ text: "あ〜い〜\n𠮟る", encoding: "shiftjis" }), h.deps);
    expect(edits?.map((edit) => [rangeOf(edit), edit.newText])).toEqual([
      ["0:1-0:2", "～"],
      ["0:3-0:4", "～"],
      // 𠮟 はサロゲートの2単位。範囲は元の字の長さで取る
      ["1:0-1:2", "叱"],
    ]);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("001.txt");
    expect(h.logs[0]).toContain("〜→～ 2個、𠮟→叱 1個");
    expect(h.unencodable).toEqual([]);
  });

  it("UTF-8 の話では、保存を待たせず何もしない", async () => {
    const h = harness();
    const edits = await fire(fakeDocument({ text: "あ〜い♡", encoding: "utf8" }), h.deps);
    expect(edits).toBeUndefined();
    expect(h.logs).toEqual([]);
    expect(h.unencodable).toEqual([]);
  });

  it("作品の中の、話でないファイルは、Shift_JIS でも触らない", async () => {
    const h = harness();
    const edits = await fire(
      fakeDocument({ text: "あ〜", encoding: "shiftjis", filePath: `${WORK}\\設定\\メモ.txt` }),
      h.deps
    );
    expect(edits).toBeUndefined();
    expect(h.notices).toEqual([]);
  });

  /*
    再現（2026-11-14 夕 Mac の実機確認）：作品一覧に登録していない Shift_JIS のファイルを原稿エディターで
    保存すると、「〜」が「?」（0x3f）で書かれ、知らせも記録も出なかった（workFolderOf が無く素通り）
  */
  it("登録していない原稿（.txt・.md）でも置き換え、ログは保管庫へ書き、知らせを出す", async () => {
    const h = harness();
    const edits = await fire(
      fakeDocument({ text: "あ〜い〜", encoding: "shiftjis", filePath: "C:\\よそ\\004_シフトJISの話.txt" }),
      h.deps
    );
    expect(edits?.map((edit) => [rangeOf(edit), edit.newText])).toEqual([
      ["0:1-0:2", "～"],
      ["0:3-0:4", "～"],
    ]);
    expect(h.logTargets).toEqual([undefined]);
    expect(h.logs[0]).toContain("〜→～ 2個");
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].message).toContain("004_シフトJISの話.txt");
    expect(h.notices[0].message).toContain("〜→～ 2個");
    expect(h.notices[0].message).toContain("作品一覧に登録していない");
  });

  it("登録していない原稿の〓も、作品を持たないまま知らせの係へ渡す", async () => {
    const h = harness();
    const edits = await fire(
      fakeDocument({ text: "あ♡", encoding: "shiftjis", filePath: "C:\\よそ\\メモ.md" }),
      h.deps
    );
    expect(edits?.map((edit) => edit.newText)).toEqual(["〓"]);
    expect(h.unencodable).toHaveLength(1);
    expect(h.unencodable[0].workFolder).toBeUndefined();
    expect(h.logTargets.every((target) => target === undefined)).toBe(true);
  });

  it("作品の外の原稿でないファイル（.txt・.md でない）は、Shift_JIS でも触らない", async () => {
    const h = harness();
    const edits = await fire(
      fakeDocument({ text: "あ〜", encoding: "shiftjis", filePath: "C:\\よそ\\main.c" }),
      h.deps
    );
    expect(edits).toBeUndefined();
  });

  it("登録した作品の話では、置き換えても知らせない（作者の決定 2026-11-08「黙って」）", async () => {
    const h = harness();
    await fire(fakeDocument({ text: "あ〜", encoding: "shiftjis" }), h.deps);
    expect(h.notices).toEqual([]);
    expect(h.logTargets).toEqual([WORK]);
  });

  it("CRLF の話でも、行と桁は文書の位置で取る（改行を LF に揃えて数えない）", async () => {
    const h = harness();
    const edits = await fire(fakeDocument({ text: "一行目\r\n二〜行目", encoding: "shiftjis" }), h.deps);
    expect(edits?.map(rangeOf)).toEqual(["1:1-1:2"]);
  });

  it("置き換え先の無い字（♡）は「?」にさせず、目印の「〓」へ字ごとに置き換え、場所つきで知らせの係へ渡す", async () => {
    const h = harness();
    const text = "あ〜\nかきくけ♡さしすせ";
    const edits = await fire(fakeDocument({ text, encoding: "shiftjis" }), h.deps);
    expect(edits?.map((edit) => [rangeOf(edit), edit.newText])).toEqual([
      ["0:1-0:2", "～"],
      ["1:4-1:5", "〓"],
    ]);
    expect(h.unencodable).toHaveLength(1);
    const [report] = h.unencodable;
    expect(report.workFolder).toBe(WORK);
    // 控えに残すのは、作者が打ったままの本文（置き換える前）
    expect(report.text).toBe(text);
    // 保存されるのは置き換えたあとの本文
    expect(report.savedText).toBe("あ～\nかきくけ〓さしすせ");
    expect(report.marks).toEqual([{ char: "♡", line: 2, context: "かきくけ〓さしすせ" }]);
    // ログに本文の前後は書かない（字と行だけ）
    expect(h.logs.join("\n")).not.toContain("かきくけ");
    expect(h.logs.join("\n")).toContain("♡");
    expect(h.logs.join("\n")).toContain("〓");
    expect(h.clean).toEqual([]);
  });

  it("〓へ置き換えるのは、控えを残し終えてから（保存の書き換えを、控えが済むまで返さない）", async () => {
    let kept: () => void = () => undefined;
    const h = harness({
      onUnencodable: () =>
        new Promise<void>((resolve) => {
          kept = resolve;
        }),
    });
    const waited = fireRaw(fakeDocument({ text: "♡", encoding: "shiftjis" }), h.deps);
    let settled = false;
    void Promise.resolve(waited).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    kept();
    expect((await waited)?.map((edit) => edit.newText)).toEqual(["〓"]);
  });

  it("控えが持ち時間のうちに済まなくても、保存は待たせ続けない（〓にして返し、ログに残す）", async () => {
    const h = harness({ onUnencodable: () => new Promise<void>(() => undefined), keepWaitMs: 10 });
    const edits = await fire(fakeDocument({ text: "♡", encoding: "shiftjis" }), h.deps);
    expect(edits?.map((edit) => edit.newText)).toEqual(["〓"]);
    expect(h.logs.join("\n")).toContain("控え");
  });

  it("CP932 にある字（①・髙・﨑・〝〟・＂＇）は〓にしない", async () => {
    const h = harness();
    const edits = await fire(fakeDocument({ text: "①髙﨑〝〟＂＇", encoding: "shiftjis" }), h.deps);
    expect(edits).toEqual([]);
    expect(h.unencodable).toEqual([]);
  });

  it("書けない字が無くなった保存では、知らせの係に「もう無い」と伝える", async () => {
    const h = harness();
    await fire(fakeDocument({ text: "あ〜い", encoding: "shiftjis" }), h.deps);
    expect(h.clean).toHaveLength(1);
  });

  describe("VS Code 1.90（文書に文字コードの欄が無い）", () => {
    it("ファイルの先頭のバイトが Shift_JIS なら置き換える", async () => {
      const h = harness({ readBytes: async () => iconv.encode("既にある本文。", "shift_jis") });
      const edits = await fire(fakeDocument({ text: "既にある本文。〜" }), h.deps);
      expect(edits?.map((edit) => edit.newText)).toEqual(["～"]);
    });

    it("ファイルが UTF-8 なら何もしない", async () => {
      const h = harness({ readBytes: async () => new TextEncoder().encode("既にある本文。") });
      const edits = await fire(fakeDocument({ text: "既にある本文。〜" }), h.deps);
      expect(edits).toEqual([]);
    });

    it("バイトが英数字だけで決まらないときは、設定 files.encoding に従う", async () => {
      const ascii = new TextEncoder().encode("abc");
      const sjis = harness({ readBytes: async () => ascii, configuredEncoding: () => "shiftjis" });
      expect((await fire(fakeDocument({ text: "abc〜" }), sjis.deps))?.map((edit) => edit.newText)).toEqual(["～"]);
      const utf8 = harness({ readBytes: async () => ascii, configuredEncoding: () => "utf8" });
      expect(await fire(fakeDocument({ text: "abc〜" }), utf8.deps)).toEqual([]);
    });

    it("まだディスクに無い（読めない）話は、設定 files.encoding に従う", async () => {
      const missing = async (): Promise<Uint8Array> => {
        throw new Error("FileNotFound");
      };
      const sjis = harness({ readBytes: missing, configuredEncoding: () => "shiftjis" });
      expect((await fire(fakeDocument({ text: "〜" }), sjis.deps))?.map((edit) => edit.newText)).toEqual(["～"]);
      const unset = harness({ readBytes: missing });
      expect(await fire(fakeDocument({ text: "〜" }), unset.deps)).toEqual([]);
    });

    it("途中で失敗しても保存を止めない（書き換え無しで返し、ログに残す）", async () => {
      const h = harness({
        readBytes: async () => new TextEncoder().encode("abc"),
        configuredEncoding: () => {
          throw new Error("設定を読めない");
        },
      });
      const edits = await fire(fakeDocument({ text: "〜" }), h.deps);
      expect(edits).toEqual([]);
      expect(h.logs.join("\n")).toContain("設定を読めない");
    });
  });
});

describe("〓にした字の知らせ（控え → 保存 → 校正・メモパネルへ残す → 真ん中の窓）", () => {
  function report(text: string, chars: string[]): UnencodableSave {
    const document = fakeDocument({ text, encoding: "shiftjis" });
    return {
      document,
      filePath: EPISODE,
      workFolder: WORK,
      text,
      savedText: text,
      marks: chars.map((char, index) => ({ char, line: index + 1, context: "〓" })),
    };
  }

  interface WarnerHarness {
    deps: UnencodableWarnerDeps;
    kept: string[];
    recorded: Array<string | undefined>;
    warned: Array<{ message: string; detail: string; buttons: readonly string[] }>;
    opened: string[];
    save(): void;
  }

  function warnerHarness(overrides: Partial<UnencodableWarnerDeps> = {}, answer?: string): WarnerHarness {
    const kept: string[] = [];
    const recorded: Array<string | undefined> = [];
    const warned: Array<{ message: string; detail: string; buttons: readonly string[] }> = [];
    const opened: string[] = [];
    let saves: Array<() => void> = [];
    const deps: UnencodableWarnerDeps = {
      keep: async (_filePath, text) => {
        kept.push(text);
        return `${WORK}\\本文\\.novelai-recovery\\001.txt.bak`;
      },
      whenSaved: () =>
        new Promise<void>((resolve) => {
          saves.push(resolve);
        }),
      record: async (_report, recoveryPath) => {
        recorded.push(recoveryPath);
        return true;
      },
      warn: async (message, detail, buttons) => {
        warned.push({ message, detail, buttons });
        return answer;
      },
      openKeep: (recoveryPath) => opened.push(`控え:${recoveryPath}`),
      openPanel: (workFolder) => opened.push(`パネル:${workFolder}`),
      convert: (filePath) => opened.push(`変換:${filePath}`),
      log: () => undefined,
      ...overrides,
    };
    return {
      deps,
      kept,
      recorded,
      warned,
      opened,
      save: () => {
        const pending = saves;
        saves = [];
        for (const resolve of pending) resolve();
      },
    };
  }

  it("控えを取り、保存が済んでから校正・メモパネルへ残し、真ん中の窓で〓にしたことを知らせる", async () => {
    const h = warnerHarness();
    const warner = createUnencodableWarner(h.deps);
    const keeping = warner.report(report("かきくけ♡\n♡", ["♡", "♡"]));
    await keeping;
    expect(h.kept).toEqual(["かきくけ♡\n♡"]);
    // 保存が済むまでは残さない・知らせない（「〓にして保存しました」を先に言わない）
    expect(h.recorded).toEqual([]);
    expect(h.warned).toEqual([]);
    h.save();
    await vi.waitFor(() => expect(h.warned).toHaveLength(1));
    expect(h.recorded).toEqual([`${WORK}\\本文\\.novelai-recovery\\001.txt.bak`]);
    const [{ message, detail, buttons }] = h.warned;
    expect(message).toBe(
      "Shift_JIS に無い字が2字あったので、「〓」にして保存しました（「♡」1行目 ほか）。校正・メモパネルに場所を残しました。" +
        "この原稿を UTF-8 に変換すれば、この字もそのまま書けます。"
    );
    expect(message).not.toContain("?");
    expect(detail).toContain("001.txt");
    expect(detail).toContain("控え");
    expect(buttons).toEqual(["校正・メモパネルを開く", "控えを開く", "UTF-8 に変換する"]);
  });

  it("1字だけなら「ほか」を付けない", async () => {
    const h = warnerHarness();
    const warner = createUnencodableWarner(h.deps);
    await warner.report(report("♡", ["♡"]));
    h.save();
    await vi.waitFor(() => expect(h.warned).toHaveLength(1));
    expect(h.warned[0].message).toContain("1字あったので、「〓」にして保存しました（「♡」1行目）。");
  });

  it("［校正・メモパネルを開く］を押すとその作品のパネルを、［控えを開く］を押すと控えを開く", async () => {
    const panel = warnerHarness({}, "校正・メモパネルを開く");
    await createUnencodableWarner(panel.deps).report(report("♡", ["♡"]));
    panel.save();
    await vi.waitFor(() => expect(panel.opened).toEqual([`パネル:${WORK}`]));

    const keep = warnerHarness({}, "控えを開く");
    await createUnencodableWarner(keep.deps).report(report("♡", ["♡"]));
    keep.save();
    await vi.waitFor(() => expect(keep.opened).toEqual([`控え:${WORK}\\本文\\.novelai-recovery\\001.txt.bak`]));
  });

  it("［UTF-8 に変換する］を押すと、この原稿を UTF-8 に変換する命令を呼ぶ（作者の指示 2026-11-09）", async () => {
    const h = warnerHarness({}, "UTF-8 に変換する");
    const saved = report("♡", ["♡"]);
    await createUnencodableWarner(h.deps).report(saved);
    h.save();
    await vi.waitFor(() => expect(h.opened).toEqual([`変換:${saved.filePath}`]));
  });

  it("同じ字の組の窓は2度出さない。ただし控えとパネルの行は毎回残す（本文の字は毎回〓になるため）", async () => {
    const h = warnerHarness();
    const warner = createUnencodableWarner(h.deps);
    await warner.report(report("かきくけ♡", ["♡"]));
    h.save();
    await vi.waitFor(() => expect(h.warned).toHaveLength(1));

    // 自動保存で続けて鳴っても、同じ字の組なら窓は1回だけ
    await warner.report(report("かきくけ♡あ", ["♡"]));
    h.save();
    await vi.waitFor(() => expect(h.recorded).toHaveLength(2));
    expect(h.kept).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.warned).toHaveLength(1);

    // 書けない字が一度無くなったあとに、また打ったら知らせ直す
    warner.forget(report("", []).document);
    await warner.report(report("かきくけ♡", ["♡"]));
    h.save();
    await vi.waitFor(() => expect(h.warned).toHaveLength(2));
  });

  it("控えを取れなかったときは、控えが無いことを書き、［控えを開く］を出さない", async () => {
    const h = warnerHarness({ keep: async () => undefined });
    await createUnencodableWarner(h.deps).report(report("♡", ["♡"]));
    h.save();
    await vi.waitFor(() => expect(h.warned).toHaveLength(1));
    expect(h.warned[0].detail).toContain("控えを残せませんでした");
    expect(h.warned[0].buttons).toEqual(["校正・メモパネルを開く", "UTF-8 に変換する"]);
    expect(h.recorded).toEqual([undefined]);
  });

  it("校正・メモパネルへ残せなかったときは、残せなかったと書き、［校正・メモパネルを開く］を出さない", async () => {
    const h = warnerHarness({
      record: async () => {
        throw new Error("書けない");
      },
    });
    await createUnencodableWarner(h.deps).report(report("♡", ["♡"]));
    h.save();
    await vi.waitFor(() => expect(h.warned).toHaveLength(1));
    expect(h.warned[0].message).toContain("校正・メモパネルには場所を残せませんでした");
    expect(h.warned[0].buttons).toEqual(["控えを開く", "UTF-8 に変換する"]);
  });

  it("登録していない原稿では、登録していないのでパネルに残していないと書き、パネルのボタンを出さない（0.152.10）", async () => {
    const h = warnerHarness({ record: async () => false });
    await createUnencodableWarner(h.deps).report({ ...report("♡", ["♡"]), workFolder: undefined });
    h.save();
    await vi.waitFor(() => expect(h.warned).toHaveLength(1));
    expect(h.warned[0].message).toContain("作品一覧に登録していないので、校正・メモパネルには場所を残していません");
    expect(h.warned[0].buttons).toEqual(["控えを開く", "UTF-8 に変換する"]);
  });
});

describe("〓にした字の行を、校正・メモパネルの置き場へ足す", () => {
  function finding(id: string): Finding {
    return {
      id,
      time: "2026-11-09T00:00:00.000Z",
      file: "本文/001.txt",
      hintLine: 1,
      original: "〓",
      target: "〓",
      suggestion: "",
      before: "",
      after: "",
      message: "",
      category: "other",
      label: "Shift_JIS に無い字",
    };
  }

  function store(existing: FindingView[]) {
    const recorded: Finding[] = [];
    const decided: FindingDecision[] = [];
    return {
      recorded,
      decided,
      load: async () => existing,
      record: async (findings: readonly Finding[]) => {
        recorded.push(...findings);
      },
      decide: async (decisions: readonly FindingDecision[]) => {
        decided.push(...decisions);
      },
    };
  }

  it("足す。前に見送った同じ番号の行は、未決へ戻す（同じ場所にまた〓を置いたので）", async () => {
    const dismissed: FindingView = { ...finding("f1"), status: "dismissed" };
    const fake = store([dismissed]);
    const count = await recordMarkFindings(fake, [finding("f1"), finding("f2")], "2026-11-09T01:00:00.000Z");
    expect(count).toBe(2);
    expect(fake.recorded.map(({ id }) => id)).toEqual(["f1", "f2"]);
    expect(fake.decided).toEqual([
      { findingId: "f1", time: "2026-11-09T01:00:00.000Z", status: "pending", note: expect.stringContaining("〓") },
    ]);
  });

  it("足すものが無ければ置き場に触らない", async () => {
    const fake = store([]);
    expect(await recordMarkFindings(fake, [], "2026-11-09T01:00:00.000Z")).toBe(0);
    expect(fake.recorded).toEqual([]);
    expect(fake.decided).toEqual([]);
  });
});
