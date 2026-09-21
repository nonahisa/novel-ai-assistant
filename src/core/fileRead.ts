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

export interface FileReader {
  readFile(filePath: string): Promise<Uint8Array>;
  stat(filePath: string): Promise<FileStatLite>;
  readDirectory(dirPath: string): Promise<Array<[name: string, type: FileKind]>>;
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
};

/** `node:fs/promises` で読む。**`node:` は動的 import でしか触らない**（規則7） */
async function createNodeReader(): Promise<FileReader> {
  const { readFile, stat, readdir } = await import("node:fs/promises");
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
  };
}

/** 一度決めたら使い回す。**約束のまま持つ**ので、同時に呼ばれても import は1回 */
let pending: Promise<FileReader> | undefined;
/** 試験から差し込む代役（`setFileReaderForTests`）。製品では常に `undefined` */
let override: FileReader | undefined;

/**
 * 読み口を得る。**1回作って使い回す**（動的 import を毎回走らせない）。
 */
export async function fileReader(): Promise<FileReader> {
  if (override !== undefined) return override;
  if (pending === undefined) {
    pending = canRunProcesses()
      ? createNodeReader().then(createDispatchingReader)
      : Promise.resolve(vscodeReader);
  }
  return pending;
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
}

/** 試験が差し込むための、`vscode.workspace.fs` 版の読み口 */
export function vscodeFileReaderForTests(): FileReader {
  return vscodeReader;
}
