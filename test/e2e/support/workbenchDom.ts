/**
 * VS Code 本体の画面（ワークベンチ）の DOM に頼る部分を、**ここ1か所に集める**（設計書6.113）。
 *
 * タブの列・クイックオープン・知らせのクラス名は VS Code の中の事情で、
 * 版が上がると変わることがある。壊れたらここだけ直せばよいように、
 * テストの本体からはクラス名を書かない。
 *
 * 確かめた版：1.138.0（2026-10-03）。1.141.0 に合わせたが**未実行**（2026-10-10。配布物の
 * `workbench.desktop.main.js` の `redrawTabLabel`・`doRedrawTabDirty`・`doRedrawTabActive` を読み、
 * タブの名前が拡張子を `.label-suffix` へ分けるようになったのに合わせた——`readTabState`）。
 * ほかのクラス名（`.quick-input-*`・`.monaco-checkbox`・`.notification-toast`・`.monaco-dialog-box`・
 * `.keybindings-header`・`.marker-widget` など）は、1.141.0 の配布物にも残っていることだけを確かめた。
 */
import type { Locator, Page } from "playwright-core";
import { waitUntil } from "./wait";

/**
 * 本体の吹き出し（タブやパンくずにマウスを置くと出る、ファイルの場所などの表示）を消す
 * （2026-10-04、ノートPCで設定資料パネルの［一覧を出す］が30秒押せなかった調べ）。
 *
 * 狭い窓では、前の操作でマウスが残った所に出た吹き出しが、隣の列の WebView の
 * ボタンに重なる。吹き出しはクリックを受け止め（Playwright の「intercepts pointer
 * events」）、押しに行くマウスが吹き出しの上に乗るので**消えないまま**押し直しが
 * 続いた。1024×640 の窓で毎回起き、1434×897 では重ならずに通る。
 *
 * マウスを、吹き出しの出ない下のステータスバーの中ほどへ逃がし、消えるまで待つ。
 */
export async function dismissWorkbenchHover(page: Page): Promise<void> {
  const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await page.mouse.move(Math.round(size.width / 2), size.height - 3);
  await waitUntil(
    async () =>
      page.evaluate(
        () =>
          !Array.from(document.querySelectorAll(".workbench-hover, .monaco-hover")).some((element) => {
            const box = (element as HTMLElement).getBoundingClientRect();
            return box.width > 0 && box.height > 0 && !element.classList.contains("hidden");
          })
      ),
    "本体の吹き出しが消える",
    5_000
  );
}

/** タブ1枚の様子（`readTabState` が返す） */
export interface TabState {
  /** タブの名前。ファイルのタブなら拡張子まで含めた名前（「001_はじまり.txt」） */
  name: string;
  /** その列で前に出ているか */
  active: boolean;
  /** 未保存の印（●）が付いているか */
  dirty: boolean;
}

/** 列（グループ）1つの様子 */
export interface EditorGroupState {
  /** 焦点のある列か */
  active: boolean;
  tabs: TabState[];
}

/**
 * 列ごとのタブの様子を**ここ1か所で**読む。タブの名前・前に出ているか・未保存の印を
 * 読む関数（`editorGroupTabs`・`activeTabNames`・`tabIsDirty`・`activeGroupIndex`）は、
 * 全部これを Node の側で加工するだけにする（`page.evaluate` の中へは外の関数を
 * 持ち込めないので、DOM の読み方を何か所にも写さないため）。
 *
 * **名前は `.label-name` の字に `.label-suffix` の字を足して組み立てる。**
 * 1.141.0 の配布物（`workbench.desktop.main.js` の `redrawTabLabel`）は、タブの列が
 * 新しい見た目（`.modern-ui-connected-editor-tabs`）の中にあり、名前がファイル名と同じなら、
 * 拡張子を `suffix` に分けて `.label-name` から削る（`.label-name` は「001_はじまり」、
 * `.monaco-icon-suffix-container > .label-suffix` に「.txt」）。1.138.0 の `redrawTabLabel` には
 * この分け方が無く、タブに `.label-suffix` は出ない（足しても空）。どちらの版でも
 * 拡張子つきの名前に戻る。新しい見た目を設定で切って逃げることはしない——作者の画面は
 * この見た目で動いている。
 *
 * 未保存は `.tab.dirty`、前に出ているのは `.tab.active`（1.141.0 の `doRedrawTabDirty`・
 * `doRedrawTabActive` も 1.138.0 と同じクラスを付ける。ノートPCで「未保存の印が見つからない」と
 * 落ちたのは、印ではなく名前の照合が外れていたため）。
 */
export async function readTabState(page: Page): Promise<EditorGroupState[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".editor-group-container")).map((group) => ({
      active: group.classList.contains("active"),
      tabs: Array.from(group.querySelectorAll(".tabs-container .tab")).map((tab) => {
        const base = tab.querySelector(".label-name")?.textContent ?? "";
        const suffix = tab.querySelector(".label-suffix")?.textContent ?? "";
        // 名前の部分が無い版では、読み上げ用の名前の頭を使う
        const name = base ? `${base}${suffix}`.trim() : (tab.getAttribute("aria-label") ?? "").split(",")[0].trim();
        return { name, active: tab.classList.contains("active"), dirty: tab.classList.contains("dirty") };
      }),
    }))
  );
}

/**
 * タブの名前 `actual` が `wanted` に当たるか。**拡張子のあり／なしのどちらでも一致させる**
 * （「001_はじまり.txt」と「001_はじまり」は同じタブ。ただし「001_はじまり.txt」と
 * 「001_はじまり.md」は別のタブ）。
 *
 * `readTabState` で拡張子つきに組み立て直しているので、ふだんは完全一致で当たる。
 * これは、VS Code の版がまた名前の見せ方を変えたときに、テストの期待値を
 * 書き換えずに済ませるための受け皿
 *
 * **件数つきの題も当てる**（2026-10-11、`manuscriptFootNarrow` が単独で3回とも
 * 「タブ「提案」が出る」の時間切れで落ちた。写真の右の列には「提案（1）」があった）。
 * 提案パネルは残りの件数を題に出す（設計書6.11）ので、「提案」で探したら
 * 「提案（1）」「提案(12)」にも当てる。件数で探したとき（「提案（2）」）は完全一致だけ。
 * 拡張子のある名前（話のタブ）には当てない——「第1話（2）.txt」を「第1話」で拾わないため
 */
export function tabNameMatches(actual: string, wanted: string): boolean {
  if (actual === wanted) return true;
  const counted = /^(.*?)\s*[（(]\d+[）)]$/.exec(actual);
  // 末尾が括弧で終わる名前だけを見るので、拡張子つきの話のタブは外れる
  if (counted && counted[1] === wanted) return true;
  const stem = (name: string) => name.replace(/\.[^./\\]+$/, "");
  // 片方が拡張子なしのときだけ、語幹どうしで比べる
  return stem(actual) === stem(wanted) && (actual === stem(actual) || wanted === stem(wanted));
}

/** タブの名前の並び `names` に、`wanted` に当たるものがあるか（拡張子のあり／なしを問わない） */
export function tabNamesInclude(names: readonly string[], wanted: string): boolean {
  return names.some((name) => tabNameMatches(name, wanted));
}

/** タブの名前の並び `names` のうち、`wanted` に当たるものの数（拡張子のあり／なしを問わない） */
export function countTabsNamed(names: readonly string[], wanted: string): number {
  return names.filter((name) => tabNameMatches(name, wanted)).length;
}

/** エディターの列（グループ）ごとの、タブの名前。左の列から順に */
export async function editorGroupTabs(page: Page): Promise<string[][]> {
  return (await readTabState(page)).map((group) => group.tabs.map((tab) => tab.name));
}

/** 列ごとに、前に出ているタブの名前（その列にタブが無ければ空文字）。左の列から順に */
export async function activeTabNames(page: Page): Promise<string[]> {
  return (await readTabState(page)).map((group) => group.tabs.find((tab) => tab.active)?.name ?? "");
}

/** その名前のタブが「未保存」の印（●）を付けているか（拡張子のあり／なしを問わない） */
export async function tabIsDirty(page: Page, name: string): Promise<boolean> {
  return (await readTabState(page)).some((group) =>
    group.tabs.some((tab) => tab.dirty && tabNameMatches(tab.name, name))
  );
}

/**
 * 名前が `name` に当たるタブ（拡張子のあり／なしを問わない）を指す locator。
 * いま無ければ、どのタブにも当たらない locator を返す（`waitFor` で時間切れになる）。
 *
 * `.label-name` を `hasText` で絞る形は使わない——1.141.0 では `.label-name` が拡張子を
 * 持たないので、「001_はじまり.txt」で探すと部分一致もしない
 */
export async function tabLocator(page: Page, name: string): Promise<Locator> {
  const index = (await readTabState(page))
    .flatMap((group) => group.tabs)
    .findIndex((tab) => tabNameMatches(tab.name, name));
  // 列の順・列の中のタブの順は、文書の中の `.editor-group-container .tabs-container .tab` の順と同じ。
  // `readTabState` と同じ範囲で数える（列の外に別の `.tabs-container .tab` が描かれても隣を押さない）
  return index >= 0
    ? page.locator(".editor-group-container .tabs-container .tab").nth(index)
    : page.locator(".editor-group-container .tabs-container .tab.novelai-e2e-no-such-tab");
}

/**
 * 名前が `name` のタブを押して前に出す（作者がタブを押すのと同じ道）。
 *
 * クイックオープンで開き直す道は取らない——開き直すと、拡張機能の側の「開く」の
 * 処理を通るので、「タブを前に出しただけ」の場面にならない
 */
export async function activateTab(page: Page, name: string): Promise<void> {
  await waitUntil(
    async () => tabNamesInclude((await editorGroupTabs(page)).flat(), name),
    `タブ「${name}」が出る`,
    10_000
  );
  const tab = await tabLocator(page, name);
  await tab.waitFor({ state: "visible", timeout: 10_000 });
  await tab.click();
  await waitUntil(async () => tabNamesInclude(await activeTabNames(page), name), `タブ「${name}」が前に出る`, 10_000);
}

/** 焦点のある列（グループ）の番号。左の列から 0, 1, … 。分からなければ -1 */
export async function activeGroupIndex(page: Page): Promise<number> {
  return (await readTabState(page)).findIndex((group) => group.active);
}

/** WebView 1枚の、本体の側から見た様子（`webviewLayer` が返す） */
export interface WebviewLayer {
  /** 前に出ていて、真ん中を押せばその WebView に届くか */
  inFront: boolean;
  /** 重なっている列の番号（左から 0, 1, …。見つからなければ -1） */
  groupIndex: number;
  /** その列が窓の中で見えている幅（列の右端が窓の外へ出ていれば、その分だけ狭い） */
  visibleWidth: number;
  /** 失敗の文へ添える一言（場所・大きさ・visibility・真ん中でいちばん上の iframe） */
  detail: string;
}

/**
 * 外側の iframe の名前が `outerName` の WebView が、本体の画面でどう見えているか。
 *
 * **WebView の中から「前に出ているか」は分からない。** `retainContextWhenHidden` の面
 * （原稿エディター・提案パネル）は裏に回っても DOM が残り、Playwright は裏の面の
 * 要素も見つける。そのまま押すと、前にある別の WebView の iframe が押下を受け止め
 * （「intercepts pointer events」）、30秒押し直して落ちる（ノートPC・1.141.0、2026-10-11 の
 * `neighborKeys`・`findingJumpVertical`）。
 *
 * **WebView の iframe は列の DOM の中に無い**（VS Code は別の層に重ねて、列の場所へ動かす）。
 * そこで iframe の左端が入っている列を、場所で引き当てる。前に出ているかは、
 * visibility と大きさに加え、**見えている部分の真ん中で、いちばん上の iframe がそれか**で見る
 * （別の WebView が上に重なっていれば、押下はそちらへ行く）
 */
export async function webviewLayer(page: Page, outerName: string): Promise<WebviewLayer> {
  return page.evaluate((name) => {
    const iframe = Array.from(document.querySelectorAll("iframe")).find((element) => element.name === name);
    if (!iframe) return { inFront: false, groupIndex: -1, visibleWidth: 0, detail: `iframe「${name.slice(0, 8)}」が無い` };
    const box = iframe.getBoundingClientRect();
    const style = getComputedStyle(iframe);
    const groups = Array.from(document.querySelectorAll(".editor-group-container")).map((group) => group.getBoundingClientRect());
    const groupIndex = groups.findIndex((group) => box.left + 1 >= group.left && box.left + 1 <= group.right);
    const group = groups[groupIndex];
    const visibleWidth = group ? Math.min(group.width, window.innerWidth - group.left) : 0;
    const left = Math.max(box.left, 0);
    const right = Math.min(box.right, window.innerWidth);
    const top = Math.max(box.top, 0);
    const bottom = Math.min(box.bottom, window.innerHeight);
    const sized = right - left > 1 && bottom - top > 1;
    // 真ん中の点で、いちばん上にある iframe。知らせ・吹き出しなど本体の小さな重なりは数えない
    // （別の WebView に隠れているかだけを見る。小さな重なりで「前に無い」とすると、押す場所が
    // 隠れていないのに待ち続ける）
    const hit = sized
      ? (document.elementsFromPoint((left + right) / 2, (top + bottom) / 2).find((element) => element.tagName === "IFRAME") ?? null)
      : null;
    const inFront = style.visibility !== "hidden" && sized && hit === iframe;
    const hitName =
      hit === null ? "なし" : hit instanceof HTMLIFrameElement ? `iframe「${hit.name.slice(0, 8)}」` : hit.tagName.toLowerCase();
    return {
      inFront,
      groupIndex,
      visibleWidth,
      detail:
        `iframe「${name.slice(0, 8)}」@${Math.round(box.left)},${Math.round(box.top)} ` +
        `${Math.round(box.width)}x${Math.round(box.height)} visibility=${style.visibility} 列=${groupIndex} 真ん中=${hitName}`,
    };
  }, outerName);
}

/** 本体の画面にある WebView の iframe を全部、`webviewLayer` の一言の形で（失敗の文へ添える） */
export async function webviewLayers(page: Page): Promise<string[]> {
  const names = await page
    .evaluate(() => Array.from(document.querySelectorAll("iframe.webview")).map((element) => (element as HTMLIFrameElement).name))
    .catch(() => [] as string[]);
  const details: string[] = [];
  for (const name of names) details.push((await webviewLayer(page, name).catch(() => undefined))?.detail ?? `「${name.slice(0, 8)}」読めない`);
  return details;
}

/**
 * クイックオープン（Ctrl+P）でファイルを開く。
 *
 * 候補に名前が出るまで待ってから Enter を押す（出る前に押すと、
 * 空の候補で閉じて何も開かない）。
 */
export async function quickOpen(page: Page, fileName: string): Promise<void> {
  /*
    **Ctrl+P は本体へ焦点を戻してから押す**（`pressWorkbenchKey`）。提案パネルなどの WebView を
    開いた直後は焦点が iframe の中にあり、素の `keyboard.press` は本体のキー割り当てに届かない。
    ノートPC（1.141.0、2026-10-11）の `manuscriptFootNarrow` で、提案パネルを開いたあとの
    2話目を開こうとして、入力欄が出ないまま30秒待って落ちた。パレット（`runCommand`）と同じく、
    パネルが開き終わる途中で焦点が移ることもあるので、出なければ3回まで押し直す
  */
  /*
    **打った字が入力欄に入ったことを確かめ、閉じていたら押し直す。** WebView のタブを押した直後に
    押すと、入力欄は一度開くが、遅れて届いた WebView への焦点の移動で字を打つ前に閉じる。母艦
    （0.104.2、1.141.0）の `manuscriptFootNarrow` で単独3回とも、入力欄が閉じ・値が空のまま
    候補を30秒待って落ちた（2026-10-12）
  */
  const input = page.locator(".quick-input-widget input").first();
  for (let attempt = 1; ; attempt++) {
    await pressWorkbenchKey(page, "Control+KeyP");
    const shown = await input
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (shown) {
      await page.keyboard.insertText(fileName);
      const typed = await waitUntil(
        async () => (await input.isVisible()) && (await input.inputValue()) === fileName,
        "Ctrl+P の入力欄に打った名前が入る",
        2_000
      )
        .then(() => true)
        .catch(() => false);
      if (typed) break;
      // 開いたままの入力欄で Ctrl+P を押すと候補送りになるので、閉じてから押し直す
      if (await input.isVisible().catch(() => false)) await page.keyboard.press("Escape");
    }
    if (attempt === 3) {
      const value = await input.inputValue().catch(() => "?");
      throw new Error(
        `Ctrl+P のファイル検索の入力欄が出ないか、字を打つ前に閉じます（「${fileName}」を開こうとして3回押しました。最後の入力欄の値 ${JSON.stringify(value)}）`
      );
    }
  }
  await page
    .locator(".quick-input-widget .monaco-list-row", { hasText: fileName })
    .first()
    .waitFor({ state: "visible" })
    .catch(async (error: unknown) => {
      const rows = await page.locator(".quick-input-widget .monaco-list-row").allInnerTexts().catch(() => []);
      throw new Error(`Ctrl+P の候補に「${fileName}」が出ません（出ている候補 ${JSON.stringify(rows)}）（${String(error)}）`);
    });
  await page.keyboard.press("Enter");
  await input.waitFor({ state: "hidden" }).catch((error: unknown) => {
    throw new Error(`Ctrl+P で「${fileName}」を選んだあと、入力欄が閉じません（${String(error)}）`);
  });
}

/**
 * 素のテキストエディター（Monaco）の、前に出ている1枚に見えている行の字。
 * 見えていなければ空文字
 */
export async function textEditorVisibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const editors = Array.from(document.querySelectorAll(".editor-group-container.active .monaco-editor .view-lines"));
    return editors.map((lines) => (lines as HTMLElement).innerText).join("\n");
  });
}

/** `groupIndex` 番目の列（左から 0）の、素のテキストエディターに見えている行の字 */
export async function textEditorVisibleTextIn(page: Page, groupIndex: number): Promise<string> {
  return page.evaluate((index) => {
    const group = document.querySelectorAll(".editor-group-container")[index];
    if (!group) return "";
    return Array.from(group.querySelectorAll(".monaco-editor .view-lines"))
      .map((lines) => (lines as HTMLElement).innerText)
      .join("\n");
  }, groupIndex);
}

/** 素のテキストエディターの本文を押して、焦点を移す */
export async function focusTextEditor(page: Page): Promise<void> {
  await page.locator(".editor-group-container.active .monaco-editor .view-lines").first().click();
}

/**
 * 素のテキストエディターのカーソルの行と桁（下のステータスバーの「Ln 3, Col 1」）。
 * 出ていなければ undefined。**英語の表示**（言語パックを入れていない）を前提に読む
 */
export async function textEditorCursor(page: Page): Promise<{ line: number; column: number } | undefined> {
  const text = await page
    .locator('[id="status.editor.selection"]')
    .first()
    .innerText()
    .catch(() => "");
  const match = /Ln (\d+), Col (\d+)/.exec(text);
  return match ? { line: Number(match[1]), column: Number(match[2]) } : undefined;
}

/** 問題の見出し（F8 の「次の問題」で本文の中に開く枠）が出ているか */
export async function markerWidgetShown(page: Page): Promise<boolean> {
  return (await page.locator(".monaco-editor .marker-widget").count()) > 0;
}

/**
 * コマンドパレット（Ctrl+Shift+P）で `query` を探し、並んだ行の名前を返して閉じる。
 *
 * 行の名前は「分類: 題」（この拡張機能なら「小説執筆: …」）。**候補が出揃うのを
 * 待つ**——打った直後は前の一覧が残っていることがあるので、数が落ち着くまで見る
 */
export async function commandPaletteLabels(page: Page, query: string): Promise<string[]> {
  await page.keyboard.press("Control+Shift+KeyP");
  const input = page.locator(".quick-input-widget input");
  await input.waitFor({ state: "visible" });
  await page.keyboard.insertText(query);
  const read = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll(".quick-input-widget .monaco-list-row")).map((row) =>
        (row.querySelector(".label-name")?.textContent ?? row.getAttribute("aria-label") ?? "").trim()
      )
    );
  let labels: string[] = [];
  let stable = 0;
  await waitUntil(
    async () => {
      const now = await read();
      stable = now.length > 0 && JSON.stringify(now) === JSON.stringify(labels) ? stable + 1 : 0;
      labels = now;
      return stable >= 3;
    },
    `コマンドパレットで「${query}」の候補が出揃う`,
    10_000
  );
  await page.keyboard.press("Escape");
  await input.waitFor({ state: "hidden" });
  return labels;
}

/**
 * **VS Code 本体向けのキー**（使い捨ての keybindings.json に書いた Ctrl+Alt+Shift+F<n> など）を、
 * 本体に焦点を戻してから押す。
 *
 * WebView（校正・メモパネル・人物相関図など）を開くと、焦点が WebView の中へ移る。そのまま
 * Playwright でキーを送ると、**本体のキー割り当てに届かない**（Keyboard Shortcuts
 * Troubleshooting のログに「Received keydown event」の行が1行も出ない。`document.hasFocus()` は偽か、
 * 焦点が iframe）。2026-10-03、ノートPCで `commandNames`／`memoFixOneStep` が落ちて分かった
 * （同じテストが母艦では通る。届くかどうかは WebView の読み込みの進み方しだい）。
 *
 * `window.focus()` は**画面の中だけの操作**で、OS の前面は取らない（`vscodeApp.ts` の
 * `keepOutOfTheWay` の決まりを崩さない。`page.bringToFront()` は使わない）。
 */
export async function pressWorkbenchKey(page: Page, chord: string): Promise<void> {
  await page.evaluate(() => {
    // iframe（WebView）に焦点があれば外す。焦点が本体の入力欄などにあるときは触らない
    const active = document.activeElement;
    if (active && active.tagName === "IFRAME") (active as HTMLElement).blur();
    window.focus();
  });
  await page.keyboard.press(chord);
}

/**
 * キーボード ショートカットの画面で `query` を探し、並んだ行の
 * 「コマンドの名前」と「キー」を返す（画面は開いたまま）。
 *
 * 開くのは `OPEN_KEYBINDINGS_KEY`（使い捨ての keybindings.json に足す）。
 * **Ctrl+K Ctrl+S の2段のキーは、焦点が WebView（パネル）の中にあると届かなかった**
 * （1段のキーでも同じ。`pressWorkbenchKey` で本体へ焦点を戻してから押す）
 */
export async function keybindingsEditorRows(page: Page, query: string): Promise<Array<{ command: string; keys: string }>> {
  const search = page
    .locator(".keybindings-editor .keybindings-header input")
    .first();
  // 開いていなければ開く（2回目からは探す語だけ入れ替える）
  if ((await search.count()) === 0 || !(await search.isVisible())) {
    await pressWorkbenchKey(page, OPEN_KEYBINDINGS_PRESS);
  }
  await search.waitFor({ state: "visible", timeout: 10_000 });
  await search.click();
  await page.keyboard.press("Control+KeyA");
  await page.keyboard.insertText(query);
  const read = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll(".keybindings-editor .monaco-list-row")).map((row) => ({
        // 名前の欄は幅で「…」に切れて見えるが、字そのものは全部入っている
        command: (row.querySelector(".command-label")?.textContent ?? "").trim(),
        // 「Ctrl+/」「Shift+F8」の形（キーの札と「+」をつないだ字）
        keys: (row.querySelector(".monaco-keybinding")?.textContent ?? "").trim(),
      }))
    );
  let rows: Array<{ command: string; keys: string }> = [];
  let stable = 0;
  await waitUntil(
    async () => {
      const now = await read();
      stable = now.length > 0 && JSON.stringify(now) === JSON.stringify(rows) ? stable + 1 : 0;
      rows = now;
      // 探す語を入れ替えたあと、絞り込みは少し遅れて効くので、長めに落ち着きを見る
      return stable >= 8;
    },
    `キーボード ショートカットで「${query}」の行が出揃う`,
    10_000
  );
  return rows;
}

/** 選ぶ画面（QuickPick）の1行 */
export interface QuickPickRow {
  /** 名前（`$(book)` のような絵の記号は字にならないので、前後の空白を落とした字だけ） */
  label: string;
  /** 名前の右の説明 */
  description: string;
  /** 複数選べる画面のチェック。チェックの無い画面では undefined */
  checked: boolean | undefined;
}

/**
 * 選ぶ画面（`showQuickPick`）が `title` の題で出るまで待ち、行が出揃ったら返す。
 *
 * **題で待つ。** 拡張機能は選ぶ画面を続けて何枚も出すので、前の画面の行を
 * 読まないよう、題が替わったことを確かめてから読む
 */
export async function waitForQuickPick(page: Page, title: string, timeoutMs = 15_000): Promise<QuickPickRow[]> {
  await waitUntil(
    async () => (await quickPickTitle(page)) === title,
    `選ぶ画面「${title}」が出る`,
    timeoutMs
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}${await quickInputWaitContext(page)}`);
  });
  let rows: QuickPickRow[] = [];
  let stable = 0;
  await waitUntil(
    async () => {
      const now = await quickPickRows(page);
      stable = now.length > 0 && JSON.stringify(now) === JSON.stringify(rows) ? stable + 1 : 0;
      rows = now;
      return stable >= 3;
    },
    `選ぶ画面「${title}」の行が出揃う`,
    10_000
  );
  return rows;
}

/** 右下に出ている知らせの文（出ていなければ空の配列） */
export async function notificationTexts(page: Page): Promise<string[]> {
  return page.locator(".notification-toast").allInnerTexts().catch(() => [] as string[]);
}

/** 右クリックの品書きが開いたままか */
export async function contextMenuOpen(page: Page): Promise<boolean> {
  return (await page.locator(".context-view .monaco-menu").count().catch(() => 0)) > 0;
}

/**
 * 選ぶ画面・入力欄を待って時間切れになったときに、失敗の文へ添える画面の様子。
 *
 * 待っていた画面が出なかったとき、製品が断りの知らせ（「〜を始められませんでした」など）を
 * 出して止まったのか、品書きの押下が届かなかったのかを、写真を見る前に文だけで分けたい
 * （2026-10-11 ノートPC・1.141.0 で「ここから章を始める」が3回に1回出ず、いまの題が空としか
 * 分からなかった）。形は episodeInsertRenameCommit の失敗の文に揃える
 */
export async function quickInputWaitContext(page: Page): Promise<string> {
  const toasts = await notificationTexts(page);
  const dialog = await dialogText(page).catch(() => undefined);
  const title = await quickPickTitle(page).catch(() => undefined);
  const menu = await contextMenuOpen(page);
  const watched = await readQuickInputWatch(page);
  return (
    `（出ている知らせ：${JSON.stringify(toasts)}／確認の窓：${dialog ?? "なし"}` +
    `／選ぶ画面の題：${title ?? "なし"}／品書き：${menu ? "開いたまま" : "閉じた"}` +
    (watched === undefined ? "" : `／押してからの移り変わり：${watched}`) +
    `）`
  );
}

/**
 * 押してから、選ぶ画面・入力欄が開いたか・閉じたか・焦点がどこへ移ったかを、ページの中で
 * 50ミリ秒ごとに見て、変わったときだけ控える（最大40件）。
 *
 * **画面が「出ない」と「一度出てすぐ閉じた」を分けるため。** 母艦の `manuscriptFootNarrow` は
 * 後者だった（Ctrl+P の入力欄が、遅れて届いた WebView への焦点の移動で閉じた。2026-10-12）。
 * ノートPCで品書きのあとの画面が出ずに落ちる3件（episodeInsertRenameCommit・workTreeChapterPlot・
 * manuscriptSurfaceNarrow）は写真からどちらか分からないので、落ちたときの文へ添える
 */
export async function startQuickInputWatch(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      type Watch = { timer: number; log: string[]; last: string; start: number; redraws: number; observer?: MutationObserver };
      const host = window as unknown as { __novelaiQuickInputWatch?: Watch };
      if (host.__novelaiQuickInputWatch) {
        window.clearInterval(host.__novelaiQuickInputWatch.timer);
        host.__novelaiQuickInputWatch.observer?.disconnect();
      }
      const watch: Watch = { timer: 0, log: [], last: "", start: Date.now(), redraws: 0 };
      /*
        左の列の一覧（作品一覧など）の行の入れ替えを数える。品書きが開いている間に一覧が
        描き直されると、押した項目が空振りする疑いがある（ノートPCの workTreeChapterPlot で、
        押したのに入力欄が一度も開かず、焦点が一覧へ戻った。2026-10-12）
      */
      watch.observer = new MutationObserver((records) => {
        for (const record of records) {
          const target = record.target as Element;
          if (target.closest?.(".sidebar .monaco-list-rows")) {
            watch.redraws += 1;
            return;
          }
        }
      });
      watch.observer.observe(document.body, { childList: true, subtree: true });
      const snapshot = (): string => {
        const widget = document.querySelector(".quick-input-widget") as HTMLElement | null;
        const open = !!widget && widget.style.display !== "none" && widget.offsetParent !== null;
        const title = open ? (widget?.querySelector(".quick-input-title")?.textContent ?? "").trim() : "";
        const active = document.activeElement as HTMLElement | null;
        const focus = active
          ? `${active.tagName.toLowerCase()}${active.className ? "." + String(active.className).split(" ").slice(0, 2).join(".") : ""}`
          : "なし";
        return `入力欄=${open ? `開「${title}」` : "閉"} 焦点=${focus} 一覧の描き直し=${watch.redraws}`;
      };
      const tick = (): void => {
        const now = snapshot();
        if (now === watch.last || watch.log.length >= 40) return;
        watch.last = now;
        watch.log.push(`+${Date.now() - watch.start}ms ${now}`);
      };
      tick();
      watch.timer = window.setInterval(tick, 50);
      host.__novelaiQuickInputWatch = watch;
    })
    .catch(() => undefined);
}

/** `startQuickInputWatch` の控え。始めていなければ undefined */
export async function readQuickInputWatch(page: Page): Promise<string | undefined> {
  return page
    .evaluate(() => {
      const host = window as unknown as { __novelaiQuickInputWatch?: { log: string[] } };
      return host.__novelaiQuickInputWatch ? host.__novelaiQuickInputWatch.log.join(" → ") : undefined;
    })
    .catch(() => undefined);
}

/** いま出ている選ぶ画面の題。出ていなければ undefined */
export async function quickPickTitle(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const widget = document.querySelector(".quick-input-widget") as HTMLElement | null;
    if (!widget || widget.style.display === "none" || widget.offsetParent === null) return undefined;
    const title = widget.querySelector(".quick-input-title")?.textContent?.trim();
    return title || undefined;
  });
}

/** いま出ている選ぶ画面の行（見えている行だけ。短い一覧を前提にする） */
export async function quickPickRows(page: Page): Promise<QuickPickRow[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".quick-input-widget .quick-input-list .monaco-list-row")).map((row) => {
      const label = (row.querySelector(".label-name")?.textContent ?? "").trim();
      const description = (row.querySelector(".label-description")?.textContent ?? "").trim();
      // 複数選べる画面では、行そのものが「checkbox」の役を名乗る
      const aria = row.getAttribute("aria-checked");
      const checked = aria === "true" ? true : aria === "false" ? false : undefined;
      return { label, description, checked };
    })
  );
}

/** 選ぶ画面で、名前に `label` を含む行を押す（1つだけ選ぶ画面なら、それで決まる） */
export async function pickQuickPickRow(page: Page, label: string): Promise<void> {
  await page
    .locator(".quick-input-widget .quick-input-list .monaco-list-row", { hasText: label })
    .first()
    .click();
}

/**
 * 複数選べる選ぶ画面で、名前（または説明）が `label` の行のチェックを付け外しする。
 * 押したあと、チェックが本当に替わったことを確かめる（押し損ねを黙って通さない）。
 *
 * 説明でも引けるのは、話の一覧のように名前が「第2話 …」で説明がファイル名の画面があるため
 */
export async function toggleQuickPickRow(page: Page, label: string): Promise<void> {
  const rows = await quickPickRows(page);
  const index = rows.findIndex((row) => row.label === label || row.description === label);
  if (index < 0) throw new Error(`選ぶ画面に「${label}」の行がありません（${JSON.stringify(rows)}）`);
  const before = rows[index];
  // チェック欄は行の中の `.monaco-checkbox`（1.138.0。古い版の `<input class="quick-input-list-checkbox">` ではない）
  await page
    .locator(".quick-input-widget .quick-input-list .monaco-list-row")
    .nth(index)
    .locator(".monaco-checkbox")
    .first()
    .click();
  await waitUntil(
    async () => (await quickPickRows(page))[index]?.checked === !before.checked,
    `「${label}」のチェックが替わる`,
    5_000
  );
}

/**
 * 複数選べる選ぶ画面を、いまのチェックのまま決める（右上の［OK］を押す）。
 *
 * **Enter では決めない。** チェック欄を押したあとは焦点がチェック欄にあり、
 * Enter はそのチェック欄を付け外しする（外したはずの語が戻って決まった。1.138.0）
 */
export async function acceptQuickPick(page: Page): Promise<void> {
  await page.locator(".quick-input-widget .quick-input-action .monaco-button", { hasText: "OK" }).first().click();
}

/**
 * 右下の知らせを閉じる。
 *
 * 作品を登録すると「登録しました」の知らせが出て、右下のボタンや本文の端を塞ぐ。
 * 閉じるのは使い捨ての keybindings.json に書いたキー（`notifications.clearAll`）。
 */
export async function clearNotifications(page: Page): Promise<void> {
  await page.keyboard.press(CLEAR_NOTIFICATIONS_PRESS);
  await waitUntil(
    async () => (await page.locator(".notification-toast").count()) === 0,
    "知らせが閉じる",
    5_000
  ).catch(() => undefined);
}

/**
 * 確認の画面（モーダル）に出ている文。出ていなければ undefined。
 *
 * **確認の画面は VS Code の中に描かせる**（設定 `window.dialogStyle: "custom"`）。
 * 既定の Windows では OS のダイアログになり、Playwright から読めないうえ、
 * 作者の画面の前面に出てしまう。
 */
export async function dialogText(page: Page): Promise<string | undefined> {
  const dialog = page.locator(".monaco-dialog-box");
  if ((await dialog.count()) === 0) return undefined;
  return dialog.first().innerText();
}

/** 確認の画面のボタンを、名前で押す */
export async function pressDialogButton(page: Page, label: string): Promise<void> {
  await page.locator(".monaco-dialog-box .monaco-button", { hasText: label }).first().click();
  await page.locator(".monaco-dialog-box").waitFor({ state: "detached", timeout: 5_000 });
}

/** 確認の画面を Esc で閉じる（何も選ばない） */
export async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.locator(".monaco-dialog-box").waitFor({ state: "detached", timeout: 5_000 });
}

/** キーボード ショートカットの画面を開くキー。使う件は `LaunchOptions.keybindings` へ足す */
export const OPEN_KEYBINDINGS_KEY = "ctrl+alt+shift+f4";
export const OPEN_KEYBINDINGS_PRESS = "Control+Alt+Shift+F4";
export const OPEN_KEYBINDINGS_BINDING = { key: OPEN_KEYBINDINGS_KEY, command: "workbench.action.openGlobalKeybindings" };

/** 知らせを閉じるキー（VS Code での書き方）。keybindings.json へ書く */
export const CLEAR_NOTIFICATIONS_KEY = "ctrl+alt+shift+f11";
const CLEAR_NOTIFICATIONS_PRESS = "Control+Alt+Shift+F11";
