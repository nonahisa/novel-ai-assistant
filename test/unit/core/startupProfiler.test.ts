import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  STARTUP_PROFILE_ENV,
  isStartupProfileRequested,
  profileFileStamp,
  startStartupProfile,
} from "../../src/core/startupProfiler";

/**
 * **起動のプロファイルを自分で採る**（設計書6.107。0.74.11）。
 *
 * `core/loopLag.ts` は「握られているか」までしか言わない。握っていたのが
 * **誰か**は関数の単位で見るしかないが、VS Code の
 * 「Start Extension Host Profile」は押した時点でもう起動が終わっている。
 *
 * ここで確かめるのは**本当に採れて、読める形で残るか**の1点である
 * （何が写るかは機械と起動のしかたで変わるので、名指しはしない）。
 */
describe("起動のプロファイル", () => {
  const saved = process.env[STARTUP_PROFILE_ENV];
  let logRoot = "";

  beforeEach(async () => {
    logRoot = await mkdtemp(join(tmpdir(), "novelai-profile-"));
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env[STARTUP_PROFILE_ENV];
    else process.env[STARTUP_PROFILE_ENV] = saved;
    await rm(logRoot, { recursive: true, force: true });
  });

  test("環境変数が立っていなければ、何も始めない", async () => {
    // **設定項目にしない**ので、ここが唯一の入口である。
    // 立て忘れではなく「立てていないのが普通」という作りにしてある
    delete process.env[STARTUP_PROFILE_ENV];

    expect(isStartupProfileRequested()).toBe(false);
    expect(await startStartupProfile({ logRoot })).toBeUndefined();
  });

  test("`0` や空文字も、立っていないとみなす", async () => {
    process.env[STARTUP_PROFILE_ENV] = "0";
    expect(isStartupProfileRequested()).toBe(false);
    process.env[STARTUP_PROFILE_ENV] = "";
    expect(isStartupProfileRequested()).toBe(false);
  });

  test("採って止めると、`nodes` を持つ `.cpuprofile` が残る", async () => {
    process.env[STARTUP_PROFILE_ENV] = "1";
    const places: string[] = [];
    const failures: unknown[] = [];

    const profile = await startStartupProfile({
      logRoot,
      onSaved: (filePath) => places.push(filePath),
      onFailed: (error) => failures.push(error),
    });
    expect(profile).toBeDefined();
    // 何か計算させる（空のプロファイルでも `nodes` は付くが、
    // 「採っているあいだに走ったもの」が入ることまで見たい）
    let sum = 0;
    for (let i = 0; i < 200_000; i++) sum += i;
    expect(sum).toBeGreaterThan(0);
    await profile?.stop();

    expect(failures).toEqual([]);
    expect(places).toHaveLength(1);
    expect(places[0].endsWith(".cpuprofile")).toBe(true);
    const json = JSON.parse(await readFile(places[0], "utf8")) as {
      nodes?: unknown;
    };
    // **関数ごとに集計できる形か**だけを見る。中身は機械しだい
    expect(Array.isArray(json.nodes)).toBe(true);
    expect((json.nodes as unknown[]).length).toBeGreaterThan(0);
  });

  test("二度止めても、書き出すのは1回だけ", async () => {
    // 上限のタイマーと初回描画の合図が、どちらも止めにくる
    process.env[STARTUP_PROFILE_ENV] = "1";
    const places: string[] = [];

    const profile = await startStartupProfile({
      logRoot,
      onSaved: (filePath) => places.push(filePath),
    });
    await profile?.stop();
    await profile?.stop();

    expect(places).toHaveLength(1);
  });

  test("書き先が決まっていなければ、採らずに知らせる", async () => {
    process.env[STARTUP_PROFILE_ENV] = "1";
    const failures: unknown[] = [];

    const profile = await startStartupProfile({
      logRoot: undefined,
      onFailed: (error) => failures.push(error),
    });

    expect(profile).toBeUndefined();
    expect(failures).toHaveLength(1);
  });

  test("ファイル名の時刻は現地時刻で、隣の `actions.log` と突き合わせられる", () => {
    // UTC で書くと9時間ずれて、どの起動のものか分からなくなる
    expect(profileFileStamp(new Date(2026, 8, 21, 9, 5, 7))).toBe(
      "20260921-090507"
    );
  });
});
