import * as vscode from "vscode";
import {
  describeRepoRef,
  describeRepoRefProblem,
  githubVfsLocation,
  parseGithubRepoRef,
  vscodeDevUrl,
  type GithubRepoRef,
} from "../core/githubRepoRef";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";
import { withProgress } from "../views/progress";

/**
 * ブラウザ版で、GitHubのリポジトリを作品の置き場として指す（設計書5.8.12）。
 *
 * **「取り寄せる」のではない。** 手元のVS Codeでは `git clone` でファイルを
 * 落としてくるが、ブラウザには落とす先も `git` も無い。代わりに、VS Codeが
 * GitHubの中身を直に読み書きする仕組み（`vscode-vfs://github/…`）を使う。
 * **作者から見た結果は同じ**——別のリポジトリにある作品を、いま開いている
 * 画面から登録できる。
 *
 * 以前はこの操作を丸ごと塞ぎ、「アドレス欄を書き換えてください」と案内して
 * いた。**それは行き止まりではないが、遠回りである**（別のリポジトリを開くと、
 * いま開いているものは閉じる）。ここでは開き直さずに登録まで進む。
 *
 * **登録するところまでは、このファイルの仕事ではない。** 場所を1つ決めて
 * 返すだけにして、そのあとは「フォルダから作品を追加」とまったく同じ道を
 * 通す（作品集なら中の作品を選ぶ、など）。入口ごとに違う振る舞いをさせない。
 */
export async function resolveGithubRepoFolder(): Promise<string | undefined> {
  const input = await askText({
    title: "GitHubのリポジトリを開く",
    prompt: "リポジトリを入力してください（URLを貼っても構いません）",
    placeHolder: "nonahisa/HisasNovels",
    ignoreFocusOut: true,
    validateInput: (value) => describeRepoRefProblem(value) ?? null,
  });
  if (!input) return undefined;

  const ref = parseGithubRepoRef(input);
  if (!ref) return undefined;

  const location = githubVfsLocation(ref);
  const readable = await withProgress(
    `${describeRepoRef(ref)} を読み込んでいます…`,
    () => canRead(location)
  );
  if (readable) return location;

  await offerAlternatives(ref);
  return undefined;
}

/**
 * その場所の中を、いま読めるか。
 *
 * **読めるかどうかは、試すまで分からない。** 非公開のリポジトリ、名前の
 * 打ち間違い、GitHubへのサインインが切れている——どれも同じ「読めない」に
 * なるが、こちらから区別する手立ては無い。だから**理由を当てにいかず、
 * 次に取れる手を並べる**（下の `offerAlternatives`）。
 */
async function canRead(location: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.readDirectory(vscode.Uri.parse(location));
    return true;
  } catch {
    return false;
  }
}

/**
 * 読めなかったときに、作者が次に取れる手を並べる。
 *
 * **「読めませんでした」で終わらせない。** 直に読めない場合でも、
 * そのリポジトリを新しいタブで開けば、そこから登録できる。
 */
async function offerAlternatives(ref: GithubRepoRef): Promise<void> {
  const name = describeRepoRef(ref);
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "$(link-external) 新しいタブで開く",
        detail: `${vscodeDevUrl(ref)} を開きます。開いたら「フォルダから作品を追加」で登録できます`,
        choice: "open" as const,
      },
      {
        label: "$(add) この画面に足してみる",
        detail:
          "いま開いているものに並べて追加します（VS Codeが読み込み直します）",
        choice: "workspace" as const,
      },
      cancelItem(),
    ],
    {
      title: `「${name}」の中を読めませんでした`,
      placeHolder:
        "名前の間違い・非公開・GitHubへのサインイン切れ、のいずれかです",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("choice" in picked)) return;

  if (picked.choice === "open") {
    await vscode.env.openExternal(vscode.Uri.parse(vscodeDevUrl(ref)));
    return;
  }

  await addToWorkspace(ref);
}

/**
 * いま開いているものへ並べて足す。
 *
 * **VS Codeは、この操作で拡張機能を読み込み直す**（フォルダーが1つの状態から
 * 複数の状態へ変わるため）。作業中のものが中断されるので、先に断る。
 *
 * 足せたかどうかは、`updateWorkspaceFolders` の戻り値では分からない
 * （受け付けたかを返すだけで、読み込めたかは別）。**足したあとは、
 * 作者にもう一度「フォルダから作品を追加」を押してもらう**のがいちばん確実で、
 * 説明も要らない。
 */
async function addToWorkspace(ref: GithubRepoRef): Promise<void> {
  const name = describeRepoRef(ref);
  const proceed = await vscode.window.showWarningMessage(
    `「${name}」をこの画面に足しますか？`,
    {
      modal: true,
      detail: [
        "VS Codeがいったん読み込み直します（書きかけのものは保存してください）。",
        "",
        "読み込みが終わったら、「フォルダから作品を追加」で登録できます。",
      ].join("\n"),
    },
    "足す"
  );
  if (proceed !== "足す") return;

  const folders = vscode.workspace.workspaceFolders ?? [];
  const accepted = vscode.workspace.updateWorkspaceFolders(
    folders.length,
    0,
    { uri: vscode.Uri.parse(githubVfsLocation(ref)), name: ref.repo }
  );
  if (!accepted) {
    await vscode.window.showErrorMessage(
      `「${name}」を足せませんでした。新しいタブで開く方法をお試しください（${vscodeDevUrl(
        ref
      )}）。`
    );
  }
}
