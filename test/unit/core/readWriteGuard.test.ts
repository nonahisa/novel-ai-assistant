import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { Uri, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";
import type { WorkEntry } from "../../../src/models/types";
import { AchievementStore } from "../../../src/core/achievementStore";
import type { Achievement } from "../../../src/core/celebrations";
import { KeepWordStore } from "../../../src/core/keepWordStore";
import { CustomFieldStore } from "../../../src/core/customFieldStore";
import { SynopsisStore } from "../../../src/core/synopsisStore";
import { TimelineStore } from "../../../src/core/timelineStore";
import {
  invalidateWorkGoals,
  readWorkGoals,
  writeWorkGoals,
} from "../../../src/core/workGoalsStore";
import { emptyCustomFieldSet } from "../../../src/models/customField";
import { emptyTimeline } from "../../../src/models/timeline";
import { emptyWorkGoals } from "../../../src/models/workGoals";
import { KEEP_WORD_SCHEMA_VERSION } from "../../../src/models/keepWord";
import { isExternalChangeError } from "../../../src/core/readWriteGuard";
import { absPath } from "../support/osPath";

/**
 * 「読んで、足して、書き戻す」口の、書く前の照合（2026-11-15 作者の決定「足す」）。
 *
 * 読んでから書くまでのあいだに外（別の窓・同期・作者の手）で同じファイルが
 * 書き換えられたら、**外の変更を消さずに止める**。直す前は6つの口すべてで
 * 外の変更が黙って上書きされていた（ここがその再現）。
 *
 * - 足す中身が今の中身に依らない口（実績の書き足し・指摘対象外の語）は、1回だけ
 *   読み直して足し直す。2回目も違えば止める
 * - 作者が画面で組んだ中身を書く口（独自の項目・各話あらすじ・年表・作品の目標）は、
 *   止めて、書こうとした中身を回復先へ控える
 */

const work: WorkEntry = {
  id: "work_readappend",
  title: "外の変更の街",
  folderPath: absPath("novels", "readappend"),
  registeredAt: "2026-11-15T00:00:00.000Z",
};

function diskPath(...parts: string[]): string {
  return Uri.file(path.join(work.folderPath, ...parts)).fsPath;
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (bytes: Uint8Array | undefined): string =>
  bytes ? new TextDecoder().decode(bytes) : "(無い)";

const achievement = (id: string): Achievement => ({
  id,
  kind: "work",
  day: "2026-11-15",
  at: "2026-11-15T01:00:00.000Z",
  goal: 100_000,
  written: 100_010,
  workId: work.id,
  workTitle: work.title,
});

describe("読んで足して書く口の、書く前の照合", () => {
  const disk = new Map<string, Uint8Array>();
  /** 対象のファイルを読んだ回数ごとに、外の変更を差し込む */
  let afterRead: { target: string; on: (count: number) => void } | null = null;
  let readCount = 0;

  beforeEach(() => {
    disk.clear();
    afterRead = null;
    readCount = 0;
    invalidateWorkGoals();
    workspace.textDocuments = [];
    const fs = memoryFs(disk);
    workspace.fs = {
      ...fs,
      readFile: async (uri: { fsPath: string }) => {
        const result = await fs.readFile(uri as never);
        if (afterRead && uri.fsPath === afterRead.target) {
          readCount += 1;
          afterRead.on(readCount);
        }
        return result;
      },
    } as typeof workspace.fs;
  });

  /** 読んだ直後（1回目）だけ、外で書き換える */
  function changeOnceAfterFirstRead(target: string, external: Uint8Array): void {
    afterRead = {
      target,
      on: (count) => {
        if (count === 1) disk.set(target, external);
      },
    };
  }

  describe("実績の書き足し（読み直して足し直す）", () => {
    const target = diskPath(".aiwriter", "achievements.json");
    const external = (ids: string[]): Uint8Array =>
      utf8(
        `${JSON.stringify(
          { schemaVersion: "1.0", achievements: ids.map(achievement) },
          null,
          2
        )}\n`
      );

    test("1回だけ外で変わったら、読み直して両方を残す", async () => {
      await new AchievementStore(work).append([achievement("前")]);
      changeOnceAfterFirstRead(target, external(["前", "外"]));

      await new AchievementStore(work).append([achievement("こちら")]);

      const ids = (await new AchievementStore(work).load()).map((item) => item.id);
      expect(ids).toEqual(["前", "外", "こちら"]);
    });

    test("読み直してもまた変わっていたら、書かずに止める", async () => {
      await new AchievementStore(work).append([achievement("前")]);
      let round = 0;
      afterRead = {
        target,
        // 読み込み（奇数回目）のたびに、外で別の中身へ書き換える
        on: (count) => {
          if (count % 2 === 1) {
            round += 1;
            disk.set(target, external(["前", `外${round}`]));
          }
        },
      };

      const failure = await new AchievementStore(work)
        .append([achievement("こちら")])
        .catch((error: unknown) => error);
      expect(isExternalChangeError(failure)).toBe(true);
      expect(text(disk.get(target))).toBe(text(external(["前", "外2"])));
      expect(String(failure)).toMatch(/保存していません/);
    });
  });

  describe("指摘対象外の語（読み直して足し直す）", () => {
    const target = diskPath("設定", "keep_words.json");
    const words = (list: string[]): Uint8Array =>
      utf8(
        `${JSON.stringify(
          {
            schemaVersion: KEEP_WORD_SCHEMA_VERSION,
            words: list.map((word) => ({ word, note: "", addedAt: "2026-11-15" })),
          },
          null,
          2
        )}\n`
      );

    test("足す途中で外で語が足されたら、読み直して両方を残す", async () => {
      await new KeepWordStore(work).add("前の語");
      changeOnceAfterFirstRead(target, words(["前の語", "外の語"]));

      expect(await new KeepWordStore(work).add("こちらの語")).toBe(true);

      const list = (await new KeepWordStore(work).load()).words.map((entry) => entry.word);
      expect(list).toEqual(["前の語", "外の語", "こちらの語"]);
    });

    test("消す途中で外で語が足されたら、読み直して外の語を残す", async () => {
      await new KeepWordStore(work).add("前の語");
      changeOnceAfterFirstRead(target, words(["前の語", "外の語"]));

      expect(await new KeepWordStore(work).remove("前の語")).toBe(true);

      const list = (await new KeepWordStore(work).load()).words.map((entry) => entry.word);
      expect(list).toEqual(["外の語"]);
    });

    test("読み直してもまた変わっていたら、書かずに止める", async () => {
      await new KeepWordStore(work).add("前の語");
      let round = 0;
      afterRead = {
        target,
        on: (count) => {
          if (count % 2 === 1) {
            round += 1;
            disk.set(target, words(["前の語", `外${round}`]));
          }
        },
      };

      const failure = await new KeepWordStore(work)
        .add("こちらの語")
        .catch((error: unknown) => error);
      expect(isExternalChangeError(failure)).toBe(true);
      expect(text(disk.get(target))).toBe(text(words(["前の語", "外2"])));
    });
  });

  describe("作者が組んだ中身を書く口（止めて、回復先に控える）", () => {
    const externalBytes = utf8('{"外の変更": "消してはいけない"}\n');

    test("独自の項目：読んだあとに外で書き換わっていたら、上書きしない", async () => {
      const target = diskPath("設定", "custom_fields.json");
      await new CustomFieldStore(work).save(emptyCustomFieldSet());
      const store = new CustomFieldStore(work);
      const set = await store.load();
      disk.set(target, externalBytes);

      const failure = await store
        .save({
          ...set,
          fields: [{ key: "f1", label: "口癖", hint: "", multiline: false }],
        })
        .catch((error: unknown) => error);

      expect(text(disk.get(target))).toBe(text(externalBytes));
      expect(isExternalChangeError(failure)).toBe(true);
      const copy = disk.get(diskPath("設定", ".novelai-recovery", "custom_fields.json.unsaved"));
      expect(text(copy)).toContain("口癖");
    });

    test("各話あらすじ：読んだときに無かったのに外で作られていたら、上書きしない", async () => {
      const target = diskPath("設定", "chapter_synopses.json");
      const store = new SynopsisStore(work);
      const set = await store.load();
      disk.set(target, externalBytes);

      const failure = await store
        .save({
          ...set,
          episodes: [
            {
              chapter: 1,
              fileName: "001.txt",
              title: null,
              synopsis: "こちらで作ったあらすじ",
              sourceHash: "h",
              model: null,
              promptVersion: null,
              autoGenerated: true,
              updatedAt: "2026-11-15T00:00:00.000Z",
            } as never,
          ],
        })
        .catch((error: unknown) => error);

      expect(text(disk.get(target))).toBe(text(externalBytes));
      expect(isExternalChangeError(failure)).toBe(true);
      const copy = disk.get(
        diskPath("設定", ".novelai-recovery", "chapter_synopses.json.unsaved")
      );
      expect(text(copy)).toContain("こちらで作ったあらすじ");
    });

    test("年表：読んだあとに外で書き換わっていたら、上書きしない", async () => {
      const target = diskPath("設定", "timeline.json");
      await new TimelineStore(work).save(emptyTimeline());
      const store = new TimelineStore(work);
      const timeline = await store.load();
      disk.set(target, externalBytes);

      const failure = await store
        .save({
          ...timeline,
          lines: [{ id: "line_if", name: "こちらの系統", canonical: false } as never],
        })
        .catch((error: unknown) => error);

      expect(text(disk.get(target))).toBe(text(externalBytes));
      expect(isExternalChangeError(failure)).toBe(true);
      const copy = disk.get(diskPath("設定", ".novelai-recovery", "timeline.json.unsaved"));
      expect(text(copy)).toContain("こちらの系統");
    });

    test("年表：読んだあとに外で消されていたら、作り直さない", async () => {
      const target = diskPath("設定", "timeline.json");
      await new TimelineStore(work).save(emptyTimeline());
      const store = new TimelineStore(work);
      const timeline = await store.load();
      disk.delete(target);

      const failure = await store.save(timeline).catch((error: unknown) => error);

      expect(disk.has(target)).toBe(false);
      expect(isExternalChangeError(failure)).toBe(true);
    });

    test("作品の目標：読んだあとに外で書き換わっていたら、上書きしない", async () => {
      const target = diskPath(".aiwriter", "goals.json");
      await readWorkGoals(work);
      await writeWorkGoals(work, { ...emptyWorkGoals(), perEpisodeChars: 3000 });
      const goals = await readWorkGoals(work);
      const external = utf8(
        `${JSON.stringify({ ...emptyWorkGoals(), perEpisodeChars: 5000 }, null, 2)}\n`
      );
      disk.set(target, external);

      const failure = await writeWorkGoals(work, { ...goals, perEpisodeChars: 4000 }).catch(
        (error: unknown) => error
      );

      expect(text(disk.get(target))).toBe(text(external));
      expect(isExternalChangeError(failure)).toBe(true);
      const copy = disk.get(diskPath(".aiwriter", ".novelai-recovery", "goals.json.unsaved"));
      expect(text(copy)).toContain("4000");
      // 止めたら覚えていた古い目標を捨てる。捨てないと、何度やり直しても断り続ける
      expect((await readWorkGoals(work)).perEpisodeChars).toBe(5000);
      await writeWorkGoals(work, { ...emptyWorkGoals(), perEpisodeChars: 4000 });
      expect(text(disk.get(target))).toContain("4000");
    });

    test("作品の目標：読めなかったファイル（壊れたJSON）を空の目標で塗り替えない", async () => {
      const target = diskPath(".aiwriter", "goals.json");
      const broken = utf8("<<<<<<< HEAD\n{}\n");
      disk.set(target, broken);
      await expect(readWorkGoals(work)).rejects.toThrow();

      const failure = await writeWorkGoals(work, emptyWorkGoals()).catch(
        (error: unknown) => error
      );

      expect(text(disk.get(target))).toBe(text(broken));
      expect(isExternalChangeError(failure)).toBe(true);
      // 「もう一度操作すると読み直して保存します」は嘘になる（何度やっても止まる）。直してもらう
      expect(String(failure)).toMatch(/読めない形/);
      expect(String(failure)).toMatch(/ファイルを直してから/);
      expect(String(failure)).not.toMatch(/読み直してから保存します/);
    });

    test("作品の目標：読んだあとに外で作られた読める目標は、読み直せば保存できると伝える", async () => {
      const target = diskPath(".aiwriter", "goals.json");
      await readWorkGoals(work);
      disk.set(
        target,
        utf8(`${JSON.stringify({ ...emptyWorkGoals(), perEpisodeChars: 5000 }, null, 2)}\n`)
      );

      const failure = await writeWorkGoals(work, emptyWorkGoals()).catch(
        (error: unknown) => error
      );

      expect(String(failure)).toMatch(/保存していません/);
      expect(String(failure)).toMatch(/読み直してから保存します/);
    });

    test("自分で保存したあとは、続けて保存できる（控えを書いた中身で覚え直す）", async () => {
      const store = new TimelineStore(work);
      const timeline = await store.load();
      await store.save(timeline);
      await store.save({
        ...timeline,
        lines: [{ id: "line_if", name: "二度目", canonical: false } as never],
      });
      expect(text(disk.get(diskPath("設定", "timeline.json")))).toContain("二度目");
    });
  });
});
