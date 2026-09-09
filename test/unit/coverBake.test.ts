import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import {
  BAKED_COVER_FILES,
  MAX_BAKED_COVER_BYTES,
  bakedCoverInfo,
  bakedCoverPath,
  decodePngDataUrl,
  deleteBakedCover,
  describeBakedAt,
  describeBakedPreview,
  describeCoverUse,
  readCoverSource,
  saveBakedCover,
} from "../../src/core/coverBake";
import { FileSystemError, Uri, workspace } from "./support/vscodeStub";

/**
 * 表紙・裏表紙の合成（設計書6.65.8）。
 *
 * 合成そのものはWebViewのcanvasが行い、ここへは**PNGのdataURLが1本**
 * 届く。画面から届いたものは信用せず、**PNGであることを自分で確かめて
 * から**ファイルにする（AIの出力を信用しないのと同じ理由で、外から来た
 * ものは形を検める）。
 */

/** 本物のPNGの先頭8バイト。ここが違えば、拡張子だけPNGの別物である */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function toBase64(bytes: number[]): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 中身のあるPNG（先頭8バイトだけ本物で、あとは詰め物） */
function pngDataUrl(extra = 16): string {
  return `data:image/png;base64,${toBase64([
    ...PNG_MAGIC,
    ...new Array<number>(extra).fill(0x00),
  ])}`;
}

describe("焼いた画像のdataURLを検める", () => {
  test("PNGのdataURLはバイト列になる（先頭はPNGの印）", () => {
    const bytes = decodePngDataUrl(pngDataUrl());

    expect(bytes.length).toBe(24);
    expect([...bytes.slice(0, 8)]).toEqual(PNG_MAGIC);
  });

  test("PNG以外の種類は受け取らない", () => {
    // canvas は `toDataURL("image/png")` を返すはずで、JPEGが来るのは
    // 画面側の不具合である。黙って保存すると拡張子と中身が食い違う
    expect(() =>
      decodePngDataUrl(`data:image/jpeg;base64,${toBase64([0xff, 0xd8])}`)
    ).toThrow();
    expect(() =>
      decodePngDataUrl(`data:image/svg+xml;base64,${toBase64([0x3c])}`)
    ).toThrow();
  });

  test("dataURLの形をしていないものは受け取らない", () => {
    expect(() => decodePngDataUrl("")).toThrow();
    expect(() => decodePngDataUrl("表紙です")).toThrow();
    expect(() => decodePngDataUrl("https://example.com/cover.png")).toThrow();
    // base64ではない（URLエンコードの）dataURLも通さない
    expect(() => decodePngDataUrl("data:image/png,%89PNG")).toThrow();
  });

  test("base64が壊れていたら、分かる言葉で断る", () => {
    const broken = "data:image/png;base64,これは base64 ではありません";
    expect(() => decodePngDataUrl(broken)).toThrow(/壊れ/);
  });

  test("PNGの印で始まっていないものは受け取らない", () => {
    // base64としては読めるが、中身がPNGではない場合
    const notPng = `data:image/png;base64,${toBase64([1, 2, 3, 4, 5, 6, 7, 8])}`;
    expect(() => decodePngDataUrl(notPng)).toThrow(/PNG/);
  });

  test("大きすぎる画像は、復元する前に断る", () => {
    // 20MBを超えるbase64を実際に作ると試験が重くなるので、
    // 「4文字で3バイト」の見積もりだけを踏ませる（中身は詰め物でよい）
    const payload = "A".repeat(
      Math.ceil(((MAX_BAKED_COVER_BYTES + 1024 * 1024) * 4) / 3)
    );
    expect(() => decodePngDataUrl(`data:image/png;base64,${payload}`)).toThrow(
      /大きすぎ/
    );
  });
});

describe("焼いた画像の置き場所", () => {
  test("設定/書籍 の下に、合成済みと分かる名前で置く", () => {
    const settings = path.join("C:", "novels", "work", "設定");

    expect(bakedCoverPath(settings, "front")).toBe(
      path.join(settings, "書籍", "表紙_合成済み.png")
    );
    expect(bakedCoverPath(settings, "back")).toBe(
      path.join(settings, "書籍", "裏表紙_合成済み.png")
    );
  });

  test("名前に「_合成済み」が入っている（作者の手置きとぶつからない）", () => {
    expect(BAKED_COVER_FILES.front).toContain("_合成済み");
    expect(BAKED_COVER_FILES.back).toContain("_合成済み");
  });
});

describe("焼いた時刻の言い方", () => {
  test("何月何日の何時に焼いたかが読める", () => {
    // 「古い表紙が黙って入る」のを防ぐための表示なので、
    // 分まで出す（同じ日に何度も焼き直すため）
    const text = describeBakedAt(new Date(2026, 8, 3, 14, 5));

    expect(text).toContain("2026年9月3日");
    expect(text).toContain("14:05");
  });
});

describe("保存と読み出し", () => {
  const disk = new Map<string, Uint8Array>();
  const workFolder = "C:\\novels\\work";
  const settings = path.join(workFolder, "設定");

  function diskPath(filePath: string): string {
    return Uri.file(filePath).fsPath;
  }

  beforeEach(() => {
    disk.clear();
    workspace.fs = {
      createDirectory: async () => undefined,
      readFile: async (uri: { fsPath: string }) => {
        const bytes = disk.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        disk.set(uri.fsPath, bytes);
      },
      rename: async (
        from: { fsPath: string },
        to: { fsPath: string }
      ) => {
        const bytes = disk.get(from.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        disk.delete(from.fsPath);
        disk.set(to.fsPath, bytes);
      },
      delete: async (uri: { fsPath: string }) => {
        disk.delete(uri.fsPath);
      },
      stat: async (uri: { fsPath: string }) => {
        if (!disk.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return { mtime: Date.UTC(2026, 8, 3, 5, 0, 0), size: 1 };
      },
    } as unknown as typeof workspace.fs;
  });

  test("焼いた表紙は、同じ名前へ上書きで置かれる（生成物なので）", async () => {
    await saveBakedCover(settings, "front", pngDataUrl());
    const target = diskPath(bakedCoverPath(settings, "front"));
    expect(disk.has(target)).toBe(true);

    // 2度目も同じ場所。別名で増えていくと、書き出しがどれを使うか決まらない
    await saveBakedCover(settings, "front", pngDataUrl(32));
    expect(disk.get(target)?.length).toBe(40);
    expect([...disk.keys()].filter((key) => key === target).length).toBe(1);
  });

  test("焼いた表紙があれば、元イラストより優先して使う", async () => {
    disk.set(diskPath(path.join(workFolder, "素材", "表紙.png")), new Uint8Array([1]));
    await saveBakedCover(settings, "front", pngDataUrl());

    const source = await readCoverSource(
      workFolder,
      settings,
      "front",
      "素材/表紙.png"
    );

    expect(source?.fileName).toBe(BAKED_COVER_FILES.front);
    expect(source?.bakedAt).toBeInstanceOf(Date);
  });

  test("焼いた表紙が無ければ、元イラストを使う（焼いた時刻は無い）", async () => {
    disk.set(
      diskPath(path.join(workFolder, "素材", "表紙.png")),
      new Uint8Array([1, 2, 3])
    );

    const source = await readCoverSource(
      workFolder,
      settings,
      "front",
      "素材/表紙.png"
    );

    expect(source?.fileName).toBe("素材/表紙.png");
    expect(source?.bakedAt).toBe(null);
    expect(source?.data.length).toBe(3);
  });

  test("どちらも無ければ null（文字だけの扉になる）", async () => {
    expect(await readCoverSource(workFolder, settings, "front", null)).toBe(
      null
    );
  });

  /**
   * 裏表紙も**表紙とまったく同じ拾い方**をする（焼いた→元→無し）。
   *
   * 当初は「焼いたものだけ」にしていたが、それだと `backCoverImagePath`
   * を書いた作者から見て、焼くまで何も起きない。表紙が元イラストのまま
   * 入るのに裏表紙だけ入らないのは、理由の説明できない食い違いである。
   */
  test("裏表紙も、焼いたものが無ければ元イラストを使う", async () => {
    disk.set(
      diskPath(path.join(workFolder, "素材", "裏.png")),
      new Uint8Array([9, 9])
    );

    const raw = await readCoverSource(workFolder, settings, "back", "素材/裏.png");
    expect(raw?.fileName).toBe("素材/裏.png");
    expect(raw?.bakedAt).toBe(null);

    // 焼いたら、そちらが勝つ
    await saveBakedCover(settings, "back", pngDataUrl());
    const baked = await readCoverSource(
      workFolder,
      settings,
      "back",
      "素材/裏.png"
    );
    expect(baked?.fileName).toBe(BAKED_COVER_FILES.back);
    expect(baked?.bakedAt).toBeInstanceOf(Date);
  });

  test("裏表紙は、どちらも無ければ面ごと出さない", async () => {
    expect(await readCoverSource(workFolder, settings, "back", null)).toBe(null);
  });

  /**
   * 焼いた画像が「ある・いつのものか」だけを見る口（設計書6.65.8）。
   *
   * **画面が中身を読まずに済むようにする。** エディターのプレビューは、
   * 焼いた画像があるかどうかで見せ方を変えるが、バイト列は要らない
   * （`asWebviewUri` で読むため）。
   */
  test("焼いた画像の有無と時刻を、中身を読まずに答える", async () => {
    expect(await bakedCoverInfo(settings, "front")).toBeNull();

    await saveBakedCover(settings, "front", pngDataUrl());
    const info = await bakedCoverInfo(settings, "front");

    expect(info?.filePath).toBe(bakedCoverPath(settings, "front"));
    expect(info?.bakedAt).toBeInstanceOf(Date);
    // 裏表紙は別の持ち物（片方を焼いても、もう片方は無いまま）
    expect(await bakedCoverInfo(settings, "back")).toBeNull();
  });

  /**
   * 焼いた画像を消す（設計書6.65.8）。
   *
   * 焼いたあとに元イラストを差し替えると、**画面には新しい絵、本には
   * 古い焼き上がり**という食い違いが起きる。作者が選んで消せる道を用意し、
   * 消したら元イラストの拾い方に戻る。
   */
  test("焼いた画像を消すと、元イラストの拾い方に戻る", async () => {
    disk.set(
      diskPath(path.join(workFolder, "素材", "表紙.png")),
      new Uint8Array([1, 2, 3])
    );
    await saveBakedCover(settings, "front", pngDataUrl());

    const removed = await deleteBakedCover(settings, "front");

    expect(removed).toBe(bakedCoverPath(settings, "front"));
    expect(disk.has(diskPath(removed as string))).toBe(false);
    const source = await readCoverSource(
      workFolder,
      settings,
      "front",
      "素材/表紙.png"
    );
    expect(source?.fileName).toBe("素材/表紙.png");
  });

  test("消してよいのは「_合成済み」の2つだけ（元イラストは残る）", async () => {
    const original = diskPath(path.join(workFolder, "素材", "表紙.png"));
    disk.set(original, new Uint8Array([1]));
    await saveBakedCover(settings, "front", pngDataUrl());
    await saveBakedCover(settings, "back", pngDataUrl());

    await deleteBakedCover(settings, "front");

    // 元イラストにも、もう片方の焼き上がりにも触らない
    expect(disk.has(original)).toBe(true);
    expect(disk.has(diskPath(bakedCoverPath(settings, "back")))).toBe(true);
  });

  test("焼いた画像が無ければ、消すものが無いと分かる（null）", async () => {
    expect(await deleteBakedCover(settings, "front")).toBeNull();
  });
});

/**
 * プレビューで「焼いた画像を見ている」と伝える一言（設計書6.65.8）。
 *
 * 焼いたあとは、合成の欄を触っても本の表紙は変わらない（焼き直すまで）。
 * **見ているものと本の中身が食い違わない**よう、いつ焼いたものかを出す。
 */
describe("焼いた画像を見せているときの注記", () => {
  test("いつ焼いたものかと、やり直し方を伝える", () => {
    const text = describeBakedPreview(new Date(2026, 8, 3, 14, 5));

    expect(text).toContain("焼いた画像を表示中");
    expect(text).toContain("2026年9月3日 14:05");
    expect(text).toContain("焼き直");
  });
});

/**
 * 書き出しの完了通知の一言（設計書6.65.8の最後）。
 *
 * **焼いた画像が古いことは検知できない。** せめて「いつ焼いたものか」を
 * 見せ、焼いていないなら「焼いていない」と言う。
 */
describe("表紙まわりの一言", () => {
  const baked = {
    fileName: "表紙_合成済み.png",
    data: new Uint8Array(),
    bakedAt: new Date(2026, 8, 3, 14, 5),
  };
  const raw = {
    fileName: "素材/表紙.png",
    data: new Uint8Array(),
    bakedAt: null,
  };

  test("表紙が無ければ、扉になったと伝える", () => {
    expect(describeCoverUse(null, null)).toContain("題名だけの扉");
  });

  test("焼いた表紙なら、いつ焼いたかを出す", () => {
    const text = describeCoverUse(baked, null);
    expect(text).toContain("表紙は2026年9月3日 14:05に焼いた");
    // 裏表紙が無い本では、裏表紙のことは何も言わない
    expect(text).not.toContain("裏表紙");
  });

  test("焼いた裏表紙も、いつ焼いたかを出す", () => {
    expect(
      describeCoverUse(raw, { ...baked, fileName: "裏表紙_合成済み.png" })
    ).toContain("裏表紙は2026年9月3日 14:05に焼いた");
  });

  test("裏表紙が元イラストのままなら、焼く道があることを伝える", () => {
    const text = describeCoverUse(raw, { ...raw, fileName: "素材/裏.png" });
    expect(text).toContain("裏表紙は元イラストをそのまま使いました");
    expect(text).toContain("裏表紙を焼く");
    // 「焼いたもの」とは言わない（焼いていないのだから）
    expect(text).not.toContain("に焼いたものです");
  });

  test("表紙が元イラストのままでも、焼く道があることを伝える（裏表紙と対称）", () => {
    const text = describeCoverUse(raw, null);
    expect(text).toContain("表紙は元イラストをそのまま使いました");
    expect(text).toContain("表紙を焼く");
    expect(text).not.toContain("に焼いたものです");
    // 裏表紙が無い本では、裏表紙のことは何も言わない
    expect(text).not.toContain("裏表紙");
  });
});
