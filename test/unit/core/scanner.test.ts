import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, FileType, Uri, workspace } from "../support/vscodeStub";
import { scanWork } from "../../../src/core/scanner";
import {
  setFileReaderForTests,
  vscodeFileReaderForTests,
} from "../../../src/core/fileRead";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "work_test",
  title: "作品",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-08-06T00:00:00.000Z",
};

describe("本文フォルダの選択", () => {
  beforeEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  test("本文フォルダがFileNotFoundのときだけ作品ルートへフォールバックする", async () => {
    const readDirectory = vi.fn(async () => []);
    workspace.fs = {
      readFile: vi.fn(async () => {
        throw new FileSystemError("設定なし", "FileNotFound");
      }),
      stat: vi.fn(async () => {
        throw new FileSystemError("本文なし", "FileNotFound");
      }),
      readDirectory,
    };

    const result = await scanWork(work);

    expect(result.manuscriptDir).toBe(work.folderPath);
    expect(readDirectory).toHaveBeenCalledWith(Uri.file(work.folderPath));
  });

  test("競合の退避ファイルは原稿として拾わない", async () => {
    // 「両方を残す」で作る `001.conflict-origin_main.txt` は、
    // 別環境の版の写しであって原稿ではない。同じ話数が付いた本文が
    // 2つある状態になるので、拾うと文字数が二重に数えられ、
    // AIにも同じ話を2回送る（クラウドAIならそのまま料金になる）
    const readDirectory = vi.fn(async () => [
      ["001.txt", FileType.File],
      ["001.conflict-origin_main.txt", FileType.File],
    ]);
    workspace.fs = {
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        // 作品設定は無い状態にする。本文だけを読ませたい
        if (uri.fsPath.endsWith(".json")) {
          throw new FileSystemError("設定なし", "FileNotFound");
        }
        return new TextEncoder().encode("灯が歩いた。");
      }),
      stat: vi.fn(async () => {
        throw new FileSystemError("本文なし", "FileNotFound");
      }),
      readDirectory,
    };

    const result = await scanWork(work);

    expect(result.episodes.map((episode) => episode.fileName)).toEqual([
      "001.txt",
    ]);
  });

  test("設定フォルダの中は歩かない（メモは原稿ではない）", async () => {
    /*
      作品ごとのメモは `設定/メモ/題名.md` に置く（設計書6.71）。

      **メモが原稿として拾われると、話数・文字数・あらすじ・投稿・校正の
      すべてに紛れ込む。** 走査が `設定` を飛ばすことに乗っているので、
      その前提が崩れていないことをここで押さえる。
    */
    const readDirectory = vi.fn(async (uri: { fsPath: string }) => {
      if (uri.fsPath.endsWith("設定")) {
        return [["メモ", FileType.Directory]];
      }
      if (uri.fsPath.endsWith("メモ")) {
        return [["書き出しの案.md", FileType.File]];
      }
      return [
        ["001.txt", FileType.File],
        ["設定", FileType.Directory],
      ];
    });
    workspace.fs = {
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        if (uri.fsPath.endsWith(".json")) {
          throw new FileSystemError("設定なし", "FileNotFound");
        }
        return new TextEncoder().encode("灯が歩いた。");
      }),
      stat: vi.fn(async () => {
        throw new FileSystemError("本文なし", "FileNotFound");
      }),
      readDirectory,
    };

    const result = await scanWork(work);

    expect(result.episodes.map((episode) => episode.fileName)).toEqual([
      "001.txt",
    ]);
    // そもそも中を覗きにいかない
    expect(
      readDirectory.mock.calls.map(([uri]) => uri.fsPath).join("|")
    ).not.toContain("設定");
  });

  test("カクヨムの about.txt は話に数えない（作者の実データ、2026-09-19）", async () => {
    /*
      カクヨムのバックアップをそのまま登録すると、`about.txt`
      （**作品情報**。題・キャッチコピー・紹介文・タグ）が1話として
      並び、その字数が作品の総字数に足されていた。

      **総字数が減るが、執筆量にはマイナスが残らない**——ファイル数も
      同時に減るので、`recordMeasurement` の「ファイルが増減した回は
      数えない」に乗る（`kakuyomuBackup.test.ts` で押さえている）。
    */
    const about = [
      "【タイトル】",
      "灯をたどる",
      "",
      "【キャッチコピー】",
      "その灯は、まだ消えていない。",
      "",
      "【紹介文（1行）】",
      "　夜の川べりを歩く話です。",
      "",
    ].join("\n");
    const readDirectory = vi.fn(async () => [
      ["about.txt", FileType.File],
      ["episode_0001.txt", FileType.File],
    ]);
    workspace.fs = {
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        if (uri.fsPath.endsWith(".json")) {
          throw new FileSystemError("設定なし", "FileNotFound");
        }
        if (uri.fsPath.endsWith("about.txt")) {
          return new TextEncoder().encode(about);
        }
        return new TextEncoder().encode(
          "【タイトル】\n第1話　灯\n\n【本文（1行）】\n灯が歩いた。\n"
        );
      }),
      stat: vi.fn(async () => {
        throw new FileSystemError("本文なし", "FileNotFound");
      }),
      readDirectory,
    };

    const result = await scanWork(work);

    expect(result.episodes.map((episode) => episode.fileName)).toEqual([
      "episode_0001.txt",
    ]);
    expect(result.stats.fileCount).toBe(1);
    // 紹介文もキャッチコピーも作品の字数に入らない
    expect(result.stats.totals.net).toBe("灯が歩いた。".length);
    // **落としたことは返す**（画面に出すかは使う側の判断）
    expect(result.workInfoFiles).toHaveLength(1);
    expect(result.workInfoFiles[0].endsWith("about.txt")).toBe(true);
  });

  test("読めない本文は0字の話として残る（一括読みでも消さない）", async () => {
    /*
      **一括読みへ替えても、ここは変えない**（設計書6.107）。1ファイルずつ
      読んでいたころ、読めないファイルは `catch` で0字として一覧に残った。
      一括読みで黙って捨てると、**権限のないファイルが一覧から消える**という
      別の振る舞いになる（読み口が `unreadable` の印を付けて残す）。
    */
    workspace.fs = {
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        if (uri.fsPath.endsWith(".json")) {
          throw new FileSystemError("設定なし", "FileNotFound");
        }
        if (uri.fsPath.endsWith("002.txt")) {
          throw new FileSystemError("読めません", "NoPermissions");
        }
        return new TextEncoder().encode("灯が歩いた。");
      }),
      stat: vi.fn(async () => {
        throw new FileSystemError("本文なし", "FileNotFound");
      }),
      readDirectory: vi.fn(async () => [
        ["001.txt", FileType.File],
        ["002.txt", FileType.File],
      ]),
    };

    const result = await scanWork(work);

    expect(result.episodes.map((episode) => episode.fileName)).toEqual([
      "001.txt",
      "002.txt",
    ]);
    const broken = result.episodes.find(
      (episode) => episode.fileName === "002.txt"
    );
    expect(broken?.counts.net).toBe(0);
    // 読めなかっただけなので、競合マーカー扱いにはしない
    expect(broken?.hasConflictMarkers).toBe(false);
    expect(result.stats.totals.net).toBe("灯が歩いた。".length);
  });

  test.each(["NoPermissions", "Unknown"])(
    "本文フォルダのstatが%sなら作品ルートへフォールバックせず伝播する",
    async (code) => {
      const error = new FileSystemError("本文を確認できません", code);
      const readDirectory = vi.fn(async () => []);
      workspace.fs = {
        readFile: vi.fn(async () => {
          throw new FileSystemError("設定なし", "FileNotFound");
        }),
        stat: vi.fn(async () => {
          throw error;
        }),
        readDirectory,
      };

      await expect(scanWork(work)).rejects.toBe(error);
      expect(readDirectory).not.toHaveBeenCalled();
    }
  );
});

/**
 * **走査の中を刻む**（設計書6.107）。
 *
 * 0.74.7 で読み口を Node の `fs` へ替えたところ、登録簿の整備は
 * 15.2秒→43ms になったのに**作品一覧の初回描画は25.1秒のまま**だった。
 * I/O ではなく計算そのものが残っている疑いを確かめるために、読み・
 * 数え・解析を分けて測る。**測るだけで、走査の結果は変えない。**
 */
describe("走査の計測", () => {
  beforeEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  /** 本文2つと作品情報1つを置いた作品を読ませる */
  function stubThreeFiles(): void {
    const about = [
      "【キャッチコピー】",
      "　夜を歩く。",
      "",
      "【紹介文（1行）】",
      "　夜の川べりを歩く話です。",
      "",
    ].join("\n");
    workspace.fs = {
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        if (uri.fsPath.endsWith(".json")) {
          throw new FileSystemError("設定なし", "FileNotFound");
        }
        if (uri.fsPath.endsWith("about.txt")) {
          return new TextEncoder().encode(about);
        }
        return new TextEncoder().encode("灯が歩いた。\n夜が明けた。\n");
      }),
      stat: vi.fn(async () => {
        throw new FileSystemError("本文なし", "FileNotFound");
      }),
      readDirectory: vi.fn(async () => [
        ["about.txt", FileType.File],
        ["001.txt", FileType.File],
        ["002.txt", FileType.File],
      ]),
    };
  }

  test("計測が結果に乗り、どの値も負にならない", async () => {
    stubThreeFiles();

    const { timing } = await scanWork(work);

    for (const [name, value] of Object.entries({
      prepMs: timing.prepMs,
      readMs: timing.readMs,
      countMs: timing.countMs,
      parseMs: timing.parseMs,
      otherMs: timing.otherMs,
      totalMs: timing.totalMs,
      slowestMs: timing.slowestMs,
    })) {
      // **負の値は測り方の誤り**（引き算の向きを間違えるとこうなる）
      expect(`${name}=${value >= 0}`).toBe(`${name}=true`);
    }
  });

  test("内訳の合計は、ぜんたいの時間と釣り合う", async () => {
    // `otherMs` は引き算で出すので、5つ足せば必ず合計になる。
    // ずれていれば、どこかの区間を二重に数えている
    stubThreeFiles();

    const { timing } = await scanWork(work);

    expect(
      timing.prepMs +
        timing.readMs +
        timing.countMs +
        timing.parseMs +
        timing.otherMs
    ).toBeCloseTo(timing.totalMs, 5);
  });

  test("1ファイルも読まなければ、読みは0のまま（下ごしらえと混ぜない）", async () => {
    /*
      **0.74.11 で割った境目を、ここで見張る**（設計書6.107）。
      0.74.10 までは作品設定の読み込みもフォルダーの歩きも `readMs` に
      入っていたので、**1ファイルも読んでいないのに「読み」に数字が出た**。
      「読み 58,191ms」が573回の `readFile` なのか、その手前なのかが
      分からなかったのはこのためである。
    */
    workspace.fs = {
      readFile: vi.fn(async () => {
        throw new FileSystemError("設定なし", "FileNotFound");
      }),
      stat: vi.fn(async () => {
        throw new FileSystemError("本文なし", "FileNotFound");
      }),
      readDirectory: vi.fn(async () => []),
    };

    const { timing } = await scanWork(work);

    expect(timing.files).toBe(0);
    expect(timing.readMs).toBe(0);
  });

  test("`files` は、話と作品情報を合わせた数と一致する", async () => {
    // **作品情報のファイルも読んでいる。** 話に数えないからといって
    // 走査の手間から外すと、「573ファイル」の573が実態と合わなくなる
    stubThreeFiles();

    const result = await scanWork(work);

    expect(result.timing.files).toBe(
      result.episodes.length + result.workInfoFiles.length
    );
    expect(result.timing.files).toBe(3);
  });

  test("いちばん遅かったファイルの名前が残る", async () => {
    stubThreeFiles();

    const { timing } = await scanWork(work);

    // 3つのうちどれかであること（速さは機械しだいなので名指ししない）
    expect(["about.txt", "001.txt", "002.txt"]).toContain(timing.slowestFile);
  });

  test("1つも読まなければ、最長は空のまま", async () => {
    workspace.fs = {
      readFile: vi.fn(async () => {
        throw new FileSystemError("設定なし", "FileNotFound");
      }),
      stat: vi.fn(async () => {
        throw new FileSystemError("本文なし", "FileNotFound");
      }),
      readDirectory: vi.fn(async () => []),
    };

    const { timing } = await scanWork(work);

    expect(timing.files).toBe(0);
    expect(timing.slowestFile).toBeUndefined();
    expect(timing.slowestMs).toBe(0);
  });
});

describe("走査の計測をまとめる", () => {
  test("作品ごとの計測を足し合わせ、最長は全体から選ぶ", async () => {
    const { summarizeScanTimings } = await import("../../../src/core/scanner");

    const summary = summarizeScanTimings([
      {
        files: 10,
        prepMs: 30,
        readMs: 100,
        countMs: 200,
        parseMs: 50,
        otherMs: 10,
        totalMs: 360,
        slowestFile: "001.txt",
        slowestMs: 40,
      },
      {
        files: 3,
        prepMs: 7,
        readMs: 1,
        countMs: 2,
        parseMs: 3,
        otherMs: 4,
        totalMs: 10,
        slowestFile: "巨大な合本.txt",
        slowestMs: 900,
      },
    ]);

    expect(summary.files).toBe(13);
    // **下ごしらえも足す**（0.74.11）。足し忘れると、作品が増えるほど
    // 内訳の合計がぜんたいから離れていく
    expect(summary.prepMs).toBe(37);
    expect(summary.readMs).toBe(101);
    expect(summary.countMs).toBe(202);
    expect(summary.parseMs).toBe(53);
    expect(summary.otherMs).toBe(14);
    expect(summary.totalMs).toBe(370);
    // **最長は作品をまたいで選ぶ。** どの作品の何というファイルが
    // いちばん重いのかを、1行で言い当てられるようにする
    expect(summary.slowestFile).toBe("巨大な合本.txt");
    expect(summary.slowestMs).toBe(900);
  });

  test("0件でも、すべて0の計測を返す（呼び出し側で場合分けさせない）", async () => {
    const { summarizeScanTimings } = await import("../../../src/core/scanner");

    const summary = summarizeScanTimings([]);

    expect(summary.files).toBe(0);
    expect(summary.totalMs).toBe(0);
    expect(summary.slowestFile).toBeUndefined();
  });
});

/**
 * 走査の下ごしらえも読み口を通す（設計書6.107。0.75.1）。
 *
 * ノートの実測（0.75.0）では、本文の読みが46秒→1.1秒に落ちたあとも
 * **下ごしらえだけで46秒**残っていた。犯人は `pathExists`
 * （`core/fileSystem.ts`）で、`vscode.workspace.fs.stat` を直に叩くため
 * **読み口を通らない**。1作品につき1回の往復が16作品ぶん並んでいた。
 *
 * ここで見るのは「読み口の `stat` で決めているか」だけである。
 * 速さそのものは実機でしか測れない。
 */
describe("下ごしらえも読み口で読む", () => {
  /** 既定の本文フォルダー（作品設定が無いときの `workPaths().manuscript`） */
  const MANUSCRIPT_DIR = `${work.folderPath}\\本文`;

  beforeEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  /**
   * 差し込む読み口。**`vscode.workspace.fs` を1回も呼ばない。**
   *
   * 呼ばれた場所を記録しておき、下ごしらえがこちらを通ったことを見る。
   */
  function fakeReader(manuscript: "directory" | "missing") {
    const statted: string[] = [];
    const walked: string[] = [];
    const reader = {
      async readFile(filePath: string): Promise<Uint8Array> {
        // 作品設定（.aiwriter/config.json）は無い状態にする
        throw new FileSystemError(`${filePath} は無い`, "FileNotFound");
      },
      async stat(filePath: string) {
        statted.push(filePath);
        if (manuscript === "missing") {
          throw new FileSystemError("本文フォルダーなし", "FileNotFound");
        }
        return { type: "directory" as const, size: 0, mtime: 0 };
      },
      async readDirectory(): Promise<Array<[string, "file" | "directory"]>> {
        return [];
      },
      async readTextTree(dirPath: string) {
        walked.push(dirPath);
        return [];
      },
    };
    return { reader, statted, walked };
  }

  test("本文フォルダーがあればそこを読む（読み口の stat で決める）", async () => {
    const { reader, statted, walked } = fakeReader("directory");
    const statSpy = vi.fn();
    workspace.fs = { readFile: vi.fn(), stat: statSpy, readDirectory: vi.fn() };
    setFileReaderForTests(reader);
    try {
      const result = await scanWork(work);
      expect(result.manuscriptDir).toBe(MANUSCRIPT_DIR);
      expect(walked).toEqual([MANUSCRIPT_DIR]);
    } finally {
      setFileReaderForTests(vscodeFileReaderForTests());
    }

    // 読み口へ訊いている
    expect(statted).toEqual([MANUSCRIPT_DIR]);
    // **`vscode.workspace.fs` は1回も通らない**（ここが46秒の正体だった）
    expect(statSpy).not.toHaveBeenCalled();
  });

  test("本文フォルダーが無ければ作品の根を読む", async () => {
    const { reader, walked } = fakeReader("missing");
    const statSpy = vi.fn();
    workspace.fs = { readFile: vi.fn(), stat: statSpy, readDirectory: vi.fn() };
    setFileReaderForTests(reader);
    try {
      const result = await scanWork(work);
      expect(result.manuscriptDir).toBe(work.folderPath);
      expect(walked).toEqual([work.folderPath]);
    } finally {
      setFileReaderForTests(vscodeFileReaderForTests());
    }

    expect(statSpy).not.toHaveBeenCalled();
  });
});
