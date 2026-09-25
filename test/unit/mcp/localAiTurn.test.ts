import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GLOBAL_STORAGE_ENV } from "../../../src/mcp/globalStorage";
import {
  MCP_RUN_FEATURES,
  NO_LEDGER_NOTE,
  enterLocalAi,
  localAiSessionKind,
  resetLocalAiLeaseForTest,
  withLocalAiNotes,
  withLocalAiSession,
} from "../../../src/mcp/localAiTurn";
import { FEATURE_NAMES } from "../../../src/core/mcpFeatures";
import { parseLease, serializeLease } from "../../../src/core/localAiLease";
import { resetAiSequence } from "../../../src/core/aiSequence";

/**
 * MCP サーバーの側の順番待ち（設計書6.76.1）。拡張機能と同じ札を、
 * 保管庫（`NOVELAI_GLOBAL_STORAGE`）から見つけて使う。
 *
 * 宛先は `127.0.0.2`（手元の一覧に入れていない）にして、管理外の負荷の
 * 測定（nvidia-smi と Ollama）を走らせない——この機械の GPU の様子で
 * 試験の結果が変わらないように。
 */

const ENDPOINT = "http://127.0.0.2:1";

let storage: string;
let previousEnv: string | undefined;

beforeEach(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "novelai-mcp-lease-"));
  previousEnv = process.env[GLOBAL_STORAGE_ENV];
  process.env[GLOBAL_STORAGE_ENV] = storage;
  resetLocalAiLeaseForTest();
  resetAiSequence();
});

afterEach(() => {
  if (previousEnv === undefined) delete process.env[GLOBAL_STORAGE_ENV];
  else process.env[GLOBAL_STORAGE_ENV] = previousEnv;
  resetLocalAiLeaseForTest();
  fs.rmSync(storage, { recursive: true, force: true });
});

function leaseFile(): string {
  return path.join(storage, "local-ai", "lease.json");
}

function runFile(): string {
  return path.join(storage, "local-ai", "run.json");
}

function interruptFile(): string {
  return path.join(storage, "local-ai", "interrupt.json");
}

/** 別の窓が持っている札（持ち主はこの試験のプロセス＝生きている、合言葉だけ違う） */
function otherWindowHolds(file: string, label: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    serializeLease({
      version: 1,
      token: "window",
      pid: process.pid,
      host: "extension",
      windowName: "作品A",
      label,
      startedAt: new Date().toISOString(),
    })
  );
}

describe("道具の呼び出し1回を1つの実行として札を持つ", () => {
  test("最初に送るときに取り、道具が返るまで持ち、返ったら消す", async () => {
    const { value, notes } = await withLocalAiSession("誤字脱字の検知", undefined, async () => {
      const leave1 = await enterLocalAi(ENDPOINT);
      // 送っているあいだは送信の札も持つ
      expect(parseLease(fs.readFileSync(leaseFile(), "utf8"))?.pid).toBe(process.pid);
      leave1();
      // チャンクの合間でも**まとまりの札は**離さない（別の窓の一括処理と交互に流さない）
      const record = parseLease(fs.readFileSync(runFile(), "utf8"));
      expect(record).toMatchObject({ host: "mcp", label: "誤字脱字の検知", pid: process.pid });
      const leave2 = await enterLocalAi(ENDPOINT);
      leave2();
      return "結果";
    });
    expect(value).toBe("結果");
    expect(notes).toEqual([]);
    // **返った時点で消えている**（待たずに見る）。実機で、返事を受けた呼び出し元が
    // すぐサーバーを終わらせ、札が残って次の者が見切るまで待たされた
    expect(fs.existsSync(leaseFile())).toBe(false);
    expect(fs.existsSync(runFile())).toBe(false);
  });

  test("別の窓が持っていれば待ち、待ったことを結果に1行添える", async () => {
    fs.mkdirSync(path.dirname(leaseFile()), { recursive: true });
    const other = serializeLease({
      version: 1,
      token: "window",
      pid: process.pid,
      host: "extension",
      windowName: "作品A",
      label: "推敲",
      startedAt: new Date().toISOString(),
    });
    fs.writeFileSync(leaseFile(), other);

    let sent = false;
    const running = withLocalAiSession("誤字脱字の検知", undefined, async () => {
      const leave = await enterLocalAi(ENDPOINT);
      sent = true;
      leave();
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sent).toBe(false);
    // 窓が終わって札を消した
    fs.unlinkSync(leaseFile());
    const { notes } = await running;
    expect(sent).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^別の窓（作品A）の「推敲」の完了を\d+秒待ってから送りました。$/);
  });

  test("中止されたら待ちから抜ける", async () => {
    fs.mkdirSync(path.dirname(leaseFile()), { recursive: true });
    fs.writeFileSync(
      leaseFile(),
      serializeLease({
        version: 1,
        token: "window",
        pid: process.pid,
        host: "extension",
        label: "推敲",
        startedAt: new Date().toISOString(),
      })
    );
    const controller = new AbortController();
    const running = withLocalAiSession("誤字脱字の検知", controller.signal, async () => {
      const leave = await enterLocalAi(ENDPOINT);
      leave();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await expect(running).rejects.toThrow("順番待ちを中止しました");
    // 相手の札は残っている
    expect(parseLease(fs.readFileSync(leaseFile(), "utf8"))?.token).toBe("window");
  });

  test("保管庫が見つからなければ札なしで送り、その旨を1行添える", async () => {
    delete process.env[GLOBAL_STORAGE_ENV];
    resetLocalAiLeaseForTest();
    const { notes } = await withLocalAiSession("誤字脱字の検知", undefined, async () => {
      (await enterLocalAi(ENDPOINT))();
    });
    expect(notes).toEqual([NO_LEDGER_NOTE]);
  });

  test("送らない道具では何も起きない", async () => {
    const { notes } = await withLocalAiSession("mcp.version", undefined, async () => 1);
    expect(notes).toEqual([]);
    expect(fs.existsSync(leaseFile())).toBe(false);
  });
});

describe("一括処理か単発か（6.76.1 の追記）", () => {
  test("novel.run のうち、話やチャンクを回す feature だけを一括処理にする", () => {
    // 一覧を変えたら、設計書 6.76.1 の理由も直す
    expect([...MCP_RUN_FEATURES].sort()).toEqual(
      ["contradiction", "factContradiction", "foreshadow", "proofread", "settings", "typo"].sort()
    );
    // 一覧の名前は、すべて本物の feature である（綴り違いで黙って単発にならない）
    for (const feature of MCP_RUN_FEATURES) {
      expect(FEATURE_NAMES).toContain(feature);
    }
    expect(localAiSessionKind("novel.run", { feature: "typo" })).toBe("run");
    expect(localAiSessionKind("novel.run", { feature: "chat" })).toBe("single");
    expect(localAiSessionKind("novel.run", { feature: "synopsis" })).toBe("single");
    expect(localAiSessionKind("novel.run", {})).toBe("single");
    expect(localAiSessionKind("ollama.generate", { feature: "typo" })).toBe("single");
    expect(localAiSessionKind("novel.prompt", { feature: "typo" })).toBe("single");
  });

  test("単発は、別の窓の一括処理がまとまりの札を持っていても待たずに送る", async () => {
    otherWindowHolds(runFile(), "誤字脱字の検知");
    const { notes } = await withLocalAiSession(
      "相談",
      undefined,
      async () => {
        (await enterLocalAi(ENDPOINT))();
      },
      "single"
    );
    expect(notes).toEqual([]);
    // 相手のまとまりの札はそのまま
    expect(parseLease(fs.readFileSync(runFile(), "utf8"))?.token).toBe("window");
  });

  test("一括処理は、別の窓の一括処理が終わるまで待つ（送信の札が空いていても）", async () => {
    otherWindowHolds(runFile(), "推敲");
    let sent = false;
    const running = withLocalAiSession("誤字脱字の検知", undefined, async () => {
      const leave = await enterLocalAi(ENDPOINT);
      sent = true;
      leave();
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sent).toBe(false);
    fs.unlinkSync(runFile());
    const { notes } = await running;
    expect(sent).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^別の窓（作品A）の「推敲」の完了を\d+秒待ってから送りました。$/);
  });

  test("単発が送信の札を待つあいだは「合間に入れてほしい」の印を出し、送るときに下げる", async () => {
    otherWindowHolds(leaseFile(), "誤字脱字の検知");
    let sent = false;
    const running = withLocalAiSession(
      "相談",
      undefined,
      async () => {
        const leave = await enterLocalAi(ENDPOINT);
        sent = true;
        leave();
      },
      "single"
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sent).toBe(false);
    expect(parseLease(fs.readFileSync(interruptFile(), "utf8"))).toMatchObject({
      host: "mcp",
      label: "相談",
      pid: process.pid,
    });
    // 別の窓の一括処理がチャンクを送り終えた
    fs.unlinkSync(leaseFile());
    await running;
    expect(sent).toBe(true);
    // 印は残さない（残すと別の窓の一括処理が譲り続ける）。返った時点で消えている
    expect(fs.existsSync(interruptFile())).toBe(false);
  });
});

describe("結果への添え方", () => {
  test("note の頭へ足し、localAiNotes にも並べる。鍵を足せない形はそのまま", () => {
    expect(withLocalAiNotes({ note: "元の断り" }, ["待ちました。"])).toEqual({
      note: "待ちました。\n元の断り",
      localAiNotes: ["待ちました。"],
    });
    expect(withLocalAiNotes({ a: 1 }, [])).toEqual({ a: 1 });
    expect(withLocalAiNotes([1], ["x"])).toEqual([1]);
  });
});
