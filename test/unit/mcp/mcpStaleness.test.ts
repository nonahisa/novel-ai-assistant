import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STALE_BUNDLE_LINE,
  checkBundleStaleness,
  judgeBundleStaleness,
  rememberBundleAtStartup,
  staleBundleLine,
  withStaleNote,
} from "../../../src/mcp/staleness";
import { SERVER_VERSION } from "../../../src/mcp/version";

/**
 * 走っている束が古くなっていないか（設計書6.87.15 の柱2の1）。
 *
 * **見張りたいのは2つ。**
 *
 * 1. **古いのに黙らないこと。** 2026-09-17 の実機で、古い束のまま3時間
 *    気づかなかった。版のずれと、束の作り直しの両方で気づける
 * 2. **古くないのに騒がないこと。** 読めないことを「古い」と決めつけると、
 *    正しい束で毎回断り書きが出て、誰も読まなくなる
 */

describe("judgeBundleStaleness——古いかどうかの判定", () => {
  it("リポジトリの版とずれていれば古い（どちらの版かが理由に出る）", () => {
    const judged = judgeBundleStaleness({
      serverVersion: "0.66.4",
      repositoryVersion: "0.66.5",
      startedMtimeMs: 1000,
      currentMtimeMs: 1000,
    });
    expect(judged.stale).toBe(true);
    expect(judged.reason).toContain("0.66.4");
    expect(judged.reason).toContain("0.66.5");
  });

  it("束が起動後に作り直されていれば古い（版が同じでも気づく）", () => {
    // 版を上げずに直したときは、こちらだけが動く
    const judged = judgeBundleStaleness({
      serverVersion: "0.66.4",
      repositoryVersion: "0.66.4",
      startedMtimeMs: 1000,
      currentMtimeMs: 2000,
    });
    expect(judged.stale).toBe(true);
    expect(judged.reason).toContain("作り直された");
  });

  it("どちらも読めなければ、古いとは言わない", () => {
    // **読めないことは、古いことの証拠ではない**（当てにいかない）
    expect(
      judgeBundleStaleness({
        serverVersion: "0.66.4",
        repositoryVersion: null,
        startedMtimeMs: null,
        currentMtimeMs: null,
      })
    ).toEqual({ stale: false, reason: null });
  });

  it("版が一致していて束も動いていなければ、古くない", () => {
    expect(
      judgeBundleStaleness({
        serverVersion: "0.66.4",
        repositoryVersion: "0.66.4",
        startedMtimeMs: 2000,
        currentMtimeMs: 2000,
      })
    ).toEqual({ stale: false, reason: null });
  });

  it("束が古いほうへ戻っていても、古いとは言わない", () => {
    // 更新時刻が巻き戻るのは、別の束を置いたときなど。**進んだときだけ見る**
    expect(
      judgeBundleStaleness({
        serverVersion: "0.66.4",
        repositoryVersion: "0.66.4",
        startedMtimeMs: 2000,
        currentMtimeMs: 1000,
      }).stale
    ).toBe(false);
  });
});

describe("withStaleNote——返事に断り書きを足す", () => {
  const fresh = { stale: false, reason: null };
  const stale = { stale: true, reason: "束は 0.66.4、リポジトリは 0.66.5" };

  it("古くなければ、返事に手を入れない（同じものがそのまま返る）", () => {
    const value = { note: "台帳は書き換えていません。" };
    expect(withStaleNote(value, fresh)).toBe(value);
    expect(withStaleNote(value, fresh)).not.toHaveProperty("bundleStale");
  });

  it("既存の note を消さず、断り書きを前に足す", () => {
    const result = withStaleNote(
      { note: "台帳は書き換えていません。", count: 3 },
      stale
    ) as Record<string, unknown>;
    expect(result.bundleStale).toBe(true);
    expect(result.count).toBe(3);
    const note = String(result.note);
    expect(note.startsWith("【束が古い】")).toBe(true);
    // **消さない。** 道具が書いた注意書きのほうが大事なことがある
    expect(note).toContain("台帳は書き換えていません。");
    expect(note).toContain("0.66.5");
  });

  it("note が無ければ、断り書きだけを入れる（空行を作らない）", () => {
    const result = withStaleNote({ count: 1 }, stale) as Record<string, unknown>;
    expect(result.note).toBe(staleBundleLine(stale.reason));
  });

  it("配列や文字列は、鍵を足せないのでそのまま返す", () => {
    const list = [1, 2, 3];
    expect(withStaleNote(list, stale)).toBe(list);
    expect(withStaleNote("ただの文字列", stale)).toBe("ただの文字列");
    expect(withStaleNote(null, stale)).toBe(null);
  });

  it("理由が読めなくても、1行は出る", () => {
    expect(staleBundleLine(null)).toBe(STALE_BUNDLE_LINE);
    expect(STALE_BUNDLE_LINE).toContain("Claude Code を開き直して");
  });
});

/**
 * 実際のファイルを見て判定するところ。
 *
 * **`process.argv[1]` は差し替えない**——並行して走る他のテストを巻き込む。
 * 束の場所を引数で受け取れるようにしてあるのは、そのためである。
 */
describe("rememberBundleAtStartup / checkBundleStaleness——実際に読む", () => {
  let root: string;
  let bundle: string;

  beforeEach(() => {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-stale-"));
    fs.mkdirSync(nodePath.join(root, "dist"));
    bundle = nodePath.join(root, "dist", "mcp-server.mjs");
    fs.writeFileSync(bundle, "// 偽の束\n", "utf8");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    // 次のテストへ持ち越さない（控えを捨てるため、無い場所を控え直す）
    rememberBundleAtStartup(nodePath.join(root, "dist", "無い.mjs"));
  });

  function writePackageJson(version: string): void {
    fs.writeFileSync(
      nodePath.join(root, "package.json"),
      JSON.stringify({ name: "novel-ai-assistant", version }),
      "utf8"
    );
  }

  it("束の1つ上の package.json を読み、版が揃っていれば黙る", () => {
    writePackageJson(SERVER_VERSION);
    rememberBundleAtStartup(bundle);
    const checked = checkBundleStaleness();
    expect(checked.stale).toBe(false);
    expect(checked.repositoryVersion).toBe(SERVER_VERSION);
    expect(checked.serverVersion).toBe(SERVER_VERSION);
    expect(checked.bundlePath).toBe(bundle);
    expect(checked.bundleMtimeMs).not.toBeNull();
  });

  it("package.json の版が先へ進んでいれば、古いと言う", () => {
    writePackageJson("99.99.99");
    rememberBundleAtStartup(bundle);
    const checked = checkBundleStaleness();
    expect(checked.stale).toBe(true);
    expect(checked.reason).toContain("99.99.99");
  });

  it("隣の package.json が別のパッケージなら、その版は見ない", () => {
    // 束を別の場所へ写して走らせたとき、隣にあるのは別物の package.json
    fs.writeFileSync(
      nodePath.join(root, "package.json"),
      JSON.stringify({ name: "someone-else", version: "99.99.99" }),
      "utf8"
    );
    rememberBundleAtStartup(bundle);
    const checked = checkBundleStaleness();
    expect(checked.stale).toBe(false);
    expect(checked.repositoryVersion).toBeNull();
  });

  it("package.json が無くても、古いとは言わない（当てにいかない）", () => {
    // **配布物に束は入らないし、走らせる場所に package.json があるとも限らない**
    rememberBundleAtStartup(bundle);
    const checked = checkBundleStaleness();
    expect(checked.repositoryVersion).toBeNull();
    expect(checked.stale).toBe(false);
  });

  it("壊れた package.json を、直しにいかずに無視する", () => {
    fs.writeFileSync(nodePath.join(root, "package.json"), "{壊れている", "utf8");
    rememberBundleAtStartup(bundle);
    expect(checkBundleStaleness().stale).toBe(false);
  });

  it("起動後に束が作り直されたら、古いと言う", () => {
    writePackageJson(SERVER_VERSION);
    rememberBundleAtStartup(bundle);
    // **更新時刻を明示して進める。** 書き直すだけでは、同じミリ秒に
    // 収まって差が出ないことがある
    const later = new Date(Date.now() + 60_000);
    fs.writeFileSync(bundle, "// 作り直した束\n", "utf8");
    fs.utimesSync(bundle, later, later);
    // 控え直さずに読み直す（2秒の使い回しを避けるため、時刻を進めて問う）
    const checked = checkBundleStaleness(Date.now() + 10_000);
    expect(checked.stale).toBe(true);
    expect(checked.reason).toContain("作り直された");
  });

  it("束の場所が分からなければ、古いとは言わない", () => {
    rememberBundleAtStartup("");
    const checked = checkBundleStaleness();
    expect(checked.bundlePath).toBeNull();
    expect(checked.stale).toBe(false);
  });
});
