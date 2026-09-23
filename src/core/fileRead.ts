import * as vscode from "vscode";
import * as path from "./paths";
import { canRunProcesses } from "./runtime";

/**
 * **読むだけ**の口を1つにまとめる（設計書6.107、5.8）。
 *
 * ## なぜ要るのか（2026-09-21、ノートPCで測った数字）
 *
 * 起動が遅い原因は作品の中身ではなく、**`vscode.workspace.fs` が起動直後の
 * 十数秒は詰まっていて、要求が列に並ぶ**ことだった。
 *
 * - 登録簿の整備（作品ごとの `stat` と `.gitignore` の読み）は、
 *   **1番目が 13,598ms、16番目が 70ms** と順番に沿って単調に速くなる。
 *   作品の中身は無関係で、**列の何番目か**だけで決まっていた
 * - まったく同じ `stat`＋`readFile` を **Node の `fs` で16作品ぶん読むと
 *   合計13ms・最長4ms**（1,300倍の差）
 * - 作品一覧の走査（573ファイル）も同じ列に並ぶので、一覧が出るまで26〜35秒
 *
 * OneDrive・他の拡張機能・OS はどれも潰してある。**経路そのものが遅い。**
 *
 * ## 何をするか
 *
 * **手元（Node が居る）なら `node:fs/promises` で読み、ブラウザ版の
 * VS Code なら `vscode.workspace.fs` で読む。** 読むだけなので、
 * どちらを通っても結果は同じである。
 *
 * **書き込みは一切ここに置かない。** 原稿の書き戻しは
 * `writeTextFilePreservingFormat`、台帳は `atomicWriteFile` が
 * 退避や照合まで含めて面倒を見ている（実装ルール1・2）。**速さのために
 * その道を迂回すると、守っているものが静かに外れる。**
 *
 * ## 規則7（ブラウザ版）との折り合い
 *
 * `node:fs/promises` は**動的 import でしか触らない**。静的に書くと、
 * 呼ばれなくてもブラウザ版が読み込んだ瞬間に落ちる。
 * `workRegistry.ts` の `appendBytes` が既に同じ書き方をしている。
 */

/** 場所の種類。`vscode.FileType` の数の並びを、読みやすい名前に写したもの */
export type FileKind = "file" | "directory" | "other";

/** `stat` が返すもの。両方の経路で同じ形にそろえてある */
export interface FileStatLite {
  readonly type: FileKind;
  readonly size: number;
  /** 最終更新（エポックからのミリ秒） */
  readonly mtime: number;
}

/** 一括読み（`readTextTree`）が返す1ファイル */
export interface TreeFile {
  /** 絶対パス（`paths.join` で組んだもの） */
  readonly path: string;
  /** 中身。読めなかったときは空で、`unreadable` が立つ */
  readonly bytes: Uint8Array;
  /**
   * 読めなかった（中身は空）。
   *
   * **落とさずに残す。** 1ファイルずつ読んでいたころ、読めないファイルは
   * 「0字の話」として一覧に残っていた（`scanner.ts` の `catch`）。
   * 一括読みで黙って捨てると、**権限のないファイルが一覧から消える**という
   * 別の振る舞いになる
   */
  readonly unreadable?: boolean;
}

/**
 * 名前で選り分ける。フォルダーなら「中へ入るか」、ファイルなら「読むか」。
 *
 * **フォルダーも同じ口で決める。** 走査は `設定/`・`node_modules`・`exports` へ
 * 入らない（`scanner.ts`）。読み口の側に作品の都合を持ち込まないために、
 * 判断はすべて呼び手へ返す
 *
 * **場所（`fullPath`）も渡す**（0.81.1）。作品の設定フォルダーは名前を
 * 変えられる（`config.json` の `settingsDir`）ので、名前だけでは外せない。
 * 名前の決め打ち（`設定`）では、別の名前にした作品の設定資料が話に
 * 数えられていた（ノートPCの実機確認、2026-09-23）
 */
export type TreeAccept = (
  name: string,
  kind: "file" | "directory",
  fullPath: string
) => boolean;

/** 潜る深さの上限。想定外の深い階層で無限に走査しないため（走査の元の値） */
const DEFAULT_TREE_DEPTH = 5;

export interface FileReader {
  readFile(filePath: string): Promise<Uint8Array>;
  stat(filePath: string): Promise<FileStatLite>;
  readDirectory(dirPath: string): Promise<Array<[name: string, type: FileKind]>>;
  /**
   * フォルダーの下を再帰し、**選んだファイルを中身ごと一度に返す**
   * （設計書6.107。`await` の回数を減らすために足した）。
   *
   * **なぜ要るのか。** 走査は576ファイルを1つずつ `await reader.readFile()` で
   * 読んでいた。混んだ拡張機能ホスト（他の拡張機能の読み込み・本体・ネイティブが
   * CPU を握っている）では、**`await` から戻ってくるまでに毎回数十ms 待たされる**。
   * 自分の CPU は5%しか使っていないのに一覧が出るまで19〜22秒かかったのは、
   * 「読むのが遅い」のではなく**再開の順番が回ってこない**ためである。
   * ノートの実測では、作品ごとに1回の同期読みへ替えると `await` が
   * 576回→22回、合計0.47秒（いちばん長い塊 0.09秒）になった。
   *
   * - **Node 側は同期で読む**（`readdirSync`＋`readFileSync`）。中で1回も
   *   `await` しないので、**1作品ぶんを読み切るまで手放さない**。
   *   いちばん大きい作品でも0.1秒なので、画面が固まるほどではない
   * - **ブラウザ版は今までどおり非同期**（`readDirectory`＋`readFile`）。
   *   `node:fs` が無いので、ここだけは回数を減らせない
   * - `.` で始まる名前は飛ばす（`.git`・`.aiwriter`。両方の経路で同じ）
   * - **並びは名前順**。経路や OS で一覧の順が変わらないようにする
   * - 読めなかったファイルは `unreadable` を立てて残す（捨てない）
   */
  readTextTree(
    dirPath: string,
    accept: TreeAccept,
    maxDepth?: number
  ): Promise<TreeFile[]>;
}

/**
 * 名前順にそろえる。
 *
 * **経路ごとの「フォルダーが返してくる順」に結果を預けない。** Node の
 * `readdir` と `vscode.workspace.fs.readDirectory` は同じ順とは限らず、
 * OS やファイルシステムでも変わる。並べ替えてから返せば、どこで動かしても
 * 一覧の順が同じになる
 */
function byName(
  entries: Array<[string, FileKind]>
): Array<[string, FileKind]> {
  return [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * 「見つからない」か。
 *
 * **経路によって投げてくるものが違う。** Node は `code === "ENOENT"` の
 * `Error`、VS Code は `FileSystemError`（`code === "FileNotFound"`）。
 * 呼び手はここだけを見れば、どちらを通ったかを気にせずに済む
 * （`workRegistry.ts` は「`.gitignore` がまだ無い」を見分けて新規作成する）。
 */
export function isNotFound(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) {
    return error.code === "FileNotFound";
  }
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === "ENOENT" || code === "FileNotFound";
}

/** `vscode.workspace.fs` で読む（ブラウザ版と、URI の場所はこちら） */
const vscodeReader: FileReader = {
  async readFile(filePath) {
    return vscode.workspace.fs.readFile(path.toUri(filePath));
  },
  async stat(filePath) {
    const stat = await vscode.workspace.fs.stat(path.toUri(filePath));
    return {
      // **ここは重ね合わせで見る**（`fileSystem.ts` の `isDirectory` と同じ）。
      // シンボリックリンクは `Directory | SymbolicLink` のように混ざるため、
      // 等号で見ると「リンクの先はフォルダー」を取りこぼす
      type:
        (stat.type & vscode.FileType.Directory) !== 0
          ? "directory"
          : (stat.type & vscode.FileType.File) !== 0
            ? "file"
            : "other",
      size: stat.size,
      mtime: stat.mtime,
    };
  },
  async readDirectory(dirPath) {
    const entries = await vscode.workspace.fs.readDirectory(
      path.toUri(dirPath)
    );
    return entries.map(([name, type]) => {
      // **こちらは等号で見る。** 走査（`scanner.ts`）は元から
      // `type === FileType.Directory` の等号で判定しており、リンクは
      // 拾っていなかった。Node の `Dirent` もリンクを `isDirectory()` で
      // 真にしないので、**等号にしておくと両方の経路の見え方がそろう**
      const kind: FileKind =
        type === vscode.FileType.Directory
          ? "directory"
          : type === vscode.FileType.File
            ? "file"
            : "other";
      return [name, kind] as [string, FileKind];
    });
  },
  async readTextTree(dirPath, accept, maxDepth = DEFAULT_TREE_DEPTH) {
    const result: TreeFile[] = [];
    const walk = async (current: string, depth: number): Promise<void> => {
      if (depth > maxDepth) return;
      let entries: Array<[string, FileKind]>;
      try {
        entries = await vscodeReader.readDirectory(current);
      } catch {
        // 読めないフォルダーで走査を止めない（元の `collectTextFiles` と同じ）
        return;
      }
      for (const [name, kind] of byName(entries)) {
        if (name.startsWith(".")) continue;
        const full = path.join(current, name);
        if (kind === "directory") {
          if (!accept(name, "directory", full)) continue;
          await walk(full, depth + 1);
        } else if (kind === "file") {
          if (!accept(name, "file", full)) continue;
          try {
            result.push({ path: full, bytes: await vscodeReader.readFile(full) });
          } catch {
            result.push({ path: full, bytes: EMPTY_BYTES, unreadable: true });
          }
        }
      }
    };
    await walk(dirPath, 0);
    return result;
  },
};

/** 読めなかったファイルの中身。**毎回作らない**（1つを使い回す） */
const EMPTY_BYTES = new Uint8Array(0);

/** `node:fs/promises` で読む。**`node:` は動的 import でしか触らない**（規則7） */
async function createNodeReader(): Promise<FileReader> {
  const { readFile, stat, readdir } = await import("node:fs/promises");
  // **同期の口も一緒に取っておく**（`readTextTree` のため）。ここで取れば、
  // 一括読みの中では import の `await` すら発生しない
  const { readdirSync, readFileSync } = await import("node:fs");
  return {
    async readFile(filePath) {
      // `Buffer` は `Uint8Array` を継承しているので、そのまま渡してよい
      return readFile(filePath);
    },
    async stat(filePath) {
      const info = await stat(filePath);
      return {
        type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
        size: info.size,
        mtime: info.mtimeMs,
      };
    },
    async readDirectory(dirPath) {
      const entries = await readdir(dirPath, { withFileTypes: true });
      return entries.map((entry) => {
        const kind: FileKind = entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : "other";
        return [entry.name, kind] as [string, FileKind];
      });
    },
    /**
     * **1回も `await` を挟まずに読み切る**（設計書6.107）。
     *
     * `async` を付けてあるので呼び手からは約束に見えるが、**中は同期**である。
     * 混んだ拡張機能ホストでは `await` から戻るまでが待ち時間なので、
     * 回数そのものを減らすことに意味がある（1作品＝1回）。
     */
    async readTextTree(dirPath, accept, maxDepth = DEFAULT_TREE_DEPTH) {
      const result: TreeFile[] = [];
      const walk = (current: string, depth: number): void => {
        if (depth > maxDepth) return;
        let entries: Array<[string, FileKind]>;
        try {
          entries = readdirSync(current, { withFileTypes: true }).map((entry) => {
            const kind: FileKind = entry.isDirectory()
              ? "directory"
              : entry.isFile()
                ? "file"
                : "other";
            return [entry.name, kind] as [string, FileKind];
          });
        } catch {
          // 読めないフォルダーで走査を止めない（元の `collectTextFiles` と同じ）
          return;
        }
        for (const [name, kind] of byName(entries)) {
          if (name.startsWith(".")) continue;
          const full = path.join(current, name);
          if (kind === "directory") {
            if (!accept(name, "directory", full)) continue;
            walk(full, depth + 1);
          } else if (kind === "file") {
            if (!accept(name, "file", full)) continue;
            try {
              // `Buffer` は `Uint8Array` を継承しているので、そのまま渡してよい
              result.push({ path: full, bytes: readFileSync(full) });
            } catch {
              result.push({ path: full, bytes: EMPTY_BYTES, unreadable: true });
            }
          }
        }
      };
      walk(dirPath, 0);
      return result;
    },
  };
}

/**
 * 場所ごとに振り分ける。
 *
 * **手元でも、作品が URI の場所にあることがある**（`vscode-vfs://github/...` を
 * 手元の VS Code で開いている場合。設計書5.8）。Node の `fs` はそれを
 * 読めないので、**URI の文字列はいつでも `vscode.workspace.fs` へ回す。**
 */
function createDispatchingReader(node: FileReader): FileReader {
  const pick = (location: string): FileReader =>
    path.isUriString(location) ? vscodeReader : node;
  return {
    readFile: (filePath) => pick(filePath).readFile(filePath),
    stat: (filePath) => pick(filePath).stat(filePath),
    readDirectory: (dirPath) => pick(dirPath).readDirectory(dirPath),
    readTextTree: (dirPath, accept, maxDepth) =>
      pick(dirPath).readTextTree(dirPath, accept, maxDepth),
  };
}

/** 一度決めたら使い回す。**約束のまま持つ**ので、同時に呼ばれても import は1回 */
let pending: Promise<FileReader> | undefined;
/** 試験から差し込む代役（`setFileReaderForTests`）。製品では常に `undefined` */
let override: FileReader | undefined;

/**
 * どちらを選んだか（0.74.11）。
 *
 * `node` でも、**URI の場所は `vscode.workspace.fs` へ回る**
 * （`createDispatchingReader`）。ここが言うのは「手元の道が使えるか」である。
 */
export type ReaderKind = "node" | "vscode";

/** 選んだ結果。まだ選んでいなければ `undefined` */
let chosenKind: ReaderKind | undefined;

/**
 * 読み口を得る。**1回作って使い回す**（動的 import を毎回走らせない）。
 */
export async function fileReader(): Promise<FileReader> {
  if (override !== undefined) return override;
  if (pending === undefined) {
    if (canRunProcesses()) {
      pending = createNodeReader().then((node) => {
        // **作り終えてから印を付ける。** import が失敗したときに
        // 「node を選んだ」と名乗ると、ログが実態とずれる
        chosenKind = "node";
        return createDispatchingReader(node);
      });
    } else {
      chosenKind = "vscode";
      pending = Promise.resolve(vscodeReader);
    }
  }
  return pending;
}

/**
 * どちらの読み口を選んだかを返す（設計書6.107。0.74.11）。
 *
 * **起動の1行へ出すために要る。** 0.74.9 の計測で「読み 58,191ms」が出た
 * とき、まず確かめるべきは**そもそも Node 側を通っているのか**だった。
 * `isUriString("C:/…")` は偽なので通っているはず、で止まっていた
 * ——「はず」を数字にしないと、ここから先はぜんぶ当てずっぽうになる。
 *
 * **まだ選んでいなければ選ばせてから返す**（呼び手に順番を気にさせない）。
 */
export async function readerKind(): Promise<ReaderKind> {
  // 試験の差し込みは `vscode.workspace.fs` 版なので、そう名乗る
  if (override !== undefined) return "vscode";
  await fileReader();
  return chosenKind ?? "vscode";
}

/**
 * 試験から読み口を差し替える。**製品の道は通らない。**
 *
 * 単体テストは `vscode.workspace.fs` に記憶の中のファイルを置いて動く。
 * 試験の中では Node の `fs` が「居る」ので、そのままだと本物のディスクを
 * 読みにいって、置いた作り物が見えなくなる。`test/unit/support/setup.ts`
 * が全テストの前に `vscodeFileReaderForTests()` を差し込んでいる。
 *
 * `undefined` を渡すと選び直しに戻る（`fileRead.test.ts` が Node 側を
 * 確かめるときに使う）。
 */
export function setFileReaderForTests(reader: FileReader | undefined): void {
  override = reader;
  pending = undefined;
  // 選び直しに戻すので、前に選んだ印も落とす
  chosenKind = undefined;
}

/** 試験が差し込むための、`vscode.workspace.fs` 版の読み口 */
export function vscodeFileReaderForTests(): FileReader {
  return vscodeReader;
}
