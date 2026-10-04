/**
 * 原稿エディター（横書き）を本物の VS Code で押して確かめる（画面の自動テスト、設計書6.113）。
 *
 * 2026-10-03 に作者が開発ホストで押して確かめたこと（保存・表示倍率・メモのキー・
 * 右クリックの名前）を、機械で毎回見張る。**日本語入力の本物の変換・ほかのアプリとの
 * キーの取り合い・見た目の良し悪しは、ここでは見ない**（見られない）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { findAction } from "../../src/core/actionTree";
import {
  caretPosition,
  composeText,
  footText,
  openEpisode,
  placeCaretAfter,
  revealFlashLit,
  selectionCollapsed,
  selectText,
} from "./support/manuscriptFrame";
import { tabIsDirty } from "./support/workbenchDom";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";

const EPISODE = "001_はじまり.txt";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 右クリックの品書きに並ぶはずの名前。**写しはここ1か所。**
 *
 * ルビ・傍点・投稿用コピーは**コマンドの題と同じ名前**にする決まり（作者の裁定、
 * 2026-10-03）なので、package.json のコマンドの題から読む。名前が変わっても
 * ここを直さずに済み、品書きとコマンドの題がずれたら落ちる。
 * 残りの2つはコマンドの題と違う名前なので、ここに書く。
 */
async function contextMenuNames(): Promise<string[]> {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")) as {
    contributes: { commands: Array<{ command: string; title: string }> };
  };
  const titleOf = (id: string) => {
    const found = manifest.contributes.commands.find((entry) => entry.command === id);
    if (!found) throw new Error(`package.json にコマンド ${id} がありません`);
    return found.title;
  };
  // 執筆再開の資料は、メニューの名前（actionTree）をそのまま品書きにも使う
  const resume = findAction("novelai.resumeWriting")?.label;
  if (!resume) throw new Error("actionTree に novelai.resumeWriting がありません");
  return [
    titleOf("novelai.addRuby"),
    titleOf("novelai.addEmphasis"),
    titleOf("novelai.copyForPosting"),
    "コピー（記法のまま）",
    // 実機確認リスト 0.96.9 の並びの残り（短く、名詞止めにそろえた名前）
    "AI相談（選択範囲）",
    "メモ追加",
    "校正・メモパネルを開く",
    "単話プロットを開く",
    resume,
  ];
}

/** 原稿ファイルの中身（改行は LF に揃えて比べる） */
async function fileText(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n");
}

/**
 * 操作ログ（`.aiwriter/logs/actions.log`）のうち、保存と外からの変更の行。
 * 落ちたときに「画面が何番の便を送ってから保存を頼んだか」を読むため
 */
async function saveLogLines(session: E2ESession): Promise<string> {
  try {
    const log = await readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8");
    return log
      .split(/\r?\n/)
      .filter((line) => /［保存］|外で変わった|当てられ/.test(line))
      .join(" ／ ");
  } catch {
    return "（操作ログが読めません）";
  }
}

/** Ctrl+S を押し、ファイルに `expected` が入るまで待つ */
async function saveAndWaitFor(session: E2ESession, expected: (text: string) => boolean, label: string) {
  await session.page.keyboard.press("Control+KeyS");
  await waitUntil(async () => expected(await fileText(session)), label, 15_000);
}

test("打った字が Ctrl+S でファイルに入り、「保存しました」が出て、カーソルが動かない", async () => {
  await withVsCode(
    "保存",
    [{ name: EPISODE, text: "一行目の文。\n二行目の文。\n三行目の文。\n" }],
    async (session) => {
      const frame = await openEpisode(session.page, EPISODE, "二行目の文");
      await placeCaretAfter(frame, "二行目の");
      // 日本語は変換を通さず、確定した字として入れる（IME の本物の変換は見られない）
      await session.page.keyboard.insertText("短い");
      await waitUntil(
        async () => (await composeText(frame)).includes("二行目の短い文。"),
        "打った字が画面に出る"
      );
      const before = await caretPosition(frame);
      expect(before).toEqual({ lineText: "二行目の短い文。", column: 6 });

      await saveAndWaitFor(session, (text) => text.includes("二行目の短い文。"), "打った字がファイルに入る");
      expect(await fileText(session)).toBe("一行目の文。\n二行目の短い文。\n三行目の文。\n");
      await waitUntil(async () => (await footText(frame, "note")).includes("保存しました"), "「保存しました」が出る");

      // **保存の前後でカーソルが動かない**（保存のあと描き直されても、同じ行の同じ字の後ろ）
      expect(await caretPosition(frame)).toEqual(before);
      // 念押し：続けて打った字が、同じ所へ入る
      await session.page.keyboard.insertText("ほど");
      await saveAndWaitFor(session, (text) => text.includes("短いほど"), "続けて打った字がファイルに入る");
      expect(await fileText(session)).toBe("一行目の文。\n二行目の短いほど文。\n三行目の文。\n");
    }
  );
});

test("下の欄に「表示倍率 100%」が出て、上の帯の［＋］で 106% になる", async () => {
  await withVsCode("表示倍率", [{ name: EPISODE, text: "本文の一行。\n" }], async (session) => {
    const frame = await openEpisode(session.page, EPISODE, "本文の一行");
    await waitUntil(async () => (await footText(frame, "counts")).includes("表示倍率 100%"), "「表示倍率 100%」が出る");
    await frame.locator("#bigger").click();
    await waitUntil(async () => (await footText(frame, "counts")).includes("表示倍率 106%"), "［＋］で「表示倍率 106%」になる");
  });
});

test("Ctrl+/ でカーソル行の上に // の行が入り、F8 で次のメモへ動き、光っているあいだに打つと光りが消えて字が行の頭に入る", async () => {
  await withVsCode(
    "メモのキー",
    [{ name: EPISODE, text: "一行目の文。\n二行目の文。\n三行目の文。\n// 先のメモ\n四行目の文。\n" }],
    async (session) => {
      const frame = await openEpisode(session.page, EPISODE, "二行目の文");

      // 行の途中にカーソルを置いて Ctrl+/ → その行の上にメモの行が入る
      await placeCaretAfter(frame, "二行目");
      await session.page.keyboard.press("Control+Slash");
      // メモの行は「画面→本体のコマンド→文書」と回って入るので、画面に出てから保存する
      // （すぐ Ctrl+S を押すと、入る前の文書を保存してしまう）
      await waitUntil(
        async () => /\/\/.*\n+二行目の文。/.test(await composeText(frame)),
        "Ctrl+/ でメモの行が画面に入る"
      );
      // 足したメモの行では、**印のあと（行の末尾）**から打ち始められる。行の頭だと
      // 打った字が「//」の前に入って印が壊れる
      let memoCaret: Awaited<ReturnType<typeof caretPosition>>;
      await waitUntil(async () => {
        memoCaret = await caretPosition(frame);
        return !!memoCaret && memoCaret.lineText.startsWith("//") && memoCaret.column === memoCaret.lineText.length;
      }, "Ctrl+/ のあと、カーソルがメモの行の末尾に来る").catch((error: unknown) => {
        throw new Error(`${String(error)}（カーソル：${JSON.stringify(memoCaret)}）`);
      });
      expect(await selectionCollapsed(frame), "Ctrl+/ のあとで行が選ばれています").toBe(true);
      await saveAndWaitFor(
        session,
        (text) => /^\/\/.*\n二行目の文。$/m.test(text),
        "Ctrl+/ で入れたメモの行がファイルに入る"
      );
      const lines = (await fileText(session)).split("\n");
      expect(lines[0]).toBe("一行目の文。");
      expect(lines[1]).toMatch(/^\/\/ ?$/);
      expect(lines[2]).toBe("二行目の文。");

      // 1行目に戻って F8 → 次のメモ（いま入れた2行目の「//」）へ動く。
      // 動いた先で字を打てば、その行に入る（カーソルの行をファイルで確かめる）
      await placeCaretAfter(frame, "一行目の文");
      await session.page.keyboard.press("F8");
      await waitUntil(
        async () => ((await caretPosition(frame))?.lineText ?? "").startsWith("//"),
        "F8 でメモの行へ動く"
      );
      // 飛んだ先は**行を選ばず、行の頭にカーソルだけ**（作者の裁定、2026-10-03）。
      // 選ばれていると、そのまま打った字で行が置き換わる
      expect(await selectionCollapsed(frame), "F8 の先で行が選ばれています").toBe(true);
      expect((await caretPosition(frame))?.column).toBe(0);
      // 飛んだ行はしばらく光る
      expect(await revealFlashLit(frame), "F8 の先の行が光っていません").toBe(true);
      /*
        **光っているあいだに打つ**（実機確認リスト 0.97.2）：光りがすぐ消え、打った字が
        行の頭（メモの行なら `//` の前）に入る。光りの消える時間（2.5秒ほど）より
        ずっと短い1秒の内に消えることを見る——自然に消えたのと見分けるため
      */
      await session.page.keyboard.insertText("印");
      await waitUntil(async () => !(await revealFlashLit(frame)), "光っているあいだに打つと、光りがすぐ消える", 1_000);
      await saveAndWaitFor(session, (text) => text.includes("印"), "F8 の先で打った字がファイルに入る");
      const after = (await fileText(session)).split("\n");
      // 打った字は行の頭に入り、メモの行は消えない
      expect(after[1]).toMatch(/^印\/\//);
      expect(after[0]).toBe("一行目の文。");

      // もう一度 F8 → その次のメモ（もとからあった「// 先のメモ」）
      await session.page.keyboard.press("F8");
      await waitUntil(
        async () => ((await caretPosition(frame))?.lineText ?? "").includes("先のメモ"),
        "もう一度 F8 で次のメモへ動く"
      );
      // 打たずに置けば、飛んだ行の光りは数秒で自然に消える
      expect(await revealFlashLit(frame), "2回目の F8 の先の行が光っていません").toBe(true);
      await waitUntil(async () => !(await revealFlashLit(frame)), "飛んだ行の光りが数秒で消える", 10_000);
    }
  );
});

test("本文の右クリックの品書きに、ルビ・傍点（コマンドの題と同じ名前）・2つのコピー・AI相談・メモと資料の4つが並ぶ", async () => {
  await withVsCode("右クリック", [{ name: EPISODE, text: "右クリックを試す行。\n" }], async (session) => {
    const frame = await openEpisode(session.page, EPISODE, "右クリックを試す行");
    await placeCaretAfter(frame, "右クリック");
    await frame.locator("#compose").click({ button: "right" });
    const menu = frame.locator("#menu");
    await waitUntil(async () => ((await menu.innerText().catch(() => "")) ?? "").length > 0, "右クリックの品書きが出る");
    // 品書きの1行には、名前のほかにキーの添え書きが付くことがあるので、名前の頭で見る
    const items = (await menu.innerText()).split("\n").map((line) => line.trim()).filter(Boolean);
    for (const name of await contextMenuNames()) {
      expect(
        items.some((item) => item.startsWith(name)),
        `品書きに「${name}」がありません（並び：${items.join(" / ")}）`
      ).toBe(true);
    }
  });
});

test(".txt の原稿で《《強調》》の語を選んで Ctrl+Alt+K を押し、待たずに Ctrl+S を押しても、強調の印が外れた字が保存される", async () => {
  await withVsCode(
    "txt の強調を外す",
    [{ name: EPISODE, text: "前の字と《《強調》》と後ろの字。\n" }],
    async (session) => {
      const frame = await openEpisode(session.page, EPISODE, "後ろの字");
      // 組んだ面では印（《《 》》）は見えず、語だけが傍点つきで出る。作者と同じく見えている語を選ぶ
      await selectText(frame, "強調");
      await session.page.keyboard.press("Control+Alt+KeyK");
      /*
        **画面へ送り直しが届くのを待たずに Ctrl+S を押す**（作者の裁定「調べて直す」、
        2026-10-03。設計書6.25.9）。外すのは本体のコマンドが文書へ当て、少し遅れて
        （まとめて送るので120ミリ秒ほど）画面へ送り直す。その間に押された Ctrl+S が、
        画面に残った古い字（傍点つき）を原稿へ送り直して戻していた。

        タブの未保存の印だけは待つ——本体がまだ文書へ当てていないうちに押すのは、
        作者の手では起きない別の話になる。印は細かく（10ミリ秒ごとに）見て、
        見えたらすぐ押す（waitUntil の100ミリ秒刻みだと、送り直しが届いてしまう）。
      */
      const until = Date.now() + 15_000;
      while (!(await tabIsDirty(session.page, EPISODE))) {
        if (Date.now() > until) throw new Error("Ctrl+Alt+K で文書が変わりません（タブが未保存になりません）");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // 押す直前の画面の傍点の数（1なら、送り直しがまだ届いていない＝見たい場面になっている）
      const emphasisBeforeSave = await frame.locator("#compose .emphasis").count();
      // 通った回でも、見たい場面で押せたかを読めるように残す（0 なら、この回は場面を外した）
      console.info(`[E2E] Ctrl+S を押す直前の画面の傍点：${emphasisBeforeSave}`);
      await saveAndWaitFor(session, (text) => !text.includes("《《"), "強調の印が外れてファイルに入る").catch(
        async (error: unknown) => {
          throw new Error(
            `${String(error)}（ファイル：${JSON.stringify(await fileText(session))}／押す直前の画面の傍点：${emphasisBeforeSave}／下の欄：${await footText(frame, "note")}／操作ログ：${await saveLogLines(session)}）`
          );
        }
      );
      // 保存のあとで画面からの便が遅れて当たり、文書が戻ることもない
      await waitUntil(async () => (await footText(frame, "note")).includes("保存しました"), "「保存しました」が出る");
      expect(await fileText(session)).toBe("前の字と強調と後ろの字。\n");
      expect(await tabIsDirty(session.page, EPISODE), "保存のあと、文書がまた未保存になりました（古い字で戻された）").toBe(false);
    }
  );
});

/**
 * 本体が文書を変えてから画面へ届くまで（`scheduleSend` の120ミリ秒）に打たれたとき
 * の見張り（作者の裁定「塞ぐ」、2026-10-04。設計書6.25.9）。
 *
 * 0.98.2 までは、画面は打った字を全文で送り、本体は文書との差をそのまま当てていた。
 * 画面の全文はまだ本体の変更（傍点を外した等）を知らないので、打った字の便が
 * その変更を戻していた。
 */
async function waitDirtyQuickly(session: E2ESession): Promise<void> {
  // 印は細かく（10ミリ秒ごとに）見て、見えたらすぐ打つ（100ミリ秒刻みだと送り直しが届いてしまう）
  const until = Date.now() + 15_000;
  while (!(await tabIsDirty(session.page, EPISODE))) {
    if (Date.now() > until) throw new Error("Ctrl+Alt+K で文書が変わりません（タブが未保存になりません）");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 本体の選び直し（傍点を外したあとの `select`）が画面に当たるまで待つ（2026-10-04、揺れの調べ）。
 *
 * `selectText` は、作者が見えている語を選ぶのと同じく、選択を**傍点のかたまりの中の字**
 * に置く。かたまりは編集できない（`contenteditable="false"`）ので、**そこへ打った字は
 * ブラウザが黙って捨てる**（`beforeinput` だけが起きて `input` が起きない。確かめた）。
 * 本体は外し終えると、外した語を選び直す知らせを送り、画面はそれで選択を
 * かたまりの外（かたまり全体）へ移す。その知らせは Ctrl+Alt+K の10〜17ミリ秒後に届き、
 * このテストは20〜30ミリ秒後に打つ——余裕は10ミリ秒ほどしかなく、機械が混むと逆転して、
 * 打った字が画面に入らないまま「控えの帯が出ない」で落ちた（本体の作業場で7回中1回）。
 *
 * 人の手は Ctrl+Alt+K から10ミリ秒で次の字を打てないので、ここで待つのは作者の手と
 * 同じ時機に揃えることになる。待つのは選択だけで、画面の本文（傍点が残っている
 * ＝見たい場面）は待たない。画面の中で細かく見るので、本文の送り直し（120ミリ秒）より
 * ずっと早く戻る。
 */
async function waitSelectionOutsideChunk(frame: Frame): Promise<void> {
  const moved = await frame.evaluate(async () => {
    const insideChunk = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return true;
      const range = selection.getRangeAt(0);
      const within = (node: Node) => {
        const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
        return !!element?.closest('[contenteditable="false"]');
      };
      return within(range.startContainer) || within(range.endContainer);
    };
    const until = performance.now() + 5_000;
    while (insideChunk()) {
      if (performance.now() > until) return false;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return true;
  });
  if (!moved) throw new Error("Ctrl+Alt+K のあと、5秒待っても選択が傍点のかたまりの中から動きません（本体の選び直しが届いていません）");
}

/** 落ちたときに読む操作ログの行（当て直し・ぶつかり・保存・外からの変更） */
async function rebaseLogLines(session: E2ESession): Promise<string> {
  try {
    const log = await readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8");
    return log
      .split(/\r?\n/)
      .filter((line) => /当て直|重な|［保存］|外で変わった|当てられ/.test(line))
      .join(" ／ ");
  } catch {
    return "（操作ログが読めません）";
  }
}

/**
 * 打った字の行方を、落ちた回に読めるように控える（2026-10-04、揺れの調べ）。
 *
 * 本体の作業場で「強調を外した直後に同じ所へ打つ」が1回落ちたとき、画面に打った字が無く、
 * 操作ログにも「重なった」「当て直した」が無かった。打鍵が画面（#compose）へ入らなかったのか、
 * 入って本体へ送ったが届かなかったのか、届いた本文で上書きされたのかを、写真と失敗文だけでは
 * 見分けられなかった。そこで画面の中の出来事（キー・入力・本体からの知らせ・焦点の出入り）を
 * 時刻つきで控え、**落ちたときだけ**失敗文へ添える。製品には何も足さない（画面の中の
 * イベントを外から聞くだけ）。
 */
async function traceInstall(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const holder = window as unknown as { __e2eTrace: string[]; __e2eTraceMark: (line: string) => void };
    holder.__e2eTrace = [];
    const startedAt = performance.now();
    const compose = document.getElementById("compose");
    const record = (line: string) => holder.__e2eTrace.push(`${Math.round(performance.now() - startedAt)}ms ${line}`);
    holder.__e2eTraceMark = record;
    for (const name of ["keydown", "beforeinput", "input", "compositionstart", "compositionend"]) {
      compose?.addEventListener(
        name,
        (event) => {
          const detail = event as InputEvent & KeyboardEvent;
          record(`${name} ${detail.inputType || detail.key || ""} ${JSON.stringify(compose.innerText)}`);
          // 最初の打鍵が画面に入る瞬間の傍点の数（emphasisAtFirstInput）
          if (name === "beforeinput" && (window as unknown as { __e2eEmphasisAtInput?: number }).__e2eEmphasisAtInput === undefined) {
            (window as unknown as { __e2eEmphasisAtInput?: number }).__e2eEmphasisAtInput =
              compose.querySelectorAll(".emphasis").length;
          }
        },
        true
      );
    }
    window.addEventListener(
      "message",
      (event) => {
        const message = event.data as Record<string, unknown>;
        record(
          `本体から ${String(message.type)}` +
            (typeof message.text === "string" ? ` ${JSON.stringify(message.text)}` : "") +
            (message.seq !== undefined ? ` 便${String(message.seq)}` : "") +
            (message.ok !== undefined ? ` ok=${String(message.ok)}` : "") +
            (message.conflict ? " 重なった" : "") +
            (message.start !== undefined ? ` 選ぶ${String(message.start)}-${String(message.end)}` : "")
        );
      },
      true
    );
    const name = (target: EventTarget | null) => {
      const element = target as Element | null;
      return element ? element.id || element.tagName : "なし";
    };
    document.addEventListener("focusin", (event) => record(`焦点が入る ${name(event.target)}`));
    document.addEventListener("focusout", (event) => record(`焦点が出る ${name(event.target)}`));
  });
}

/**
 * 最初の打鍵が画面に入った瞬間（beforeinput）に、画面に残っていた傍点の数（traceInstall のあと）。
 *
 * **数えるのは打つ瞬間でなければならない**（2026-10-04）。打つ前に数えると、数えてから
 * End と打鍵までの間に本体の本文が届くことがあり（機械が混むと起きた）、その回は
 * 便がふつうの道で入るのに「当て直しの道を通っていない」と誤って落ちた
 */
async function emphasisAtFirstInput(frame: Frame): Promise<number | undefined> {
  return frame.evaluate(() => (window as unknown as { __e2eEmphasisAtInput?: number }).__e2eEmphasisAtInput);
}

/** 控えに区切りを入れる（テストの側の操作の時機と、そのときの焦点） */
async function traceMark(frame: Frame, label: string): Promise<void> {
  await frame.evaluate((text) => {
    const holder = window as unknown as { __e2eTraceMark?: (line: string) => void };
    const active = document.activeElement;
    holder.__e2eTraceMark?.(
      `== ${text}（hasFocus=${String(document.hasFocus())}／焦点=${active ? active.id || active.tagName : "なし"}）`
    );
  }, label);
}

/** 落ちたときに失敗文へ添える：画面の出来事・本体の焦点・操作ログの全部 */
async function traceReport(session: E2ESession, frame: Frame): Promise<string> {
  const lines = await frame
    .evaluate(() => (window as unknown as { __e2eTrace?: string[] }).__e2eTrace ?? [])
    .catch(() => ["（画面の控えが読めません）"]);
  let log: string;
  try {
    log = await readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8");
  } catch {
    log = "（操作ログが読めません）";
  }
  const workbenchFocus = await session.page
    .evaluate(() => {
      const active = document.activeElement;
      return active ? `${active.tagName}.${String(active.className).slice(0, 80)}` : "なし";
    })
    .catch(() => "（読めません）");
  return `\n── 画面の出来事 ──\n${lines.join("\n")}\n── 本体の焦点 ──\n${workbenchFocus}\n── 操作ログ ──\n${log}`;
}

test("Ctrl+Alt+K で強調を外した直後、画面へ届く前に行末へ字を打っても、外した印は戻らず打った字も入る", async () => {
  await withVsCode(
    "強調を外した直後に打つ",
    [{ name: EPISODE, text: "前の字と《《強調》》と後ろの字。\n" }],
    async (session) => {
      const frame = await openEpisode(session.page, EPISODE, "後ろの字");
      await selectText(frame, "強調");
      await traceInstall(frame);
      await traceMark(frame, "Ctrl+Alt+K を押す");
      await session.page.keyboard.press("Control+Alt+KeyK");
      await waitDirtyQuickly(session);
      await waitSelectionOutsideChunk(frame);
      // 打つ直前の画面の傍点の数（1なら、送り直しがまだ届いていない＝見たい場面）
      const emphasisBeforeTyping = await frame.locator("#compose .emphasis").count();
      await traceMark(frame, `End を押して字を打つ（画面の傍点：${emphasisBeforeTyping}）`);
      console.info(`[E2E] 字を打つ直前の画面の傍点：${emphasisBeforeTyping}`);
      // 本体の変更（印を外した所）と重ならない所＝行末へ打つ
      await session.page.keyboard.press("End");
      await session.page.keyboard.insertText("あ");
      await traceMark(frame, "打ち終えた");
      const expected = "前の字と強調と後ろの字。あ\n";
      const withTrace = async (error: unknown): Promise<never> => {
        throw new Error(
          `${String(error)}（ファイル：${JSON.stringify(await fileText(session))}／打つ直前の傍点：${emphasisBeforeTyping}／画面：${JSON.stringify(await composeText(frame))}／操作ログ：${await rebaseLogLines(session)}）${await traceReport(session, frame)}`
        );
      };
      await waitUntil(async () => (await composeText(frame)).includes("後ろの字。あ"), "打った字が画面に出る").catch(
        withTrace
      );
      await saveAndWaitFor(session, (text) => text.includes("あ"), "打った字がファイルに入る").catch(withTrace);
      await waitUntil(async () => (await footText(frame, "note")).includes("保存しました"), "「保存しました」が出る");
      expect(
        await fileText(session),
        `外した強調の印が、打った字の便で戻されました（打つ直前の傍点：${emphasisBeforeTyping}／操作ログ：${await rebaseLogLines(session)}）`
      ).toBe(expected);
      /*
        打つ直前に傍点が残っていた（＝本体の変更がまだ画面へ届いていなかった）回は、
        本体が当て直しの道を通ったはず。届いたあとに打った回は、ふつうの道で通る
        （その回はこの見張りの場面を外しているが、落とさずに上の記録で分かる）
      */
      const emphasisAtInput = await emphasisAtFirstInput(frame);
      if (emphasisAtInput === 1) {
        expect(
          await rebaseLogLines(session),
          `当て直しの道を通っていません（打った瞬間の傍点：${emphasisAtInput}）${await traceReport(session, frame)}`
        ).toContain("当て直しました");
      }
      // 画面も両方を含む本文へ揃う（傍点は消え、打った字は残る）
      await waitUntil(
        async () =>
          (await composeText(frame)).includes("前の字と強調と後ろの字。あ") &&
          (await frame.locator("#compose .emphasis").count()) === 0,
        "画面が、印を外して字を足した本文へ揃う"
      );
    }
  );
});

/**
 * 傍点を外した直後、本体の本文が画面へ届く前に**カーソルを動かした**とき（2026-10-04、
 * ノートPCで「行末へ打つ」が毎回落ちた調べで見つけた。実装ルール1）。
 *
 * 本体は外し終えると「外した語を選び直す」知らせ（select）を送り、画面はそれを覚えて、
 * あとから届く本文で組み直すときにも当て直していた。その間に作者が End で行末へ
 * 動いても、組み直しで**選択が語へ戻り**、続けて打った字が**外した語を置き換えて**
 * 原稿へ入った（「前の字とあと後ろの字。」。本体から見れば作者の正当な編集なので、
 * 記録も帯も出ない）。遅い機械ほど本文が届くまでが長く、毎回起きた。
 *
 * 見張ること：選び直しのあとに作者が動かしたカーソルは、組み直しのあとも作者が
 * 動かした所にある。打った字は行末に入り、外した語は残る。
 */
test("Ctrl+Alt+K で強調を外した直後に End で行末へ動くと、画面へ本文が届いて組み直したあとも、カーソルは行末に残り、打った字が外した語を置き換えない", async () => {
  await withVsCode(
    "強調を外した直後に動いてから打つ",
    [{ name: EPISODE, text: "前の字と《《強調》》と後ろの字。\n" }],
    async (session) => {
      const frame = await openEpisode(session.page, EPISODE, "後ろの字");
      await selectText(frame, "強調");
      await traceInstall(frame);
      await traceMark(frame, "Ctrl+Alt+K を押す");
      await session.page.keyboard.press("Control+Alt+KeyK");
      await waitDirtyQuickly(session);
      await waitSelectionOutsideChunk(frame);
      await session.page.keyboard.press("End");
      // End のときに傍点がまだ画面にあれば、見たい場面（組み直しが End のあとに来る）
      const emphasisAtEnd = await frame.locator("#compose .emphasis").count();
      await traceMark(frame, `End を押した（画面の傍点：${emphasisAtEnd}）`);
      console.info(`[E2E] End を押した直後の画面の傍点：${emphasisAtEnd}`);
      // 本体の本文が届いて組み直されるまで待つ（傍点が消える）
      await waitUntil(
        async () => (await frame.locator("#compose .emphasis").count()) === 0,
        "本体の本文が届いて、画面の傍点が消える"
      );
      const report = async () => `（End のときの傍点：${emphasisAtEnd}）${await traceReport(session, frame)}`;
      const caret = await caretPosition(frame);
      expect(
        { caret, collapsed: await selectionCollapsed(frame) },
        `組み直しのあと、カーソルが行末にありません${await report()}`
      ).toEqual({ caret: { lineText: "前の字と強調と後ろの字。", column: 12 }, collapsed: true });
      await session.page.keyboard.insertText("あ");
      await saveAndWaitFor(session, (text) => text.includes("あ"), "打った字がファイルに入る");
      expect(await fileText(session), `打った字が行末に入っていません${await report()}`).toBe(
        "前の字と強調と後ろの字。あ\n"
      );
    }
  );
});

test("Ctrl+Alt+K で強調を外した直後、画面へ届く前に同じ語の上へ打つと、外した印は戻らず、打った字は控えとして［戻す］の帯に残る", async () => {
  await withVsCode(
    "強調を外した直後に同じ所へ打つ",
    [{ name: EPISODE, text: "前の字と《《強調》》と後ろの字。\n" }],
    async (session) => {
      const frame = await openEpisode(session.page, EPISODE, "後ろの字");
      await selectText(frame, "強調");
      await traceInstall(frame);
      await traceMark(frame, "Ctrl+Alt+K を押す");
      await session.page.keyboard.press("Control+Alt+KeyK");
      await waitDirtyQuickly(session);
      await waitSelectionOutsideChunk(frame);
      const emphasisBeforeTyping = await frame.locator("#compose .emphasis").count();
      await traceMark(frame, `字を打つ（画面の傍点：${emphasisBeforeTyping}）`);
      console.info(`[E2E] 字を打つ直前の画面の傍点：${emphasisBeforeTyping}`);
      // 選んだままの語の上へ打つ＝本体の変更と同じ所。どちらが正しいかは機械には決められない
      await session.page.keyboard.insertText("あ");
      await traceMark(frame, "打ち終えた");
      /*
        **打つ瞬間までに本体の本文が届いていた回は、見たい場面を外している**（機械が混むと
        起きる。2026-10-04）。そのとき作者は、傍点の外れた語を選んで打ったことになるので、
        語が打った字に置き換わり、帯は出ないのが正しい。その形を確かめて終える
      */
      if ((await emphasisAtFirstInput(frame)) === 0) {
        console.info("[E2E] 打つ瞬間に本体の本文が届いていたので、ふつうの置き換えとして確かめます");
        await saveAndWaitFor(session, (text) => text.includes("あ"), "打った字がファイルに入る");
        expect(await fileText(session)).toBe("前の字とあと後ろの字。\n");
        expect(
          await frame.evaluate(() => document.getElementById("rescue")?.classList.contains("open") === true),
          "本文が届いてから打ったのに、控えの帯が出ました"
        ).toBe(false);
        return;
      }
      // 打った字は、黙って捨てずに帯で知らせる
      await waitUntil(
        async () => frame.evaluate(() => document.getElementById("rescue")?.classList.contains("open") === true),
        "打った字の控えの帯が出る"
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（ファイル：${JSON.stringify(await fileText(session))}／打つ直前の傍点：${emphasisBeforeTyping}／画面：${JSON.stringify(await composeText(frame))}／操作ログ：${await rebaseLogLines(session)}）${await traceReport(session, frame)}`
        );
      });
      const bar = await frame.evaluate(() => document.getElementById("rescueText")?.textContent ?? "");
      expect(bar).toContain("重な");
      try {
        /*
          **帯が出たら、待たずに［戻す］［それでも戻す］を押す**（作者の裁定、2026-10-04。設計書6.25.9）。
          0.98.6 までは、本体は断ったあとの本文を120ミリ秒まとめて（続く変更で延ばして）送っていたので、
          帯が出てすぐ押すと、画面は傍点を外す前の本文を元にして戻す便を送り、本体はもう一度
          「重なった」と断って帯を出し直していた（同時に走らせて16回中3回。このテストは、本体の本文が
          画面に届くのを待ってから押して避けていた）。いまは断った直後だけ待たずに送るので、
          待ちを外しても一度で通る。保存（Ctrl+S）も挟まない——挟むと、その待ちで本文が届いてしまう
        */
        await traceMark(frame, "［戻す］を押す");
        await frame.locator("#rescueRestore").click();
        const confirm = await frame.evaluate(() => document.getElementById("rescueRestore")?.textContent ?? "");
        expect(confirm).toBe("それでも戻す");
        await traceMark(frame, "［それでも戻す］を押す");
        await frame.locator("#rescueRestore").click();
        // 一度で通る：帯は閉じたまま、出し直されない
        await holdsFor(
          async () =>
            !(await frame.evaluate(() => document.getElementById("rescue")?.classList.contains("open") === true)),
          "［それでも戻す］のあと、帯が閉じたまま（二度目の「重なった」で出し直されない）",
          1_500
        );
        await waitUntil(async () => (await composeText(frame)).includes("前の字とあと後ろの字。"), "打った字が画面へ戻る");
        await traceMark(frame, "Ctrl+S（戻した字を保存）");
        await saveAndWaitFor(session, (text) => text.includes("あ"), "打った字がファイルに入る");
        expect(await fileText(session)).toBe("前の字とあと後ろの字。\n");
      } catch (error) {
        // どの段で落ちても、打った字の行方を読めるようにする
        const barNow = await frame
          .evaluate(() => document.getElementById("rescueText")?.textContent ?? "")
          .catch(() => "（読めません）");
        if (error instanceof Error) {
          error.message += `（ファイル：${JSON.stringify(await fileText(session))}／画面：${JSON.stringify(await composeText(frame))}／帯：${JSON.stringify(barNow)}）${await traceReport(session, frame)}`;
        }
        throw error;
      }
    }
  );
});
