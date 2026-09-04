import * as path from "path";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { unzipSync } from "fflate";
import { exportEpub } from "../../src/features/exportEpub";
import type { WorkEntry } from "../../src/models/types";
import {
  FileSystemError,
  FileType,
  Uri,
  window,
  workspace,
} from "./support/vscodeStub";

/**
 * 合本（1ファイルに複数話）をEPUBへ組む（設計書6.65.15）。
 *
 * **合本は話ごとに割って、1話＝1章で組む。** 書き出しは長いあいだ
 * `parseEpisodeMetadata` だけを通っており、区切り行（`エピソードN開始`）も
 * 【エピソードタイトル】【後書き】【リアクション】も、まるごと本文として
 * 本に入っていた（作者の原稿を1文字も変えないので、被害は本の中だけ）。
 *
 * ここは作り物のファイルシステムで `exportEpub` をそのまま動かし、
 * 出来た本を開いて確かめる。本文や目次を別に組み直すと、**製品に無い本**
 * を確かめたことになる。
 */

const work: WorkEntry = {
  id: "work_epub_collected",
  title: "氷の街",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const disk = new Map<string, Uint8Array>();
const shown: string[] = [];

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

function put(relativePath: string, text: string): void {
  disk.set(
    diskPath(path.join(work.folderPath, relativePath)),
    new TextEncoder().encode(text)
  );
}

/** 作り物のファイルシステム。キーは `Uri.file` が返す形に揃える */
function installDisk(): void {
  const separator = path.sep;
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
      to: { fsPath: string },
      options?: { overwrite?: boolean }
    ) => {
      const bytes = disk.get(from.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      if (!options?.overwrite && disk.has(to.fsPath)) {
        throw new FileSystemError("exists", "FileExists");
      }
      disk.set(to.fsPath, bytes);
      disk.delete(from.fsPath);
    },
    delete: async (uri: { fsPath: string }) => {
      disk.delete(uri.fsPath);
    },
    stat: async (uri: { fsPath: string }) => {
      if (disk.has(uri.fsPath)) {
        return { mtime: Date.UTC(2026, 8, 5, 5, 0, 0), size: 1 };
      }
      const prefix = uri.fsPath + separator;
      for (const key of disk.keys()) {
        if (key.startsWith(prefix)) return { mtime: 0, size: 0 };
      }
      throw new FileSystemError("missing", "FileNotFound");
    },
    readDirectory: async (uri: { fsPath: string }) => {
      const prefix = uri.fsPath + separator;
      const names = new Map<string, FileType>();
      for (const key of disk.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const cut = rest.indexOf(separator);
        if (cut < 0) names.set(rest, FileType.File);
        else names.set(rest.slice(0, cut), FileType.Directory);
      }
      if (names.size === 0) throw new FileSystemError("missing", "FileNotFound");
      return [...names.entries()];
    },
  } as unknown as typeof workspace.fs;
}

beforeEach(() => {
  disk.clear();
  shown.length = 0;
  installDisk();

  window.showInformationMessage = async (message: string) => {
    shown.push(message);
    return undefined;
  };
  window.showWarningMessage = async (message: string) => {
    shown.push(message);
    return undefined;
  };
  window.showErrorMessage = async (message: string) => {
    shown.push(message);
    return undefined;
  };
});

function writeBook(config: Record<string, unknown>): void {
  put("設定/書籍/book.json", JSON.stringify(config));
}

/** 書き出された本を開き直す（ZIPの中身をそのまま返す） */
function exported(): Record<string, Uint8Array> {
  const found = [...disk.entries()].find(([name]) => name.endsWith(".epub"));
  if (!found) throw new Error("EPUBが書き出されていません");
  return unzipSync(found[1]);
}

function textIn(files: Record<string, Uint8Array>, name: string): string {
  const bytes = files[name];
  if (!bytes) throw new Error(`${name} が本に入っていません`);
  return new TextDecoder().decode(bytes);
}

/**
 * 目に見える字だけを取り出す。
 *
 * 縦書きでは数字が `<span class="tcy">1</span>` に包まれるので、
 * 素の文字列と突き合わせるには札を落とす必要がある。
 */
function plain(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/** 実データで観察された合本の形（区切り＋頭書き＋後書き＋リアクション） */
const COLLECTED = [
  "------------------------- エピソード1開始 -------------------------",
  "【エピソードタイトル】",
  "１話　転生",
  "",
  "【本文】",
  "　朝が来た。",
  "",
  "　鐘が鳴る。",
  "",
  "【後書き】",
  "　お読みいただきありがとうございます。",
  "",
  "【リアクション】",
  "いいね: 19件",
  "",
  "------------------------- エピソード2開始 -------------------------",
  "【エピソードタイトル】",
  "２話　再会",
  "",
  "【本文】",
  "　昼が来た。",
  "",
  "------------------------- エピソード3開始 -------------------------",
  "【エピソードタイトル】",
  "３話　別離",
  "",
  "【本文】",
  "　夜が来た。",
].join("\n");

describe("合本は話ごとに章へ割る（設計書6.65.15）", () => {
  beforeEach(() => {
    put("本文/全話.txt", COLLECTED);
    writeBook({ title: "氷の街" });
  });

  test("3話ぶんの合本から、3つの章ができる", async () => {
    await exportEpub(work);
    const files = exported();

    expect(Object.keys(files)).toContain("OEBPS/chapter-001.xhtml");
    expect(Object.keys(files)).toContain("OEBPS/chapter-002.xhtml");
    expect(Object.keys(files)).toContain("OEBPS/chapter-003.xhtml");
    // 4つ目は無い（合本を丸ごと1章にしていた頃は1つしか無かった）
    expect(Object.keys(files)).not.toContain("OEBPS/chapter-004.xhtml");
    expect(shown.join("\n")).toContain("EPUBを書き出しました（3話）");
  });

  test("区切り行・頭書き・後書き・リアクションは本文に入らない", async () => {
    await exportEpub(work);
    const files = exported();
    const bodies = [1, 2, 3]
      .map((index) => plain(textIn(files, `OEBPS/chapter-00${index}.xhtml`)))
      .join("\n");

    expect(bodies).toContain("朝が来た。");
    expect(bodies).toContain("昼が来た。");
    expect(bodies).toContain("夜が来た。");

    expect(bodies).not.toContain("エピソード1開始");
    expect(bodies).not.toContain("エピソードタイトル");
    expect(bodies).not.toContain("【本文】");
    expect(bodies).not.toContain("お読みいただきありがとうございます");
    expect(bodies).not.toContain("いいね: 19件");
  });

  test("章の見出しは、その話の話数と題になる", async () => {
    await exportEpub(work);
    const files = exported();

    expect(plain(textIn(files, "OEBPS/chapter-001.xhtml"))).toContain(
      "第1話　転生"
    );
    expect(plain(textIn(files, "OEBPS/chapter-002.xhtml"))).toContain(
      "第2話　再会"
    );
    expect(plain(textIn(files, "OEBPS/chapter-003.xhtml"))).toContain(
      "第3話　別離"
    );
  });

  test("目次にも話ごとの題が並ぶ", async () => {
    await exportEpub(work);
    const nav = plain(textIn(exported(), "OEBPS/nav.xhtml"));

    expect(nav).toContain("第1話　転生");
    expect(nav).toContain("第2話　再会");
    expect(nav).toContain("第3話　別離");
    // 合本を丸ごと1章にしていた頃は、この1行しか無かった
    expect(nav).not.toContain("第1〜3話");
  });

  /**
   * **話数が読めない話でも、番号を捏造しない**（`collectedEpisodeLabel` と
   * 同じ約束）。並び順を話数として出すと、「プロローグ」が第1話になる。
   */
  test("話数の読めない話は、題だけを見出しにする", async () => {
    put(
      "本文/全話.txt",
      [
        "------- エピソード1開始 -------",
        "【エピソードタイトル】",
        "プロローグ",
        "",
        "【本文】",
        "　雪が降る。",
        "",
        "------- エピソード2開始 -------",
        "【エピソードタイトル】",
        "１話　転生",
        "",
        "【本文】",
        "　朝が来た。",
      ].join("\n")
    );

    await exportEpub(work);
    const files = exported();

    expect(plain(textIn(files, "OEBPS/chapter-001.xhtml"))).toContain(
      "プロローグ"
    );
    expect(plain(textIn(files, "OEBPS/chapter-001.xhtml"))).not.toContain(
      "第1話"
    );
    expect(plain(textIn(files, "OEBPS/chapter-002.xhtml"))).toContain(
      "第1話　転生"
    );
  });
});

/**
 * **単話ファイルだけの作品は、1バイトも変わらない**（回帰の固定）。
 *
 * 合本を割る道を足したせいで、いままで出ていた本が変わっては困る。
 * 中身の見分けが付かないので、ZIPの中の1つ1つをハッシュで固定する
 * （下の期待値は、合本を割る前の書き出しから採った）。
 *
 * `content.opf` だけは書き出すたびに変わる（本を見分ける札と時刻）ので、
 * その2か所を伏せてから固定する。
 */
describe("単話だけの作品の本は変わらない（回帰の固定）", () => {
  /** 1区切りだけの頭書き付き。**これは合本ではない**（単話の道を通る） */
  const WITH_HEADER = [
    "-------- エピソード1開始 --------",
    "【エピソードタイトル】",
    "２話　再会",
    "",
    "【本文】",
    "　昼が来た。",
  ].join("\n");

  /** 書き出すたびに変わる2か所を伏せる */
  function stableOpf(text: string): string {
    return text
      .replace(/urn:uuid:[0-9a-fA-F-]+/g, "urn:uuid:FIXED")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, "FIXED");
  }

  test("ZIPの中身がひとつ残らず同じ", async () => {
    put("本文/第1話 出会い.txt", "　朝が来た。\n\n　鐘が鳴る。");
    put("本文/第2話.txt", WITH_HEADER);
    writeBook({ title: "氷の街", author: "望月" });

    await exportEpub(work);
    const files = exported();

    const digests: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(files)) {
      const target =
        name === "OEBPS/content.opf"
          ? new TextEncoder().encode(
              stableOpf(new TextDecoder().decode(bytes))
            )
          : bytes;
      digests[name] = createHash("sha256").update(target).digest("hex");
    }

    expect(digests).toEqual(GOLDEN);
  });
});

/**
 * 合本を割る前の書き出しから採ったハッシュ（2026-09-05）。
 *
 * **ここを更新してよいのは、本の見た目を変えると決めたときだけ**である。
 * 合本の実装で動いたら、単話の道を巻き込んでいる。
 */
const GOLDEN: Record<string, string> = {
  mimetype: "e468e350d1143eb648f60c7b0bd6031101ec0544a361ca74ecef256ac901f48b",
  "META-INF/container.xml":
    "9651e8491f140491133c46c807ea254ad3761412551a9e516c9ee4d37eca58e9",
  "OEBPS/content.opf":
    "67189ebbbd1739d71bfe85b826be3212973260c4fa9ede0f1143267a401896a2",
  "OEBPS/nav.xhtml":
    "deffc11a1af93d52016328e8a767600371603f8ce44870f618a4970f56544cb2",
  "OEBPS/style.css":
    "efaf77984db779fde5d0c22caa9b52d11161de9a228c9ca8816066022ceb5bd9",
  "OEBPS/cover.xhtml":
    "57c976846884228c05723713693b3112cba591ce48021a884c7ad902cbdf15e5",
  "OEBPS/titlepage.xhtml":
    "57c976846884228c05723713693b3112cba591ce48021a884c7ad902cbdf15e5",
  "OEBPS/chapter-001.xhtml":
    "1e31401a8c54a34b7806aea49ed2ef0758b661968a53444a17cde53f6a0e0943",
  "OEBPS/chapter-002.xhtml":
    "2f357793043272c100ce93f5cd508c2b7163fa68141c4afce0f7cdde25d7c1ac",
  "OEBPS/colophon.xhtml":
    "0bfa9571055d7344fb12d771459a250facc612d2cbb795f141af367af155be00",
};
