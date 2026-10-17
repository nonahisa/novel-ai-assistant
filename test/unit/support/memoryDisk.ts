import * as nodePath from "node:path";
import { FileSystemError, FileType, type workspace } from "./vscodeStub";

/**
 * メモリ上のファイル置き場（`workspace.fs` の作り物）の共通の部品
 * （2026-10-17。単体テストの前準備の写しを寄せた）。
 *
 * ## なぜここにあるのか
 *
 * 単体テストの約120ファイルが、`Map<道, 中身>` を `workspace.fs` に見せる
 * 作り物を**各自で30〜50行ずつ書いていた**。中身はほぼ同じ写しで、
 * 作り物の振る舞いを1つ直すたびに十数ファイルへ同じ直しを写すことになる。
 *
 * ## 作り物を親切にしない
 *
 * **写す前の形を、そのまま選べるようにしてある。** 「本物に近い良い作り物」を
 * 1つ作って全部をそれに揃えると（stat に種類を足す・無いファイルの削除で
 * 断る、など）、テストが通る理由が変わってしまい、確かめている中身を
 * 変えたことになる。そのため：
 *
 * - **持たせる口（`methods`）は写す前と同じだけにする。** 口が無いことで
 *   別の道を通る製品のコードがある（`readDirectory` が無ければ走査しない、など）
 * - `stat` の答え（`fileStat`・`folderStat`）も、写す前の値をそのまま渡す
 * - 道の書き方は揃えない。`uri.fsPath` を**生のまま**鍵にする（テストの側が
 *   `Uri.file(...).fsPath` で揃えてから `Map` へ入れている）
 *
 * ## `Map` は呼ぶ側が持つ
 *
 * テストは `disk.set`・`disk.get`・`disk.clear()` で中身を直接触る。
 * 部品が新しい `Map` を作って返す形にすると、全テストの参照を書き換える
 * ことになるので、呼ぶ側の `Map` を受け取る。
 *
 * **代役（`vscodeStub`）から型と失敗の形を引く。** `"vscode"` も試験では同じ
 * 代役を指すが、丸ごと差し替える（`vi.mock("vscode")`）テストでは別物になる。
 * そういうテストはここを使わない（失敗の形が製品の見分け方と食い違う）。
 *
 * 開いている文書へ当てる道の試験は `openDocumentFake.ts`（消した記録を残す別物）。
 */

/** `workspace.fs` の口の名前 */
export type MemoryFsMethod =
  | "createDirectory"
  | "readFile"
  | "writeFile"
  | "rename"
  | "delete"
  | "stat"
  | "readDirectory";

export interface MemoryFsOptions {
  /**
   * 持たせる口。既定は `createDirectory`・`readFile`・`writeFile`・`rename`・
   * `delete`・`stat`（いちばん多かった形）。`readDirectory` は
   * `readDirectory` の指定があるときだけ足す
   */
  readonly methods?: readonly MemoryFsMethod[];
  /**
   * `rename` で、`overwrite` の指定が無いのに行き先があれば断る（既定 true）。
   * 本物の `workspace.fs.rename` と同じ。false は「断らずに置き換える」写しの形
   */
  readonly renameRefusesExisting?: boolean;
  /** `delete` で、無いファイルを消そうとしたら断る（既定 false＝黙って済ます） */
  readonly deleteRefusesMissing?: boolean;
  /** ファイルがあったときの `stat` の答え（既定 `{ type: 1, ctime: 0, mtime: 0, size: 0 }`） */
  readonly fileStat?: Readonly<Record<string, unknown>>;
  /**
   * 指定すると、**中に何か入っている道をフォルダーとして見せる**（`stat` がこの答えを返す）。
   * 指定しなければ、`Map` に無い道は全部「無い」
   */
  readonly folderStat?: Readonly<Record<string, unknown>>;
  /**
   * 一覧の返し方。指定すると `readDirectory` の口を持つ。
   *
   * - `"nested"`：下にあるものを直下の名前で返す（さらに下があればフォルダー）。区切りは `path.sep`
   * - `"filesOnly"`：直下のファイルだけを返す（`path.dirname` が一致するもの）
   *
   * - `"empty"`：どのフォルダーも空として返す（一覧を使わない試験で、口だけ要るとき）
   * - `"missing"`：どのフォルダーも「無い」で断る
   *
   * `nested` と `filesOnly` は、1件も無ければ「無い」で断る
   */
  readonly readDirectory?: "nested" | "filesOnly" | "empty" | "missing";
}

const DEFAULT_METHODS: readonly MemoryFsMethod[] = [
  "createDirectory",
  "readFile",
  "writeFile",
  "rename",
  "delete",
  "stat",
];

const DEFAULT_FILE_STAT = { type: 1, ctime: 0, mtime: 0, size: 0 };

/**
 * `disk` を `workspace.fs` に見せる作り物を返す。テストは
 * `workspace.fs = memoryFs(disk, {...})` と代入する。
 */
export function memoryFs(
  disk: Map<string, Uint8Array>,
  options: MemoryFsOptions = {}
): typeof workspace.fs {
  const separator = nodePath.sep;
  const renameRefusesExisting = options.renameRefusesExisting ?? true;
  const fileStat = options.fileStat ?? DEFAULT_FILE_STAT;
  const all: Record<MemoryFsMethod, unknown> = {
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
      renameOptions?: { overwrite?: boolean }
    ) => {
      const bytes = disk.get(from.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      if (renameRefusesExisting && !renameOptions?.overwrite && disk.has(to.fsPath)) {
        throw new FileSystemError("exists", "FileExists");
      }
      disk.set(to.fsPath, bytes);
      disk.delete(from.fsPath);
    },
    delete: async (uri: { fsPath: string }) => {
      if (!disk.delete(uri.fsPath) && options.deleteRefusesMissing) {
        throw new FileSystemError("missing", "FileNotFound");
      }
    },
    stat: async (uri: { fsPath: string }) => {
      // 写す前と同じく、呼ぶたびに新しい答えを返す（受け取った側が書き換えても次に響かない）
      if (disk.has(uri.fsPath)) return { ...fileStat };
      if (options.folderStat) {
        const prefix = uri.fsPath + separator;
        for (const key of disk.keys()) {
          if (key.startsWith(prefix)) return { ...options.folderStat };
        }
      }
      throw new FileSystemError("missing", "FileNotFound");
    },
    readDirectory: async (uri: { fsPath: string }) => {
      if (options.readDirectory === "empty") return [];
      if (options.readDirectory === "missing") {
        throw new FileSystemError("missing", "FileNotFound");
      }
      if (options.readDirectory === "filesOnly") {
        const entries = [...disk.keys()].filter(
          (filePath) => nodePath.dirname(filePath) === uri.fsPath
        );
        if (entries.length === 0) throw new FileSystemError("missing", "FileNotFound");
        return entries.map(
          (filePath) => [nodePath.basename(filePath), FileType.File] as [string, FileType]
        );
      }
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
  };
  const methods = [...(options.methods ?? DEFAULT_METHODS)];
  if (options.readDirectory && !methods.includes("readDirectory")) methods.push("readDirectory");
  const picked: Record<string, unknown> = {};
  for (const name of methods) picked[name] = all[name];
  return picked as unknown as typeof workspace.fs;
}
