import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { openEpubEditorPanel } from "../../src/features/epubEditorPanel";
import { emptyCharacter } from "../../src/models/character";
import { BAKED_COVER_FILES } from "../../src/core/coverBake";
import type { WorkEntry } from "../../src/models/types";
import {
  FileSystemError,
  FileType,
  Uri,
  window,
  workspace,
} from "./support/vscodeStub";

/**
 * EPUBエディターのプレビュー（設計書6.65.6・6.65.8・6.65.10・6.65.11）。
 *
 * **画面と本の中身が食い違わないこと**だけを見る。見え方の良し悪しは実機
 * でしか分からないが、「本に入るのに画面に無い」「画面にあるのに本へ入らない」
 * は機械で見張れる——そしてそれは、作者がいちばん困る食い違いである。
 *
 * 作り物のWebViewパネルへ `openEpubEditorPanel` をそのまま繋ぎ、画面へ
 * 送られたものを覗く（面を別に組み直すと、製品に無いものを見たことになる）。
 */

/** 画面へ送られたもの */
interface PreviewPage {
  label: string;
  html: string;
  note: string | null;
  compose?: string;
}

interface PreviewPayload {
  pages: PreviewPage[];
  episodes: Array<{ path: string; label: string }>;
  placementWarnings: string[];
  characterNotice: string | null;
  compose: Record<string, { baked: { note: string } | null }>;
}

const posted: Array<{ type?: string; data?: PreviewPayload }> = [];
/** 画面から拡張機能へ送る口（押した操作を再現する） */
let toExtension: ((message: unknown) => void) | null = null;
const disk = new Map<string, Uint8Array>();
const shown: string[] = [];

/** 作品はテストごとに別にする（開いたパネルは作品ごとに覚えられている） */
let counter = 0;
let work: WorkEntry;

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

function put(relativePath: string, text: string): void {
  disk.set(
    diskPath(path.join(work.folderPath, relativePath)),
    new TextEncoder().encode(text)
  );
}

function putBytes(relativePath: string, bytes: number[]): void {
  disk.set(
    diskPath(path.join(work.folderPath, relativePath)),
    new Uint8Array(bytes)
  );
}

function writeBook(config: Record<string, unknown>): void {
  put("設定/書籍/book.json", JSON.stringify(config));
}

/** 公開・登場済み・モブでない人物（本へ載る人。設計書6.65.11） */
function writeCharacter(id: string, name: string): void {
  put(`設定/characters/${id}.json`, JSON.stringify(emptyCharacter(id, name)));
}

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
        return { mtime: Date.UTC(2026, 8, 3, 5, 0, 0), size: 1 };
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

/** 作り物のWebViewパネル。送られたものを覚えるだけ */
function installPanel(): void {
  window.createWebviewPanel = () => ({
    webview: {
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (uri: { fsPath: string }) => ({
        toString: () =>
          `https://file+.vscode-resource/${uri.fsPath.split("\\").join("/")}`,
      }),
      postMessage: (message: { type?: string; data?: PreviewPayload }) => {
        posted.push(message);
      },
      onDidReceiveMessage: (listener: (message: unknown) => void) => {
        toExtension = listener;
        return { dispose: () => undefined };
      },
    },
    reveal: () => undefined,
    onDidDispose: () => ({ dispose: () => undefined }),
    dispose: () => undefined,
  });
}

beforeEach(() => {
  counter++;
  work = {
    id: `work_epub_panel_${counter}`,
    title: "氷の街",
    folderPath: `C:\\novels\\work${counter}`,
    registeredAt: "2026-09-03T00:00:00.000Z",
  };
  disk.clear();
  posted.length = 0;
  shown.length = 0;
  toExtension = null;
  installDisk();
  installPanel();

  window.showInformationMessage = async (message: string) => {
    shown.push(message);
    return undefined;
  };
  window.showErrorMessage = async (message: string) => {
    shown.push(message);
    return undefined;
  };
});

/** パネルを開き、画面の準備完了まで進める */
async function open(): Promise<void> {
  await openEpubEditorPanel(
    { subscriptions: [] } as unknown as Parameters<
      typeof openEpubEditorPanel
    >[0],
    work
  );
  await send({ type: "ready" });
}

/** 画面からの知らせを1つ送る（押した操作の再現） */
async function send(message: unknown): Promise<void> {
  if (!toExtension) throw new Error("受け取り手がまだ居ません");
  await toExtension(message);
}

/** 最後に画面へ渡った面の一式 */
function latest(): PreviewPayload {
  for (let index = posted.length - 1; index >= 0; index--) {
    const message = posted[index];
    if ((message.type === "book" || message.type === "preview") && message.data) {
      return message.data;
    }
  }
  throw new Error("面が1度も渡っていません");
}

function page(label: string): PreviewPage {
  const found = latest().pages.find((entry) => entry.label === label);
  if (!found) throw new Error(`面「${label}」がありません`);
  return found;
}

/** 競合マーカー。行頭の7文字（`textFile.ts` の見分け方に合わせる） */
const CONFLICT = "<".repeat(7);

describe("目次のプレビュー（設計書6.65.11）", () => {
  beforeEach(() => {
    put("本文/第1話.txt", "あ\n\nい");
  });

  /**
   * **本に入る行は、プレビューにも出る。** 登場人物一覧は本文の前の面
   * （`nav.xhtml` の先頭に行が入る）なのに、プレビューの目次にだけ
   * 無かった——「見た目どおりに編集できる」が壊れている状態である。
   */
  test("人物一覧を出す設定なら、目次の先頭に「登場人物」の行が入る", async () => {
    writeBook({
      title: "氷の街",
      characterPage: { enabled: true, showIcons: false },
    });
    writeCharacter("char_001", "月島灯");

    await open();
    const toc = page("目次").html;

    expect(toc).toContain("登場人物");
    // 本と同じ並び（本文の前）である
    expect(toc.indexOf("登場人物")).toBeLessThan(toc.indexOf("第1話"));
    // 面そのものも出る（行だけあって飛び先が無い、を作らない）
    expect(latest().pages.map((entry) => entry.label)).toContain("登場人物");
  });

  test("人物一覧を出さない設定なら、目次にも行を入れない", async () => {
    writeBook({ title: "氷の街" });
    writeCharacter("char_001", "月島灯");

    await open();

    expect(page("目次").html).not.toContain("登場人物");
  });

  test("出す設定でも、載る人が居なければ行を入れない", async () => {
    // 面が出ないのに目次だけ行があると、飛び先の無い行になる
    writeBook({
      title: "氷の街",
      characterPage: { enabled: true, showIcons: false },
    });

    await open();

    expect(page("目次").html).not.toContain("登場人物");
    expect(latest().pages.map((entry) => entry.label)).not.toContain("登場人物");
  });
});

describe("競合のある話（設計書6.65.10）", () => {
  beforeEach(() => {
    put("本文/第1話.txt", "あ\n\nい");
    put("本文/第2話.txt", `${CONFLICT} HEAD\nあ\nい`);
    writeBook({ title: "氷の街" });
  });

  /**
   * **競合のある話は本から外れる**（`exportEpub` が外す）のに、話を選ぶ欄には
   * ふつうに並んでいた。挿絵や改ページを置いても入らない理由が分からない。
   */
  test("話を選ぶ欄に、本から外れることを書く", async () => {
    await open();
    const labels = latest().episodes.map((entry) => entry.label);

    expect(labels.some((label) => label.includes("第1話"))).toBe(true);
    expect(
      labels.find((label) => label.includes("第2話"))
    ).toContain("競合のため本から外れます");
    // **選べなくはしない**（直せば入るので、指定は残してよい）
    expect(latest().episodes).toHaveLength(2);
  });

  test("目次のプレビューには、競合の話を並べない", async () => {
    await open();
    const toc = page("目次");

    expect(toc.html).toContain("第1話");
    expect(toc.html).not.toContain("第2話");
    // 黙って消さない。入らない理由は面の注記で言う
    expect(toc.note).toContain("競合");
  });
});

describe("画像の見つからない挿絵（設計書6.65.10）", () => {
  beforeEach(() => {
    put("本文/第1話.txt", "あ\n\nい");
  });

  /**
   * **本に入らないことを、書き出す前に伝える。** 欄には挿絵の行があるので、
   * 場所を打ち間違えていても「入る」ように見えていた。
   */
  test("画像が置かれていない挿絵は、欄で警告する", async () => {
    writeBook({
      title: "氷の街",
      illustrations: [
        {
          episodePath: "本文/第1話.txt",
          afterParagraph: 1,
          imagePath: "素材/無い絵.png",
          caption: "",
        },
      ],
    });

    await open();
    const warnings = latest().placementWarnings.join("\n");

    expect(warnings).toContain("素材/無い絵.png");
    expect(warnings).toContain("本に入りません");
  });

  test("画像が置いてあれば、何も言わない", async () => {
    putBytes("素材/絵.png", [0x89, 0x50]);
    writeBook({
      title: "氷の街",
      illustrations: [
        {
          episodePath: "本文/第1話.txt",
          afterParagraph: 1,
          imagePath: "素材/絵.png",
          caption: "",
        },
      ],
    });

    await open();

    expect(latest().placementWarnings).toEqual([]);
  });
});

describe("焼いた表紙のプレビュー（設計書6.65.8）", () => {
  beforeEach(() => {
    put("本文/第1話.txt", "あ\n\nい");
    putBytes("素材/表紙.png", [0x89, 0x50]);
  });

  /**
   * **プレビューも書き出しと同じ拾い順**（焼いた→元→無し）。
   *
   * 焼いたあとも合成の途中経過を見せていたので、元イラストを差し替えても、
   * `coverImagePath` を空にしても、画面と本の中身が食い違っていた。
   */
  test("焼いた画像があれば、それを表紙の面に出す", async () => {
    writeBook({ title: "氷の街", coverImagePath: "素材/表紙.png" });
    putBytes(`設定/書籍/${BAKED_COVER_FILES.front}`, [0x89, 0x50]);

    await open();
    const cover = page("表紙");

    expect(cover.html).toContain(BAKED_COVER_FILES.front);
    // canvas の合成は出さない（焼いたものが本に入るのだから）
    expect(cover.compose).toBeUndefined();
    expect(cover.note).toContain("焼いた画像を表示中");
    expect(cover.note).toContain("焼き直");
  });

  test("元イラストの指定を消しても、焼いた画像は表紙の面に出る", async () => {
    // **本には入り続ける**ので、画面からも消えてはいけない
    writeBook({ title: "氷の街" });
    putBytes(`設定/書籍/${BAKED_COVER_FILES.front}`, [0x89, 0x50]);

    await open();

    expect(page("表紙").html).toContain(BAKED_COVER_FILES.front);
    // 消す入口は、合成の欄が畳まれていても出す
    expect(latest().compose.front.baked).not.toBeNull();
  });

  test("焼いていなければ、いままでどおり合成の面を出す", async () => {
    writeBook({ title: "氷の街", coverImagePath: "素材/表紙.png" });

    await open();

    expect(page("表紙").compose).toBe("front");
    expect(latest().compose.front.baked).toBeNull();
  });

  test("裏表紙も同じ（焼いていれば、焼いた画像の面になる）", async () => {
    writeBook({ title: "氷の街" });
    putBytes(`設定/書籍/${BAKED_COVER_FILES.back}`, [0x89, 0x50]);

    await open();
    const back = page("裏表紙");

    expect(back.html).toContain(BAKED_COVER_FILES.back);
    expect(back.compose).toBeUndefined();
    expect(back.note).toContain("焼いた画像を表示中");
  });
});

describe("焼いた画像を消す（設計書6.65.8）", () => {
  beforeEach(() => {
    put("本文/第1話.txt", "あ\n\nい");
    putBytes("素材/表紙.png", [0x89, 0x50]);
  });

  test("消すと、面は元イラストの合成に戻る", async () => {
    writeBook({ title: "氷の街", coverImagePath: "素材/表紙.png" });
    putBytes(`設定/書籍/${BAKED_COVER_FILES.front}`, [0x89, 0x50]);

    await open();
    expect(page("表紙").html).toContain(BAKED_COVER_FILES.front);

    await send({ type: "unbake", side: "front", config: {} });

    // 焼いた画像は消え、面は元イラストの合成に戻る
    expect(
      disk.has(
        diskPath(
          path.join(work.folderPath, "設定", "書籍", BAKED_COVER_FILES.front)
        )
      )
    ).toBe(false);
    expect(page("表紙").compose).toBe("front");
    expect(latest().compose.front.baked).toBeNull();
    // 何をしたかを作者へ伝える
    expect(shown.join("\n")).toContain("焼いた画像を消しました");
  });

  /** **消してよいのは `_合成済み` の2つだけ**（元イラストには触らない） */
  test("元イラストと、もう片方の焼き上がりには触らない", async () => {
    writeBook({ title: "氷の街", coverImagePath: "素材/表紙.png" });
    putBytes(`設定/書籍/${BAKED_COVER_FILES.front}`, [0x89, 0x50]);
    putBytes(`設定/書籍/${BAKED_COVER_FILES.back}`, [0x89, 0x50]);

    await open();
    await send({ type: "unbake", side: "front", config: {} });

    const original = diskPath(path.join(work.folderPath, "素材", "表紙.png"));
    const backBaked = diskPath(
      path.join(work.folderPath, "設定", "書籍", BAKED_COVER_FILES.back)
    );
    expect(disk.has(original)).toBe(true);
    expect(disk.has(backBaked)).toBe(true);
  });

  test("焼いた画像が無ければ、消すものが無いと伝えるだけ", async () => {
    writeBook({ title: "氷の街", coverImagePath: "素材/表紙.png" });

    await open();
    posted.length = 0;
    await send({ type: "unbake", side: "front", config: {} });

    const status = posted.filter((message) => message.type === "status");
    expect(JSON.stringify(status)).toContain("焼いた画像はありません");
  });
});
