import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { openEpubEditorPanel } from "../../src/features/epubEditorPanel";
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
 * EPUBエディターの「未保存」の扱い（設計書6.65.6。作者の指摘、2026-09-06）。
 *
 * 確かめるのは3つ。
 *
 * 1. **見る面を切り替えただけでは未保存にしない。** 中身は変わっていない
 * 2. **中身を変えたら未保存にする**（1のために2まで消してはいけない）
 * 3. **閉じたら控え、次に開いたら戻せる。** WebViewのタブには「閉じますか」
 *    を出せないので、閉じたあとに拾えるようにしておくしかない
 */

interface PanelPayload {
  config?: Record<string, unknown>;
  dirty?: boolean;
}

const posted: Array<{ type?: string; data?: PanelPayload }> = [];
let toExtension: ((message: unknown) => void) | null = null;
/** タブが閉じられたときに呼ばれるもの（画面を閉じる操作の再現） */
let onDispose: (() => void) | null = null;
const disk = new Map<string, Uint8Array>();
/** 通知に出した文言と、そのとき並べた選択肢と、返す答え */
const asked: string[] = [];
const offered: string[][] = [];
let answer: string | undefined;

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

function has(relativePath: string): boolean {
  return disk.has(diskPath(path.join(work.folderPath, relativePath)));
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
      if (!disk.delete(uri.fsPath)) {
        throw new FileSystemError("missing", "FileNotFound");
      }
    },
    stat: async (uri: { fsPath: string }) => {
      if (disk.has(uri.fsPath)) return { mtime: 1, size: 1 };
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

/** 作り物のWebViewパネル。送られたものを覚え、閉じる操作を再現できるようにする */
function installPanel(): void {
  window.createWebviewPanel = () => ({
    webview: {
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (uri: { fsPath: string }) => ({
        toString: () => uri.fsPath,
      }),
      postMessage: (message: { type?: string; data?: PanelPayload }) => {
        posted.push(message);
      },
      onDidReceiveMessage: (listener: (message: unknown) => void) => {
        toExtension = listener;
        return { dispose: () => undefined };
      },
    },
    reveal: () => undefined,
    onDidDispose: (listener: () => void) => {
      onDispose = listener;
      return { dispose: () => undefined };
    },
    dispose: () => undefined,
  });
}

beforeEach(() => {
  counter++;
  work = {
    id: `work_epub_dirty_${counter}`,
    title: "氷の街",
    folderPath: `C:\\novels\\dirty${counter}`,
    registeredAt: "2026-09-06T00:00:00.000Z",
  };
  disk.clear();
  posted.length = 0;
  asked.length = 0;
  offered.length = 0;
  answer = undefined;
  toExtension = null;
  onDispose = null;
  installDisk();
  installPanel();
  (
    commands as { executeCommand?: (...args: unknown[]) => unknown }
  ).executeCommand = () => Promise.resolve(undefined);
  window.showInformationMessage = async () => undefined;
  window.showErrorMessage = async () => undefined;
  window.showWarningMessage = (async (
    message: string,
    ...rest: unknown[]
  ): Promise<string | undefined> => {
    asked.push(message);
    const choices = rest.filter(
      (item): item is string => typeof item === "string"
    );
    offered.push(choices);
    return answer && choices.includes(answer) ? answer : undefined;
  }) as typeof window.showWarningMessage;
  put("本文/第1話.txt", "あ\n\nい");
  put("設定/書籍/book.json", JSON.stringify({ title: "氷の街" }));
});

async function open(): Promise<void> {
  await openEpubEditorPanel(
    { subscriptions: [] } as unknown as Parameters<
      typeof openEpubEditorPanel
    >[0],
    work
  );
  await send({ type: "ready" });
}

async function send(message: unknown): Promise<void> {
  if (!toExtension) throw new Error("受け取り手がまだ居ません");
  await toExtension(message);
}

/** 最後に画面へ渡ったもの */
function latest(): PanelPayload {
  for (let index = posted.length - 1; index >= 0; index--) {
    const message = posted[index];
    if ((message.type === "book" || message.type === "preview") && message.data) {
      return message.data;
    }
  }
  throw new Error("面が1度も渡っていません");
}

/** いま画面が持っている欄の値（`fillForm` が受け取るもの） */
function shownConfig(): Record<string, unknown> {
  for (let index = posted.length - 1; index >= 0; index--) {
    const config = posted[index].data?.config;
    if (config) return config;
  }
  throw new Error("欄の値が渡っていません");
}

/** 画面の `readForm` が送り返す形（欄を触っていないときの中身） */
function formOf(config: Record<string, unknown>): Record<string, unknown> {
  return {
    title: config.title,
    author: config.author,
    illustrator: config.illustrator,
    label: config.label,
    writingMode: config.writingMode,
    tocPattern: config.tocPattern,
    tocEntryStyle: config.tocEntryStyle,
    tocOrnament: config.tocOrnament,
    colophonOrnament: config.colophonOrnament,
    collapseBlankLines: config.collapseBlankLines,
    coverImagePath: config.coverImagePath ?? null,
    backCoverImagePath: config.backCoverImagePath ?? null,
    characterPage: {
      showIcons:
        (config.characterPage as { showIcons?: boolean } | undefined)
          ?.showIcons === true,
    },
    fonts: config.fonts,
    coverLayout: config.coverLayout,
    backCoverLayout: config.backCoverLayout,
    illustrations: config.illustrations,
    pageBreaks: config.pageBreaks,
  };
}

describe("未保存の印は、中身が変わったときだけ", () => {
  test("欄を触らずに送り返しても、未保存にはならない", async () => {
    // 面を切り替えると、打ちかけの字を落とさないために欄の値が送られる。
    // **中身は同じ**なので、これで「未保存の変更があります」が出てはいけない
    await open();
    expect(latest().dirty).toBe(false);

    await send({ type: "change", config: formOf(shownConfig()) });

    expect(latest().dirty).toBe(false);
  });

  test("中身を変えたら未保存になる", async () => {
    await open();

    await send({
      type: "change",
      config: { ...formOf(shownConfig()), title: "氷の街（改訂）" },
    });

    expect(latest().dirty).toBe(true);
  });
});

describe("閉じたときの控えと、次に開いたときの復元", () => {
  const draft = "設定/書籍/.novelai-recovery/book.json.draft";

  test("未保存のまま閉じたら控える", async () => {
    await open();
    await send({
      type: "change",
      config: { ...formOf(shownConfig()), author: "月島灯" },
    });

    onDispose?.();
    // 閉じたあとの後始末は待ってもらえないので、書き終わるまで1度譲る
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(has(draft)).toBe(true);
  });

  test("保存してから閉じたときは控えない", async () => {
    await open();
    await send({
      type: "change",
      config: { ...formOf(shownConfig()), author: "月島灯" },
    });
    await send({ type: "save", config: formOf(shownConfig()) });

    onDispose?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(has(draft)).toBe(false);
  });

  test("次に開いたとき「復元する」を選ぶと、閉じたときの値が戻る", async () => {
    await open();
    await send({
      type: "change",
      config: { ...formOf(shownConfig()), author: "月島灯" },
    });
    onDispose?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    posted.length = 0;
    toExtension = null;
    answer = "復元する";
    await open();

    expect(asked.join("\n")).toContain("保存していない編集");
    // 設計図が変わっていないので、訊くのは従来どおりの2択でよい
    expect(offered.at(-1)).toEqual(["復元する", "捨てる"]);
    expect(shownConfig().author).toBe("月島灯");
    // 戻したものは、まだファイルに入っていない（未保存のままである）
    expect(latest().dirty).toBe(true);
    // 答えたので控えは残さない（次に開いたときにもう一度聞かれない）
    expect(has(draft)).toBe(false);
  });

  test("「捨てる」を選ぶと、ファイルの値のまま開く", async () => {
    await open();
    await send({
      type: "change",
      config: { ...formOf(shownConfig()), author: "月島灯" },
    });
    onDispose?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    posted.length = 0;
    toExtension = null;
    answer = "捨てる";
    await open();

    expect(shownConfig().author).toBe("");
    expect(latest().dirty).toBe(false);
    expect(has(draft)).toBe(false);
  });

  test("答えずに閉じたら、控えは残す（次に開いたときにもう一度聞く）", async () => {
    await open();
    await send({
      type: "change",
      config: { ...formOf(shownConfig()), author: "月島灯" },
    });
    onDispose?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    posted.length = 0;
    toExtension = null;
    answer = undefined;
    await open();

    expect(shownConfig().author).toBe("");
    expect(has(draft)).toBe(true);
  });
});

/**
 * 退避したあとに、外で設計図が直されていたとき（設計書6.65.7、2026-09-06）。
 *
 * **控えを取った時点と、いま読んだ設計図を比べる。** 比べないと、閉じて
 * いるあいだに別の窓・GitHub同期・編集部から入った正しい更新が、古い
 * 下書きの復元で黙って押し流される。保存の関所は「開いてから変わって
 * いないか」しか見ないので、開き直したあとの復元は素通りしてしまう。
 */
describe("退避したあとに設計図が外で変わっていたら、復元を既定にしない", () => {
  const draft = "設定/書籍/.novelai-recovery/book.json.draft";

  /** 未保存のまま閉じ、そのあいだに外で設計図が直された状態を作る */
  async function stashThenChangeOutside(): Promise<void> {
    await open();
    await send({
      type: "change",
      config: { ...formOf(shownConfig()), author: "月島灯" },
    });
    onDispose?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 別の窓や同期から、正しい更新が入る
    put("設定/書籍/book.json", JSON.stringify({ title: "氷の街", label: "○○文庫" }));

    posted.length = 0;
    toExtension = null;
  }

  test("3択で訊き、いちばん手前は「今の設計図を使う」", async () => {
    await stashThenChangeOutside();
    answer = undefined; // Escで閉じたときの形

    await open();

    expect(asked.join("\n")).toContain("退避したあとに設計図が変わっています");
    expect(asked.join("\n")).toContain("復元すると今の設計図を捨てます");
    expect(offered.at(-1)).toEqual([
      "今の設計図を使う（下書きは残す）",
      "下書きで上書きする",
      "捨てる",
    ]);
  });

  test("「今の設計図を使う」なら、外の更新が残り、下書きも残る", async () => {
    await stashThenChangeOutside();
    answer = "今の設計図を使う（下書きは残す）";

    await open();

    expect(shownConfig().label).toBe("○○文庫");
    expect(shownConfig().author).toBe("");
    expect(latest().dirty).toBe(false);
    // **捨てない。** あとで見比べたくなるかもしれない
    expect(has(draft)).toBe(true);
  });

  test("「下書きで上書きする」を選んだときだけ、古い下書きが載る", async () => {
    await stashThenChangeOutside();
    answer = "下書きで上書きする";

    await open();

    expect(shownConfig().author).toBe("月島灯");
    // まだ書いていない（保存するかどうかは作者が決める）
    expect(latest().dirty).toBe(true);
    expect(has(draft)).toBe(false);
  });

  test("「捨てる」なら、外の更新のまま開いて控えを消す", async () => {
    await stashThenChangeOutside();
    answer = "捨てる";

    await open();

    expect(shownConfig().label).toBe("○○文庫");
    expect(shownConfig().author).toBe("");
    expect(has(draft)).toBe(false);
  });

  test("基準を持たない古い控え（0.35.5まで）も、食い違いとして訊く", async () => {
    // 0.35.5 までは下書きの中身だけを書いていた。**どこから書き始めたか
    // 分からない**ので、黙って戻さず訊く
    put(draft, JSON.stringify({ title: "氷の街", author: "月島灯" }));
    answer = undefined;

    await open();

    expect(asked.join("\n")).toContain("保存していない編集が残っています");
    expect(offered.at(-1)).toHaveLength(3);
  });

  test("基準が分からないときは、変わったと断言しない", async () => {
    // **知らないことを、知っている風に言わない。** 旧形式の控えは基準を
    // 持っていないだけで、設計図が本当に外で直されたのかは分かっていない。
    // 「変わっています」と言い切ると、入ってもいない更新を探しに行かせる
    put(draft, JSON.stringify({ title: "氷の街", author: "月島灯" }));
    answer = undefined;

    await open();

    const message = asked.join("\n");
    expect(message).toContain(
      "いつの下書きか分からないため確認します" +
        "（退避したあとに設計図が変わっている可能性があります）"
    );
    expect(message).not.toContain("退避したあとに設計図が変わっています");
    // 訊き方（3択）は、食い違いが分かっているときと同じでよい
    expect(offered.at(-1)).toEqual([
      "今の設計図を使う（下書きは残す）",
      "下書きで上書きする",
      "捨てる",
    ]);
  });
});
