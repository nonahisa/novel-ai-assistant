import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { openEpubEditorPanel } from "../../src/features/epubEditorPanel";
import { emptyCharacter } from "../../src/models/character";
import { BAKED_COVER_FILES } from "../../src/core/coverBake";
import type { WorkEntry } from "../../src/models/types";
import {
  commands,
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
  /** 保留の面か（設計書6.65.15の段D）。選べば見えるが、本には入らない */
  suspended?: boolean;
}

interface PreviewPayload {
  pages: PreviewPage[];
  /** 本の並びの行（設計書6.65.15の段C） */
  blocks: Array<{
    type: string;
    label: string;
    detail: string | null;
    removable: boolean;
    /** 保留中か（設計書6.65.15の段D） */
    suspended?: boolean;
    /** 保留にできるか。**本文だけ false**（本が空になる） */
    suspendable?: boolean;
  }>;
  /** 右クリックの「この後ろに挿入」に出す種類（設計書6.65.15の段D） */
  insertTypes: Array<{
    key: string;
    label: string;
    enabled: boolean;
    reason: string;
  }>;
  /** 話と章の一覧（章の行は読み取り専用） */
  outline: Array<{ kind: string; path?: string; label: string }>;
  placementWarnings: string[];
  characterNotice: string | null;
  compose: Record<string, { baked: { note: string } | null }>;
  selectBlock?: number;
}

const posted: Array<{ type?: string; data?: PreviewPayload }> = [];
/** `vscode.commands.executeCommand` に渡されたもの（ファイルを開く道） */
const executed: Array<{ command: string; args: unknown[] }> = [];
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
  executed.length = 0;
  toExtension = null;
  installDisk();
  installPanel();
  (
    commands as { executeCommand?: (...args: unknown[]) => unknown }
  ).executeCommand = (command: unknown, ...args: unknown[]) => {
    executed.push({ command: String(command), args });
    return Promise.resolve(undefined);
  };

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
    // 本と同じ並び（本文の前）である。既定は縦書きなので、話数の「1」は
    // 縦中横のspanで包まれる（設計書6.65.15の2）
    expect(toc.indexOf("登場人物")).toBeLessThan(
      toc.indexOf('第<span class="tcy">1</span>話')
    );
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
    const episodes = latest().outline.filter(
      (entry) => entry.kind === "episode"
    );
    const labels = episodes.map((entry) => entry.label);

    expect(labels.some((label) => label.includes("第1話"))).toBe(true);
    expect(
      labels.find((label) => label.includes("第2話"))
    ).toContain("競合のため本から外れます");
    // **選べなくはしない**（直せば入るので、指定は残してよい）
    expect(episodes).toHaveLength(2);
  });

  test("目次のプレビューには、競合の話を並べない", async () => {
    await open();
    const toc = page("目次");

    // 既定は縦書きなので、話数の「1」は縦中横のspanで包まれる（設計書6.65.15の2）
    expect(toc.html).toContain('第<span class="tcy">1</span>話');
    expect(toc.html).not.toContain('第<span class="tcy">2</span>話');
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

/**
 * 面の並び（設計書6.65.15の段B）。
 *
 * **プレビューの並びは本の並びである。** 並びを編む画面（段C）はまだ
 * 無いが、book.json に書かれた並びには従う——ここが食い違うと、画面で
 * 見ていたものと違う本が出てくる。
 */
describe("プレビューの面の並び（設計書6.65.15）", () => {
  beforeEach(() => {
    put("本文/第1話.txt", "あ\n\nい");
  });

  function labels(): string[] {
    return latest().pages.map((entry) => entry.label);
  }

  test("blocks を書いていない本は、いままでどおりの並び", async () => {
    // **回帰の見張り。** 面の名前も順序も第2段から変えない
    writeBook({ title: "氷の街" });

    await open();

    expect(labels()).toEqual([
      "表紙",
      "タイトルページ",
      "目次",
      "本文の冒頭",
      "奥付",
    ]);
  });

  test("書いた並びの順に、面が出る", async () => {
    writeBook({
      title: "氷の街",
      // **`tocEnabled` は書かない。** 段Bでは「目次を出す設定のままだと
      // 並びに書いていなくても目次が戻る」ため false を書いていたが、
      // 段Cで並びが正になったので、既定（出す）のままでも戻らない
      blocks: [
        { type: "body" },
        { type: "halfTitle" },
        { type: "cover" },
        { type: "colophon" },
      ],
    });

    await open();

    expect(labels()).toEqual([
      "本文の冒頭",
      "タイトルページ",
      "表紙",
      "奥付",
    ]);
  });

  test("口絵は画像の面として出る（解説文つき）", async () => {
    putBytes("素材/口絵.png", [0x89, 0x50]);
    writeBook({
      title: "氷の街",
      blocks: [
        { type: "cover" },
        { type: "frontIllustration", imagePath: "素材/口絵.png", caption: "朝" },
        { type: "body" },
      ],
    });

    await open();
    const plate = latest().pages.find((entry) => entry.label === "口絵");

    expect(plate).toBeDefined();
    // 画面は `asWebviewUri` のURIで読む（本ではZIPの中の機械名になる）
    expect(plate?.html).toContain("口絵.png");
    expect(plate?.html).toContain("<figcaption>朝</figcaption>");
  });

  test("画像の無い口絵は、面を出さずに警告する（本にも入らない）", async () => {
    writeBook({
      title: "氷の街",
      blocks: [
        { type: "body" },
        { type: "sectionArt", imagePath: "素材/無い扉絵.png" },
      ],
    });

    await open();

    expect(labels()).not.toContain("扉絵");
    const warnings = latest().placementWarnings.join("\n");
    expect(warnings).toContain("素材/無い扉絵.png");
    expect(warnings).toContain("本に入りません");
  });

  test("あとがきの原稿があれば、本文と同じ組版で面になる", async () => {
    writeBook({ title: "氷の街" });
    put("設定/書籍/あとがき.md", "{拙作|せっさく}をお読みいただき");

    await open();
    const afterword = latest().pages.find(
      (entry) => entry.label === "あとがき"
    );

    expect(afterword).toBeDefined();
    expect(afterword?.html).toContain("<ruby>拙作<rt>せっさく</rt></ruby>");
  });

  test("あとがきの原稿が無ければ、面も出ない", async () => {
    writeBook({ title: "氷の街" });

    await open();

    expect(labels()).not.toContain("あとがき");
  });
});

/**
 * 本の並びを編む（設計書6.65.15の段C）。
 *
 * **並びが正になった。** 画面から挿す・動かす・外すと `blocks` が変わり、
 * 保存すると book.json へ入る——目次・人物紹介のチェック欄はもう関係しない。
 */
describe("並びの編集（設計書6.65.15の段C）", () => {
  beforeEach(() => {
    put("本文/第1話.txt", "あ\n\nい");
  });

  function bookPath(): string {
    return diskPath(path.join(work.folderPath, "設定", "書籍", "book.json"));
  }

  /** 保存したあとの book.json の並び（画面の言い分ではなく、書かれたもの） */
  async function savedBlocks(): Promise<string[]> {
    await send({ type: "save", config: {} });
    const bytes = disk.get(bookPath());
    if (!bytes) throw new Error("book.json が書かれていません");
    const config = JSON.parse(new TextDecoder().decode(bytes)) as {
      blocks?: Array<{ type: string }>;
    };
    return (config.blocks ?? []).map((block) => block.type);
  }

  function types(): string[] {
    return latest().blocks.map((block) => block.type);
  }

  test("パレットの種類を挿すと、選んでいる面の後ろへ入る", async () => {
    writeBook({
      title: "氷の街",
      blocks: [{ type: "cover" }, { type: "body" }, { type: "colophon" }],
    });

    await open();
    await send({ type: "insertBlock", blockType: "toc", index: 0, config: {} });

    expect(types()).toEqual(["cover", "toc", "body", "colophon"]);
    // 入れた面を選ばせる（続けて設定を触れるように）
    expect(latest().selectBlock).toBe(1);
    expect(await savedBlocks()).toEqual(["cover", "toc", "body", "colophon"]);
  });

  test("1冊に1つの面は、既にあれば挿さずに理由を言う", async () => {
    writeBook({
      title: "氷の街",
      blocks: [{ type: "cover" }, { type: "body" }],
    });

    await open();
    const mark = posted.length;
    await send({ type: "insertBlock", blockType: "cover", index: 0, config: {} });

    expect(types()).toEqual(["cover", "body"]);
    // 押しても無反応にはしない（理由を言う）
    expect(JSON.stringify(posted.slice(mark))).toContain("1冊に1つだけ");
  });

  test("上へ・下へで並びが入れ替わる", async () => {
    writeBook({
      title: "氷の街",
      blocks: [{ type: "cover" }, { type: "toc" }, { type: "body" }],
    });

    await open();
    await send({ type: "moveBlock", index: 1, direction: -1, config: {} });

    expect(types()).toEqual(["toc", "cover", "body"]);
    await send({ type: "moveBlock", index: 0, direction: 1, config: {} });
    expect(types()).toEqual(["cover", "toc", "body"]);
  });

  test("削除すると、本からもプレビューからも消える", async () => {
    writeBook({
      title: "氷の街",
      blocks: [{ type: "cover" }, { type: "toc" }, { type: "body" }],
    });

    await open();
    expect(latest().pages.map((entry) => entry.label)).toContain("目次");

    await send({ type: "removeBlock", index: 1, config: {} });

    expect(types()).toEqual(["cover", "body"]);
    expect(latest().pages.map((entry) => entry.label)).not.toContain("目次");
    expect(await savedBlocks()).toEqual(["cover", "body"]);
  });

  /** **本文は1冊にちょうど1つ**。消せないし、増やせない */
  test("本文は削除も複製もできない", async () => {
    writeBook({
      title: "氷の街",
      blocks: [{ type: "cover" }, { type: "body" }],
    });

    await open();
    const body = latest().blocks.find((block) => block.type === "body");
    expect(body?.removable).toBe(false);
    expect(
      latest().insertTypes.find((entry) => entry.key === "body")?.enabled
    ).toBe(false);

    await send({ type: "removeBlock", index: 1, config: {} });
    expect(types()).toEqual(["cover", "body"]);
  });

  /**
   * 挿入の一覧（設計書6.65.15の段D）。右クリックのメニューに出すのは
   * **置ける種類だけ**なので、置けないものには理由を添えて false を渡す
   * （画面がその行を出さない）。呼び名も拡張機能側が持つ。
   */
  test("挿入の一覧は、既にある面を置けないものとして理由を持つ", async () => {
    writeBook({
      title: "氷の街",
      blocks: [{ type: "cover" }, { type: "body" }],
    });

    await open();
    const insertTypes = latest().insertTypes;

    // 章区切りを含めて11種ぶん（面10種＋章区切り）
    expect(insertTypes).toHaveLength(11);
    expect(insertTypes.find((entry) => entry.key === "cover")?.enabled).toBe(
      false
    );
    expect(insertTypes.find((entry) => entry.key === "cover")?.reason).toContain(
      "1冊に1つだけ"
    );
    // 口絵・扉絵は何枚でも置ける
    expect(
      insertTypes.find((entry) => entry.key === "sectionArt")?.enabled
    ).toBe(true);
    expect(insertTypes.find((entry) => entry.key === "toc")?.enabled).toBe(true);
    // **呼び名は拡張機能側が持つ**（メニューの文字を画面で組み立てない）
    expect(insertTypes.find((entry) => entry.key === "toc")?.label).toBe("目次");
    expect(insertTypes.find((entry) => entry.key === "chapter")?.label).toBe(
      "章区切り"
    );
  });

  /**
   * ドラッグで落とした並び（設計書6.65.15の段D。作者の指定）。
   *
   * 画面から届くのは「掴んだ面」と「落とした隙間」だけで、計算は
   * `dropBookBlock` が持つ。**取りやめ（Esc・枠の外）では何も変わらない**
   * ことを、ここでも受け口の側から固定しておく。
   */
  test("落とした隙間へ並びが動く", async () => {
    writeBook({
      title: "氷の街",
      blocks: [{ type: "cover" }, { type: "toc" }, { type: "body" }],
    });

    await open();
    // 目次（1）を先頭の隙間（0）へ
    await send({ type: "dropBlock", from: 1, before: 0, config: {} });

    expect(types()).toEqual(["toc", "cover", "body"]);
    // 動かした面をそのまま選ばせる（続けて設定を触れるように）
    expect(latest().selectBlock).toBe(0);
    expect(await savedBlocks()).toEqual(["toc", "cover", "body"]);
  });

  test("本文も動かせる（外せないだけで、位置は変えられる）", async () => {
    writeBook({
      title: "氷の街",
      blocks: [{ type: "cover" }, { type: "toc" }, { type: "body" }],
    });

    await open();
    await send({ type: "dropBlock", from: 2, before: 1, config: {} });

    expect(types()).toEqual(["cover", "body", "toc"]);
  });

  test("自分自身の上・範囲の外へ落としても、何も変わらない", async () => {
    writeBook({
      title: "氷の街",
      blocks: [{ type: "cover" }, { type: "toc" }, { type: "body" }],
    });

    await open();
    const mark = posted.length;
    await send({ type: "dropBlock", from: 1, before: 1, config: {} });
    await send({ type: "dropBlock", from: 1, before: 2, config: {} });
    await send({ type: "dropBlock", from: 1, before: 9, config: {} });
    await send({ type: "dropBlock", from: -1, before: 0, config: {} });

    expect(types()).toEqual(["cover", "toc", "body"]);
    // 並びが変わらないので、選び直しの指示も出さない
    expect(
      posted.slice(mark).some((message) => message.data?.selectBlock !== undefined)
    ).toBe(false);
  });

  test("口絵は、絵の場所を訊いてから挿す（絵の無い面は作らない）", async () => {
    putBytes("素材/口絵.png", [0x89, 0x50]);
    writeBook({
      title: "氷の街",
      blocks: [{ type: "cover" }, { type: "body" }],
    });
    window.showInputBox = async () => "素材/口絵.png";

    await open();
    await send({
      type: "insertBlock",
      blockType: "frontIllustration",
      index: 0,
      config: {},
    });

    expect(types()).toEqual(["cover", "frontIllustration", "body"]);
    // 行には、どの絵かを添える（同じ呼び名の面が並ぶため）
    expect(
      latest().blocks.find((block) => block.type === "frontIllustration")?.detail
    ).toBe("素材/口絵.png");
  });

  test("絵の場所を取りやめたら、面は増えない", async () => {
    writeBook({
      title: "氷の街",
      blocks: [{ type: "cover" }, { type: "body" }],
    });
    window.showInputBox = async () => undefined;

    await open();
    await send({
      type: "insertBlock",
      blockType: "sectionArt",
      index: 0,
      config: {},
    });

    expect(types()).toEqual(["cover", "body"]);
  });
});

/**
 * 目次・人物紹介は並びが決める（設計書6.65.15の段C）。
 *
 * 段Bまではチェック欄（`tocEnabled`・`characterPage.enabled`）が正だった。
 * **チェック欄の値は書き換えず、見もしない**——古い book.json から既定の
 * 並びを組む材料としてだけ残っている。
 */
describe("チェック欄ではなく並びが決める（設計書6.65.15の段C）", () => {
  beforeEach(() => {
    put("本文/第1話.txt", "あ\n\nい");
  });

  test("目次を出す設定でも、並びに無ければ面は出ない", async () => {
    writeBook({
      title: "氷の街",
      tocEnabled: true,
      blocks: [{ type: "cover" }, { type: "body" }],
    });

    await open();

    expect(latest().pages.map((entry) => entry.label)).not.toContain("目次");
  });

  test("人物紹介は、チェックが false でも並びにあれば出る", async () => {
    writeCharacter("char_001", "月島灯");
    writeBook({
      title: "氷の街",
      characterPage: { enabled: false, showIcons: false },
      blocks: [{ type: "characters" }, { type: "body" }],
    });

    await open();

    expect(latest().pages.map((entry) => entry.label)).toContain("登場人物");
  });

  test("イラストの有無を変えても、チェック欄の値は書き換えない", async () => {
    writeCharacter("char_001", "月島灯");
    writeBook({
      title: "氷の街",
      characterPage: { enabled: true, showIcons: true },
      blocks: [{ type: "characters" }, { type: "body" }],
    });

    await open();
    // 画面が送ってくるのはイラストの有無だけである
    await send({
      type: "save",
      config: { characterPage: { showIcons: false } },
    });

    const bytes = disk.get(
      diskPath(path.join(work.folderPath, "設定", "書籍", "book.json"))
    );
    const config = JSON.parse(
      new TextDecoder().decode(bytes as Uint8Array)
    ) as { characterPage: { enabled: boolean; showIcons: boolean } };
    expect(config.characterPage).toEqual({ enabled: true, showIcons: false });
  });
});

/**
 * 章区切り（設計書6.65.15の段C・6.66）。
 *
 * **章立ての台帳が正なので、blocks には入らない。** パレットから押しても
 * 書き換わるのは `設定/章立て.json` だけである。
 */
describe("章区切り（設計書6.65.15の段C）", () => {
  beforeEach(() => {
    put("本文/第1話.txt", "あ\n\nい");
    put("本文/第2話.txt", "う\n\nえ");
    writeBook({ title: "氷の街" });
  });

  function chaptersPath(): string {
    return diskPath(path.join(work.folderPath, "設定", "章立て.json"));
  }

  /** 選択画面。**この作り物では2話目を選ぶ**（先頭以外を選べることも見る） */
  function pickSecondEpisode(): void {
    (window as unknown as Record<string, unknown>).showQuickPick = async (
      items: Array<{ label: string }>
    ) => items.find((item) => item.label.includes("第2話"));
  }

  test("押すと台帳へ書く（blocks には入らない）", async () => {
    pickSecondEpisode();
    window.showInputBox = async () => "第二章　邂逅";

    await open();
    const before = latest().blocks.map((block) => block.type);
    await send({ type: "addChapter", config: {} });

    const bytes = disk.get(chaptersPath());
    expect(bytes).toBeDefined();
    const set = JSON.parse(new TextDecoder().decode(bytes as Uint8Array)) as {
      chapters: Array<{ name: string; startEpisodePath: string }>;
    };
    expect(set.chapters).toEqual([
      { name: "第二章　邂逅", startEpisodePath: "本文/第2話.txt" },
    ]);
    // **面は1つも増えない**（章は本の並びの持ち物ではない）
    expect(latest().blocks.map((block) => block.type)).toEqual(before);
  });

  test("台帳の章は、話の一覧に読み取り専用の行として挟まる", async () => {
    put(
      "設定/章立て.json",
      JSON.stringify({
        schemaVersion: "1",
        chapters: [{ name: "第二章　邂逅", startEpisodePath: "本文/第2話.txt" }],
      })
    );

    await open();
    const outline = latest().outline;

    expect(outline.map((entry) => entry.kind)).toEqual([
      "episode",
      "chapter",
      "episode",
    ]);
    expect(outline[1].label).toContain("第二章　邂逅");
    // 章の行には選び先が無い（押しても話を選べない）
    expect(outline[1].path).toBeUndefined();
  });

  test("取りやめたら、台帳は作らない", async () => {
    (window as unknown as Record<string, unknown>).showQuickPick = async () =>
      undefined;

    await open();
    await send({ type: "addChapter", config: {} });

    expect(disk.has(chaptersPath())).toBe(false);
  });

  /**
   * 目次の束ね（設計書6.66.4の3）。
   *
   * **プレビューと書き出しが同じ束ね方を通る。** 別々に束ねると、
   * 画面で見た目次と本の目次が食い違う（`exportEpub` 側は
   * `epubChapterToc.test.ts` が見張る）。
   */
  test("「章ごとに区切る」目次は、台帳の章名で束ねる", async () => {
    writeBook({ title: "氷の街", tocPattern: "chapters" });
    put(
      "設定/章立て.json",
      JSON.stringify({
        schemaVersion: "1",
        chapters: [{ name: "第二章　邂逅", startEpisodePath: "本文/第2話.txt" }],
      })
    );

    await open();
    const toc = page("目次").html;

    expect(toc).toContain('<span class="toc-group">第二章　邂逅</span>');
    // ファイル名由来の束ね（「本編」）は、台帳がある作品では出ない
    expect(toc).not.toContain('<span class="toc-group">本編</span>');
  });

  test("台帳が無ければ、目次は従来のファイル名由来の束ねのまま", async () => {
    writeBook({ title: "氷の街", tocPattern: "chapters" });

    await open();

    expect(page("目次").html).toContain('<span class="toc-group">本編</span>');
  });

  test("章を足したら、その場で目次の束ねも変わる", async () => {
    // 一覧の行だけ直して目次の束ねを古いままにすると、同じ画面の中で
    // 章の切れ目が2通りに見える
    writeBook({ title: "氷の街", tocPattern: "chapters" });
    pickSecondEpisode();
    window.showInputBox = async () => "第二章　邂逅";

    await open();
    await send({ type: "addChapter", config: {} });

    expect(page("目次").html).toContain(
      '<span class="toc-group">第二章　邂逅</span>'
    );
  });
});

describe("あとがきを書く入口（設計書6.65.15）", () => {
  beforeEach(() => {
    put("本文/第1話.txt", "あ\n\nい");
    writeBook({ title: "氷の街" });
  });

  function afterwordPath(): string {
    return diskPath(path.join(work.folderPath, "設定", "書籍", "あとがき.md"));
  }

  test("原稿が無ければ雛形を作って開く（中身は本に入らない一言だけ）", async () => {
    await open();
    await send({ type: "openAfterword", config: {} });

    const bytes = disk.get(afterwordPath());
    expect(bytes).toBeDefined();
    const text = new TextDecoder().decode(bytes as Uint8Array);
    // 付箋（`//`）だけなので、書き出しても面は増えない
    expect(text.split("\n").every((line) => line.trim() === "" || line.startsWith("//"))).toBe(true);
    expect(executed.map((entry) => entry.command)).toContain("vscode.open");
  });

  test("既にある原稿は上書きしない（開くだけ）", async () => {
    put("設定/書籍/あとがき.md", "書きかけの文章");

    await open();
    await send({ type: "openAfterword", config: {} });

    expect(new TextDecoder().decode(disk.get(afterwordPath()) as Uint8Array)).toBe(
      "書きかけの文章"
    );
    expect(executed.map((entry) => entry.command)).toContain("vscode.open");
  });
});

/**
 * バックアップの頭書き（設計書6.65.15の段D。作者の指定）。
 *
 * 作者の原稿には、投稿サイトのダウンロードツールが付けた頭書きが残って
 * いることがある。**本にも、段落の一覧にも入れない。** 組版と段落番号が
 * 同じ切り出し（`parseEpisodeMetadata`）を通っていないと、画面で指した
 * 段落と挿絵の入る場所がずれる（設計書6.65.10）。
 */
describe("バックアップの頭書き（設計書6.65.15の段D）", () => {
  const BACKUP = [
    "-------- エピソード1開始 --------",
    "【エピソードタイトル】",
    "１話　転生",
    "",
    "【本文】",
    "　朝が来た。",
    "",
    "　鐘が鳴る。",
  ].join("\n");

  /** 最後に届いた段落の一覧（挿絵・改ページを置く欄の中身） */
  function latestParagraphs(): string[] {
    for (let index = posted.length - 1; index >= 0; index--) {
      const message = posted[index] as { type?: string; items?: string[] };
      if (message.type === "paragraphs") return message.items ?? [];
    }
    throw new Error("段落の一覧が1度も渡っていません");
  }

  test("本文の面に、頭書きの見出しが入らない", async () => {
    put("本文/第1話.txt", BACKUP);
    writeBook({ title: "氷の街" });

    await open();
    const body = page("本文の冒頭").html;

    expect(body).toContain("朝が来た。");
    expect(body).not.toContain("エピソードタイトル");
    expect(body).not.toContain("エピソード1開始");
    expect(body).not.toContain("【本文】");
  });

  test("段落の一覧は、頭書きを除いた本文の段落から始まる", async () => {
    put("本文/第1話.txt", BACKUP);
    writeBook({ title: "氷の街" });

    await open();
    await send({ type: "episode", episodePath: "本文/第1話.txt" });

    // 2段落ちょうど。頭書きが混ざると、1番目が「１話　転生」になる
    // 冒頭は字下げを落として見せる（`paragraphPreview`）
    expect(latestParagraphs()).toEqual(["朝が来た。", "鐘が鳴る。"]);
  });

  /** 頭書きの無い原稿は、いままでどおり1文字も落ちない（回帰の固定） */
  test("頭書きの無い原稿は、いままでどおり全部が本文になる", async () => {
    put("本文/第1話.txt", "　朝が来た。\n\n　鐘が鳴る。");
    writeBook({ title: "氷の街" });

    await open();
    await send({ type: "episode", episodePath: "本文/第1話.txt" });

    // 冒頭は字下げを落として見せる（`paragraphPreview`）
    expect(latestParagraphs()).toEqual(["朝が来た。", "鐘が鳴る。"]);
    expect(page("本文の冒頭").html).toContain("朝が来た。");
  });

  /**
   * 合本（1ファイルに複数話）も、**本と同じ切り分け**を通す
   * （設計書6.65.15。`core/bookChapters.ts`）。
   *
   * 段落の一覧は**最初の話ぶん**である。挿絵・改ページの指定はファイル
   * 単位で、書き出しも合本の最初の話にだけ効かせているので、ここが
   * 合本まるごとの段落だと、指した位置と入る位置がずれる。
   */
  const COLLECTED = [
    "------- エピソード1開始 -------",
    "【エピソードタイトル】",
    "１話　転生",
    "",
    "【本文】",
    "　朝が来た。",
    "",
    "　鐘が鳴る。",
    "",
    "【後書き】",
    "　ありがとうございます。",
    "",
    "------- エピソード2開始 -------",
    "【エピソードタイトル】",
    "２話　再会",
    "",
    "【本文】",
    "　昼が来た。",
  ].join("\n");

  test("合本の冒頭プレビューは、1話目だけを見せる", async () => {
    put("本文/全話.txt", COLLECTED);
    writeBook({ title: "氷の街" });

    await open();
    const body = page("本文の冒頭").html;

    expect(body).toContain("朝が来た。");
    // 見出しは1話目のもの（縦書きでは数字が `tcy` に包まれる）
    expect(body.replace(/<[^>]+>/g, "")).toContain("第1話　転生");
    expect(body).not.toContain("エピソード2開始");
    expect(body).not.toContain("【本文】");
    expect(body).not.toContain("ありがとうございます");
    expect(body).not.toContain("昼が来た。");
  });

  test("合本の段落の一覧も、1話目の本文だけになる", async () => {
    put("本文/全話.txt", COLLECTED);
    writeBook({ title: "氷の街" });

    await open();
    await send({ type: "episode", episodePath: "本文/全話.txt" });

    expect(latestParagraphs()).toEqual(["朝が来た。", "鐘が鳴る。"]);
  });
});

/**
 * 面の保留（設計書6.65.15の段D。作者の依頼、2026-09-04）。
 *
 * **「出力には入らないが、比較用に残る」**が狙いである。だから
 * 　・本の組み立て（目次の行・人物一覧の面）からは外れる
 * 　・並びの行には残り、選べば編集画面もプレビューも見える
 * の両方を、同じ受け口から確かめる。**見えなければ比較にならない。**
 */
describe("面の保留（設計書6.65.15の段D）", () => {
  beforeEach(() => {
    put("本文/第1話.txt", "あ\n\nい");
  });

  function bookPath(): string {
    return diskPath(path.join(work.folderPath, "設定", "書籍", "book.json"));
  }

  /** 保存したあとの book.json の並び（画面の言い分ではなく、書かれたもの） */
  async function savedBlocks(): Promise<
    Array<{ type: string; suspended?: boolean }>
  > {
    await send({ type: "save", config: {} });
    const bytes = disk.get(bookPath());
    if (!bytes) throw new Error("book.json が書かれていません");
    const config = JSON.parse(new TextDecoder().decode(bytes)) as {
      blocks?: Array<{ type: string; suspended?: boolean }>;
    };
    return config.blocks ?? [];
  }

  test("保留にすると行に印が付き、保存すると book.json に残る", async () => {
    writeBook({
      title: "氷の街",
      blocks: [{ type: "cover" }, { type: "toc" }, { type: "body" }],
    });

    await open();
    await send({ type: "suspendBlock", index: 1, suspended: true, config: {} });

    const row = latest().blocks[1];
    expect(row.type).toBe("toc");
    expect(row.suspended).toBe(true);
    // **行は消えない**（比較のために置いてあるものなので）
    expect(latest().blocks.map((block) => block.type)).toEqual([
      "cover",
      "toc",
      "body",
    ]);
    expect(await savedBlocks()).toEqual([
      { type: "cover" },
      { type: "toc", suspended: true },
      { type: "body" },
    ]);
  });

  test("保留を解除すると、book.json から項目ごと消える", async () => {
    writeBook({
      title: "氷の街",
      blocks: [{ type: "cover", suspended: true }, { type: "body" }],
    });

    await open();
    expect(latest().blocks[0].suspended).toBe(true);

    await send({ type: "suspendBlock", index: 0, suspended: false, config: {} });

    expect(latest().blocks[0].suspended).toBe(false);
    expect(await savedBlocks()).toEqual([{ type: "cover" }, { type: "body" }]);
  });

  /** **本文は保留にできない**（本が空になる）。メニューにも出さない */
  test("本文には保留のメニューを出さない", async () => {
    writeBook({
      title: "氷の街",
      blocks: [{ type: "cover" }, { type: "body" }],
    });

    await open();

    expect(latest().blocks[0].suspendable).toBe(true);
    expect(latest().blocks[1].suspendable).toBe(false);

    // 送られてきても受け取らない（画面の作りだけに頼らない）
    await send({ type: "suspendBlock", index: 1, suspended: true, config: {} });
    expect(latest().blocks[1].suspended).toBe(false);
  });

  /**
   * **仕様を戻した**（0.32.0のレビュー）。表紙を保留にすればもう1枚
   * 挿せる形にしていたが、**表紙の中身は `BookConfig` に1つしかない**ので、
   * 2枚置いても同じ面が並ぶだけで「2案の見比べ」にならない。挿入の可否は
   * `canAddBookBlock` 任せなので、画面のほうも押せなくなる。
   */
  test("表紙を保留にしても、もう1つ表紙は挿せない", async () => {
    writeBook({
      title: "氷の街",
      blocks: [{ type: "cover" }, { type: "body" }],
    });

    await open();
    expect(
      latest().insertTypes.find((entry) => entry.key === "cover")?.enabled
    ).toBe(false);

    await send({ type: "suspendBlock", index: 0, suspended: true, config: {} });
    expect(
      latest().insertTypes.find((entry) => entry.key === "cover")?.enabled
    ).toBe(false);

    // 送られてきても受け取らない（画面の作りだけに頼らない）
    await send({ type: "insertBlock", blockType: "cover", index: 0, config: {} });
    expect(latest().blocks.map((block) => block.type)).toEqual([
      "cover",
      "body",
    ]);
  });

  /** **黙って2つ有効にしない。** 断る理由も言う */
  test("同じ種類の有効な面が居れば、解除を断って理由を言う", async () => {
    writeBook({
      title: "氷の街",
      blocks: [
        { type: "cover" },
        { type: "cover", suspended: true },
        { type: "body" },
      ],
    });

    await open();
    const mark = posted.length;
    await send({ type: "suspendBlock", index: 1, suspended: false, config: {} });

    expect(latest().blocks[1].suspended).toBe(true);
    const said = JSON.stringify(posted.slice(mark));
    expect(said).toContain("表紙");
    expect(said).toContain("先に");
  });

  /**
   * **本の組み立てからは外れる。** 目次の「登場人物」の行は、人物紹介の面が
   * 本に入るときだけ出る（設計書6.65.11）——保留にしたら行も消える。
   */
  test("保留の人物紹介は、目次の行に出ない", async () => {
    writeCharacter("char_001", "月島灯");
    writeBook({
      title: "氷の街",
      blocks: [
        { type: "toc" },
        { type: "characters", suspended: true },
        { type: "body" },
      ],
    });

    await open();

    expect(page("目次").html).not.toContain("登場人物");
  });

  test("保留にしていなければ、いままでどおり目次に行が出る", async () => {
    writeCharacter("char_001", "月島灯");
    writeBook({
      title: "氷の街",
      blocks: [{ type: "toc" }, { type: "characters" }, { type: "body" }],
    });

    await open();

    expect(page("目次").html).toContain("登場人物");
  });

  /**
   * **保留の面を選べば、その面のプレビューは見える**（作者の依頼）。
   * 見えなければ、2案を見比べるという保留の狙いが果たせない。
   */
  test("保留の面も、選べばプレビューが出る（印つき）", async () => {
    writeCharacter("char_001", "月島灯");
    writeBook({
      title: "氷の街",
      blocks: [
        { type: "toc" },
        { type: "characters", suspended: true },
        { type: "body" },
      ],
    });

    await open();
    const characters = latest().pages.find(
      (entry) => entry.label === "登場人物"
    );

    expect(characters).toBeDefined();
    expect(characters?.html).toContain("月島灯");
    // **保留であることは画面で分かる**（黙って本に入らないのが、いちばん困る）
    expect(characters?.suspended).toBe(true);
    // 有効な面には印を付けない
    expect(
      latest().pages.find((entry) => entry.label === "目次")?.suspended
    ).toBe(false);
  });

  /**
   * **本に入らないものについては言わない**（0.32.0のレビュー）。
   *
   * 保留の扉絵は書き出しでも組み立てでも外れるので、絵が見つからなくても
   * 本は何も変わらない。それでも警告を出すと、直しようのない（そして
   * 直さなくてよい）注意書きが欄に居座る。
   */
  test("保留の扉絵は、画像が無くても警告に出ない", async () => {
    writeBook({
      title: "氷の街",
      blocks: [
        { type: "body" },
        { type: "sectionArt", imagePath: "素材/無い扉絵.png", suspended: true },
      ],
    });

    await open();

    expect(latest().placementWarnings.join("\n")).not.toContain(
      "素材/無い扉絵.png"
    );
  });

  test("有効な扉絵の警告は、いままでどおり出る", async () => {
    writeBook({
      title: "氷の街",
      blocks: [
        { type: "body" },
        { type: "sectionArt", imagePath: "素材/無い扉絵.png" },
      ],
    });

    await open();

    expect(latest().placementWarnings.join("\n")).toContain("素材/無い扉絵.png");
  });

  /**
   * **「載ります」と言うのは、本に入るときだけ**（0.32.0のレビュー）。
   * 保留の人物紹介について人数を告げると、出ない面の話をしたことになる。
   */
  test("人物紹介が保留だけなら、案内を出さない", async () => {
    writeCharacter("char_001", "月島灯");
    writeBook({
      title: "氷の街",
      blocks: [{ type: "characters", suspended: true }, { type: "body" }],
    });

    await open();

    expect(latest().characterNotice).toBeNull();
  });

  test("有効な人物紹介なら、いままでどおり人数を伝える", async () => {
    writeCharacter("char_001", "月島灯");
    writeBook({
      title: "氷の街",
      blocks: [{ type: "characters" }, { type: "body" }],
    });

    await open();

    expect(latest().characterNotice).toContain("1人");
  });
});
