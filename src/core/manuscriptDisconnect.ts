/**
 * つながりの切れた原稿エディターを見つける（作者の裁定、2026-10-02
 * 「起動し直したら、開いていた原稿エディターを開き直す」。設計書6.25.9）。
 *
 * **なぜ要るか。** VS Code は拡張機能ホストだけを起動し直したとき（Marketplace の
 * 自動更新・「開発者: 拡張機能ホストを再起動」）、既に開いている原稿エディターの
 * 画面を新しい拡張機能へつなぎ直さない（`resolveCustomTextEditor` は1つの画面に
 * 1回しか呼ばれない）。画面は生きたまま受け手を失い、打った字が文書へ届かない
 * （2026-10-01 ノートPC・2026-10-02 机のPC）。新しい拡張機能から見えるのは
 * タブの一覧だけなので、「タブはあるのに、つながりに来ない」ことで見分ける。
 *
 * **誤って出さないための決まり**（ふつうにウィンドウを開いたときは何も出さない）：
 *
 * - **前に出ているタブだけを見る。** VS Code は背景のカスタムエディターを、前に
 *   出すまで作らない（つながりに来ない）。背景のタブを数えると、ふつうに開いた
 *   ウィンドウでも「切れた」と見てしまう。背景に回っている切れた画面は、作者が
 *   前に出したときにタブの知らせが来るので、そこで同じ判定にかける
 * - **猶予を置いて2回見る。** 1回目に「前に出ていて、つながっていない」タブを
 *   控え、猶予のあとにもう一度見て、両方で当てはまるものだけを切れたと見る。
 *   ふつうに開いたときのつながりの遅れは、VS Code が画面を拡張機能へ渡すまでの
 *   間だけ（つながったことは `resolveCustomTextEditor` の先頭、最初の await より
 *   前で記録する）なので、10秒あれば覆える
 * - **一度知らせた原稿は繰り返さない。**
 *
 * ここは判定だけを持つ（VS Code にも Node にも依存しない）。
 */

/**
 * 1回目と2回目のあいだの猶予（ミリ秒）。
 *
 * 起動した直後はほかの拡張機能の立ち上げと競り、VS Code が画面を渡すのが
 * 遅れることがある。短くすると、ふつうに開いたときに誤って知らせる。長くても
 * 失うのは知らせが出るまでの時間だけ（画面の赤字は4秒で別に出る。6.25.9）。
 */
export const MANUSCRIPT_RESOLVE_GRACE_MS = 10_000;

/** 原稿エディターのタブ1つ（鍵は `manuscriptLedgerKey` で作ったもの） */
export interface ManuscriptTabLook {
  key: string;
  /** そのグループで前に出ているか（`Tab.isActive`） */
  active: boolean;
}

/** 1回目に見る：前に出ていて、まだつながっていないタブの鍵（重なりは1つに） */
export function unresolvedActiveTabs(
  tabs: readonly ManuscriptTabLook[],
  resolved: ReadonlySet<string>
): string[] {
  const found: string[] = [];
  for (const tab of tabs) {
    if (!tab.active || resolved.has(tab.key) || found.includes(tab.key)) continue;
    found.push(tab.key);
  }
  return found;
}

/**
 * 猶予のあとにもう一度見る：1回目にも2回目にも「前に出ていて、つながって
 * いない」タブのうち、まだ知らせていないもの。
 */
export function confirmDisconnectedTabs(input: {
  earlier: readonly string[];
  tabs: readonly ManuscriptTabLook[];
  resolved: ReadonlySet<string>;
  warned: ReadonlySet<string>;
}): string[] {
  const now = unresolvedActiveTabs(input.tabs, input.resolved);
  return now.filter(
    (key) => input.earlier.includes(key) && !input.warned.has(key)
  );
}

/**
 * 原稿エディターの面がつながったとき、同じ原稿の面がほかにもあれば、その記録の1行
 * （設計書6.25.11）。無ければ undefined。
 *
 * **台帳の数とタブの数の両方で見る。** 拡張機能ホストを起動し直したあとは
 * 台帳が空なので、台帳だけを見ると、切れた面の隣に同じ原稿の面がつながっても
 * 1枚目と数えて何も残らない（2026-10-03 の実機。2枚目の行は、ウィンドウを
 * 再読み込みしたときに初めて出た）。タブは VS Code が覚えているので、
 * 起動し直したあとでも数えられる。
 *
 * @param ledgerFaces この面を載せる前に、台帳に載っていた同じ原稿の面の数
 * @param tabColumns 同じ原稿の原稿エディターのタブが居る列（この面のタブを含む）。
 *   タブを読めない環境では空
 */
export function sameManuscriptFaceNote(input: {
  ledgerFaces: number;
  tabColumns: readonly number[];
  viewType: string;
  column: number | undefined;
}): string | undefined {
  const where = `入口: ${input.viewType}／列: ${input.column ?? "不明"}`;
  if (input.ledgerFaces > 0) {
    return `原稿エディタ：同じ原稿の面がもう1枚開かれました（${input.ledgerFaces + 1}枚目。${where}）`;
  }
  if (input.tabColumns.length < 2) return undefined;
  const unconnected = input.tabColumns.length - 1;
  return (
    `原稿エディタ：同じ原稿のタブがほかにもあるところで、この面がつながりました` +
    `（タブ${input.tabColumns.length}枚／列: ${input.tabColumns.join("・")}。` +
    `この拡張機能とつながっていない面が${unconnected}枚。拡張機能ホストを起動し直したあとに起きます。${where}）`
  );
}
