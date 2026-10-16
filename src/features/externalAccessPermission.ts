import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { ExternalAccessPermissionStore } from "../core/externalAccessPermissionStore";
import { cancelItem, isCancelItem } from "../views/dialogs";
import {
  ALL_TOOLS,
  FINDING_LIST_KEY,
  FINDING_PROPOSE_KEY,
  SEPARATE_READ_KEYS,
  clientKeyOf,
  clientPermissionOf,
  isSeparatelyGrantedKey,
  type ExternalClientPermission,
} from "../core/externalAccessPermission";
import { AI_INSTRUCTION_TARGETS } from "../core/aiInstructions";
import { FEATURE_LABELS, type FeatureName } from "../core/mcpFeatures";

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
 * 相談ログ・ログ・編集履歴を読ませると何が出るか（作者の裁定 2026-10-16 の6）。
 *
 * **「全部の道具」の許可に含まれないことを、許す前に言う。** 含まれると思って
 * いる作者は、どこで許すのかを探すことになる。
 */
const WHAT_SEPARATE_KEYS_MEAN =
  "相談ログ・ログ・編集履歴は、「全部の道具」を許可していても読めません" +
  "（作者が1つずつ許可します）。\n\n" +
  "・相談ログ：相談パネルなどでの質問・返事・渡した場面の冒頭が出ます\n" +
  "・ログ：動作の記録です。AIの返事の断片（本文の一部）が入ることがあります\n" +
  "・編集履歴：作者と編集部の操作の記録（直した中身を含む）が出ます\n" +
  "・どれも読むだけで、書き換えません。いつでも取り消せます";

/**
 * ノックされた道具を、その場で許すか決める（設計書6.87.14）。
 *
 * **作者の指示（2026-09-16）**：「MCP承認を検知した場合は、拡張機能の
 * 画面上にポップアップさせてください」。
 *
 * **1件ずつ決める形にした。** 機能を最初に並べて選ばせるより、
 * **使われたものが来たときに1つ許す**ほうが、作者は何を許したのかを
 * 分かったまま進められる。
 *
 * **許すのは「鍵」であって、道具の名前ではない**（0.66.7）。道具は
 * `novel.run` の1本に束ねられたので、名前で許すと16の機能が全部通る。
 *
 * @returns 何か決めたか（画面を更新するかの判断に使う）
 */
export async function askAboutKnock(
  work: WorkEntry,
  knock: { client: string; tool: string; key: string; at: string }
): Promise<boolean> {
  const who = clientKeyOf(knock.client);
  const what = describeAccessKey(knock.key);
  /*
    **名指しの鍵（相談ログ・ログ・編集履歴）には「全部を許可」を出さない。**
    「全部」はそれらを覆わない（作者の裁定 2026-10-16）ので、押しても通らず、
    作者には「許したのに読めない」と見える。中身が何かを detail に足す。
  */
  if (isSeparatelyGrantedKey(knock.key)) {
    const allow = "この道具だけ許可";
    const separate = await vscode.window.showWarningMessage(
      `外部AI（${who}）が「${work.title}」で「${what}」を使おうとしました。`,
      {
        modal: true,
        detail:
          `断りました（許可がないためです）。\n\n${ABOUT_CLIENT_NAME}\n\n` +
          `${WHAT_SEPARATE_KEYS_MEAN}\n\n` +
          "「この道具だけ許可」を選ぶと、この相手のこの読み方だけが通るようになります（ほかの2つは別に許可が要ります）。",
      },
      allow
    );
    if (separate !== allow) return false;
    await new ExternalAccessPermissionStore(work).allowTool(knock.client, knock.key);
    void offerReview(work, `${who} の「${what}」を許可しました。`);
    return true;
  }
  const answer = await vscode.window.showWarningMessage(
    `外部AI（${who}）が「${work.title}」で「${what}」を使おうとしました。`,
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
  /*
    **許可したあとの知らせは待たない**（`void`。2026-09-24）。ボタン付きの
    知らせは、作者が閉じるまで返事を返さない——右下から消えても通知の
    一覧に残り、待ち続ける。ここで待つと、呼び出し側（見張り）が「見た」を
    覚えるのがその先になり、**放っておいた窓では覚えが書かれないまま、
    別の窓が同じノックを出し直した**。答えはモーダルで出ているので、
    ここで返してよい。
  */
  if (answer === "この道具だけ許可") {
    await store.allowTool(knock.client, knock.key);
    void offerReview(
      work,
      `${who} の「${what}」を許可しました。ほかの道具はまだ拒否のままです。`
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
  void offerReview(work, `${who} に全部の道具を許可しました。`);
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

      **ただし「待っていれば来る」のは、指示書を置いた作品だけである**
      （作者が詰まった。2026-09-20）。指示書と MCP の登録が無ければ
      外部AIは道具に繋がらないので、**お尋ねする機会そのものが永遠に
      来ない**——「先に決めておく必要はありません」だけを出すと、
      作者はここで行き止まる。
    */
    if (await hasAiInstructions(work)) {
      await vscode.window.showInformationMessage(
        `「${work.title}」は、外部AI（MCP）の利用をまだ誰にも許可していません（既定は拒否です）。`,
        {
          modal: true,
          detail:
            "許可は、外部AIが実際に使おうとしたときに画面でお尋ねします" +
            "（そのとき「この道具だけ許可」を選べます）。\n\n" +
            "先に決めておく必要はありません。" + legacyNote(permission.legacy),
        }
      );
      return;
    }

    /*
      **出口をその場に出す**（`offerReview` と同じ考え方）。「指示書を
      置いてください」と文章で書いても、**どこから置くのかを探すのは作者**
      である。押せるものとして出せば、探さなくてよい。
    */
    const write = "AI用の指示書を置く";
    const answer = await vscode.window.showInformationMessage(
      `「${work.title}」には、まだAI用の指示書を置いていません。`,
      {
        modal: true,
        detail:
          "指示書と MCP の登録が無いと、外部AIはこの拡張機能の道具に" +
          "繋がらないので、お尋ねする機会そのものが来ません。\n\n" +
          "指示書を置くと、外部AIが道具を使おうとしたときに、" +
          "この画面で1件ずつ許可を決められるようになります（既定は拒否のままです）。" +
          legacyNote(permission.legacy),
      },
      write,
      "あとで"
    );
    if (answer === write) {
      // コマンド経由で呼ぶ（`features` → `extension.ts` の逆流を作らないため）
      const ref: PermissionWorkRef = { type: "work", work };
      await vscode.commands.executeCommand("novelai.writeAiInstructions", ref);
    }
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

/**
 * コマンドへ「この作品で」と伝える最小の形（`extension.ts` の `WorkRef`）。
 *
 * **`extension.ts` から型を借りない**（`features` → `extension.ts` の
 * 逆流になる）。`features/finishNewWork.ts` と同じ作法。
 */
interface PermissionWorkRef {
  readonly type: "work";
  readonly work: WorkEntry;
}

/**
 * この作品に、AI用の指示書が1つでも置かれているか（設計書6.87.15 柱5）。
 *
 * **1つでもあれば「置いてある」と見る。** 相手は複数選べるので、
 * どれが置かれているかは作者の選び方次第である——ここで問うているのは
 * 「**外部AIがノックしに来る道があるか**」だけなので、1つで足りる。
 *
 * 置き先の表は `core/aiInstructions.ts` に1つだけある。写しを持つと、
 * 置き先を足したときに片方だけ直す日が来る。
 */
async function hasAiInstructions(work: WorkEntry): Promise<boolean> {
  for (const target of AI_INSTRUCTION_TARGETS) {
    const file = path.join(work.folderPath, target.instructionPath);
    try {
      await vscode.workspace.fs.stat(path.toUri(file));
      return true;
    } catch {
      // 無いだけ。ほかの置き先を見る
    }
  }
  return false;
}

/** 古い形の許可が残っているときの断り（どちらの文面でも同じことを言う） */
function legacyNote(legacy: boolean): string {
  return legacy
    ? "\n\nこの作品には古い形の許可が残っていますが、いまの版では使っていません。接続元ごとに決め直してください。"
    : "";
}

/**
 * 許可の鍵を、作者が読める呼び名にする（0.66.7）。
 *
 * **`typo` だけでは、作者は何を許すのか分からない。** 表は
 * `core/mcpFeatures.ts` に1つだけ置いてある（MCP側の断り文句も同じ表を見る）。
 * 0.66.6 までの古い名前（`typo.run`）は表に無いので、そのまま出す。
 */
function describeAccessKey(key: string): string {
  // 指摘を置く鍵（2026-10-01）。鍵の文字だけでは何を許すのか読めない
  if (key === FINDING_PROPOSE_KEY) return `指摘を提案パネルへ置くこと（${key}）`;
  if (key === FINDING_LIST_KEY) return `提案パネルの指摘を読むこと（${key}）`;
  const separate = isSeparatelyGrantedKey(key) ? SEPARATE_READ_KEYS[key] : undefined;
  if (separate) return `${separate}（${key}）`;
  if (key === ALL_TOOLS) return "全部の道具（相談ログ・ログ・編集履歴は含みません）";
  const label = FEATURE_LABELS[key as FeatureName];
  return label ? `${label}（${key}）` : key;
}

function describeScope(client: ExternalClientPermission): string {
  // 名指しの鍵は「全部」に数えないので、別に数えて添える
  const separate = client.tools.filter(isSeparatelyGrantedKey).length;
  const ordinary = client.tools.filter((tool) => !isSeparatelyGrantedKey(tool));
  const scope = ordinary.includes(ALL_TOOLS)
    ? "全部の道具"
    : `${ordinary.length}個の道具`;
  const logs = separate > 0 ? `・相談ログ等${separate}つ` : "";
  return client.sampling ? `${scope}${logs}・考えさせることも許可` : `${scope}${logs}`;
}

async function editClient(
  work: WorkEntry,
  store: ExternalAccessPermissionStore,
  client: ExternalClientPermission
): Promise<void> {
  const actions: string[] = [];
  // 「全部」を許していても、名指しの鍵があれば1つずつ取り消せるようにする
  if (
    client.tools.length > 0 &&
    (!client.tools.includes(ALL_TOOLS) || client.tools.some(isSeparatelyGrantedKey))
  ) {
    actions.push("道具を1つ取り消す");
  }
  /*
    **相談ログ・ログ・編集履歴はここで選べる**（作者の裁定 2026-10-16 の6）。
    ノックを待たずに先に許せる口を置く——「全部」を許した接続元はノックの後に
    探しに来るので、ここに無いと許す場所が見つからない。
  */
  actions.push(SEPARATE_KEYS_ACTION);
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

  if (answer.label === SEPARATE_KEYS_ACTION) {
    await chooseSeparateKeys(store, client);
    return;
  }

  if (answer.label === "道具を1つ取り消す") {
    const tool = await vscode.window.showQuickPick(
      [
        // **取り消す値は印に書かれているものそのまま。** 見出しだけ日本語にする
        ...[...client.tools]
          .sort()
          .map((key) => ({ label: key, description: describeAccessKey(key) })),
        cancelItem(),
      ],
      {
        title: `${client.name} に許可している道具`,
        placeHolder: "取り消す道具を選んでください",
      }
    );
    if (!tool || isCancelItem(tool)) return;
    await store.revokeTool(client.name, tool.label);
    /*
      **残った名指しの許可を言う。** 「全部」を取り消しても相談ログ等の許可は残る
      （別々に決めたもの）ので、言わないと「全部取り消したのに読める」に見える
    */
    const remaining =
      clientPermissionOf(await store.load(), client.name)?.tools.filter(isSeparatelyGrantedKey) ?? [];
    void vscode.window.showInformationMessage(
      `${client.name} の「${tool.label}」を取り消しました。` +
        (remaining.length > 0
          ? `名指しで許した「${remaining.map((key) => SEPARATE_READ_KEYS[key]).join("・")}」は残っています。`
          : "")
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

/** 許可の画面の項目名（相談ログ・ログ・編集履歴を選ぶ） */
const SEPARATE_KEYS_ACTION = "相談ログ・ログ・編集履歴を読ませる／やめる";

/**
 * 相談ログ・ログ・編集履歴を、1つずつ許す／やめる（作者の裁定 2026-10-16 の6）。
 *
 * **いま許しているものに印を付けた複数選択**で出す。選んだものが許可、外したものが
 * 取り消しになる。許すときは中身（何が外へ出るか）を先に見せてから確かめる。
 */
async function chooseSeparateKeys(
  store: ExternalAccessPermissionStore,
  client: ExternalClientPermission
): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    Object.entries(SEPARATE_READ_KEYS).map(([key, label]) => ({
      label,
      description: key,
      picked: client.tools.includes(key),
      key,
    })),
    {
      title: `${client.name} に読ませるもの（全部の道具の許可には含まれません）`,
      placeHolder: "読ませるものに印を付けてください（外すと取り消します）",
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );
  if (!picked) return;
  const wanted = new Set(picked.map((item) => item.key));
  const adding = Object.keys(SEPARATE_READ_KEYS).filter(
    (key) => wanted.has(key) && !client.tools.includes(key)
  );
  const removing = Object.keys(SEPARATE_READ_KEYS).filter(
    (key) => !wanted.has(key) && client.tools.includes(key)
  );
  if (adding.length === 0 && removing.length === 0) return;

  if (adding.length > 0) {
    const sure = await vscode.window.showWarningMessage(
      `${client.name} に、${adding.map((key) => SEPARATE_READ_KEYS[key]).join("・")}ことを許可しますか。`,
      { modal: true, detail: `${ABOUT_CLIENT_NAME}\n\n${WHAT_SEPARATE_KEYS_MEAN}` },
      "許可する"
    );
    if (sure !== "許可する") return;
  }
  for (const key of adding) await store.allowTool(client.name, key);
  for (const key of removing) await store.revokeTool(client.name, key);
  void vscode.window.showInformationMessage(
    [
      adding.length > 0 ? `許可：${adding.map((key) => SEPARATE_READ_KEYS[key]).join("・")}` : "",
      removing.length > 0 ? `取り消し：${removing.map((key) => SEPARATE_READ_KEYS[key]).join("・")}` : "",
    ]
      .filter(Boolean)
      .join("／")
  );
}
