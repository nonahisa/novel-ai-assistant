import { afterEach, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import iconv from "iconv-lite";
// **差し替え口はスタブから直に取る**（ほかのテストと同じ形）。`"vscode"` から
// 取ると型は本物の宣言になり、`workspace.fs` は読み取り専用・
// `FileSystemError` は引数1つまでなので、覚え書きのファイルシステムを
// 差し込めない。実体は vitest の別名でどちらも同じこのファイルである
import {
  FileSystemError,
  Uri,
  window,
  workspace,
} from "../support/vscodeStub";
import { importWorkFromZip } from "../../../src/features/importWorkFromZip";
import {
  bridgeConfirmsToMessages,
  type ConfirmPicker,
} from "../support/confirmPicker";
import { inspectWorkBackup } from "../../../src/core/workZip";
// **期待する場所は、製品と同じ組み立て方で作る。** 区切り文字を手で
// 書くと、動かす環境（Windows と そうでないもの）で試験だけが落ちる
import * as paths from "../../../src/core/paths";
import type { WorkEntry } from "../../../src/models/types";

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

let confirmBridge: ConfirmPicker | undefined;

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
  // 確認は画面上部の選択窓で出る（A4、2026-09-23）。このファイルは確認の
  // 中身と答えを下の `showInformationMessage` で扱っているので、そこへ橋渡しする
  confirmBridge?.restore();
  confirmBridge = bridgeConfirmsToMessages();
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

/**
 * 書き出された「取り込みの記録」（`.aiwriter/generated/`）の中身。
 *
 * **通知に入れなかった詳しい話は、ここで確かめる**（0.70.1）。通知は1行で
 * しか出せないので、重複・欠番・文字コードの説明はこの記録へ回している。
 */
function importRecord(fs: MemoryFs, folder: string): string {
  const prefix = paths.join(folder, ".aiwriter", "generated", "取り込みの記録");
  const found = fs
    .placed()
    .filter((name) => name.startsWith(prefix) && name.endsWith(".md"));
  expect(found.length, "取り込みの記録が書き出されていない").toBe(1);
  return fs.text(found[0]);
}

/** 書庫が1つに決まる形（`decideNewWorkHome` が訊かずに決める） */
const WORKS = [{ folderPath: paths.join(LIBRARY, "既にある作品") }];

describe("ZIPから作品を取り込む", () => {
  afterEach(() => {
    window.showOpenDialog = original.showOpenDialog;
    window.showInformationMessage = original.showInformationMessage;
    confirmBridge?.restore();
    confirmBridge = undefined;
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

  /*
    実機確認リスト（0.83.8）の「なろうのバックアップを新しく取り込むと、取り込みの記録に
    「話ごとのファイルに分ける」の案内が出るか」。なろうの合本は【第N章】の見出しを
    章の最初の話にだけ持つ（作者の N5078JI.txt の形）。合本のままでは2つ目以降の章を
    置けないので、取り込みは章を立てずに、分ける操作へ案内する。
    分けると章が立つことは `splitCollectedSections.test.ts` が見ている。
  */
  it("章の見出しのある、なろうの合本を取り込むと、記録に「話ごとのファイルに分ける」の案内が残る", async () => {
    const withChapters = NAROU_TEXT.replace(
      "【エピソードタイトル】\n１　自殺の後始末",
      "【第1章】\n第一章『夏』\n\n【エピソードタイトル】\n１　自殺の後始末"
    ).replace(
      "【エピソードタイトル】\n２　ラジオ",
      "【第2章】\n第二章『冬』\n\n【エピソードタイトル】\n２　ラジオ"
    );
    // 置き換えが効いていること（効かなければ、この試験は何も見ていない）
    expect(withChapters.match(/【第\d章】/g)).toHaveLength(2);

    /** 作品を数え直す（章立ての判断で走査する）ために、フォルダーの中も読めるようにする */
    class ListingFs extends MemoryFs {
      override install(): void {
        super.install();
        const files = this.files;
        const directories = this.directories;
        (workspace.fs as unknown as Record<string, unknown>).readDirectory = async (uri: {
          fsPath: string;
        }) => {
          const separator = paths.separatorFor(uri.fsPath);
          const prefix = uri.fsPath.endsWith(separator) ? uri.fsPath : uri.fsPath + separator;
          const children = new Map<string, number>();
          for (const name of [...files.keys(), ...directories]) {
            if (!name.startsWith(prefix)) continue;
            const rest = name.slice(prefix.length);
            if (!rest) continue;
            const [head, ...tail] = rest.split(separator);
            children.set(head, tail.length > 0 || directories.has(name) ? 2 : 1);
          }
          if (children.size === 0 && !directories.has(uri.fsPath)) {
            throw new FileSystemError(uri.fsPath, "FileNotFound");
          }
          return [...children.entries()];
        };
      }
    }
    const fs = new ListingFs({
      [NAROU_ZIP_PATH]: zipSync({ "N4190FX.txt": utf8(withChapters) }),
    });
    fs.install();
    stubWindow(NAROU_ZIP_PATH);

    await importWorkFromZip(WORKS, async () =>
      workEntry(NAROU_WORK_FOLDER, NAROU_TITLE)
    );

    const text = importRecord(fs, NAROU_WORK_FOLDER);
    expect(text).toContain("章の見出しが2個あります");
    expect(text).toContain("話ごとのファイルに分ける");
    // 取り込みは章立ての台帳を作らない（原稿も1文字も変えずに置く約束）
    expect(
      fs.placed().some((name) => name.includes(paths.join(".aiwriter", "chapters")))
    ).toBe(false);
    // 知らせには見出しだけ（中身は記録にある）
    expect(notices[notices.length - 1].message).toContain("章立て");
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
    expect(done.buttons).toEqual([
      "取り込みの記録を開く",
      "フォルダーを開く",
      "手入力する",
    ]);
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

      **言う場所は取り込みの記録に移した**（0.70.1）。終わったことの内訳は、
      通知ではなく記録に書く。通知には短い「下ごしらえしました」だけを出す。
    */
    const record = importRecord(fs, NAROU_WORK_FOLDER);
    expect(record).toContain("作品全体と各話の読者の反応を記録しました");
    expect(record).not.toContain("3件");
    expect(notices[notices.length - 1].message).toContain(
      "小説家になろうの作品として下ごしらえしました"
    );
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
      "取り込みの記録を開く",
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
    expect(done.buttons).toEqual(["取り込みの記録を開く", "フォルダーを開く"]);
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

  it("相談パネルから渡されたときは、ファイルを選び直させずに同じ道で取り込む", async () => {
    // 作者の依頼（2026-09-23）：落としたファイルを、もう一度選ばせない
    const fs = new MemoryFs({});
    fs.install();
    stubWindow();
    let dialogs = 0;
    window.showOpenDialog = async () => {
      dialogs++;
      return undefined;
    };

    await importWorkFromZip(WORKS, async () => workEntry(), {
      fileName: "星を継ぐ者たち_20260919.zip",
      inspection: inspectWorkBackup(ZIP_BYTES, "星を継ぐ者たち_20260919.zip"),
    });

    expect(dialogs).toBe(0);
    expect(fs.text(paths.join(MANUSCRIPT, "episode_0001.txt"))).toBe(EPISODE_TEXT);
    // 確認の画面にも、渡されたファイルの名前が出る
    expect(notices[0].detail).toContain("取り込む元：星を継ぐ者たち_20260919.zip");
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

/**
 * アルファポリスのバックアップ（`.txt` 直）の取り込み（0.69.10）。
 *
 * **入れ物が ZIP ではない。** 作品情報の見出しも1つも無いので、題は
 * ファイル名から採るしかない。ここで見るのは**どこへ何を置いたか**と、
 * **重複・欠番を作者へ言っているか**（作者の指示、2026-09-19）である。
 */
const ALPHAPOLIS_PATH = "c:/Downloads/転生受験生の教科書チート生活 (2).txt";
const ALPHAPOLIS_TITLE = "転生受験生の教科書チート生活";
const ALPHAPOLIS_FOLDER = paths.join(LIBRARY, ALPHAPOLIS_TITLE);

/** 実物と同じ形（章題→話の見出し→本文。重複1組と欠番1つを入れてある） */
const ALPHAPOLIS_TEXT = [
  "第一章『死の谷』",
  "１話　転生",
  "",
  "　化学の先生が、無駄話をしていた&#x2014;&#x2014;。",
  "",
  "２話　てこの原理と救助",
  "",
  "　棒を渡して、支点を作る。",
  "",
  "４話　筋肉と電気",
  "",
  "　筋肉は電気で動く。",
  "",
  "４話　筋肉と電気",
  "",
  "　筋肉は電気で動く。",
  "",
].join("\r\n");

describe("アルファポリスのバックアップ（.txt）から取り込む", () => {
  afterEach(() => {
    window.showOpenDialog = original.showOpenDialog;
    window.showInformationMessage = original.showInformationMessage;
    confirmBridge?.restore();
    confirmBridge = undefined;
    window.showWarningMessage = original.showWarningMessage;
    workspace.fs = original.fs;
  });

  it("題をファイル名から採り、原稿を合本として本文フォルダーへ置く", async () => {
    const fs = new MemoryFs({ [ALPHAPOLIS_PATH]: utf8(ALPHAPOLIS_TEXT) });
    fs.install();
    stubWindow(ALPHAPOLIS_PATH);
    const registered: Array<{ folderPath: string; title: string }> = [];

    await importWorkFromZip(WORKS, async (folderPath, title) => {
      registered.push({ folderPath, title });
      return workEntry(ALPHAPOLIS_FOLDER, ALPHAPOLIS_TITLE);
    });

    // 重複ダウンロードの印（(2)）は題にもフォルダー名にも残さない
    expect(registered).toEqual([
      { folderPath: ALPHAPOLIS_FOLDER, title: ALPHAPOLIS_TITLE },
    ]);

    const manuscript = paths.join(
      ALPHAPOLIS_FOLDER,
      "本文",
      `${ALPHAPOLIS_TITLE}.txt`
    );
    expect(fs.placed()).toContain(manuscript);

    const text = fs.text(manuscript);
    // 文字参照はほどけている（`&#x2014;` が原稿に残らない）
    expect(text).toContain("無駄話をしていた——。");
    expect(/&#?[0-9A-Za-z]+;/.test(text)).toBe(false);
    // 既存の合本の形に載っている（製品の他の機能が話を見つけられる）
    expect(text).toContain("エピソード1開始");
    expect(text).toContain("【第1章】");
  });

  it("重複と欠番を、確認の画面と完了のお知らせの両方で言う", async () => {
    const fs = new MemoryFs({ [ALPHAPOLIS_PATH]: utf8(ALPHAPOLIS_TEXT) });
    fs.install();
    stubWindow(ALPHAPOLIS_PATH);

    await importWorkFromZip(WORKS, async () =>
      workEntry(ALPHAPOLIS_FOLDER, ALPHAPOLIS_TITLE)
    );

    // 確認の画面（モーダルの小さい字）
    const confirm = notices[0];
    expect(confirm.detail).toContain("4話");
    expect(confirm.detail).toContain("中身まで同じ");
    expect(confirm.detail).toContain("3話が見当たりません");

    /*
      **読み飛ばされても、もう一度言う。** ただし言う場所は分けた（0.70.1）
      ——通知には見出しだけを出し、詳しい話は取り込みの記録に残す。
      1行に繋がった通知は、実機で読めなかった（作者の報告、2026-09-19）。
    */
    const done = notices[notices.length - 1];
    expect(done.message).toContain("同じ話番号");
    expect(done.message).toContain("番号の抜け");
    // 止めない——3話を取り込み終えている
    expect(done.message).toContain("3話を取り込みました");

    const record = importRecord(fs, ALPHAPOLIS_FOLDER);
    expect(record).toContain("中身まで同じ");
    expect(record).toContain("1つだけ取り込みます");
    expect(record).toContain("3話が見当たりません");
  });

  /*
    **文字コードの助言は、製品でも出す**（作者の指示、2026-09-19）。

    実物で測ると、同じ作品の Shift_JIS 版には半角 `?` が9個、UTF-8 版には
    2個あった——差の7個は `①②③④⑤⑥` と `•`、**Shift_JIS に無い文字**である。
    取り込む前に言えば、作者は取りやめて UTF-8 で書き出し直して来られる。
  */
  it("Shift_JIS で読んだら、確認の画面と完了のお知らせの両方で言う", async () => {
    const sjis = new Uint8Array(
      iconv.encode(
        ALPHAPOLIS_TEXT.replace(
          "　棒を渡して、支点を作る。",
          "　棒を渡して、支点を作る? いや、作れる?"
        ),
        "shift_jis"
      )
    );
    const fs = new MemoryFs({ [ALPHAPOLIS_PATH]: sjis });
    fs.install();
    stubWindow(ALPHAPOLIS_PATH);

    await importWorkFromZip(WORKS, async () =>
      workEntry(ALPHAPOLIS_FOLDER, ALPHAPOLIS_TITLE)
    );

    // 確認の画面（取り込む前）。**ここに出るのがいちばん大事**
    const confirm = notices[0];
    expect(confirm.detail).toContain("Shift_JIS");
    expect(confirm.detail).toContain("UTF-8");
    expect(confirm.detail).toContain("半角の ? が2個");
    expect(confirm.detail).toContain("取りやめ");

    // 完了のお知らせ。**見出しだけ**を出し、中身は取り込みの記録に残す
    const done = notices[notices.length - 1];
    expect(done.message).toContain("文字コード");

    const record = importRecord(fs, ALPHAPOLIS_FOLDER);
    expect(record).toContain("Shift_JIS");
    expect(record).toContain("UTF-8");
  });

  it("UTF-8 で読めたときは、文字コードの話をしない", async () => {
    const fs = new MemoryFs({ [ALPHAPOLIS_PATH]: utf8(ALPHAPOLIS_TEXT) });
    fs.install();
    stubWindow(ALPHAPOLIS_PATH);

    await importWorkFromZip(WORKS, async () =>
      workEntry(ALPHAPOLIS_FOLDER, ALPHAPOLIS_TITLE)
    );

    const said = notices
      .map((entry) => `${entry.message}\n${entry.detail}`)
      .join("\n");
    expect(said).not.toContain("Shift_JIS");
    expect(said).not.toContain("UTF-8");
  });

  it("アルファポリスの形でない .txt は、1件も置かずに断る", async () => {
    const fs = new MemoryFs({
      [ALPHAPOLIS_PATH]: utf8("　夜が更けていく。\n　少年は机に向かった。\n"),
    });
    fs.install();
    stubWindow(ALPHAPOLIS_PATH);
    let registered = 0;

    await importWorkFromZip(WORKS, async () => {
      registered += 1;
      return undefined;
    });

    expect(warnings.join("\n")).toContain("取り込める形のバックアップ");
    expect(registered).toBe(0);
    expect(fs.placed()).toEqual([ALPHAPOLIS_PATH]);
  });
});

/**
 * 完了のお知らせと、取り込みの記録（作者の実機報告、2026-09-19）。
 *
 * アルファポリスの Shift_JIS 版を取り込んだとき、通知が**1行に連結された
 * 壁のような文章**になった（重複・欠番・文字コードの助言・読者の反応が
 * ぜんぶ入って280字あまり）。VS Code の通知は行を分けられないので、
 * **詳しい話は通知に入れない**——取り込みの記録として書き出し、通知は
 * 「終わったこと」と「次にできること」だけにする。
 *
 * 記録を実ファイルにするのは、**通知を閉じても読めるようにする**ためである。
 * 閉じたら二度と見られない形では、書いていないのとほとんど変わらない。
 */
describe("完了のお知らせは短く、詳しい話は記録へ", () => {
  afterEach(() => {
    window.showOpenDialog = original.showOpenDialog;
    window.showInformationMessage = original.showInformationMessage;
    confirmBridge?.restore();
    confirmBridge = undefined;
    window.showWarningMessage = original.showWarningMessage;
    workspace.fs = original.fs;
  });

  /** 書き出された取り込みの記録の中身（既定はアルファポリスの作品） */
  function record(fs: MemoryFs, folder: string = ALPHAPOLIS_FOLDER): string {
    return importRecord(fs, folder);
  }

  it("通知には、重複・欠番・文字コードの長い説明を入れない", async () => {
    const sjis = new Uint8Array(iconv.encode(ALPHAPOLIS_TEXT, "shift_jis"));
    const fs = new MemoryFs({ [ALPHAPOLIS_PATH]: sjis });
    fs.install();
    stubWindow(ALPHAPOLIS_PATH);

    await importWorkFromZip(WORKS, async () =>
      workEntry(ALPHAPOLIS_FOLDER, ALPHAPOLIS_TITLE)
    );

    const done = notices[notices.length - 1].message;
    // 実機で出た壁の中身を、1つずつ名指しで締め出す
    expect(done).not.toContain("中身まで同じでした");
    expect(done).not.toContain("下書きや非公開の話があると番号は飛びます");
    expect(done).not.toContain("丸数字");
    expect(done).not.toContain("半角の ?");
    expect(done).not.toContain("書き出したときに");
    // 通知は1行で出る。**読める長さに収める**（実機の壁は280字あまり）
    expect(done.length, `長すぎる：${done}`).toBeLessThanOrEqual(120);
  });

  it("通知は、終わったことと、気をつけたいことの見出しだけを言う", async () => {
    const sjis = new Uint8Array(iconv.encode(ALPHAPOLIS_TEXT, "shift_jis"));
    const fs = new MemoryFs({ [ALPHAPOLIS_PATH]: sjis });
    fs.install();
    stubWindow(ALPHAPOLIS_PATH);

    await importWorkFromZip(WORKS, async () =>
      workEntry(ALPHAPOLIS_FOLDER, ALPHAPOLIS_TITLE)
    );

    const done = notices[notices.length - 1];
    expect(done.message).toContain("3話を取り込みました");
    // 何があったかは見出しだけ。中身は記録にある
    expect(done.message).toContain("同じ話番号");
    expect(done.message).toContain("文字コード");
    expect(done.message).toContain("取り込みの記録");
    expect(done.buttons).toContain("取り込みの記録を開く");
  });

  it("重複・欠番・文字コードの詳しい話は、記録に残る", async () => {
    const sjis = new Uint8Array(iconv.encode(ALPHAPOLIS_TEXT, "shift_jis"));
    const fs = new MemoryFs({ [ALPHAPOLIS_PATH]: sjis });
    fs.install();
    stubWindow(ALPHAPOLIS_PATH);

    await importWorkFromZip(WORKS, async () =>
      workEntry(ALPHAPOLIS_FOLDER, ALPHAPOLIS_TITLE)
    );

    const text = record(fs);
    expect(text).toContain("中身まで同じ");
    expect(text).toContain("1つだけ取り込みます");
    expect(text).toContain("3話が見当たりません");
    expect(text).toContain("Shift_JIS");
    expect(text).toContain("UTF-8");
    // 取り込んだ元と話数も、あとから確かめられる
    expect(text).toContain(ALPHAPOLIS_TITLE);
    expect(text).toContain("3話");
  });

  /*
    **記録を置けなかったときは、黙って落とさない。**

    置き場に書けない（権限・容量・ブラウザ版の保管庫）ことは起こりうる。
    そのときまで通知を短くすると、重複も文字コードの助言も**どこにも
    残らない**——読みにくい通知のほうが、消えてしまうよりましである。
  */
  it("記録を書けなかったら、読みにくくても通知で全部言う", async () => {
    const sjis = new Uint8Array(iconv.encode(ALPHAPOLIS_TEXT, "shift_jis"));
    const fs = new MemoryFs({ [ALPHAPOLIS_PATH]: sjis });
    fs.install();
    // スタブの `fs` はどんな関数でも入る形（`(...args: never[]) => unknown`）
    // なので、呼ぶ側で本来の引数の形に戻してから包む
    const writable = workspace.fs.writeFile as (
      uri: { fsPath: string },
      bytes: Uint8Array
    ) => Promise<void>;
    workspace.fs = {
      ...workspace.fs,
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        if (uri.fsPath.includes("generated")) throw new Error("書けません");
        await writable(uri, bytes);
      },
    } as unknown as typeof workspace.fs;
    stubWindow(ALPHAPOLIS_PATH);

    await importWorkFromZip(WORKS, async () =>
      workEntry(ALPHAPOLIS_FOLDER, ALPHAPOLIS_TITLE)
    );

    const done = notices[notices.length - 1];
    expect(done.message).toContain("中身まで同じ");
    expect(done.message).toContain("Shift_JIS");
    // 開く先が無いので、記録のボタンは出さない（押して空振りさせない）
    expect(done.buttons).not.toContain("取り込みの記録を開く");
  });

  it("気をつけたいことが無ければ、通知でも記録でも騒がない", async () => {
    const fs = new MemoryFs({ [ZIP_PATH]: ZIP_BYTES });
    fs.install();
    stubWindow();

    await importWorkFromZip(WORKS, async () => workEntry());

    const done = notices[notices.length - 1];
    expect(done.message).toContain("1話を取り込みました");
    expect(done.message).not.toContain("気をつけたいこと");
    // **記録はいつでも書く。** 何を取り込んだかは、問題が無くても残す
    expect(record(fs, WORK_FOLDER)).toContain("星を継ぐ者たち");
  });
});
