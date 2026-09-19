import { afterEach, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { FileSystemError, Uri, window, workspace } from "vscode";
import { importWorkFromZip } from "../../src/features/importWorkFromZip";
// **期待する場所は、製品と同じ組み立て方で作る。** 区切り文字を手で
// 書くと、動かす環境（Windows と そうでないもの）で試験だけが落ちる
import * as paths from "../../src/core/paths";
import type { WorkEntry } from "../../src/models/types";

/**
 * ZIPからの取り込み（設計書6.98）の、書き込みまわり。
 *
 * 読み取りと下書きの決め方は `workZip.test.ts` が見ている。ここで見るのは
 * **どこへ書いたか**と、**すでにあるフォルダーには書かないこと**
 * （実装ルール1・2）の2つである。止まるほうだけを試すと、「いつでも
 * 止まる実装」が満点になるので、**通る道も一緒に確かめる。**
 *
 * ファイルは作らず、覚え書きの上で動かす（作者の原稿の近くで試験を
 * 走らせない）。
 */

const ZIP_PATH = "c:/Downloads/星を継ぐ者たち_20260919.zip";
/** 登録済みの作品の親。ここが書庫になり、作品フォルダーができる */
const LIBRARY = paths.normalize("c:/小説");
const WORK_FOLDER = paths.join(LIBRARY, "星を継ぐ者たち");
const MANUSCRIPT = paths.join(WORK_FOLDER, "本文");
const SETTINGS = paths.join(WORK_FOLDER, "設定");

const ABOUT_TEXT = [
  "【タイトル】",
  "星を継ぐ者たち",
  "",
  "【ジャンル】",
  "異世界ファンタジー",
  "",
  "【キャッチコピー】",
  "教科書の力を見直してみませんか？",
  "",
  "【紹介文】",
  "受験生の少年が、いきなり異世界に転生した。",
  "",
  "【タグ】",
  "- 異世界転生",
  "- チート",
  "",
].join("\n");

const EPISODE_TEXT = [
  "【タイトル】",
  "第1話　転生前夜",
  "",
  "【本文】",
  "夜が更けていく。",
  "",
].join("\n");

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const ZIP_BYTES = zipSync({
  "about.txt": utf8(ABOUT_TEXT),
  "episode_0001.txt": utf8(EPISODE_TEXT),
});

/**
 * カクヨムのバックアップと分かる作品情報（設計書6.99）。
 *
 * 上の `ABOUT_TEXT` との違いは【セルフレイティング】だけである——**この欄が
 * あるかどうかで、出どころを見分ける**（`backupSite.ts`）。見分けられない
 * ZIPでは台帳を作らないことも、同じ試験の中で確かめる。
 */
const KAKUYOMU_ABOUT_TEXT = [
  ABOUT_TEXT,
  "【セルフレイティング】",
  "- 残酷描写有り",
  "",
].join("\n");

const KAKUYOMU_ZIP_BYTES = zipSync({
  "about.txt": utf8(KAKUYOMU_ABOUT_TEXT),
  "episode_0001.txt": utf8(EPISODE_TEXT),
});

/**
 * なろうの書き出し（実物の形。2026-09-19、作者の `N4190FX.zip`）。
 *
 * **Nコードの名前の .txt が1つだけ**で、頭に作品情報、続けて全話が並ぶ。
 * 話ごとの【リアクション】と、末尾の【免責事項】まで含めて組む。
 */
const NAROU_ZIP_PATH = "c:/Downloads/N4190FX.zip";
const NAROU_TITLE = "肉片とラジオと心霊現象";
const NAROU_WORK_FOLDER = paths.join(LIBRARY, NAROU_TITLE);
const NAROU_POSTING = paths.join(NAROU_WORK_FOLDER, "設定", "投稿状態.json");

const NAROU_TEXT = [
  "【ユーザ情報】",
  "ユーザID: 1125969",
  "",
  "【Nコード】",
  "N4190FX",
  "",
  "【タイトル】",
  NAROU_TITLE,
  "",
  "【ジャンル】",
  "ホラー〔文芸〕",
  "",
  "【キーワード】",
  "怪談 実体験 飛び降り",
  "",
  "【あらすじ】",
  "筆者が中学３年生の頃に体験した実体験です。",
  "",
  "【評価】",
  "総合評価ポイント: 2pt",
  "評価者数: 1人",
  "お気に入り登録: 1件",
  // **評価平均は小数になる。** 台帳まで小数のまま届くかを、この道で見る
  "評価ポイント: 2pt",
  "評価平均: 2.50pt",
  "",
  "【収益情報】",
  "累計獲得チアスコア: 0.00",
  "",
  "------------------------- エピソード1開始 -------------------------",
  "【エピソードタイトル】",
  "１　自殺の後始末",
  "",
  "【本文】",
  "　あれは、確か中学３年生の頃。",
  "",
  "【リアクション】",
  "0件",
  "",
  "------------------------- エピソード2開始 -------------------------",
  "【エピソードタイトル】",
  "２　ラジオ",
  "",
  "【本文】",
  "　その夜、ラジオが鳴った。",
  "",
  "【リアクション】",
  "3件",
  "",
  "【免責事項】",
  "このファイルは『小説家になろう』の投稿済み作品テキストダウンロード機能を用いて作成されました。",
  "",
].join("\n");

const NAROU_ZIP_BYTES = zipSync({ "N4190FX.txt": utf8(NAROU_TEXT) });

const POSTING = paths.join(SETTINGS, "投稿状態.json");

/** 覚え書きの上のファイルシステム。**本物のディスクには触らない** */
class MemoryFs {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>();

  constructor(seed: Record<string, Uint8Array>) {
    for (const [name, bytes] of Object.entries(seed)) {
      this.files.set(name, bytes);
    }
  }

  /** 一時ファイル（`.novelai-....tmp`）を除いた、置かれたファイルの名前 */
  placed(): string[] {
    return [...this.files.keys()]
      .filter((name) => !name.includes(".novelai-"))
      .sort();
  }

  text(name: string): string {
    const bytes = this.files.get(name);
    if (!bytes) throw new Error(`${name} が置かれていません。`);
    return new TextDecoder().decode(bytes);
  }

  install(): void {
    workspace.fs = {
      readFile: async (uri: { fsPath: string }) => {
        const bytes = this.files.get(uri.fsPath);
        if (!bytes) throw new FileSystemError(uri.fsPath, "FileNotFound");
        return bytes;
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        this.files.set(uri.fsPath, bytes);
      },
      stat: async (uri: { fsPath: string }) => {
        if (this.files.has(uri.fsPath)) return { type: 1 };
        if (this.directories.has(uri.fsPath)) return { type: 2 };
        throw new FileSystemError(uri.fsPath, "FileNotFound");
      },
      createDirectory: async (uri: { fsPath: string }) => {
        this.directories.add(uri.fsPath);
      },
      rename: async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        if (this.files.has(to.fsPath) && !options?.overwrite) {
          throw new FileSystemError(to.fsPath, "FileExists");
        }
        const bytes = this.files.get(from.fsPath);
        if (!bytes) throw new FileSystemError(from.fsPath, "FileNotFound");
        this.files.delete(from.fsPath);
        this.files.set(to.fsPath, bytes);
      },
      delete: async (uri: { fsPath: string }) => {
        this.files.delete(uri.fsPath);
      },
    } as unknown as typeof workspace.fs;
  }
}

const original = {
  showOpenDialog: window.showOpenDialog,
  showInformationMessage: window.showInformationMessage,
  showWarningMessage: window.showWarningMessage,
  fs: workspace.fs,
};

const warnings: string[] = [];
/** 出した「お知らせ」。最後の1件が取り込みの完了報告になる */
const notices: Array<{
  message: string;
  buttons: string[];
  /** モーダルの小さい字。確認の画面に何が出たかはここにある */
  detail: string;
}> = [];

/** 画面の3つの窓口を差し替える。作者は「取り込む」を押した体にする */
function stubWindow(zipPath: string = ZIP_PATH): void {
  warnings.length = 0;
  notices.length = 0;
  window.showOpenDialog = async () => [Uri.file(zipPath)];
  window.showInformationMessage = (async (
    message: string,
    ...items: unknown[]
  ) => {
    notices.push({
      message,
      // 確認の窓は第1引数のうしろにモーダルの指定が来る。ボタンだけを拾う
      buttons: items.filter((item): item is string => typeof item === "string"),
      detail: items
        .map((item) =>
          item && typeof item === "object" && "detail" in item
            ? String((item as { detail?: unknown }).detail ?? "")
            : ""
        )
        .join(""),
    });
    return "取り込む";
  }) as typeof window.showInformationMessage;
  window.showWarningMessage = (async (message: string) => {
    warnings.push(message);
    return undefined;
  }) as typeof window.showWarningMessage;
}

function workEntry(
  folderPath: string = WORK_FOLDER,
  title = "星を継ぐ者たち"
): WorkEntry {
  return {
    id: "w1",
    title,
    folderPath,
    registeredAt: "2026-09-19T00:00:00.000Z",
  };
}

/** 書庫が1つに決まる形（`decideNewWorkHome` が訊かずに決める） */
const WORKS = [{ folderPath: paths.join(LIBRARY, "既にある作品") }];

describe("ZIPから作品を取り込む", () => {
  afterEach(() => {
    window.showOpenDialog = original.showOpenDialog;
    window.showInformationMessage = original.showInformationMessage;
    window.showWarningMessage = original.showWarningMessage;
    workspace.fs = original.fs;
  });

  it("書庫の中に作品フォルダーを作り、原稿を本文フォルダーへ置く", async () => {
    const fs = new MemoryFs({ [ZIP_PATH]: ZIP_BYTES });
    fs.install();
    stubWindow();
    const registered: Array<{ folderPath: string; title: string }> = [];

    await importWorkFromZip(WORKS, async (folderPath, title) => {
      registered.push({ folderPath, title });
      return workEntry();
    });

    expect(registered).toEqual([
      { folderPath: WORK_FOLDER, title: "星を継ぐ者たち" },
    ]);
    expect(fs.placed()).toContain(paths.join(MANUSCRIPT, "episode_0001.txt"));
    expect(fs.placed()).toContain(paths.join(MANUSCRIPT, "about.txt"));
    // 頭書きごと、ZIPの中身をそのまま置く
    expect(fs.text(paths.join(MANUSCRIPT, "episode_0001.txt"))).toBe(EPISODE_TEXT);
  });

  it("「1作品だと分かっている」と伝えて登録を頼む（書庫か訊かせない）", async () => {
    const fs = new MemoryFs({ [ZIP_PATH]: ZIP_BYTES });
    fs.install();
    stubWindow();
    const options: unknown[] = [];

    await importWorkFromZip(WORKS, async (_folderPath, _title, given) => {
      options.push(given);
      return workEntry();
    });

    // **作ったのは取り込み自身である**（`本文/` と `設定/` を置いた）。
    // 書庫かもしれないと見に行かせると、作者に間違った既定の選択が出る
    expect(options).toEqual([{ knownSingleWork: true }]);
  });

  it("about.txt のキャッチコピーと紹介文を、紹介文の文書へ下書きする", async () => {
    const fs = new MemoryFs({ [ZIP_PATH]: ZIP_BYTES });
    fs.install();
    stubWindow();

    await importWorkFromZip(WORKS, async () => workEntry());

    const synopsis = fs.text(paths.join(SETTINGS, "synopsis.md"));
    expect(synopsis).toContain("教科書の力を見直してみませんか？");
    expect(synopsis).toContain("受験生の少年が、いきなり異世界に転生した。");
  });

  it("about.txt のジャンルとタグを、プロットの空いている節へ下書きする", async () => {
    const fs = new MemoryFs({ [ZIP_PATH]: ZIP_BYTES });
    fs.install();
    stubWindow();

    await importWorkFromZip(WORKS, async () => workEntry());

    const plot = fs.text(paths.join(SETTINGS, "plot.md"));
    expect(plot).toContain("異世界ファンタジー");
    expect(plot).toContain("異世界転生");
    expect(plot).toContain("チート");
  });

  it("紹介文の文書がすでにあれば、上書きしない", async () => {
    const fs = new MemoryFs({
      [ZIP_PATH]: ZIP_BYTES,
      [paths.join(SETTINGS, "synopsis.md")]: utf8("作者が書いた紹介文\n"),
    });
    fs.install();
    stubWindow();

    // 作品フォルダーそのものは「まだ無い」ことにして、取り込みは通す
    // （`設定/` の中だけが先に在る、という作りにくい形をわざと作る）
    await importWorkFromZip(WORKS, async () => workEntry());

    expect(fs.text(paths.join(SETTINGS, "synopsis.md"))).toBe(
      "作者が書いた紹介文\n"
    );
  });

  /*
    読者の反応の下ごしらえ（設計書6.99／6.79.7）。

    **訊かずに書くものなので、書きすぎないことのほうを厚く見る。**
    出どころが分からないZIPで台帳ができてしまうと、なろうの作品に
    カクヨムの記録が入り、あとから分けられない。
  */
  it("カクヨムのバックアップなら、投稿状態の台帳へサイトを書き留める", async () => {
    const fs = new MemoryFs({ [ZIP_PATH]: KAKUYOMU_ZIP_BYTES });
    fs.install();
    stubWindow();

    await importWorkFromZip(WORKS, async () => workEntry());

    const ledger = JSON.parse(fs.text(POSTING));
    // **作品IDもURLも持たない**（バックアップに入っていない。6.68.5）
    expect(ledger.siteProfiles).toEqual([
      { site: "kakuyomu", genre: "異世界ファンタジー" },
    ]);
    // 数字は1つも作らない。紹介文の「10万PV達成記念」から拾わない
    expect(ledger.readerStats).toBeUndefined();
    expect(ledger.sites).toEqual([]);
  });

  it("出どころが分からないZIPでは、台帳を作らない", async () => {
    const fs = new MemoryFs({ [ZIP_PATH]: ZIP_BYTES });
    fs.install();
    stubWindow();

    await importWorkFromZip(WORKS, async () => workEntry());

    expect(fs.placed()).not.toContain(POSTING);
  });

  it("投稿状態がすでにあれば、作者が書いたものを壊さない", async () => {
    const existing = {
      schemaVersion: "1",
      sites: [],
      siteProfiles: [
        { site: "kakuyomu", genre: "現代ファンタジー", note: "本編はこちら" },
      ],
      posts: [],
      rankings: [],
    };
    const fs = new MemoryFs({
      [ZIP_PATH]: KAKUYOMU_ZIP_BYTES,
      [POSTING]: utf8(`${JSON.stringify(existing, null, 2)}\n`),
    });
    fs.install();
    stubWindow();

    await importWorkFromZip(WORKS, async () => workEntry());

    // ジャンルもメモも、取り込みの下ごしらえで押し流さない（実装ルール2）
    expect(JSON.parse(fs.text(POSTING)).siteProfiles).toEqual(
      existing.siteProfiles
    );
  });

  it("なろうのバックアップでは、貼り付けを案内しない（手入力だけ）", async () => {
    const fs = new MemoryFs({ [NAROU_ZIP_PATH]: NAROU_ZIP_BYTES });
    fs.install();
    stubWindow(NAROU_ZIP_PATH);

    await importWorkFromZip(WORKS, async () =>
      workEntry(NAROU_WORK_FOLDER, NAROU_TITLE)
    );

    const done = notices[notices.length - 1];
    expect(done.message).toContain("小説家になろう");
    expect(done.message).toContain("手入力");
    // **封筒を受け取らないサイトで「貼り付け」と言わない**（6.79.7の判定）
    expect(done.message).not.toContain("貼り付け");
    expect(done.buttons).toEqual(["フォルダーを開く", "手入力する"]);
  });

  /*
    なろうのバックアップには**読者の反応の数字が入っている**（作者の裁定、
    2026-09-19）。作品全体の【評価】と、話ごとの【リアクション】である。
    サイトへは触らない——読むのは作者がダウンロードしたファイルだけ。
  */
  it("なろうのバックアップから、作品IDと読者の反応を台帳へ積む", async () => {
    const fs = new MemoryFs({ [NAROU_ZIP_PATH]: NAROU_ZIP_BYTES });
    fs.install();
    stubWindow(NAROU_ZIP_PATH);

    await importWorkFromZip(WORKS, async () =>
      workEntry(NAROU_WORK_FOLDER, NAROU_TITLE)
    );

    const ledger = JSON.parse(fs.text(NAROU_POSTING));
    expect(ledger.siteProfiles).toEqual([
      {
        site: "narou",
        workId: "n4190fx",
        workUrl: "https://ncode.syosetu.com/n4190fx/",
        genre: "ホラー〔文芸〕",
      },
    ]);

    const stats = ledger.readerStats as Array<Record<string, unknown>>;
    expect(stats).toHaveLength(3);
    expect(stats.map((row) => row.source)).toEqual([
      "backup",
      "backup",
      "backup",
    ]);
    // **なろう固有の指標も取りこぼさない**（0.69.9）
    expect(stats[0]).toMatchObject({
      site: "narou",
      scope: "work",
      metrics: {
        points: 2,
        bookmarks: 1,
        narou_raters: 1,
        narou_ratingPoints: 2,
        // 小数のまま台帳へ届く（切り捨てて別の値にしない）
        narou_ratingAverage: 2.5,
      },
    });
    expect(stats[1]).toMatchObject({ scope: "episode", episode: 1, metrics: { likes: 0 } });
    expect(stats[2]).toMatchObject({ scope: "episode", episode: 2, metrics: { likes: 3 } });

    // 収益情報とユーザIDは、台帳のどこにも入らない
    const asText = fs.text(NAROU_POSTING);
    expect(asText).not.toContain("チアスコア");
    expect(asText).not.toContain("1125969");
    /*
      **何を書き留めたかは言うが、件数は言わない**（0.69.9、作者の指摘）。
      話ごとに1件ずつ積むので、500話なら501件になる——「501件記録しました」は
      知らせではなく驚きになる。内訳は台帳と執筆量パネルで見られる。
    */
    const last = notices[notices.length - 1].message;
    expect(last).toContain("作品全体と各話の読者の反応を記録しました");
    expect(last).not.toContain("3件");
  });

  /*
    **合本の話数は、ファイルの数ではない**（0.69.9）。なろうのバックアップは
    全話が1ファイルなので、ファイルを数えると「1話を取り込みました」と出る
    （実データで確認）。確認の画面と完了のお知らせの両方を見る。
  */
  it("なろうの合本は、中の話数で数える（確認画面と完了のお知らせ）", async () => {
    const fs = new MemoryFs({ [NAROU_ZIP_PATH]: NAROU_ZIP_BYTES });
    fs.install();
    stubWindow(NAROU_ZIP_PATH);

    await importWorkFromZip(WORKS, async () =>
      workEntry(NAROU_WORK_FOLDER, NAROU_TITLE)
    );

    const confirm = notices.map((entry) => entry.detail).join("\n");
    expect(confirm).toContain("取り込む話：2話");
    expect(confirm).toContain("1つのファイルに全話が入っています");
    expect(notices[notices.length - 1].message).toContain("2話を取り込みました");
  });

  it("なろうの【キーワード】を、タグとしてプロットへ下書きする", async () => {
    const fs = new MemoryFs({ [NAROU_ZIP_PATH]: NAROU_ZIP_BYTES });
    fs.install();
    stubWindow(NAROU_ZIP_PATH);

    await importWorkFromZip(WORKS, async () =>
      workEntry(NAROU_WORK_FOLDER, NAROU_TITLE)
    );

    const plot = fs.text(paths.join(NAROU_WORK_FOLDER, "設定", "plot.md"));
    expect(plot).toContain("怪談");
    expect(plot).toContain("飛び降り");
  });

  it("カクヨムのバックアップでは、貼り付けと手入力の両方を案内する", async () => {
    const fs = new MemoryFs({ [ZIP_PATH]: KAKUYOMU_ZIP_BYTES });
    fs.install();
    stubWindow();

    await importWorkFromZip(WORKS, async () => workEntry());

    const done = notices[notices.length - 1];
    expect(done.message).toContain("読者の反応");
    expect(done.buttons).toEqual([
      "フォルダーを開く",
      "貼り付けて取り込む",
      "手入力する",
    ]);
  });

  it("出どころが分からなければ、読者の反応へ誘わない", async () => {
    const fs = new MemoryFs({ [ZIP_PATH]: ZIP_BYTES });
    fs.install();
    stubWindow();

    await importWorkFromZip(WORKS, async () => workEntry());

    const done = notices[notices.length - 1];
    expect(done.message).not.toContain("読者の反応");
    expect(done.buttons).toEqual(["フォルダーを開く"]);
  });

  it("同じ名前のフォルダーがすでにあれば、理由を出して止まる", async () => {
    const fs = new MemoryFs({ [ZIP_PATH]: ZIP_BYTES });
    fs.directories.add(WORK_FOLDER);
    fs.install();
    stubWindow();
    let registered = 0;

    await importWorkFromZip(WORKS, async () => {
      registered += 1;
      return undefined;
    });

    expect(warnings.join("\n")).toContain("すでにあります");
    expect(registered, "登録まで進んではいけない").toBe(0);
    // ZIPのほかには1件も置いていない
    expect(fs.placed()).toEqual([ZIP_PATH]);
  });

  it("ZIPを選ばずに閉じたら、何も起きない", async () => {
    const fs = new MemoryFs({ [ZIP_PATH]: ZIP_BYTES });
    fs.install();
    stubWindow();
    window.showOpenDialog = async () => undefined;

    await importWorkFromZip(WORKS, async () => workEntry());

    expect(fs.placed()).toEqual([ZIP_PATH]);
  });

  it("危ないファイル名のZIPは、1件も置かずに断る", async () => {
    const dangerous = zipSync({
      "episode_0001.txt": utf8(EPISODE_TEXT),
      "../外へ.txt": utf8("よそへ書きます"),
    });
    const fs = new MemoryFs({ [ZIP_PATH]: dangerous });
    fs.install();
    stubWindow();
    let registered = 0;

    await importWorkFromZip(WORKS, async () => {
      registered += 1;
      return undefined;
    });

    expect(warnings.join("\n")).toContain("外を指すファイル名");
    expect(registered).toBe(0);
    expect(fs.placed()).toEqual([ZIP_PATH]);
  });
});
