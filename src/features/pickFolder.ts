import * as vscode from "vscode";
import { fromUri, toUri } from "../core/paths";
import { canRunProcesses } from "../core/runtime";
import { pathExists } from "../core/fileSystem";
import type { WorkLocation } from "../core/libraryHome";
import {
  existingWorkFolderHomeCandidates,
  newFolderHomeCandidates,
} from "../core/newFolderHome";
import { cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 作品フォルダー（またはその置き場）を選ぶ（設計書5.8.8）。
 *
 * **ブラウザ版では、フォルダーを選ぶダイアログを当てにできない。**
 * vscode.dev で開いているのはGitHubの仮想ファイルシステム
 * （`vscode-vfs://github/...`）で、そこにOSのファイル選択画面は無い。
 *
 * 代わりに**いま開いているフォルダー**（ワークスペース）から選ばせる。
 * ブラウザでは、そもそも作品はそこにしか無い——リポジトリを開いた状態が
 * 出発点なので、これで足りる。
 *
 * 手元のVS Codeでは、これまでどおりダイアログを出す。**作品はどこにでも
 * 置けるので、開いているフォルダーに限ると不便になる。**
 */

/** 一覧に出ているのに中を読めないフォルダーへ添える印 */
const UNREADABLE_NOTE =
  "⚠ いま中を読めません（GitHubの読み込みが終わっていない可能性があります）";

/**
 * そのフォルダーの中を、いま実際に読めるか。
 *
 * **一覧に出ていることと、読めることは別。** ブラウザ版では、GitHubの
 * 読み込みが終わっていない・失敗した状態でもワークスペースフォルダーとして
 * 名前だけが並ぶ（エクスプローラーには「ワークスペース フォルダー
 * (Canceled) を解決できません」と出る）。
 */
async function canRead(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.readDirectory(uri);
    return true;
  } catch {
    return false;
  }
}

/** 選べるフォルダーが無いときに出す案内 */
const NO_FOLDER_HINT =
  "フォルダーが開かれていません。vscode.dev でGitHubのリポジトリを開いてから、もう一度お試しください。";

/**
 * @param purpose 選択画面の見出しに出す目的（「作品フォルダを選択」など）
 * @param openLabel ダイアログのボタン文言（手元のVS Codeでのみ使う）
 * @param defaultPath 窓を最初に開く場所。渡さなければVS Codeに任せる
 */
export async function pickFolder(
  purpose: string,
  openLabel: string,
  defaultPath?: string
): Promise<string | undefined> {
  if (canRunProcesses()) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel,
      title: purpose,
      // **`vscode.Uri.file()` を直に呼ばない**（実装ルール7）
      defaultUri: defaultPath ? toUri(defaultPath) : undefined,
    });
    if (!picked || picked.length === 0) return undefined;
    return fromUri(picked[0]);
  }

  return pickFromWorkspaceFolders(purpose);
}

/**
 * 「新しい置き場を作る」ときのフォルダー選択（設計書6.97.6）。
 *
 * **既存の作品を選ばせる `pickFolder` とは、窓を開く場所が違う。**
 * 既にあるものを選ぶなら「最後に使った場所」が親切だが、新しく作るなら
 * そこは危ない——直前に原稿を触っていれば、**作者の作品フォルダーの中**が
 * 開いた状態で立ち上がり、そのまま押せば原稿の中に書庫が入る
 * （2026-09-21、実機で判明）。
 *
 * どこを開くかの判断は `core/newFolderHome.ts` にある。ここは**実際に
 * あるかどうかだけを確かめる**——登録した作品を作者が移していると、
 * 候補の場所がもう無いことがある。
 */
export async function pickNewFolderParent(options: {
  readonly purpose: string;
  readonly openLabel: string;
  /** 登録済みの作品。**この中は既定にしない** */
  readonly works: readonly WorkLocation[];
}): Promise<string | undefined> {
  return pickFolder(
    options.purpose,
    options.openLabel,
    await defaultParentForNewFolder(options.works)
  );
}

/** 新しいフォルダーを作る場所の既定。無ければ `undefined`（VS Codeに任せる） */
export async function defaultParentForNewFolder(
  works: readonly WorkLocation[]
): Promise<string | undefined> {
  return firstExisting(
    newFolderHomeCandidates({ works, workspaceFolders: workspaceFolderPaths() })
  );
}

/**
 * 「フォルダから追加」——既にある作品フォルダーを選ぶ（2026-09-23）。
 *
 * **窓は書庫（作品が並んでいる階層）から開く。** 渡さないと VS Code は
 * 「最後に使った場所」を出し、ノートPCの実機では**選択中の作品の `設定`
 * フォルダーの中**から開いた。どこを開くかの判断は `core/newFolderHome.ts`
 * の `existingWorkFolderHomeCandidates`。
 */
export async function pickExistingWorkFolder(options: {
  /** 登録済みの作品。**この中は既定にしない** */
  readonly works: readonly WorkLocation[];
}): Promise<string | undefined> {
  const defaultPath = canRunProcesses()
    ? await firstExisting(
        existingWorkFolderHomeCandidates({
          works: options.works,
          workspaceFolders: workspaceFolderPaths(),
        })
      )
    : // ブラウザ版は窓を出さず、開いているフォルダーから選ばせる（既定は要らない）
      undefined;
  return pickFolder("作品フォルダを選択", "この作品フォルダを登録", defaultPath);
}

function workspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) =>
    fromUri(folder.uri)
  );
}

/** 候補のうち、実在する最初の1つ。無ければ `undefined`（VS Codeに任せる） */
async function firstExisting(
  candidates: readonly string[]
): Promise<string | undefined> {
  for (const candidate of candidates) {
    // **確かめられなくても窓は開く。** 既定はあくまで親切であって、
    // 外したドライブや権限のないフォルダーのせいで
    // 「フォルダーを選べない」になってはいけない
    try {
      if (await pathExists(candidate)) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * 開いているフォルダーから選ぶ。
 *
 * **1つしか無くても選択画面を出す。** 黙って決めると、作者は何が
 * 登録されようとしているのか分からないまま次の画面（作品名の入力）へ
 * 進むことになる。
 */
async function pickFromWorkspaceFolders(
  purpose: string
): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    await vscode.window.showWarningMessage(NO_FOLDER_HINT);
    return undefined;
  }

  // **選ばせる前に、本当に読めるか確かめる。**
  //
  // ブラウザ版では、フォルダーが一覧に出ていても中を読めないことがある
  // （GitHubの読み込みが終わっていない・失敗した場合。エクスプローラーには
  // 「ワークスペース フォルダー (Canceled) を解決できません」と出る）。
  // そのまま選ばせると、**選べたのに何も起きない**という分かりにくい
  // 終わり方になる（2026-08-22、作者の環境で判明）
  const items = await Promise.all(
    folders.map(async (folder) => {
      const readable = await canRead(folder.uri);
      return {
        label: folder.name,
        description: describeFolder(folder.uri),
        detail: readable ? undefined : UNREADABLE_NOTE,
        folderPath: fromUri(folder.uri),
        readable,
      };
    })
  );

  const picked = await vscode.window.showQuickPick<
    vscode.QuickPickItem & { folderPath?: string; readable?: boolean }
  >([...items, cancelItem()], {
    title: purpose,
    placeHolder: "いま開いているフォルダーから選びます",
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked) || !picked.folderPath) return undefined;

  if (picked.readable === false) {
    await vscode.window.showWarningMessage(
      `「${picked.label}」の中をいま読み込めません。`,
      {
        modal: true,
        detail: [
          "GitHubからの読み込みが終わっていないか、失敗しています。",
          "",
          "ページを再読み込み（F5）してから、もう一度お試しください。",
          "それでも直らない場合は、アドレス欄のリポジトリ名をご確認ください。",
        ].join("\n"),
      }
    );
    return undefined;
  }
  return picked.folderPath;
}

/**
 * 選択肢の右に出す説明。
 *
 * **どこのリポジトリかを見せる。** 同じ名前のフォルダーを別の場所で
 * 開いていることがあるので、名前だけでは選べない。
 */
export function describeFolder(uri: vscode.Uri): string {
  if (uri.scheme === "file") return uri.fsPath;
  // vscode-vfs://github/nonahisa/HisasNovels → github: nonahisa/HisasNovels
  const authority = uri.authority || uri.scheme;
  return `${authority}: ${uri.path.replace(/^\//, "")}`;
}
