import * as vscode from "vscode";
import { LmStudioProvider } from "../ai/lmstudioProvider";
import { AIRegistry, runSetupWizard } from "../ai/registry";
import {
  detectPackageManager,
  installPackage,
  shortenProgress,
} from "../core/packageInstall";
import { canRunProcesses } from "../core/runtime";
import { logStep } from "../core/logger";
import { askText } from "../views/dialogs";
import { withCancellableProgress, withProgress } from "../views/progress";

/**
 * LM Studioを使える状態にするまでの案内（設計書6.16・6.24）。
 *
 * 作者の依頼（2026-08-27）：「LM Studioのセットアップを作成してください」。
 *
 * ## なぜ要るか
 *
 * LM Studioは**鍵も課金も要らない手元のAI**で、この拡張機能で使える6つの
 * うち**いちばん確かめやすい**。それなのに導入の案内が無く、Ollamaだけが
 * `setupOllama.ts` を持っていた。**足りないものを1つずつ、順に案内する**
 * という組み立てはOllamaと同じにしてある。
 *
 * ## Ollamaと決定的に違うところ——こちらからは起動できない
 *
 * Ollamaは実行ファイルを持つので拡張機能から起こせるが、**LM StudioはGUIの
 * アプリで、サーバーの開始もモデルの読み込みも画面の操作でしか行えない。**
 * 自動化できるふりをしない。**案内して、作者が操作したあとに確かめ直す**
 * （「もう一度確かめる」で①へ戻る輪）。
 *
 * ## モデル名を薦めない
 *
 * LM Studioの中の検索で取れるモデルは入れ替わりが早い。**特定の名前を
 * 決め打ちすると、案内した時点で実態とずれる**（この作品で繰り返した失敗）。
 * 「日本語が扱える指示追従モデル」という言い方までにとどめる。
 */

/** winget の配布ID。この機械の `winget search` で確認した（2026-08-27） */
const WINGET_ID = "ElementLabs.LMStudio";

/** 配布ページ。wingetが無い環境（Mac / Linux）でも、ここから入れられる */
const DOWNLOAD_PAGE = "https://lmstudio.ai/";

export async function setupLmStudio(registry: AIRegistry): Promise<void> {
  const provider = new LmStudioProvider();

  // **一度案内したら、次からは導入の勧めを出さない。** 輪を回っている
  // ということは作者が「もう一度確かめる」を押したということで、
  // 入れ直しではなく起動の手順を知りたい場面である
  let offeredInstall = false;

  for (;;) {
    // ① 接続確認
    const connection = await withProgress("LM Studioを探しています…", () =>
      provider.testConnection()
    );

    if (!connection.ok) {
      if (!offeredInstall) {
        offeredInstall = true;
        // ② 入っていないのか、起動していないだけなのかは**こちらからは
        // 見分けられない**（LM Studioは実行ファイルの場所が決まっていない）。
        // 両方の道を並べて、作者に選んでもらう
        if (!(await offerInstall())) return;
      }
      // ③ 起動・サーバー開始・モデル読み込みの案内
      if (!(await guideStartServer())) return;
      continue;
    }

    // ④ 繋がったが、モデルが読み込まれていない
    if ((connection.modelCount ?? 0) === 0) {
      if (!(await guideLoadModel())) return;
      continue;
    }

    // ⑤ コンテキスト長を合わせる
    await askContextWindow(provider);

    // ⑥ 使うAIとして選ぶ
    const action = await vscode.window.showInformationMessage(
      `${connection.message} このままLM Studioを使う設定にしますか？`,
      "設定する",
      "あとで"
    );
    if (action === "設定する") {
      await runSetupWizard(registry);
    }
    return;
  }
}

/**
 * 入れる道を案内する。続けてよければ true。
 *
 * **wingetが無い環境でも行き止まりにしない**（Mac / Linux、あるいは
 * wingetを持たないWindows）。配布ページを開く道は必ず残す。
 */
async function offerInstall(): Promise<boolean> {
  const install = "wingetで入れる";
  const open = "配布ページを開く";

  const choices: string[] = [];
  // 外部プロセスを起動できるときだけ勧める。押しても必ず失敗する
  // 選択肢を出さない（設計書5.8.5と同じ考え方）
  if (canRunProcesses() && (await detectPackageManager()) === "winget") {
    choices.push(install);
  }
  choices.push(open, "閉じる");

  const action = await vscode.window.showInformationMessage(
    "LM Studioに接続できませんでした。" +
      "まだ入れていなければ入れてください。" +
      "すでに入っている場合は、このあとの案内どおりに起動してください。",
    ...choices
  );

  if (action === install) {
    logStep(`セットアップ: ${WINGET_ID} を導入`);
    const outcome = await withCancellableProgress(
      "LM Studioを入れています",
      async (progress, token) =>
        installPackage(WINGET_ID, {
          onLine: (line) => {
            if (token.isCancellationRequested) return;
            progress.report({ message: shortenProgress(line) });
          },
        })
    );
    if (outcome.kind === "failed") {
      vscode.window.showErrorMessage(
        `LM Studioの導入に失敗しました。${outcome.detail}`
      );
      return false;
    }
    if (outcome.kind === "cancelled") return false;
    if (outcome.kind === "already") {
      vscode.window.showInformationMessage("LM Studioはすでに入っています。");
    }
    // **入れ終わっても、まだ繋がらない。** 起動とサーバーの開始が要る。
    // ここで終わると「入れたのに動かない」に見えるので、案内へ続ける
    return true;
  }

  if (action === open) {
    await vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_PAGE));
    return true;
  }

  return false;
}

/**
 * 起動とサーバー開始の案内。「もう一度確かめる」を押されたら true。
 *
 * **文言は `lmstudioProvider.ts` の `testConnection` と揃える。**
 * 接続に失敗したときの案内と、ここの手順が食い違うと、作者はどちらを
 * 信じればよいのか分からなくなる。
 */
async function guideStartServer(): Promise<boolean> {
  const retry = "もう一度確かめる";
  const action = await vscode.window.showInformationMessage(
    "LM Studioを起動し、左の「Developer」からローカルサーバーを開始してください。" +
      "そのうえで、使いたいモデルを読み込みます。" +
      "できたら「もう一度確かめる」を押してください。",
    retry,
    "閉じる"
  );
  return action === retry;
}

/**
 * モデルを読み込む案内。「もう一度確かめる」を押されたら true。
 *
 * **モデル名は書かない。** LM Studioの中の検索で取れるものは入れ替わりが
 * 早く、名前を決め打ちすると案内した時点で古くなる。
 */
async function guideLoadModel(): Promise<boolean> {
  const retry = "もう一度確かめる";
  const action = await vscode.window.showInformationMessage(
    "LM Studioには接続できましたが、モデルが読み込まれていません。" +
      "LM Studioの検索から、日本語が扱える指示追従モデルを取得して読み込んでください。" +
      "できたら「もう一度確かめる」を押してください。",
    retry,
    "閉じる"
  );
  return action === retry;
}

/**
 * コンテキスト長を、LM Studio側の設定に合わせてもらう。
 *
 * **読み込んだ長さが取れたら、それを初期値にする**（`lmstudioProvider.ts` の
 * 冒頭を参照）。作者に手で写させると、写し間違いと写し忘れが起きる。
 * 実際より大きい値が入っていると、**入力が黙って切り捨てられる**——
 * エラーにならないので、「AIが本文の後半を読んでいない」という形でしか
 * 現れない。
 *
 * 取れないとき（口の無い古い版）は、これまでどおり現在の設定値を初期値にし、
 * LM Studioの画面と同じ値にしてもらう。
 *
 * **強制しない。** Escで飛ばせる。あとから設定画面でも直せる値である。
 */
async function askContextWindow(provider: LmStudioProvider): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("novelai");
  const current = configuration.get<number>("lmstudio.contextWindow", 8192);
  const detected = await provider.readLoadedContextWindow();

  const input = await askText({
    title: "LM Studioのコンテキスト長",
    prompt:
      detected === undefined
        ? "LM Studioでモデルを読み込んだときの Context Length と同じ値にしてください。" +
          "実際より大きいと、入力が黙って切り捨てられます。"
        : "LM Studioから読み取った値です。通常はこのままでかまいません。",
    value: String(detected ?? current),
    validateInput: (value) => {
      const text = value.trim();
      if (text.length === 0) return "数字を入力してください";
      if (!/^[0-9]+$/.test(text)) return "半角の数字だけで入力してください";
      if (Number(text) <= 0) return "1以上の数を入力してください";
      return null;
    },
  });
  if (input === undefined) return;

  const value = Number(input.trim());
  if (!Number.isFinite(value) || value <= 0) return;
  if (value === current) return;

  // 作品ごとではなく、この機械全体の設定にする。LM Studioの読み込み方は
  // 作品ではなく機械の側の事情で決まる
  await configuration.update("lmstudio.contextWindow", value, true);
  vscode.window.showInformationMessage(
    `コンテキスト長を ${value} にしました。`
  );
}
