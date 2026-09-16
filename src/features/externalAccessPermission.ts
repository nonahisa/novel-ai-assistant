import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { ExternalAccessPermissionStore } from "../core/externalAccessPermissionStore";
import { cancelItem, isCancelItem } from "../views/dialogs";
import {
  ALL_TOOLS,
  clientKeyOf,
  type ExternalClientPermission,
} from "../core/externalAccessPermission";

/**
 * 外部AI（MCP）の利用を許可する／取り消す（設計書6.87.10、6.87.14）。
 *
 * **既定は拒否。** 拡張機能を入れただけ・MCPサーバーを登録しただけでは、
 * 外部AIは原稿を1文字も読めない。ここが**意思確認の唯一の入口**である。
 *
 * **許可しても全開放にしない**（作者の指示、2026-09-16）。許すのは
 * 「**この接続元が、この道具を**」であって、「この作品を外部AIに」ではない。
 *
 * **許可の前に、何が起きるかを全部見せる。** 「許可しますか」だけを問うと、
 * 作者は何を許したのか分からないまま押すことになる。
 */

/**
 * 許可したときに何ができるようになるか。
 *
 * **できることとできないことを、両方書く。** 片方だけだと、作者は
 * 「原稿を勝手に書き換えられるのでは」と読むか、逆に「読まれるだけなら
 * 安全だ」と読む。どちらも正しくない。
 */
const WHAT_HAPPENS =
  "許可すると、この作品の本文・設定資料・プロットを、その外部AIが" +
  "MCPサーバー経由で読めるようになります。\n\n" +
  "・読むだけで、原稿も設定資料も書き換えません\n" +
  "・読まれた記録は残り、編集履歴の画面で見られます\n" +
  "・手元の Ollama で処理する分には、原稿はこの機械から出ません\n" +
  "・外部AI自身に読ませる使い方では、本文がその会社のサーバーへ渡ります\n" +
  "・許可はこの機械だけに効きます（同期しません）。いつでも取り消せます";

/**
 * 接続元の名乗りについての断り。**鍵だと思わせない。**
 *
 * 名乗りは MCP の `initialize` で相手が申告するもので、偽れる。
 * それでも区別する値打ちはあるが、**そこを隠すと作者の判断が狂う。**
 */
const ABOUT_CLIENT_NAME =
  "接続元の名前は、つないできた相手が自分で名乗ったものです" +
  "（身元の証明ではありません）。";

/**
 * 考えさせること（sampling）を許すと何が起きるか（設計書6.87.12）。
 *
 * **作者の指示（2026-09-16）**：「ここでも、初期は閉鎖で解放するときは
 * 外部に情報を出す旨警告を表示させてください」。
 *
 * **読ませることとの違いを、はっきり書く。** 読ませるだけなら本文は
 * 呼び出し元まで。考えさせると、**呼び出し元が選んだAIへ渡る**——
 * どのAIかを、この拡張機能は選べないし、知ることもできない。
 */
const WHAT_SAMPLING_MEANS =
  "「考えさせる」を許可すると、外部AIがこの作品の本文を" +
  "そのAIが選んだ別のAIへ渡して、代わりに考えさせられるようになります。\n\n" +
  "・渡す先をこちらでは選べません（呼び出し元が決めます）\n" +
  "・どこへ渡ったかは、答えたモデル名しか分かりません\n" +
  "・道具の許可とは別です。許可しなくても、道具は使えます\n" +
  "・渡した記録は残ります（編集履歴の画面）\n" +
  "・いつでも取り消せます";

/**
 * ノックされた道具を、その場で許すか決める（設計書6.87.14）。
 *
 * **作者の指示（2026-09-16）**：「MCP承認を検知した場合は、拡張機能の
 * 画面上にポップアップさせてください」。
 *
 * **1件ずつ決める形にした。** 54本を最初に並べて選ばせるより、
 * **使われた道具が来たときに1つ許す**ほうが、作者は何を許したのかを
 * 分かったまま進められる。
 *
 * @returns 何か決めたか（画面を更新するかの判断に使う）
 */
export async function askAboutKnock(
  work: WorkEntry,
  knock: { client: string; tool: string; at: string }
): Promise<boolean> {
  const who = clientKeyOf(knock.client);
  const answer = await vscode.window.showWarningMessage(
    `外部AI（${who}）が「${work.title}」で「${knock.tool}」を使おうとしました。`,
    {
      modal: true,
      detail:
        `断りました（許可がないためです）。\n\n${ABOUT_CLIENT_NAME}\n\n` +
        `${WHAT_HAPPENS}\n\n` +
        "「この道具だけ許可」を選ぶと、この相手のこの道具だけが通るようになります。" +
        "ほかの道具は、使われたときにまた確認します。",
    },
    "この道具だけ許可",
    `${who} に全部の道具を許可`
  );
  if (!answer) return false;

  const store = new ExternalAccessPermissionStore(work);
  if (answer === "この道具だけ許可") {
    await store.allowTool(knock.client, knock.tool);
    await offerReview(
      work,
      `${who} の「${knock.tool}」を許可しました。ほかの道具はまだ拒否のままです。`
    );
    return true;
  }

  /*
    **全部を許すときは、もう一度だけ確かめる。** ここだけは「これから
    増える道具まで含めて許す」ことになるので、**押し間違いで通してしまう
    形にしない。**
  */
  const sure = await vscode.window.showWarningMessage(
    `${who} に、この作品の全部の道具を許可しますか。`,
    {
      modal: true,
      detail:
        "これから足される道具も含めて、この相手には確認せずに通るようになります。\n\n" +
        `${ABOUT_CLIENT_NAME}\n\nいつでも取り消せます。`,
    },
    "全部許可する"
  );
  if (sure !== "全部許可する") return false;
  await store.allowTool(knock.client, ALL_TOOLS);
  await offerReview(work, `${who} に全部の道具を許可しました。`);
  return true;
}

/**
 * 許可したことを知らせ、**その場で見直せるようにする**。
 *
 * **作者の実機確認（2026-09-16）**：「どこに表示されるかわからなかった」。
 * 「詳細メニューの◯◯から取り消せます」と文章で書いても、**探すのは作者**
 * である。押せるものとして出せば、探さなくてよい（views/dialogs.ts の
 * 「Escでも閉じられるが、出口は見せる」と同じ考え）。
 */
async function offerReview(work: WorkEntry, message: string): Promise<void> {
  const next = await vscode.window.showInformationMessage(
    message,
    "いまの許可を見る"
  );
  if (next === "いまの許可を見る") {
    await toggleExternalAccessPermission(work);
  }
}

/**
 * いまの許可を見て、足したり取り消したりする。
 *
 * **一覧から入る。** 「許可しますか／取り消しますか」の2択にすると、
 * 接続元ごと・道具ごとの状態が見えないまま決めることになる。
 */
export async function toggleExternalAccessPermission(
  work: WorkEntry
): Promise<void> {
  const store = new ExternalAccessPermissionStore(work);
  const permission = await store.load();

  if (permission.clients.length === 0) {
    /*
      **まだ誰にも許していないときは、ここから許可を作らない。**
      どの相手が来るのかも、どの道具を使うのかも、まだ分からない
      ——**ノックされたときに決める**のがいちばん確かである。
    */
    await vscode.window.showInformationMessage(
      `「${work.title}」は、外部AI（MCP）の利用をまだ誰にも許可していません（既定は拒否です）。`,
      {
        modal: true,
        detail:
          "許可は、外部AIが実際に使おうとしたときに画面でお尋ねします" +
          "（そのとき「この道具だけ許可」を選べます）。\n\n" +
          "先に決めておく必要はありません。" +
          (permission.legacy
            ? "\n\nこの作品には古い形の許可が残っていますが、いまの版では使っていません。接続元ごとに決め直してください。"
            : ""),
      }
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    [
      ...permission.clients.map((client) => ({
        label: client.name,
        description: describeScope(client),
        detail: client.decidedAt
          ? `${client.decidedAt.slice(0, 10)} に ${client.decidedOn || "この機械"} で決めました`
          : undefined,
        client,
      })),
      cancelItem(),
    ],
    {
      title: `「${work.title}」で許可している接続元`,
      placeHolder: "決め直す接続元を選んでください",
    }
  );
  if (!picked || isCancelItem(picked) || !("client" in picked)) return;
  await editClient(work, store, picked.client);
}

function describeScope(client: ExternalClientPermission): string {
  const scope = client.tools.includes(ALL_TOOLS)
    ? "全部の道具"
    : `${client.tools.length}個の道具`;
  return client.sampling ? `${scope}・考えさせることも許可` : scope;
}

async function editClient(
  work: WorkEntry,
  store: ExternalAccessPermissionStore,
  client: ExternalClientPermission
): Promise<void> {
  const actions: string[] = [];
  if (!client.tools.includes(ALL_TOOLS) && client.tools.length > 0) {
    actions.push("道具を1つ取り消す");
  }
  actions.push(
    client.sampling ? "考えさせるのをやめる" : "考えさせることも許可する"
  );
  actions.push("この接続元を取り消す");

  const answer = await vscode.window.showQuickPick(
    [...actions.map((label) => ({ label })), cancelItem()],
    {
      title: `${client.name}（${describeScope(client)}）`,
      placeHolder: "どうしますか",
    }
  );
  if (!answer || isCancelItem(answer)) return;

  if (answer.label === "道具を1つ取り消す") {
    const tool = await vscode.window.showQuickPick(
      [
        ...[...client.tools].sort().map((label) => ({ label })),
        cancelItem(),
      ],
      {
        title: `${client.name} に許可している道具`,
        placeHolder: "取り消す道具を選んでください",
      }
    );
    if (!tool || isCancelItem(tool)) return;
    await store.revokeTool(client.name, tool.label);
    void vscode.window.showInformationMessage(
      `${client.name} の「${tool.label}」を取り消しました。`
    );
    return;
  }

  if (answer.label === "考えさせることも許可する") {
    /*
      **ここでも警告を出す**（作者の指示、2026-09-16）。道具を許すことと、
      本文を呼び出し元の選んだAIへ渡すことは、危ないところが違う。
    */
    const sure = await vscode.window.showWarningMessage(
      `${client.name} に、この作品で考えさせること（sampling）を許可しますか。`,
      { modal: true, detail: WHAT_SAMPLING_MEANS },
      "許可する"
    );
    if (sure !== "許可する") return;
    await store.setSampling(client.name, true);
    void vscode.window.showInformationMessage(
      `${client.name} に考えさせることを許可しました。本文は呼び出し元が選んだAIへ渡ります。`
    );
    return;
  }

  if (answer.label === "考えさせるのをやめる") {
    await store.setSampling(client.name, false);
    void vscode.window.showInformationMessage(
      `${client.name} に考えさせるのをやめました。道具の許可はそのままです。`
    );
    return;
  }

  await store.revokeClient(client.name);
  void vscode.window.showInformationMessage(
    `${client.name} の許可を全部取り消しました。`
  );
}
