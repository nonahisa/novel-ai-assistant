import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Uri, workspace } from "vscode";
import {
  parseWriterMirror,
  serializeWriterMirror,
  WRITER_MIRROR_FILE,
  WRITER_MIRROR_SCHEMA,
  type WriterMirrorFile,
} from "../../../src/core/writerProfileMirror";
import { ADVICE_STORAGE_ENV } from "../../../src/mcp/adviceProfileMirror";
import { chatPrompt, chatValidate } from "../../../src/mcp/tools/chat";
import {
  WriterProfileStore,
  type WriterProfile,
} from "../../../src/core/writerProfileStore";
import type { WriterStyle } from "../../../src/core/writerStyle";
import {
  importWriterProfileMirror,
  refreshWriterProfileMirror,
} from "../../../src/features/adviceProfileMirror";

/**
 * 執筆スタイル（作家タイプ診断の5問）の控え（点検、2026-09-23）。
 *
 * 外部AI（MCP）経由の相談には、段取り・直す時期が**明示したときだけ**
 * 乗り、相談で読み取った直す時期（`writerStyleSignals`）も書き戻されて
 * いなかった。助言方針の控え（6.86.7）と同じ道で塞いだ。
 *
 * 見るのは——
 *
 * 1. MCP が控えから読めること（渡さなくても乗る）／明示が優先されること
 * 2. `writerStyleSignals` が**製品と同じ歯止め**（2回続けて同じに読めたら反映）
 *    で書き戻されること、**同じ答えは二度効かないこと**
 * 3. 診断していない作者の値を、推定で生やさないこと
 * 4. 拡張機能が書き出す／取り込むこと。**作品フォルダーへは書かないこと**
 */

let storage = "";
let work = "";
let previousEnv: string | undefined;

function mirrorPath(): string {
  return nodePath.join(storage, WRITER_MIRROR_FILE);
}

function writeMirror(file: WriterMirrorFile): void {
  fs.writeFileSync(mirrorPath(), serializeWriterMirror(file), "utf8");
}

function readMirror(): WriterMirrorFile {
  const parsed = parseWriterMirror(fs.readFileSync(mirrorPath(), "utf8"));
  if (!parsed) throw new Error("控えを読めませんでした");
  return parsed;
}

const STYLE: WriterStyle = {
  situation: "have_files",
  plan: "hybrid",
  revise: "per_episode",
  material: "memo",
  outlet: "serial",
};

function sampleProfile(overrides: Partial<WriterProfile> = {}): WriterProfile {
  return { style: STYLE, updatedAt: "2026-09-13T00:00:00.000Z", ...overrides };
}

function putProfile(profile: WriterProfile = sampleProfile()): void {
  writeMirror({
    schema: WRITER_MIRROR_SCHEMA,
    updatedAt: "2026-09-20T00:00:00.000Z",
    profile,
  });
}

function answer(revise: string, reply = "そうですね。"): string {
  return JSON.stringify({ reply, writerStyleSignals: { revise } });
}

/** 時計が1ミリ秒進むまで待つ（書き出しと書き戻しの前後関係を作るため） */
async function waitForNextMillisecond(): Promise<void> {
  const started = Date.now();
  while (Date.now() === started) {
    await new Promise((done) => setTimeout(done, 1));
  }
}

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
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-writer-"));
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

describe("MCP は控えから執筆スタイルを読む", () => {
  test("控えがあれば、渡されなくても段取りと直す時期を足す", () => {
    putProfile();

    const result = chatPrompt({ folder: work, question: "どう思いますか" });

    expect(result.diagnoses.writerStyle).toBe(true);
    expect(result.diagnoses.writerStyleSource).toBe("mirror");
    expect(result.systemPrompt).toContain("【この作者の書き方】");
    expect(result.diagnoses.omitted.join("\n")).not.toContain("執筆スタイル");
  });

  test("渡された答えのほうが優先される（控えは上書きしない）", () => {
    putProfile();

    const result = chatPrompt({
      folder: work,
      question: "どう思いますか",
      writerStyle: { ...STYLE, plan: "improviser" },
    });

    expect(result.diagnoses.writerStyleSource).toBe("input");
  });

  test("控えが無ければ、黙って省かずに理由を言う", () => {
    const result = chatPrompt({ folder: work, question: "どう思いますか" });

    expect(result.diagnoses.writerStyle).toBe(false);
    expect(result.diagnoses.omitted.join("\n")).toContain("writerStyle");
  });

  test("壊れた控え・知らない値は、無かったことにする", () => {
    fs.writeFileSync(mirrorPath(), "{", "utf8");
    expect(chatPrompt({ folder: work, question: "どう" }).diagnoses.writerStyle).toBe(
      false
    );

    fs.writeFileSync(
      mirrorPath(),
      JSON.stringify({
        schema: WRITER_MIRROR_SCHEMA,
        updatedAt: "2026-09-20T00:00:00.000Z",
        profile: {
          style: { ...STYLE, plan: "そんな段取りは無い" },
          updatedAt: "2026-09-13T00:00:00.000Z",
        },
      }),
      "utf8"
    );
    expect(chatPrompt({ folder: work, question: "どう" }).diagnoses.writerStyle).toBe(
      false
    );
  });
});

describe("相談の答えから、直す時期を書き戻す", () => {
  test("1回目は数えるだけ、2回続けて同じに読めたら変わり、変わったことを中身ごと知らせる", () => {
    putProfile();

    const first = chatValidate({ folder: work, response: answer("after_all", "1") });
    expect(first.writerStyleNote).toContain("1回目");
    expect(readMirror().profile.style.revise).toBe("per_episode");

    const second = chatValidate({ folder: work, response: answer("after_all", "2") });
    expect(second.writerStyleNote).toContain("書き終えてから");
    expect(second.writerStyleNote).toContain("作家タイプ診断");
    expect(readMirror().profile.style.revise).toBe("after_all");
    // **診断日（作者が答えた日）は動かさない**
    expect(readMirror().profile.updatedAt).toBe("2026-09-13T00:00:00.000Z");
  });

  test("同じ答えを2回渡しても、1回しか数えない（撃ち直しで歯止めを迂回させない）", () => {
    putProfile();
    const response = answer("after_all");

    chatValidate({ folder: work, response });
    const again = chatValidate({ folder: work, response });

    expect(again.writerStyleNote).toContain("反映済み");
    expect(readMirror().profile.style.revise).toBe("per_episode");
    expect(readMirror().profile.reviseStreak?.count).toBe(1);
  });

  test("知らない値は捨てる（指示語がそのまま返っても動かない）", () => {
    putProfile();

    const result = chatValidate({
      folder: work,
      response: answer("inline|per_episode|after_all"),
    });

    expect(result.writerStyleNote).toBeUndefined();
    expect(readMirror().profile.reviseStreak).toBeUndefined();
  });

  test("診断していない作者の値は、推定で生やさない", () => {
    const result = chatValidate({ folder: work, response: answer("after_all") });

    expect(result.writerStyleNote).toBeUndefined();
    expect(fs.existsSync(mirrorPath())).toBe(false);
  });

  test("作品フォルダーへは1バイトも書かない", () => {
    putProfile();
    chatValidate({ folder: work, response: answer("after_all", "1") });
    chatValidate({ folder: work, response: answer("after_all", "2") });

    expect(filesUnder(work)).toEqual([]);
  });
});

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

  function memento(): {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Promise<void>;
  } {
    const values = new Map<string, unknown>();
    return {
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

  beforeEach(() => {
    installNodeFileSystem();
  });

  test("答えを控えへ書き出す。置き先は保管庫で、作品フォルダーではない", async () => {
    const state = memento();
    const store = new WriterProfileStore(state as never);
    await store.set(STYLE);

    await refreshWriterProfileMirror(context(state), store);

    expect(readMirror().profile.style).toEqual(STYLE);
    expect(filesUnder(work)).toEqual([]);
  });

  test("中身が変わらなければ、控えの時刻を動かさない", async () => {
    const state = memento();
    const store = new WriterProfileStore(state as never);
    await store.set(STYLE);
    await refreshWriterProfileMirror(context(state), store);
    const first = readMirror().updatedAt;

    await waitForNextMillisecond();
    await refreshWriterProfileMirror(context(state), store);

    expect(readMirror().updatedAt).toBe(first);
  });

  test("作者が答えを消したら、控えも消す", async () => {
    const state = memento();
    const store = new WriterProfileStore(state as never);
    await store.set(STYLE);
    await refreshWriterProfileMirror(context(state), store);

    await store.clear();
    await refreshWriterProfileMirror(context(state), store);

    expect(fs.existsSync(mirrorPath())).toBe(false);
  });

  test("控えのほうが新しければ取り込む（MCP が動かしたぶん）。診断日は動かさない", async () => {
    const state = memento();
    const store = new WriterProfileStore(state as never);
    await store.set(STYLE);
    await refreshWriterProfileMirror(context(state), store);
    const answeredAt = store.get()?.updatedAt;

    await waitForNextMillisecond();
    chatValidate({ folder: work, response: answer("after_all", "1") });
    chatValidate({ folder: work, response: answer("after_all", "2") });

    await importWriterProfileMirror(context(state), store);

    expect(store.get()?.style.revise).toBe("after_all");
    expect(store.get()?.updatedAt).toBe(answeredAt);
  });

  test("書き出し直しても、効かせた答えの指紋は消えない", async () => {
    const state = memento();
    const store = new WriterProfileStore(state as never);
    await store.set(STYLE);
    await refreshWriterProfileMirror(context(state), store);

    await waitForNextMillisecond();
    const response = answer("after_all");
    chatValidate({ folder: work, response });

    // 起動しなおした形（取り込み → 書き出し）
    await importWriterProfileMirror(context(state), store);
    await refreshWriterProfileMirror(context(state), store);

    const again = chatValidate({ folder: work, response });
    expect(again.writerStyleNote).toContain("反映済み");
    expect(readMirror().profile.reviseStreak?.count).toBe(1);
  });

  test("控えが古ければ、手元（globalState）を残す", async () => {
    const state = memento();
    const store = new WriterProfileStore(state as never);
    await store.set(STYLE);
    await refreshWriterProfileMirror(context(state), store);

    writeMirror({
      schema: WRITER_MIRROR_SCHEMA,
      updatedAt: "2026-01-01T00:00:00.000Z",
      profile: sampleProfile({ style: { ...STYLE, revise: "inline" } }),
    });

    await importWriterProfileMirror(context(state), store);

    expect(store.get()?.style.revise).toBe("per_episode");
  });
});
