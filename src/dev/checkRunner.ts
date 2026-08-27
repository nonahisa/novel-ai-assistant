import * as vscode from "vscode";
import * as paths from "../core/paths";
import { PENDING_CHECKS, type PendingCheckSection } from "../views/pendingChecks";
import { PENDING_CHECK_ITEMS } from "./pendingCheckItems";
import { cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 実機確認リストを、速く回すための道具（作者の依頼、2026-08-26）。
 *
 * **配布物には入らない。** `esbuild.js` が本番ビルドで `__DEV_HELPERS__` を
 * `false` に畳むので、このファイルは束に入らない（`npm run verify:vsix` が見張る）。
 *
 * ## これまでの手間
 *
 * 1. `docs/実機確認リスト.md` を開いて項目を読む
 * 2. その機能を操作メニューから探す
 * 3. 試す
 * 4. 文書へ戻って `[ ]` を `[x]` にする
 *
 * **300件を1件ずつこれで回すのは現実的でない。** 2と4を無くす。
 *
 * ## この道具でやること
 *
 * - 節を選ぶ → **その機能をその場で実行できる**（探さない。節一覧の▶からも飛べる）
 * - 通った項目に印を付ける → **文書へ書き戻す**（開き直さない）
 *
 * ## 項目の文章は、この道具だけが持つ
 *
 * 確認リストの項目には、作者の作品名のような**外へ出すつもりのない言葉**が入る。
 * 配布物に入るほう（`views/pendingChecks.ts`）は件数だけにして、
 * **文章は `pendingCheckItems.ts`（この道具と一緒に落ちる）**に置いた。
 *
 * ## 判断は作者がする
 *
 * 「通ったか」を機械が決めることはできない。**印を付けるのは作者**である。
 * ここが自動で進むと、確かめていないものが済んだことになる。
 */

/** 確認リストの場所。**拡張機能のフォルダーから引く**（開いている作品とは無関係） */
const CHECKLIST = "docs/実機確認リスト.md";

export function registerCheckRunner(
  context: vscode.ExtensionContext
): vscode.Disposable {
  return vscode.commands.registerCommand("novelai.runChecks", async () => {
    await runChecks(context);
  });
}

async function runChecks(context: vscode.ExtensionContext): Promise<void> {
  const chosen = await pickSection();
  if (!chosen) return;

  // ▶で選ばれたら、**節へ入らずにその機能だけ実行して終わる**。
  // 「該当機能へとべる」のが依頼（作者、2026-08-27）で、印を付けるのは別の操作
  if (chosen.kind === "run") {
    await runFeature(chosen.section);
    return;
  }

  await walkSection(context, chosen.section);
}

/** 節一覧で選ばれたもの。**中を回すのか、その機能へ飛ぶのか**で分かれる */
type SectionChoice =
  | { kind: "walk"; section: PendingCheckSection }
  | { kind: "run"; section: PendingCheckSection };

/** 節の行。取りやめの項目は `section` を持たない */
type SectionItem = vscode.QuickPickItem & { section?: PendingCheckSection };

/** どの節を回すか。**残りの多い順ではなく、リストの並び順**（危ないものから並んでいる） */
async function pickSection(): Promise<SectionChoice | undefined> {
  /**
   * その節の機能へ飛ぶボタン。**タイトルバーではなく、行に付ける**（作者の依頼、2026-08-27）。
   *
   * タイトルバーのボタンは「いま押したら**どの節**を実行するのか」が画面から読めない
   * （選んでいる行と結びついて見えない）。行に付ければ**節と実行が1対1**になり、
   * 押し間違いようがない。ついでに、節へ入らないと▶が無い状態も解消される。
   */
  const runButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("play"),
    tooltip: "この機能を実行する",
  };

  const items: SectionItem[] = PENDING_CHECKS.map((section) => ({
    label: `${section.id ? `${section.id}. ` : ""}${section.title}`,
    description: `残り${section.count}`,
    detail:
      section.commands.length > 0
        ? `実行できます: ${section.commands.join(" / ")}`
        : "実行する操作はありません（見るだけ・環境が要るもの）",
    // 実行する操作が無い節に▶を出すと、押しても何も起きない
    buttons: section.commands.length > 0 ? [runButton] : undefined,
    section,
  }));

  const quick = vscode.window.createQuickPick<SectionItem>();
  quick.title = `実機確認（残り ${total()}件）`;
  quick.placeholder =
    "確かめる節を選んでください。危ないものから並んでいます（▶でその機能をすぐ実行できます）";
  quick.matchOnDetail = true;
  // **閉じる道を画面に出す**（設計書6.17.3）。Escを知らない人には出口が無く見える
  quick.items = [...items, cancelItem()];
  // `ignoreFocusOut` は既定（false）のまま。ここは打ち込んだ入力を失う画面ではないので、
  // 外側をクリックしても抜けられるほうがよい（書き換える前の選択画面と同じ挙動）。
  // なお、この画面の名前をコメントに書かないこと——`quickPickCancel.test.ts` が
  // 文字列で呼び出し箇所を拾うので、コメントでも呼び出しと見なされて落ちる

  const done = new Promise<SectionChoice | undefined>((resolve) => {
    quick.onDidTriggerItemButton((event) => {
      const section = event.item.section;
      if (!section) return;
      // **先に答えを決めてから閉じる。** 逆にすると onDidHide が先に走って
      // 「取りやめ」で片付いてしまう。実際の実行は画面を閉じたあと（runChecks）で行う
      resolve({ kind: "run", section });
      quick.hide();
    });
    quick.onDidAccept(() => {
      const picked = quick.selectedItems[0];
      resolve(
        picked && !isCancelItem(picked) && picked.section
          ? { kind: "walk", section: picked.section }
          : undefined
      );
      quick.hide();
    });
    quick.onDidHide(() => resolve(undefined));
  });

  // この画面は show を呼ぶまで出ない。0.22.13でここが抜け、**押しても何も
  // 起きない**まま出荷した（`checkRunnerShow.test.ts` が見張る。あのテストは
  // ソースの文字列を数えるので、このコメントに作成側の関数名を書かないこと）
  quick.show();
  const chosen = await done;
  quick.dispose();
  return chosen;
}

/**
 * 1つの節を回す。
 *
 * **実行と、印を付けるのを分ける。** 押した瞬間に済みにすると、
 * 見ていないものが済んだことになる。
 */
async function walkSection(
  context: vscode.ExtensionContext,
  section: PendingCheckSection
): Promise<void> {
  const run: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("play"),
    tooltip: "この機能を実行する",
  };
  const openDoc: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("book"),
    tooltip: "確認リストの該当箇所を開く",
  };

  const quick = vscode.window.createQuickPick<vscode.QuickPickItem>();
  quick.title = `${section.id ? `${section.id}. ` : ""}${section.title}`;
  // **▶がどこにあるかを書く。** タイトルバーの小さなアイコンは気づかれない（作者の指摘、2026-08-27）。
  // 実行する操作が無い節では▶自体を出していないので、そのときは書かない
  const runHint =
    section.commands.length > 0 ? "右上の▶でこの機能を実行できます。" : "";
  quick.placeholder = `通った項目を選んで Enter。${runHint}選ばなければ何も変わりません`;
  quick.canSelectMany = true;
  quick.items = itemsOf(section).map((item) => ({ label: item }));
  quick.buttons = section.commands.length > 0 ? [run, openDoc] : [openDoc];
  quick.ignoreFocusOut = true;

  const done = new Promise<readonly vscode.QuickPickItem[] | undefined>(
    (resolve) => {
      quick.onDidTriggerButton(async (button) => {
        if (button === run) await runFeature(section);
        if (button === openDoc) await openChecklist(context, section);
      });
      quick.onDidAccept(() => {
        resolve(quick.selectedItems);
        quick.hide();
      });
      quick.onDidHide(() => resolve(undefined));
    }
  );

  quick.show();
  const selected = await done;
  quick.dispose();
  if (!selected || selected.length === 0) return;

  await markDone(
    context,
    section,
    selected.map((item) => item.label)
  );
}

/** その節の機能を実行する。**探さずに、ここから飛べる**のが要点 */
async function runFeature(section: PendingCheckSection): Promise<void> {
  if (section.commands.length === 1) {
    await vscode.commands.executeCommand(section.commands[0]);
    return;
  }

  const choices: vscode.QuickPickItem[] = section.commands.map((command) => ({
    label: command,
  }));

  const picked = await vscode.window.showQuickPick([...choices, cancelItem()], {
    title: "どれを実行しますか",
  });
  if (!picked || isCancelItem(picked)) return;
  await vscode.commands.executeCommand(picked.label);
}

/** 確認リストの該当箇所を開く。**節の見出しへカーソルを置く** */
async function openChecklist(
  context: vscode.ExtensionContext,
  section: PendingCheckSection
): Promise<void> {
  const uri = checklistUri(context);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);

  const at = findHeading(document.getText(), section);
  if (at === undefined) return;
  const position = new vscode.Position(at, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(
    new vscode.Range(position, position),
    vscode.TextEditorRevealType.AtTop
  );
}

/**
 * 通った項目に印を付け、文書へ書き戻す。
 *
 * **文言で照合する。** 行番号で覚えると、別の節を先に済みにしたときにずれる。
 * 見つからなかったものは**黙って落とさず、件数を伝える**。
 */
async function markDone(
  context: vscode.ExtensionContext,
  section: PendingCheckSection,
  labels: readonly string[]
): Promise<void> {
  const uri = checklistUri(context);
  const original = new TextDecoder().decode(
    await vscode.workspace.fs.readFile(uri)
  );
  const lines = original.split("\n");

  const start = findHeading(original, section);
  if (start === undefined) {
    void vscode.window.showWarningMessage(
      `確認リストに「${section.title}」が見つかりませんでした。`
    );
    return;
  }

  const wanted = new Set(labels);
  let marked = 0;
  for (let i = start + 1; i < lines.length; i++) {
    // 次の見出しに当たったら、その節は終わり
    if (/^#{2,3}\s/.test(lines[i])) break;
    const pending = /^-\s\[\s\]\s(.+)$/.exec(lines[i]);
    if (!pending) continue;
    const text = pending[1].replace(/\*\*/g, "").trim();
    if (!wanted.has(text)) continue;
    lines[i] = lines[i].replace("- [ ]", "- [x]");
    wanted.delete(text);
    marked++;
  }

  if (marked === 0) {
    void vscode.window.showWarningMessage("印を付けられる項目がありませんでした。");
    return;
  }

  await vscode.workspace.fs.writeFile(
    uri,
    new TextEncoder().encode(lines.join("\n"))
  );

  const missed = wanted.size > 0 ? `（${wanted.size}件は見つかりませんでした）` : "";
  void vscode.window.showInformationMessage(
    `${marked}件に印を付けました${missed}。` +
      "メニューの「テスト中」へ反映するには、" +
      "`node scripts/pendingChecks.mjs` のあと拡張機能開発ホストを再読み込みしてください。"
  );
}

/** その節の見出しの行。無ければ undefined */
function findHeading(
  markdown: string,
  section: PendingCheckSection
): number | undefined {
  const lines = markdown.split("\n");
  const at = lines.findIndex((line) => {
    if (!/^#{2,3}\s/.test(line)) return false;
    const text = line.replace(/^#{2,3}\s+/, "");
    return section.id
      ? text.startsWith(`${section.id}.`)
      : text.startsWith(section.title);
  });
  return at === -1 ? undefined : at;
}

function checklistUri(context: vscode.ExtensionContext): vscode.Uri {
  return paths.toUri(paths.join(context.extensionPath, CHECKLIST));
}

function total(): number {
  return PENDING_CHECKS.reduce((sum, section) => sum + section.count, 0);
}

/**
 * その節の項目の文章。
 *
 * 鍵は確認リストの番号。**番号の無い節は名前を鍵にする**（生成器と揃える）。
 */
function itemsOf(section: PendingCheckSection): readonly string[] {
  return PENDING_CHECK_ITEMS[section.id || section.title] ?? [];
}
