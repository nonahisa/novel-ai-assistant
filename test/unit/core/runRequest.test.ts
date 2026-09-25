import { describe, expect, test } from "vitest";
import {
  RUN_ARRIVAL_MS,
  RUN_CONFIRM_MS,
  RUN_FEATURES,
  RUN_MAX_PER_HOUR,
  buildRunUri,
  checkRunFile,
  checkRunToken,
  countRecentRuns,
  describeRunConfirm,
  findRunFeature,
  isConfirmTooLate,
  isRunOpen,
  isRunStale,
  parseRunQuery,
  parseRunState,
  parseRunTicket,
  formatRunTicket,
  runIdOfFileName,
  runStatusOf,
  type RunStateRecord,
  type RunTicket,
} from "../../../src/core/runRequest";
import { sha256Text } from "../../../src/core/hash";
import { permissionKeyOf } from "../../../src/core/externalAccessPermission";
import { paidUsageLines } from "../../../src/core/paidUsageNotice";

/**
 * VS Code の中のAI設定で走らせてもらう道の判定（設計書6.87.22）。
 *
 * **合言葉が合わない依頼は、確認も出さずに断る**——`vscode://` はウェブページの
 * リンク1つでも開かせられる。ここで見るのは、MCP と拡張機能が共有する判定。
 */

const ID = "0123456789abcdef";
const TOKEN = "a".repeat(64);
const CREATED = Date.parse("2026-09-25T10:00:00+09:00");

function ticket(overrides: Partial<RunTicket> = {}): RunTicket {
  return {
    version: 1,
    id: ID,
    tokenHash: sha256Text(TOKEN),
    feature: "typo",
    folder: "C:\\作品\\星の町",
    client: "claude-code",
    createdAt: new Date(CREATED).toISOString(),
    ...overrides,
  };
}

function state(overrides: Partial<RunStateRecord> = {}): RunStateRecord {
  return { version: 1, id: ID, state: "confirming", at: new Date(CREATED).toISOString(), ...overrides };
}

describe("合言葉の照合", () => {
  test("一致すれば通る", () => {
    expect(checkRunToken(ticket(), TOKEN, CREATED + 1000, sha256Text)).toEqual({ ok: true });
  });

  test("一致しなければ「出どころの分からない依頼」", () => {
    const result = checkRunToken(ticket(), "b".repeat(64), CREATED + 1000, sha256Text);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.kind).toBe("mismatch");
  });

  test("長さの違う合言葉も一致とは読まない", () => {
    const result = checkRunToken(ticket(), TOKEN.slice(0, 63), CREATED, sha256Text);
    expect(result.ok).toBe(false);
  });

  test("依頼から猶予を過ぎて届いたら断る（控えた URI を後から開かせない）", () => {
    const result = checkRunToken(ticket(), TOKEN, CREATED + RUN_ARRIVAL_MS + 1, sha256Text);
    expect(result.ok === false && result.kind).toBe("late");
  });

  test("猶予ちょうどまでは通る", () => {
    expect(checkRunToken(ticket(), TOKEN, CREATED + RUN_ARRIVAL_MS, sha256Text).ok).toBe(true);
  });

  test("札には合言葉そのものを置かない（ハッシュだけ）", () => {
    const text = formatRunTicket(ticket());
    expect(text).not.toContain(TOKEN);
    expect(parseRunTicket(text)?.tokenHash).toBe(sha256Text(TOKEN));
  });
});

describe("URI のクエリ", () => {
  test("組んだ URI を読み戻せる", () => {
    const uri = buildRunUri(ID, TOKEN);
    expect(uri.startsWith("vscode://nonahisa.novel-ai-assistant/run?")).toBe(true);
    expect(parseRunQuery(uri.slice(uri.indexOf("?") + 1))).toEqual({ ok: true, id: ID, token: TOKEN });
  });

  test("作品の場所も機能も URI に載せない", () => {
    const uri = buildRunUri(ID, TOKEN);
    expect(uri).not.toContain("folder");
    expect(uri).not.toContain("feature");
  });

  test("知らない鍵・同じ鍵の2つ目・形の合わない値は断る", () => {
    expect(parseRunQuery(`id=${ID}&token=${TOKEN}&feature=apply`).ok).toBe(false);
    expect(parseRunQuery(`id=${ID}&id=${ID}&token=${TOKEN}`).ok).toBe(false);
    expect(parseRunQuery(`id=xyz&token=${TOKEN}`).ok).toBe(false);
    expect(parseRunQuery(`id=${ID}`).ok).toBe(false);
  });
});

describe("白名簿", () => {
  test("読み取りと生成だけ", () => {
    expect(RUN_FEATURES.map((def) => def.feature).sort()).toEqual(
      ["contradiction", "deviation", "foreshadow", "proofread", "synopsis", "typo"].sort()
    );
  });

  test("適用・抽出・反映の類は無い", () => {
    for (const name of ["apply", "settings", "extract", "pending", "chat", "episodePlot"]) {
      expect(findRunFeature(name)).toBeUndefined();
    }
  });

  test("白名簿の外の札も読める（受け口が理由を言って断れるように）", () => {
    const parsed = parseRunTicket(formatRunTicket(ticket({ feature: "apply" as never })));
    expect(parsed?.feature).toBe("apply");
    expect(findRunFeature(parsed?.feature)).toBeUndefined();
  });
});

describe("対象の話の指定", () => {
  test("相対パスだけ", () => {
    expect(checkRunFile("本文\\第1話.txt")).toBeUndefined();
    expect(checkRunFile("C:\\外\\x.txt")).toBeDefined();
    expect(checkRunFile("/etc/x")).toBeDefined();
    expect(checkRunFile("本文/../../x.txt")).toBeDefined();
    expect(checkRunFile("a\u0000b")).toBeDefined();
  });
});

describe("run.result の状態", () => {
  test("拡張機能がまだ受け取っていない", () => {
    expect(runStatusOf(ticket(), undefined, CREATED + 1000).status).toBe("waiting");
  });

  test("受け取られないまま猶予を過ぎたら期限切れ", () => {
    expect(runStatusOf(ticket(), undefined, CREATED + RUN_ARRIVAL_MS + 1).status).toBe("expired");
  });

  test("作者の確認待ち", () => {
    const view = runStatusOf(ticket(), state(), CREATED + 60_000);
    expect(view.status).toBe("confirming");
    expect(view.message).toContain("作者");
  });

  test("確認が出たまま期限を過ぎたら期限切れ", () => {
    expect(runStatusOf(ticket(), state(), CREATED + RUN_CONFIRM_MS + 1).status).toBe("expired");
  });

  test("実行中・終わった・断られた・失敗", () => {
    expect(runStatusOf(ticket(), state({ state: "running" }), CREATED).status).toBe("running");
    expect(runStatusOf(ticket(), state({ state: "done" }), CREATED).status).toBe("done");
    const declined = runStatusOf(ticket(), state({ state: "declined" }), CREATED);
    expect(declined.status).toBe("declined");
    const refused = runStatusOf(
      ticket(),
      state({ state: "refused", reason: "許可が無い。", nextAction: "許可する" }),
      CREATED
    );
    expect(refused.status).toBe("refused");
    expect(refused.message).toContain("許可が無い");
    expect(refused.message).toContain("次の操作：許可する");
    expect(runStatusOf(ticket(), state({ state: "failed" }), CREATED).status).toBe("failed");
  });

  test("返事の出ていない依頼か", () => {
    expect(isRunOpen(ticket(), undefined, CREATED)).toBe(true);
    expect(isRunOpen(ticket(), state(), CREATED)).toBe(true);
    expect(isRunOpen(ticket(), state({ state: "done" }), CREATED)).toBe(false);
    expect(isRunOpen(ticket(), state(), CREATED + RUN_CONFIRM_MS + 1)).toBe(false);
  });

  test("壊れた状態のファイルは読まない", () => {
    expect(parseRunState("{")).toBeUndefined();
    expect(parseRunState(JSON.stringify({ version: 1, id: ID, state: "?", at: "x" }))).toBeUndefined();
  });
});

describe("期限と上限", () => {
  test("「走らせる」の期限は依頼から数える", () => {
    expect(isConfirmTooLate(ticket(), CREATED + RUN_CONFIRM_MS)).toBe(false);
    expect(isConfirmTooLate(ticket(), CREATED + RUN_CONFIRM_MS + 1)).toBe(true);
  });

  test("数えるのは作者が「走らせる」を押した回だけ", () => {
    const now = CREATED + 10 * 60_000;
    const states = [
      state({ state: "done", startedAt: new Date(CREATED).toISOString() }),
      state({ state: "declined" }),
      state({ state: "refused" }),
      state({ state: "done", startedAt: new Date(CREATED - 2 * 60 * 60_000).toISOString() }),
    ];
    expect(countRecentRuns(states, now)).toBe(1);
    expect(RUN_MAX_PER_HOUR).toBeGreaterThan(0);
  });

  test("7日を過ぎた札は片付けてよい", () => {
    expect(isRunStale(new Date(CREATED).toISOString(), CREATED + 6 * 86_400_000)).toBe(false);
    expect(isRunStale(new Date(CREATED).toISOString(), CREATED + 8 * 86_400_000)).toBe(true);
  });

  test("ファイル名から依頼番号を読む", () => {
    expect(runIdOfFileName(`${ID}.request.json`)).toEqual({ id: ID, kind: "request" });
    expect(runIdOfFileName(`${ID}.state.json`)).toEqual({ id: ID, kind: "state" });
    expect(runIdOfFileName(`${ID}.state.json.tmp`)).toBeUndefined();
  });
});

describe("確認のモーダル", () => {
  const base = {
    ticket: ticket(),
    featureLabel: "誤字脱字の検知",
    workTitle: "星の町",
    targetLabel: "第3話.txt",
    providerName: "作り物のクラウドAI",
    model: "model-x",
    bodyChars: 4321,
    episodeCount: 1,
  };

  test("依頼の中身を全部並べる（どこから・作品・話・機能・AI・送る量）", () => {
    const { message, detail } = describeRunConfirm({ ...base, paid: false, paidLines: [] });
    expect(message).toContain("誤字脱字の検知");
    for (const expected of ["claude-code", "自己申告", "星の町", "第3話.txt", "作り物のクラウドAI", "model-x", "4,321字", "無料"]) {
      expect(detail).toContain(expected);
    }
    expect(detail).not.toContain("今後は確認しない");
  });

  test("有料のAIなら、画面の確認と同じ料金の断りを出す", () => {
    const paidLines = paidUsageLines("作り物のクラウドAI", "model-x");
    const { detail } = describeRunConfirm({ ...base, paid: true, paidLines });
    for (const line of paidLines) expect(detail).toContain(line);
    expect(detail).not.toContain("無料");
  });
});

describe("許可の鍵", () => {
  test("run.result は run.request と同じ鍵で確かめる", () => {
    expect(permissionKeyOf("run.result", undefined)).toBe("run.request");
    expect(permissionKeyOf("run.request", "typo")).toBe("run.request");
  });
});
