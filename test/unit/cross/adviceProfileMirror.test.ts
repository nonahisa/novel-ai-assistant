import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Uri, workspace } from "vscode";
import {
  ADVICE_MIRROR_DEFAULT_KEY,
  ADVICE_MIRROR_FILE,
  ADVICE_MIRROR_SCHEMA,
  adviceMirrorKey,
  adviceProfileFingerprint,
  isAdviceMirrorNewer,
  parseAdviceMirror,
  type AdviceMirrorFile,
} from "../../src/core/adviceProfileMirror";
import {
  ADVICE_STORAGE_ENV,
  updateAdviceProfile,
} from "../../src/mcp/adviceProfileMirror";
import { chatPrompt, chatValidate } from "../../src/mcp/tools/chat";
import type { AdviceProfile } from "../../src/core/advicePolicy";
import { AdvicePolicyStore } from "../../src/core/advicePolicyStore";
import {
  importAdviceProfileMirror,
  refreshAdviceProfileMirror,
} from "../../src/features/adviceProfileMirror";
import type { WorkEntry } from "../../src/models/types";

/**
 * 助言方針の控え（設計書6.86.7）。
 *
 * **見るのは4つ。**
 *
 * 1. MCP が控えから読めること（外部AI経由の相談にも、タイプと調子が効く）
 * 2. 明示（`adviceAnswers`）のほうが優先されること
 * 3. 相談の答えの `profileSignals` で状態が動き、控えへ書き戻ること
 *    （±0.5ずつ・受容度「低」は2回続かないと下げない・14日で切れる）
 * 4. **作品フォルダーへは1バイトも書かないこと**——作者の目にも Git にも
 *    触れさせないというのが、この仕組みの前提そのものである
 */

/** 試験のあいだだけ使う置き場。**本物の保管庫も作品も触らない** */
let storage = "";
let work = "";
let previousEnv: string | undefined;

function mirrorPath(): string {
  return nodePath.join(storage, ADVICE_MIRROR_FILE);
}

function writeMirror(file: AdviceMirrorFile): void {
  fs.writeFileSync(mirrorPath(), JSON.stringify(file, null, 2), "utf8");
}

function readMirror(): AdviceMirrorFile {
  const parsed = parseAdviceMirror(fs.readFileSync(mirrorPath(), "utf8"));
  if (!parsed) throw new Error("控えを読めませんでした");
  return parsed;
}

/** 読者志向が高い作者（読者最適型）。点数は9問の答えから作られる形と同じ */
function sampleProfile(overrides: Partial<AdviceProfile> = {}): AdviceProfile {
  return {
    scores: { reader: 6, self: 2, taste: 1 },
    answers: [2, 2, 2, 1, 1, 0, 0, 1, 0],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** 時計が1ミリ秒進むまで待つ（書き出しと書き戻しの前後関係を作るため） */
async function waitForNextMillisecond(): Promise<void> {
  const started = Date.now();
  while (Date.now() === started) {
    await new Promise((done) => setTimeout(done, 1));
  }
}

/** 中身のあるファイルを、道つきで数える（作品フォルダーを見張るため） */
function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = nodePath.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

beforeEach(() => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-advice-"));
  storage = nodePath.join(root, "storage");
  work = nodePath.join(root, "作品");
  fs.mkdirSync(storage, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  previousEnv = process.env[ADVICE_STORAGE_ENV];
  process.env[ADVICE_STORAGE_ENV] = storage;
});

afterEach(() => {
  if (previousEnv === undefined) delete process.env[ADVICE_STORAGE_ENV];
  else process.env[ADVICE_STORAGE_ENV] = previousEnv;
});

describe("控えの形（core）", () => {
  test("道の書き方が違っても、同じ作品は同じ鍵になる", () => {
    expect(adviceMirrorKey("C:\\Users\\nona\\作品\\")).toBe(
      adviceMirrorKey("c:/users/nona/作品")
    );
  });

  test("どちらが新しいか決められないときは、控えを新しいと言わない", () => {
    const at = "2026-09-20T00:00:00.000Z";
    // 同じ時刻・古い・日付が読めない——どれも「手元を残す」
    expect(isAdviceMirrorNewer(at, at)).toBe(false);
    expect(isAdviceMirrorNewer("2026-09-19T00:00:00.000Z", at)).toBe(false);
    expect(isAdviceMirrorNewer("いつか", at)).toBe(false);
    expect(isAdviceMirrorNewer(at, "いつか")).toBe(false);
    // まだ一度も取り込んでいなければ、控えが新しい
    expect(isAdviceMirrorNewer(at, undefined)).toBe(true);
    expect(isAdviceMirrorNewer("2026-09-21T00:00:00.000Z", at)).toBe(true);
  });

  test("壊れた控え・知らない値は、無かったことにする", () => {
    expect(parseAdviceMirror("{")).toBeUndefined();
    expect(parseAdviceMirror(JSON.stringify({ schema: 99, entries: [] }))).toBeUndefined();

    const file = parseAdviceMirror(
      JSON.stringify({
        schema: ADVICE_MIRROR_SCHEMA,
        entries: [
          { key: "a", updatedAt: "x", profile: { scores: { reader: "たくさん" } } },
          {
            key: "b",
            updatedAt: "x",
            profile: {
              scores: { reader: 1, self: 2, taste: 3 },
              answers: [0, 1, 2],
              updatedAt: "y",
              state: { acceptance: "とても低い", confidence: "mid", updatedAt: "y" },
            },
          },
        ],
      })
    );
    // 点数が読めないものは丸ごと落ち、読めない調子だけが落ちる
    expect(file?.entries.map((entry) => entry.key)).toEqual(["b"]);
    expect(file?.entries[0].profile.state).toBeUndefined();
  });

  test("中身が同じなら、指紋も同じ（鍵の並びに引きずられない）", () => {
    const a: AdviceProfile = {
      scores: { reader: 6, self: 2, taste: 1 },
      answers: [2, 2, 2, 1, 1, 0, 0, 1, 0],
      updatedAt: "2026-09-20T00:00:00.000Z",
    };
    const b: AdviceProfile = {
      updatedAt: "2026-09-20T00:00:00.000Z",
      answers: [2, 2, 2, 1, 1, 0, 0, 1, 0],
      scores: { taste: 1, self: 2, reader: 6 },
    };
    expect(adviceProfileFingerprint(a)).toBe(adviceProfileFingerprint(b));
  });
});

describe("MCP は控えから読む", () => {
  test("控えがあれば、渡されなくても助言方針を足す", () => {
    writeMirror({
      schema: ADVICE_MIRROR_SCHEMA,
      entries: [
        {
          key: adviceMirrorKey(work),
          folderPath: work,
          updatedAt: new Date().toISOString(),
          profile: sampleProfile(),
        },
      ],
    });

    const result = chatPrompt({ folder: work, question: "どう思いますか" });

    expect(result.diagnoses.advicePolicy).toBe(true);
    expect(result.diagnoses.advicePolicySource).toBe("mirror");
    expect(result.systemPrompt).toContain("【この作者への助言の方針】");
  });

  test("作品の控えが無ければ、作者の既定へ落ちる（製品と同じ）", () => {
    writeMirror({
      schema: ADVICE_MIRROR_SCHEMA,
      entries: [
        {
          key: ADVICE_MIRROR_DEFAULT_KEY,
          updatedAt: new Date().toISOString(),
          profile: sampleProfile(),
        },
      ],
    });

    expect(chatPrompt({ folder: work, question: "どう" }).diagnoses.advicePolicy).toBe(
      true
    );
  });

  test("渡された答えのほうが優先される（控えは上書きしない）", () => {
    writeMirror({
      schema: ADVICE_MIRROR_SCHEMA,
      entries: [
        {
          key: adviceMirrorKey(work),
          updatedAt: new Date().toISOString(),
          profile: sampleProfile(),
        },
      ],
    });

    const result = chatPrompt({
      folder: work,
      question: "どう思いますか",
      adviceAnswers: [0, 0, 0, 2, 2, 2, 0, 0, 0],
    });

    expect(result.diagnoses.advicePolicySource).toBe("input");
  });

  test("控えが無ければ、黙って省かずに理由を言う", () => {
    const result = chatPrompt({ folder: work, question: "どう思いますか" });

    expect(result.diagnoses.advicePolicy).toBe(false);
    expect(result.diagnoses.omitted.join("\n")).toContain("adviceAnswers");
  });

  /**
   * **調子は14日で切れる**（`isStateFresh`）。切れても相談は止まらず、
   * タイプの方針だけが送られる。迂回していないことを、ここで見張る。
   */
  test("14日を過ぎた調子は送らない（方針そのものは送る）", () => {
    const stale = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    writeMirror({
      schema: ADVICE_MIRROR_SCHEMA,
      entries: [
        {
          key: adviceMirrorKey(work),
          updatedAt: new Date().toISOString(),
          profile: sampleProfile({
            state: { acceptance: "low", confidence: "low", updatedAt: stale },
          }),
        },
      ],
    });

    const result = chatPrompt({ folder: work, question: "どう" });
    expect(result.systemPrompt).toContain("【この作者への助言の方針】");
    expect(result.systemPrompt).not.toContain("【いまの調子】");
  });

  test("14日以内の調子は送る", () => {
    writeMirror({
      schema: ADVICE_MIRROR_SCHEMA,
      entries: [
        {
          key: adviceMirrorKey(work),
          updatedAt: new Date().toISOString(),
          profile: sampleProfile({
            state: {
              acceptance: "low",
              confidence: "low",
              updatedAt: new Date().toISOString(),
            },
          }),
        },
      ],
    });

    expect(chatPrompt({ folder: work, question: "どう" }).systemPrompt).toContain(
      "【いまの調子】"
    );
  });
});

describe("相談の答えから、控えを書き戻す", () => {
  function answer(signals: Record<string, unknown>): string {
    return JSON.stringify({ reply: "そう思います。", profileSignals: signals });
  }

  function putProfile(profile: AdviceProfile): void {
    writeMirror({
      schema: ADVICE_MIRROR_SCHEMA,
      entries: [
        {
          key: adviceMirrorKey(work),
          folderPath: work,
          updatedAt: "2026-09-01T00:00:00.000Z",
          profile,
        },
      ],
    });
  }

  test("点数は±0.5ずつ動き、動かしたことを（中身は伏せて）知らせる", () => {
    putProfile(sampleProfile({ scores: { reader: 3, self: 2, taste: 1 } }));

    const result = chatValidate({ folder: work, response: answer({ reader: 1 }) });

    expect(result.adviceProfileNote).toBeDefined();
    // **受容度・自信度そのものは返さない**（作者にも見せないと決めたもの）
    expect(result.adviceProfileNote).not.toMatch(/受容度|自信度|low|high/);

    const entry = readMirror().entries[0];
    expect(entry.profile.scores.reader).toBe(3.5);
    // 書き戻した時刻が動く（どちらが新しいかの唯一の手掛かり）
    expect(entry.updatedAt).not.toBe("2026-09-01T00:00:00.000Z");
  });

  test("受容度「低」は、2回続かないと下げない", () => {
    putProfile(sampleProfile());

    // **別々の相談の答えにする。** 同じ文字列を2回渡すのは「撃ち直し」で、
    // そちらは1回しか効かない（下の「同じ答えを2回渡しても」）
    chatValidate({
      folder: work,
      response: JSON.stringify({
        reply: "いまは感想がほしいです。",
        profileSignals: { acceptance: "low" },
      }),
    });
    expect(readMirror().entries[0].profile.state?.acceptance).toBe("mid");

    chatValidate({
      folder: work,
      response: JSON.stringify({
        reply: "やはり指摘はつらいです。",
        profileSignals: { acceptance: "low" },
      }),
    });
    expect(readMirror().entries[0].profile.state?.acceptance).toBe("low");
  });

  /**
   * **撃ち直しで歯止めを迂回させない。** 外部AIは `novel.validate` を
   * 2回撃てる（間違えて撃つ）。素直に効かせると ±0.5 が ±1.0 になり、
   * 「段階が1つ動くまでおおよそ10回の相談が要る」という設計が崩れる。
   */
  test("同じ答えを2回渡しても、1回しか効かない", () => {
    putProfile(sampleProfile({ scores: { reader: 3, self: 2, taste: 1 } }));
    const response = answer({ reader: 1 });

    const first = chatValidate({ folder: work, response });
    const second = chatValidate({ folder: work, response });

    expect(readMirror().entries[0].profile.scores.reader).toBe(3.5);
    expect(first.adviceProfileNote).toContain("更新");
    // 2回目は「反映済み」と伝える（黙って無視しない／値は漏らさない）
    expect(second.adviceProfileNote).toContain("反映済み");
    expect(second.adviceProfileNote).not.toMatch(/受容度|自信度|low|high/);
  });

  /*
    **同じ文面でも、時間が空けば別の相談である。**

    弾きたいのは「撃ち直し」（秒のうちの二度撃ち）だけで、そこまで
    まとめて弾くと**受容度「低」の連続判定が永久に成立しない**——
    2回続かないと下げない、という歯止めが、下げる側だけ効かなくなる。
    **指摘がきつくて2回続けて同じ反応を返した作者が、いつまでも
    「受け取れる人」のままになる。**

    小さいモデルは同じ文面を返しやすい（2026-09-20 の測定で `gemma4:12b`
    が2つの話で2回とも同じ空の答えを返した）ので、現実に起きる。
  */
  test("同じ答えでも、60秒より後なら効く", () => {
    putProfile(sampleProfile({ scores: { reader: 3, self: 2, taste: 1 } }));
    const response = answer({ reader: 1 });

    const at = new Date("2026-09-20T10:00:00.000Z");
    updateAdviceProfile(work, { reader: 1 }, "same-hash", at);
    expect(readMirror().entries[0].profile.scores.reader).toBe(3.5);

    // 30秒後——撃ち直しとみなして弾く
    const soon = new Date(at.getTime() + 30_000);
    expect(updateAdviceProfile(work, { reader: 1 }, "same-hash", soon)).toBe(
      "duplicate"
    );
    expect(readMirror().entries[0].profile.scores.reader).toBe(3.5);

    // 90秒後——別の相談とみなして効かせる
    const later = new Date(at.getTime() + 90_000);
    expect(updateAdviceProfile(work, { reader: 1 }, "same-hash", later)).toBe(
      "updated"
    );
    expect(readMirror().entries[0].profile.scores.reader).toBe(4);
    expect(response).toBeTruthy();
  });

  test("違う答えなら、2回目も効く", () => {
    putProfile(sampleProfile({ scores: { reader: 3, self: 2, taste: 1 } }));

    chatValidate({ folder: work, response: answer({ reader: 1 }) });
    chatValidate({
      folder: work,
      // 同じ傾向でも、答えの文が違えば別の相談である
      response: JSON.stringify({
        reply: "なるほど、そう思います。",
        profileSignals: { reader: 1 },
      }),
    });

    expect(readMirror().entries[0].profile.scores.reader).toBe(4);
  });

  test("指紋を持たない古い控えも、そのまま読めて効く", () => {
    // 0.71.x より前に書かれた形（`lastSignalHash` が無い）
    writeMirror({
      schema: ADVICE_MIRROR_SCHEMA,
      entries: [
        {
          key: adviceMirrorKey(work),
          updatedAt: "2026-09-01T00:00:00.000Z",
          profile: sampleProfile({ scores: { reader: 3, self: 2, taste: 1 } }),
        },
      ],
    });

    const result = chatValidate({ folder: work, response: answer({ reader: 1 }) });

    expect(result.adviceProfileNote).toContain("更新");
    expect(readMirror().entries[0].profile.scores.reader).toBe(3.5);
    // 効かせたあとは指紋が入る（次の撃ち直しはここで止まる）
    expect(readMirror().entries[0].lastSignalHash).toBeDefined();
  });

  test("形の違う値は捨てる（点数を壊さない）", () => {
    putProfile(sampleProfile({ scores: { reader: 3, self: 2, taste: 1 } }));

    const result = chatValidate({
      folder: work,
      // 指示語がそのまま返ってきた形。`parseProfileSignals` が落とす
      response: answer({ reader: "+1", acceptance: "low|mid|high" }),
    });

    expect(result.adviceProfileNote).toBeUndefined();
    expect(readMirror().entries[0].profile.scores.reader).toBe(3);
  });

  test("既定しか無い作品では、作品の控えができ、既定は動かない", () => {
    writeMirror({
      schema: ADVICE_MIRROR_SCHEMA,
      entries: [
        {
          key: ADVICE_MIRROR_DEFAULT_KEY,
          updatedAt: "2026-09-01T00:00:00.000Z",
          profile: sampleProfile({ scores: { reader: 3, self: 2, taste: 1 } }),
        },
      ],
    });

    chatValidate({ folder: work, response: answer({ reader: 1 }) });

    const file = readMirror();
    const fallback = file.entries.find(
      (entry) => entry.key === ADVICE_MIRROR_DEFAULT_KEY
    );
    const own = file.entries.find((entry) => entry.key === adviceMirrorKey(work));
    expect(fallback?.profile.scores.reader).toBe(3);
    expect(own?.profile.scores.reader).toBe(3.5);
  });

  test("方針がどこにも無ければ、推定で生やさない", () => {
    const result = chatValidate({ folder: work, response: answer({ reader: 1 }) });

    expect(result.adviceProfileNote).toBeUndefined();
    expect(fs.existsSync(mirrorPath())).toBe(false);
  });

  /**
   * **ここが「可能な限り隠蔽」の中身である。** 控えも書き戻しも、
   * 作者が普段開く場所（作品フォルダー、`.aiwriter/` を含む）には出ない。
   */
  test("作品フォルダーへは1バイトも書かない", () => {
    writeMirror({
      schema: ADVICE_MIRROR_SCHEMA,
      entries: [
        {
          key: adviceMirrorKey(work),
          updatedAt: "2026-09-01T00:00:00.000Z",
          profile: sampleProfile(),
        },
      ],
    });
    const before = filesUnder(work);

    chatPrompt({ folder: work, question: "どう思いますか" });
    chatValidate({ folder: work, response: answer({ reader: 1, acceptance: "high" }) });

    expect(filesUnder(work)).toEqual(before);
    expect(before).toEqual([]);
  });
});

/**
 * 拡張機能の側（書き出しと取り込み）。
 *
 * `vscode.workspace.fs` は試験では空なので、**本物のファイルへ落とす代役**を
 * 差し込む。控えは MCP（Node の `fs`）と同じ場所を見るので、
 * 記憶の中だけで動かすと、この仕組みの肝（同じ場所を2つのプロセスが見る）が
 * 試験から消える。
 */
describe("拡張機能が控えを書き出す／取り込む", () => {
  function installNodeFileSystem(): void {
    (workspace as { fs: unknown }).fs = {
      readFile: async (uri: { fsPath: string }): Promise<Uint8Array> =>
        fs.readFileSync(uri.fsPath),
      writeFile: async (
        uri: { fsPath: string },
        bytes: Uint8Array
      ): Promise<void> => {
        fs.writeFileSync(uri.fsPath, bytes);
      },
      rename: async (
        from: { fsPath: string },
        to: { fsPath: string }
      ): Promise<void> => {
        fs.renameSync(from.fsPath, to.fsPath);
      },
      createDirectory: async (uri: { fsPath: string }): Promise<void> => {
        fs.mkdirSync(uri.fsPath, { recursive: true });
      },
      delete: async (uri: { fsPath: string }): Promise<void> => {
        fs.rmSync(uri.fsPath, { force: true });
      },
      stat: async (uri: { fsPath: string }): Promise<unknown> => {
        const stat = fs.statSync(uri.fsPath);
        return {
          type: stat.isDirectory() ? 2 : 1,
          size: stat.size,
          mtime: stat.mtimeMs,
          ctime: stat.ctimeMs,
        };
      },
    };
  }

  /** `globalState` の代役（`vscode.Memento`） */
  function memento(): {
    values: Map<string, unknown>;
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Promise<void>;
  } {
    const values = new Map<string, unknown>();
    return {
      values,
      get<T>(key: string): T | undefined {
        return values.get(key) as T | undefined;
      },
      async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) values.delete(key);
        else values.set(key, value);
      },
    };
  }

  function context(state: ReturnType<typeof memento>): never {
    return { globalStorageUri: Uri.file(storage), globalState: state } as never;
  }

  function workEntry(): WorkEntry {
    return {
      id: "w1",
      title: "作品",
      folderPath: work,
      registeredAt: "2026-09-01T00:00:00.000Z",
    };
  }

  beforeEach(() => {
    installNodeFileSystem();
  });

  test("方針を控えへ書き出す。置き先は保管庫で、作品フォルダーではない", async () => {
    const state = memento();
    const store = new AdvicePolicyStore(state as never);
    await store.set("w1", sampleProfile());

    await refreshAdviceProfileMirror(context(state), store, [workEntry()]);

    const entry = readMirror().entries.find(
      (item) => item.key === adviceMirrorKey(work)
    );
    expect(entry?.workId).toBe("w1");
    expect(entry?.profile.scores.reader).toBe(6);
    expect(filesUnder(work)).toEqual([]);
  });

  test("中身が変わらなければ、控えの時刻を動かさない", async () => {
    const state = memento();
    const store = new AdvicePolicyStore(state as never);
    await store.set("w1", sampleProfile());

    await refreshAdviceProfileMirror(context(state), store, [workEntry()]);
    const first = readMirror().entries[0].updatedAt;
    await refreshAdviceProfileMirror(context(state), store, [workEntry()]);

    expect(readMirror().entries[0].updatedAt).toBe(first);
  });

  test("作者が方針を消したら、控えからも消す", async () => {
    const state = memento();
    const store = new AdvicePolicyStore(state as never);
    await store.set("w1", sampleProfile());
    await refreshAdviceProfileMirror(context(state), store, [workEntry()]);

    await store.clear("w1");
    await refreshAdviceProfileMirror(context(state), store, [workEntry()]);

    expect(readMirror().entries).toEqual([]);
  });

  test("書き出し直しても、効かせた答えの指紋は消えない", async () => {
    const state = memento();
    const store = new AdvicePolicyStore(state as never);
    await store.set("w1", sampleProfile({ scores: { reader: 3, self: 2, taste: 1 } }));
    await refreshAdviceProfileMirror(context(state), store, [workEntry()]);

    const response = JSON.stringify({
      reply: "はい",
      profileSignals: { reader: 1 },
    });
    // 書き出しと書き戻しが同じミリ秒に並ぶと、取り込みが「決められない」に
    // 倒れて手元が残る（そちらは別の試験で見ている）。ここで見たいのは指紋
    await waitForNextMillisecond();
    chatValidate({ folder: work, response });

    // 起動しなおした形（取り込み → 書き出し）
    await importAdviceProfileMirror(context(state), store, [workEntry()]);
    await refreshAdviceProfileMirror(context(state), store, [workEntry()]);

    // ここで同じ答えをもう一度渡しても、二度は効かない
    const again = chatValidate({ folder: work, response });
    expect(again.adviceProfileNote).toContain("反映済み");
    expect(readMirror().entries[0].profile.scores.reader).toBe(3.5);
  });

  test("控えのほうが新しければ取り込む（MCP が動かしたぶん）", async () => {
    const state = memento();
    const store = new AdvicePolicyStore(state as never);
    await store.set("w1", sampleProfile({ scores: { reader: 3, self: 2, taste: 1 } }));
    await refreshAdviceProfileMirror(context(state), store, [workEntry()]);

    // **時計が進むのを待つ。** 新しいかどうかはミリ秒で比べるので、同じ
    // ミリ秒に書き出しと書き戻しが並ぶと「決められない＝手元を残す」に倒れる
    // （実機では起動と相談のあいだに秒単位の間がある）
    await waitForNextMillisecond();

    // 外部AI経由の相談で動いた、という形を作る
    chatValidate({
      folder: work,
      response: JSON.stringify({ reply: "はい", profileSignals: { reader: 1 } }),
    });

    await importAdviceProfileMirror(context(state), store, [workEntry()]);

    expect(store.get("w1")?.scores.reader).toBe(3.5);
  });

  test("控えが古ければ、手元（globalState）を残す", async () => {
    const state = memento();
    const store = new AdvicePolicyStore(state as never);
    await store.set("w1", sampleProfile({ scores: { reader: 3, self: 2, taste: 1 } }));
    await refreshAdviceProfileMirror(context(state), store, [workEntry()]);

    // 控えだけを古い時刻のまま別の値に差し替える（外から書かれた形）
    const file = readMirror();
    writeMirror({
      schema: ADVICE_MIRROR_SCHEMA,
      entries: file.entries.map((entry) => ({
        ...entry,
        updatedAt: "2026-01-01T00:00:00.000Z",
        profile: { ...entry.profile, scores: { reader: 0, self: 0, taste: 0 } },
      })),
    });

    await importAdviceProfileMirror(context(state), store, [workEntry()]);

    expect(store.get("w1")?.scores.reader).toBe(3);
  });

  test("登録簿に無い作品の控えは取り込まない", async () => {
    const state = memento();
    const store = new AdvicePolicyStore(state as never);
    writeMirror({
      schema: ADVICE_MIRROR_SCHEMA,
      entries: [
        {
          key: adviceMirrorKey(nodePath.join(storage, "よその作品")),
          workId: "よそのID",
          updatedAt: new Date().toISOString(),
          profile: sampleProfile(),
        },
      ],
    });

    await importAdviceProfileMirror(context(state), store, [workEntry()]);

    expect(store.get("w1")).toBeUndefined();
    expect(store.getDefault()).toBeUndefined();
  });
});
