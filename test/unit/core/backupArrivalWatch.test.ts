import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BACKUP_WAIT_LIMIT_MS,
  BackupArrivalWatch,
  type DownloadFolderLister,
} from "../../../src/core/backupArrivalWatch";
import { downloadFolderLister } from "../../../src/core/downloadFolderNode";

/**
 * バックアップを待っているあいだ、ダウンロードのフォルダーに来たファイルに気づく
 * （作者の指示 2026-11-01）。**見る場所は一時フォルダーへ差し替えて試す。**
 *
 * - 押したあとに来た、この作品のバックアップらしい名前だけに気づく
 * - 押す前からあったファイル・別の名前は無視する（大きさも尋ねない）
 * - 書き終わる（2回続けて同じ大きさ）まで知らせない
 * - 30分で止まる
 */

const target = { site: "narou" as const, workId: "n4190fx", title: "氷の街の約束" };

let folder: string;
let clock: number;
const now = (): number => clock;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "novelai-downloads-"));
  clock = Date.parse("2026-11-01T10:00:00.000Z");
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

/** 大きさを尋ねた名前を控える（ほかのファイルを開かない・尋ねないことを確かめる） */
function spying(lister: DownloadFolderLister): DownloadFolderLister & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    names: () => lister.names(),
    size: (name) => {
      asked.push(name);
      return lister.size(name);
    },
  };
}

describe("ダウンロードのフォルダーの見張り", () => {
  test("押したあとに来たバックアップらしい名前に、書き終わってから気づく", async () => {
    const watch = new BackupArrivalWatch({ target, lister: downloadFolderLister(folder), now });
    await watch.start();
    await writeFile(join(folder, "N4190FX.zip"), "PK");
    // 1回目は大きさを控えるだけ（書きかけかもしれない）
    expect(await watch.poll()).toEqual({ kind: "waiting" });
    expect(await watch.poll()).toEqual({ kind: "arrived", names: ["N4190FX.zip"] });
    // 一度知らせた名前は二度と知らせない
    expect(await watch.poll()).toEqual({ kind: "waiting" });
  });

  test("題の頭と合う名前（カクヨム・アルファポリスの形）にも気づく", async () => {
    const watch = new BackupArrivalWatch({ target, lister: downloadFolderLister(folder), now });
    await watch.start();
    await writeFile(join(folder, "氷の街の約束_20261101.zip"), "PK");
    await watch.poll();
    expect(await watch.poll()).toEqual({ kind: "arrived", names: ["氷の街の約束_20261101.zip"] });
  });

  test("押す前からあったファイルは、同じ作品の名前でも無視する", async () => {
    await writeFile(join(folder, "N4190FX.zip"), "PK");
    const lister = spying(downloadFolderLister(folder));
    const watch = new BackupArrivalWatch({ target, lister, now });
    await watch.start();
    await watch.poll();
    expect(await watch.poll()).toEqual({ kind: "waiting" });
    expect(lister.asked).toEqual([]);
  });

  test("別の名前のファイルは無視し、大きさも尋ねない", async () => {
    const lister = spying(downloadFolderLister(folder));
    const watch = new BackupArrivalWatch({ target, lister, now });
    await watch.start();
    await writeFile(join(folder, "請求書.pdf"), "x");
    await writeFile(join(folder, "novel-ai-assistant.zip"), "PK");
    await writeFile(join(folder, "N1111IR.zip"), "PK");
    await watch.poll();
    expect(await watch.poll()).toEqual({ kind: "waiting" });
    expect(lister.asked).toEqual([]);
  });

  test("書きかけ（.crdownload）のあいだは気づかず、名前が変わったら気づく", async () => {
    const watch = new BackupArrivalWatch({ target, lister: downloadFolderLister(folder), now });
    await watch.start();
    await writeFile(join(folder, "N4190FX.zip.crdownload"), "PK");
    await watch.poll();
    expect(await watch.poll()).toEqual({ kind: "waiting" });
    await rename(join(folder, "N4190FX.zip.crdownload"), join(folder, "N4190FX.zip"));
    await watch.poll();
    expect(await watch.poll()).toEqual({ kind: "arrived", names: ["N4190FX.zip"] });
  });

  test("大きさが変わっているあいだ（書いている途中）は知らせない", async () => {
    const watch = new BackupArrivalWatch({ target, lister: downloadFolderLister(folder), now });
    await watch.start();
    await writeFile(join(folder, "N4190FX.zip"), "PK");
    await watch.poll();
    await writeFile(join(folder, "N4190FX.zip"), "PK-more");
    expect(await watch.poll()).toEqual({ kind: "waiting" });
    expect(await watch.poll()).toEqual({ kind: "arrived", names: ["N4190FX.zip"] });
  });

  test("30分で止まる", async () => {
    const watch = new BackupArrivalWatch({ target, lister: downloadFolderLister(folder), now });
    await watch.start();
    clock += BACKUP_WAIT_LIMIT_MS - 1;
    expect(await watch.poll()).toEqual({ kind: "waiting" });
    clock += 1;
    expect(await watch.poll()).toEqual({ kind: "expired" });
  });

  test("フォルダーが無ければ、待ちを始めるところで投げる（呼ぶ側が理由を言う）", async () => {
    const watch = new BackupArrivalWatch({
      target,
      lister: downloadFolderLister(join(folder, "無いフォルダー")),
      now,
    });
    await expect(watch.start()).rejects.toThrow();
  });
});
