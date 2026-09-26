/**
 * `vscode` の代役（内蔵ブラウザの原稿エディター・試作。設計書 6.112）。
 *
 * 読み書き役（desk/server.mjs）は、原稿の書き戻しに拡張機能と**同じ**
 * `writeTextFilePreservingFormat`（src/core/textFile.ts）を使う。写しを
 * 作ると、ハッシュ照合・文字コードと改行の保持・変わった所だけの置換の
 * どれかが片方だけ直って、もう片方が古いまま残る（この作品で何度も踏んだ形）。
 *
 * そこで、束ねるときに `vscode` をこのファイルへ差し替える
 * （desk/build.mjs の alias）。**書き戻しの道が触る分だけ**を Node の
 * `fs` で持つ。ここに無いものへ触れたら、束の中で undefined になる。
 */
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

export class Uri {
  /** @param {string} fsPath */
  constructor(fsPath) {
    this.scheme = "file";
    this.fsPath = fsPath;
    this.path = fsPath.replace(/\\/g, "/");
  }
  /** @param {string} fsPath */
  static file(fsPath) {
    return new Uri(nodePath.resolve(fsPath));
  }
  /** 読み書き役は手元のファイルしか扱わない。URIの文字列が来たら止める */
  static parse(value) {
    throw new Error(`手元のファイル以外は扱えません: ${value}`);
  }
  toString() {
    return `file:///${this.path.replace(/^\//, "")}`;
  }
}

/**
 * VS Code と同じく `code` で種類を見分けられるようにする。
 * atomicWrite.ts は「既にある（FileExists）」「無い（FileNotFound）」を
 * これで分けて、新規作成の衝突を判断している。
 */
export class FileSystemError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

function translate(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  if (code === "ENOENT") return new FileSystemError(String(error.message), "FileNotFound");
  if (code === "EEXIST") return new FileSystemError(String(error.message), "FileExists");
  return error;
}

async function wrap(run) {
  try {
    return await run();
  } catch (error) {
    throw translate(error);
  }
}

const fileSystem = {
  readFile: (uri) => wrap(async () => new Uint8Array(await fs.readFile(uri.fsPath))),
  writeFile: (uri, bytes) => wrap(() => fs.writeFile(uri.fsPath, bytes)),
  delete: (uri) => wrap(() => fs.rm(uri.fsPath, { recursive: false })),
  createDirectory: (uri) => wrap(() => fs.mkdir(uri.fsPath, { recursive: true })),
  readDirectory: (uri) =>
    wrap(async () => {
      const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((entry) => [
        entry.name,
        entry.isDirectory() ? FileType.Directory : entry.isFile() ? FileType.File : FileType.Unknown,
      ]);
    }),
  stat: (uri) =>
    wrap(async () => {
      const info = await fs.stat(uri.fsPath);
      return {
        type: info.isDirectory() ? FileType.Directory : FileType.File,
        size: info.size,
        mtime: info.mtimeMs,
        ctime: info.ctimeMs,
      };
    }),
  /**
   * **`overwrite: false` は、既にあれば必ず失敗させる。** Node の `rename` は
   * Windows でも黙って上書きする。原稿の「退避 → 新規作成」は、この
   * 「既にあれば失敗」を頼りに外からの書き込みと衝突しないことを保っているので、
   * ハードリンク（既にあれば EEXIST で失敗する）で置いてから元を消す。
   */
  rename: (source, target, options) =>
    wrap(async () => {
      if (options && options.overwrite) {
        await fs.rename(source.fsPath, target.fsPath);
        return;
      }
      try {
        await fs.link(source.fsPath, target.fsPath);
      } catch (error) {
        if (error && error.code === "EEXIST") throw error;
        // リンクを張れない場所（別のドライブなど）では、排他の写しで代える
        await fs.copyFile(source.fsPath, target.fsPath, fs.constants.COPYFILE_EXCL);
      }
      await fs.rm(source.fsPath);
    }),
};

export const workspace = {
  fs: fileSystem,
  /**
   * 開いている文書は無い（未保存の検出は、読み書き役が自分で持つ）。
   * textFile.ts の `hasUnsavedChanges` はこれを見る。
   */
  textDocuments: [],
  getConfiguration: () => ({ get: (_key, fallback) => fallback }),
};

/**
 * 画面の組み立て（manuscriptEditorHtml.ts）が操作の一覧（views/actionList.ts）から
 * 案内の文言を1つ借りるため、一覧の木を作る部品まで束に入る。読み書き役は
 * 木を作らないので、**作ろうとしたら止める**（黙って壊れた物を作らない）。
 */
class Unavailable {
  constructor() {
    throw new Error("この部品は、VS Code の外の読み書き役では使えません");
  }
}
export const EventEmitter = Unavailable;
export const TreeItem = Unavailable;
export const MarkdownString = Unavailable;
export const ThemeIcon = Unavailable;
export const ThemeColor = Unavailable;
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

export const window = {};
export const commands = {};
export const env = {};
export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
