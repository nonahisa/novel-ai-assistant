import { beforeEach, describe, expect, test } from "vitest";
import { FileSystemError, Uri, workspace } from "../support/vscodeStub";
import { createRunRequestDeps } from "../../../src/features/runRequestRunners";
import {
  RUN_REQUEST_DIRECTORY,
  formatRunTicket,
  runTicketFileName,
  type RunStateRecord,
} from "../../../src/core/runRequest";
import { sha256Text } from "../../../src/core/hash";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 受け口の手足の置き場（設計書6.87.22）。
 *
 * **札と結果は拡張機能の保管庫（`globalStorageUri`）にだけ置く。** 作品フォルダーに
 * 置くと同期されて編集部の機械へ流れる（結果には本文の抜粋が入る）。
 * **状態は最初の1回だけ作れる**——ここが合言葉の「1回限り」の錠である。
 */

const STORAGE = "c:\\Users\\作者\\AppData\\Code\\globalStorage\\nonahisa.novel-ai-assistant";
const WORK_FOLDER = "c:\\作品\\星の町";
const files = new Map<string, Uint8Array>();
const directories = new Set<string>();
const writes: string[] = [];

function key(uri: { toString(): string }): string {
  return uri.toString();
}

beforeEach(() => {
  files.clear();
  directories.clear();
  writes.length = 0;
  (workspace as { fs: unknown }).fs = {
    readFile: async (uri: { toString(): string }) => {
      const bytes = files.get(key(uri));
      if (!bytes) throw new FileSystemError("ありません", "FileNotFound");
      return bytes;
    },
    writeFile: async (uri: { toString(): string }, bytes: Uint8Array) => {
      files.set(key(uri), bytes);
      writes.push(key(uri));
    },
    rename: async (
      from: { toString(): string },
      to: { toString(): string },
      options?: { overwrite?: boolean }
    ) => {
      const bytes = files.get(key(from));
      if (!bytes) throw new FileSystemError("ありません", "FileNotFound");
      if (files.has(key(to)) && options?.overwrite === false) {
        throw new FileSystemError("あります", "FileExists");
      }
      files.delete(key(from));
      files.set(key(to), bytes);
      writes.push(key(to));
    },
    delete: async (uri: { toString(): string }) => {
      files.delete(key(uri));
    },
    stat: async (uri: { toString(): string }) => {
      if (!files.has(key(uri))) throw new FileSystemError("ありません", "FileNotFound");
      return { type: 1 };
    },
    createDirectory: async (uri: { toString(): string }) => {
      directories.add(key(uri));
    },
    readDirectory: async (uri: { toString(): string }) => {
      const prefix = `${key(uri)}/`;
      return [...files.keys()]
        .filter((name) => name.startsWith(prefix) && !name.slice(prefix.length).includes("/"))
        .map((name) => [name.slice(prefix.length), 1]);
    },
  };
});

function makeDeps() {
  return createRunRequestDeps({
    context: { globalStorageUri: Uri.file(STORAGE) } as never,
    findWork: () => ({ id: "w", title: "星の町", folderPath: WORK_FOLDER } as WorkEntry),
    aiRegistry: {
      resolve: () => ({
        provider: { id: "sakura", displayName: "作り物のクラウドAI", isPaid: true, apiKey: "sk-秘密" },
        model: "m",
      }),
    } as never,
    log: () => undefined,
  });
}

function state(id: string, kind: RunStateRecord["state"]): RunStateRecord {
  return { version: 1, id, state: kind, at: "2026-09-25T01:00:00.000Z" };
}

describe("保管庫だけに置く", () => {
  test("状態は保管庫の run-requests/ に書き、作品フォルダーには書かない", async () => {
    const deps = makeDeps();
    expect(await deps.claim(state("0123456789abcdef", "confirming"))).toBe(true);
    await deps.writeState(state("0123456789abcdef", "done"));
    expect(writes.length).toBeGreaterThan(0);
    const storageKey = Uri.file(`${STORAGE}\\${RUN_REQUEST_DIRECTORY}`).toString();
    for (const written of writes) {
      expect(written.startsWith(storageKey)).toBe(true);
      expect(written).not.toContain(Uri.file(WORK_FOLDER).toString());
    }
    const listed = await deps.listStates();
    expect(listed.map((entry) => entry.state)).toEqual(["done"]);
  });

  test("状態は最初の1回だけ作れる（合言葉の使い回しを止める錠）", async () => {
    const deps = makeDeps();
    expect(await deps.claim(state("0123456789abcdef", "confirming"))).toBe(true);
    expect(await deps.claim(state("0123456789abcdef", "confirming"))).toBe(false);
  });

  test("MCP が保管庫に置いた札を読む", async () => {
    const id = "fedcba9876543210";
    files.set(
      Uri.file(`${STORAGE}\\${RUN_REQUEST_DIRECTORY}\\${runTicketFileName(id)}`).toString(),
      new TextEncoder().encode(
        formatRunTicket({
          version: 1,
          id,
          tokenHash: sha256Text("x"),
          feature: "typo",
          folder: WORK_FOLDER,
          client: "claude-code",
          createdAt: "2026-09-25T01:00:00.000Z",
        })
      )
    );
    const deps = makeDeps();
    expect((await deps.readTicket(id))?.feature).toBe("typo");
    expect(await deps.readTicket("0000000000000000")).toBeUndefined();
  });
});

describe("鍵を持ち出さない", () => {
  test("割当のAIは名前とIDとモデルだけを返す", () => {
    const ai = makeDeps().resolveAi({ feature: "typo", label: "誤字脱字の検知", assigned: "typo" });
    expect(ai).toEqual({ providerId: "sakura", providerName: "作り物のクラウドAI", model: "m", paid: true });
    expect(JSON.stringify(ai)).not.toContain("sk-");
  });
});
