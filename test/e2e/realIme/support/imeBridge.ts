/**
 * 本物の日本語入力（オリジナルIME。殻は Setsuna）で、OS のキーを原稿エディターへ打つ部品（2026-11-15 作者の依頼）。
 *
 * ふだんの画面の自動テストは、字を確定した形で入れる（`keyboard.insertText`）か、Chromium の変換の口
 * （CDP の `Input.imeSetComposition`）を使う。どちらも本物の IME を通らないので、「「 を確定すると 」 が付いて
 * カーソルが間に来る」のような、IME と原稿エディターのやり取りは見張れない。ここでは IME の側の台本
 * （`imeScripts.ts`）で Windows のキーを送り、本物の変換の流れのまま打つ。
 *
 * ## 作者の窓へ打たないための守り（三重）
 * 1. 門：`NOVELAI_REAL_IME=1` が無ければ試しを流さない（`imeScripts.ts` の `REAL_IME_ENABLED`）
 * 2. 統合の側：台本を呼ぶ**直前に毎回** `assertTestWindowFocused`（本体と画面の中で焦点が試しの窓にあるか）
 * 3. IME の側：台本が1打ごとに、前の窓のプロセス名・起動の引数（その回の `--user-data-dir`）・題名の印を確かめる
 *
 * 落ちても、試しの前に控えた作者の IME の状態は `-After` で必ず戻す（`runRealImeTest` の finally）。
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import type { TestContext } from "vitest";
import {
  assertTestWindowFocused,
  ForegroundRefusedError,
  withVsCode,
  type E2ESession,
  type FixtureEpisode,
  type LaunchOptions,
} from "../../support/vscodeApp";
import {
  assertSetsunaActive,
  describeRun,
  missingScripts,
  RigNotReady,
  runTrialScript,
  SCRIPT_SEND_KEYS,
  shellMark,
  shellSince,
  trialAfter,
  trialBefore,
  trialRefresh,
  type ShellMark,
  type ShellSignals,
} from "./imeScripts";

export { REAL_IME_ENABLED } from "./imeScripts";

/**
 * 試し用の窓の題名に入れる印（`window.title`）。IME の側の台本へ `-TitleContains` で渡し、
 * 題名でも試し用の窓かを確かめさせる。英数字だけにする（台本の `-like` と文字コードで揺れないように）
 */
export const TITLE_MARK = "NOVELAI-REALIME";

/** IME の側の台本が、15分を超えた試しの知らせを古いとみなすので、その手前で書き直す */
const REFRESH_AFTER_MS = 10 * 60_000;

/** 打つものの1段（IME の側の台本の書き方。`romaji:kareha`・`key:SPACE`・`char:[`・`ctrl:s`・`wait:500`） */
export type KeyStep = string;

interface SendKeysJson {
  sent?: number;
  stopped?: string | null;
}

/** 打った先の IME が止めた（前の窓が試し用でない）。作者の窓へ移った疑いがあるので、続きは打たない */
export class TypingStopped extends Error {}

/** その回の試し用の VS Code の `--user-data-dir`（`vscodeApp.ts` の launch が一時フォルダーの根の下に作る） */
function userDataDir(session: E2ESession): string {
  return path.join(session.root, "user-data");
}

/**
 * 試し用の VS Code の本体の exe の名前（`.vscode-test` の Code.exe）。
 * **起こしたプロセスの名前（spawnfile）は使わない**——Windows では Playwright が cmd.exe を通して起こすので
 * cmd.exe になり、IME の側が「前の窓が cmd.exe ではない」と打つのを止めた（2026-11-16）
 */
function exeName(_session: E2ESession): string {
  return "Code.exe";
}

/**
 * PowerShell の台本を走らせて、標準出力を返す（走らなければ undefined）。
 *
 * **台本は -EncodedCommand（UTF-16LE の base64）で渡す。** -Command に文字列で渡すと、Node が引数の
 * 引用符を打ち消す形と PowerShell 5.1 の読み方が合わず、Add-Type の中の "user32.dll" で文字列が切れて
 * Add-Type が黙って失敗し、前面の窓はいつも「Idle」（番号 0 のプロセス）と読めていた（2026-11-16。
 * 外から測ると前面はずっとこの PC のアプリだった）。失敗は標準エラーにだけ出て終了コードは 0 だった
 */
async function runPowerShell(script: string): Promise<string | undefined> {
  const { execFile } = await import("node:child_process");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { windowsHide: true },
      (error, stdout) => {
        /*
          標準エラーは見ない。-EncodedCommand では Add-Type の進み具合が CLIXML で標準エラーへ出る（失敗ではない）。
          台本の中で失敗したときは、標準出力が空になるので、読む側が undefined に倒す
        */
        resolve(error ? undefined : String(stdout).trim());
      }
    );
  });
}

const USER32 = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class NovelaiWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")] public static extern uint ThreadOf(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
`;

/** OS で前に出ている窓のプロセスの名前（Windows。読めなければ undefined。前面の窓が無ければ "none"。日本語は標準出力の文字コードで化けるので使わない） */
async function osForegroundProcess(): Promise<string | undefined> {
  const out = await runPowerShell(
    USER32 +
      "$p = 0; [void][NovelaiWin]::GetWindowThreadProcessId([NovelaiWin]::GetForegroundWindow(), [ref]$p)\n" +
      "if ($p -eq 0) { 'none' } else { (Get-Process -Id $p).ProcessName }\n"
  );
  return out === undefined || out === "" ? undefined : out;
}

/**
 * 窓（ハンドルの数）を、OS の前面へ出す。Windows は前面に無いプロセスからの SetForegroundWindow を断るので、
 * いま前面にある窓のスレッドの入力へ一時的につないでから（AttachThreadInput）出す
 */
async function raiseWindowByHandle(handle: string): Promise<void> {
  if (!/^\d+$/.test(handle)) return;
  await runPowerShell(
    USER32 +
      `$h = [IntPtr]::new([Int64]${handle})` + "\n" +
      "$me = [NovelaiWin]::GetCurrentThreadId(); $other = [NovelaiWin]::ThreadOf([NovelaiWin]::GetForegroundWindow(), [IntPtr]::Zero)\n" +
      "$attached = $other -ne 0 -and $other -ne $me -and [NovelaiWin]::AttachThreadInput($me, $other, $true)\n" +
      "if ([NovelaiWin]::IsIconic($h)) { [void][NovelaiWin]::ShowWindow($h, 9) }\n" +
      "[void][NovelaiWin]::BringWindowToTop($h); [void][NovelaiWin]::SetForegroundWindow($h)\n" +
      "if ($attached) { [void][NovelaiWin]::AttachThreadInput($me, $other, $false) }\n"
  );
}

/**
 * **OS で前に出ているのが試し用の VS Code か**を確かめ、違えば前面を取り直す（3回まで）。
 * Electron の側の「焦点がある」は、Windows が前面を渡さなかったときも真を返すことがあった
 * （2026-11-16、前に出ていたのはこのセッションのアプリ claude.exe だった）。取れなければ打たずに飛ばす。
 *
 * 前面を取り直すときは、窓をしまって戻す形（minimize → restore）を使わず、窓のハンドルを OS の側から前へ出す
 * （しまった瞬間は前面の窓が無くなり、入力につなぐ先が無くなる）
 */
/** OS で前に出ているのが試し用の VS Code か */
async function isOsForegroundTestWindow(): Promise<boolean> {
  const name = await osForegroundProcess();
  return name !== undefined && /^code$/i.test(name);
}

async function ensureOsForeground(session: E2ESession): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const name = await osForegroundProcess();
    if (name !== undefined && /^code$/i.test(name)) return;
    const handle = await session.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return undefined;
      win.show();
      return win.getNativeWindowHandle().readBigUInt64LE(0).toString();
    });
    if (handle !== undefined) await raiseWindowByHandle(handle);
    await session.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.focus();
      win?.webContents.focus();
    });
    await session.page.waitForTimeout(800);
  }
  const last = await osForegroundProcess();
  if (last !== undefined && /^code$/i.test(last)) return;
  throw new ForegroundRefusedError(`OS で前に出ている窓が試し用の VS Code になりません（いま前にあるのは ${last ?? "不明"}）。打たずに飛ばします`);
}

/**
 * 1つの試しの中で、本物の IME で打つ口。`runRealImeTest` が作って本体へ渡す。
 *
 * **最初の1打だけを別に送り、殻の合図で Setsuna かを確かめてから残りを送る**（打つ先が Setsuna でなければ、
 * 残りの打鍵はほかの入力の打鍵になるだけなので打たない）。変換中の字は台本の呼び出しをまたいで続く
 */
/** 原稿エディターの組んで書く面。`RealIme.type` の焦点の既定 */
const COMPOSE_SELECTOR = "#compose";

export interface TypeOptions {
  /**
   * 打つ前に焦点を置く欄（既定は原稿の面 `#compose`）。原稿の面のときだけ、置いたカーソルを控えて当て直す。
   * ほかの欄（プロットモードの相談の欄など）へ打つ試しのために足した（2026-11-16）
   */
  focus?: string;
}

export class RealIme {
  private checked = false;
  private stepFiles = 0;
  private refreshedAt = Date.now();

  constructor(
    readonly session: E2ESession,
    /** VS Code を起こす前に取った殻の記録の位置（殻が起きた行もこのあとに入る） */
    private readonly launchMark: ShellMark
  ) {}

  /** いまの殻の記録の位置（打つ前に取り、`signalsSince` で読む。括弧の対・カーソルの置き直しを報告に添える） */
  mark(): Promise<ShellMark> {
    return shellMark();
  }

  signalsSince(mark: ShellMark): Promise<ShellSignals> {
    return shellSince(mark);
  }

  /**
   * `steps` を本物の IME で打つ。`frame` は打つ先の原稿エディターの面（焦点がその面の中にあることも確かめる）。
   * 呼ぶたびに、台本を呼ぶ直前に `assertTestWindowFocused` を通す
   */
  async type(frame: Frame, steps: readonly KeyStep[], options: TypeOptions = {}): Promise<void> {
    await this.prepare(frame, options.focus);
    await this.sendChecked(frame, steps);
  }

  /**
   * `steps`（読みを打って SPACE で候補の窓を出し、少し待つところまで）を打ち、**出た候補の窓の並びを殻の合図から読んで**、
   * `target` の番目まで DOWN（UP）で動かして ENTER で確定する（2026-11-16）。
   *
   * **番目を決め打ちしない。** 候補の並びは作者の学習（フロントエンドとエンジンのアプリごとの学習）・裏の並べ直し・
   * 作品の辞書で替わる。「何もしなければ 『 が2番目」と決め打ちすると、作者の機械では 『 がもう1番目で、DOWN 1回で
   * 「 を確定して落ちていた（novel-ime の見立て）。`target` が並びに無ければ、IME の候補の不具合として落とす
   */
  async typeAndChoose(frame: Frame, steps: readonly KeyStep[], target: string): Promise<void> {
    await this.prepare(frame);
    const mark = await shellMark();
    await this.sendChecked(frame, steps);
    const window = (await shellSince(mark)).lastCandidates;
    /*
      **並びが読めないときは、落とさずに飛ばす**（2026-11-16）。SPACE の前に答えが届いてその場で窓を開く道では、
      古いフロントエンドは並びを tsf.log に書かない（setsuna 4279e5a で書くようにした。効くのはデスクトップの
      フロントエンドを BB929CCF 以降へ入れ替えてから）。製品の不具合ではないので、IME の記録待ちとして飛ばす
    */
    if (!window) {
      throw new RigNotReady(
        `候補の窓の並びが殻の記録にありません（「${target}」を選べません）。IME の記録待ち：デスクトップのフロントエンドが BB929CCF より前だと、SPACE の前に答えが届いた窓の並びを書きません`
      );
    }
    const at = window.list.indexOf(target);
    if (at < 0) {
      throw new Error(`候補の窓に「${target}」がありません（並び：${JSON.stringify(window.list)}・選んでいる番目 ${window.selected}）`);
    }
    const move = at - window.selected;
    const key: KeyStep = move >= 0 ? "key:DOWN" : "key:UP";
    await this.send(frame, [...Array.from({ length: Math.abs(move) }, () => key), "wait:200", "key:ENTER"]);
  }

  /** 打ち始める前に1回：長い試しなら試しの作品の知らせを書き直し、前面とカーソルを整える */
  private async prepare(frame: Frame, focus = COMPOSE_SELECTOR): Promise<void> {
    if (Date.now() - this.refreshedAt > REFRESH_AFTER_MS) {
      await trialRefresh(this.session.workFolder);
      this.refreshedAt = Date.now();
    }
    /*
      **前面とカーソルを整えるのは、1打目の前に1回だけ**（2026-11-16。IME の記録との突き合わせ）。前は送るたびに
      前面を取り直してカーソルを置き直していたので、最初の1打を送ってから残りを送るまでの約4.5秒の間に、
      変換中の字（「k」）を Chromium が確定し、続きは置き直したカーソル（末尾）へ入っていた
    */
    await this.prepareFocus(frame, focus);
  }

  /** 最初の1打だけを別に送って Setsuna かを確かめ（1回目だけ）、残りを送る */
  private async sendChecked(frame: Frame, steps: readonly KeyStep[]): Promise<void> {
    let rest = [...steps];
    if (!this.checked) {
      const [first, after] = splitFirstKey(rest);
      await this.send(frame, first);
      // 殻が記録を書き終わるのを少し待つ（記録は打鍵のたびに追記される）
      await frame.page().waitForTimeout(400);
      assertSetsunaActive(await shellSince(this.launchMark), exeName(this.session));
      this.checked = true;
      rest = after;
    }
    if (rest.length > 0) await this.send(frame, rest);
  }

  /**
   * 前面を試し用の窓にし、原稿の面へ焦点とカーソルを戻す（打ち始める前に1回）。
   */
  private async prepareFocus(frame: Frame, focus: string): Promise<void> {
    if (focus !== COMPOSE_SELECTOR) {
      // 原稿の面でない欄（プロットモードの相談の欄など）は、前面を整えてからその欄へ焦点を置くだけ（カーソルは末尾のまま）
      const raised = !(await isOsForegroundTestWindow());
      await ensureOsForeground(this.session);
      if (raised) await frame.page().waitForTimeout(1_500);
      await frame.locator(focus).focus();
      return;
    }
    /*
      **置いたカーソルを、前面を取り直したあとに置き直す**（2026-11-16）。窓が前へ出て焦点が戻ると、原稿の面の
      カーソルが末尾へ動き、行の頭で打つはずの字が文書の終わりに入った。取り直す間に焦点が一度外れると、原稿
      エディターは書きかけを送って面を組み直す（blur → flushUnsent）ので、選択の Range は古い要素を指したまま
      使えなくなる。**何番目の字の節の何字目か**で控え、焦点を戻したあとに組み直された面で当て直す
    */
    await frame
      .evaluate(() => {
        const compose = document.getElementById("compose");
        const selection = window.getSelection();
        const box = window as unknown as { __novelaiImeOffset?: { node: number; offset: number } };
        box.__novelaiImeOffset = undefined;
        if (!compose || !selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (!compose.contains(range.startContainer)) return;
        // **何番目の字の節の何字目か**で控える（字の数で控えると改行が数に入らず、行の境で前の行の末尾と次の行の
        // 頭を取り違えた。2026-11-16 かぎ括弧の対の試しで「あ」が前の行の末尾に入った）
        if (range.startContainer.nodeType !== Node.TEXT_NODE) return;
        const walker = document.createTreeWalker(compose, NodeFilter.SHOW_TEXT);
        let index = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode(), index++) {
          if (node === range.startContainer) {
            box.__novelaiImeOffset = { node: index, offset: range.startOffset };
            return;
          }
        }
      })
      .catch(() => undefined);
    const raised = !(await isOsForegroundTestWindow());
    await ensureOsForeground(this.session);
    // 焦点が一度外れたなら、面の組み直し（拡張機能との往復）が済むのを待ってから当て直す
    if (raised) await frame.page().waitForTimeout(1_500);
    // 原稿の面へ焦点を戻し、控えた選択を当て直す
    await frame.locator("#compose").focus().catch(() => undefined);
    await frame
      .evaluate(() => {
        const box = window as unknown as { __novelaiImeOffset?: { node: number; offset: number } };
        const saved = box.__novelaiImeOffset;
        const compose = document.getElementById("compose");
        if (saved === undefined || !compose) return;
        // 組み直された面でも字の節の並びは同じなので、同じ番目の節の同じ字へ当て直す
        const walker = document.createTreeWalker(compose, NodeFilter.SHOW_TEXT);
        let index = 0;
        let last: Text | undefined;
        for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null, index++) {
          last = node;
          if (index === saved.node) {
            const range = document.createRange();
            range.setStart(node, Math.min(saved.offset, node.length));
            range.collapse(true);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            return;
          }
        }
        if (last) window.getSelection()?.collapse(last, last.length);
      })
      .catch(() => undefined);
  }

  private async send(frame: Frame, steps: readonly KeyStep[]): Promise<void> {
    // **台本を呼ぶ直前に毎回**、焦点が試し用の窓（とその原稿エディターの面）にあるかを確かめる（窓もカーソルも動かさない）
    await assertTestWindowFocused(this.session, frame);
    /*
      段は JSON のファイルで渡す（-StepsFile）。`powershell -File` に JSON を直に渡すと引用符が落ちる。
      置き場は一時フォルダーの根（試しのあとに VS Code ごと消える）
    */
    const file = path.join(this.session.root, `realime_steps_${++this.stepFiles}.json`);
    await writeFile(file, JSON.stringify(steps), "utf8");
    const run = await runTrialScript<SendKeysJson>(SCRIPT_SEND_KEYS, [
      "-Process",
      exeName(this.session),
      "-CommandLineContains",
      userDataDir(this.session),
      "-TitleContains",
      TITLE_MARK,
      "-StepsFile",
      file,
      /*
        **窓のまん中を押させない**（2026-11-16）。IME の側の台本は題名の印を渡されると、打つ前に前の窓のまん中を
        本物のマウスで1回押す（頁の試しで textarea へ焦点を置くため。novel-ime fc7b4f8）。VS Code ではまん中が
        原稿エディターの面の上にあり、短い本文では字の無い所を押すのでカーソルが文書の末尾へ動き、置いたカーソル
        でなく末尾に字が入っていた。焦点とカーソルは `prepareFocus` が置く
      */
      "-NoClick",
    ]);
    if (run.code === 0) return;
    if (run.code === 2) {
      throw new TypingStopped(
        `打つ先が試し用の窓でないので、IME の側が打つのを止めました（${run.json?.stopped ?? "理由不明"}。` +
          `打った数 ${String(run.json?.sent ?? "?")}）。残りは打っていません。${describeRun(SCRIPT_SEND_KEYS, run)}`
      );
    }
    throw new Error(`キーを送れませんでした。${describeRun(SCRIPT_SEND_KEYS, run)}`);
  }
}

/**
 * 段の並びの、最初の1打だけを切り出す（`romaji:kareha` なら `romaji:k` と `romaji:areha`）。
 * `wait:` は打鍵でないので、最初の打鍵の前の待ちは最初の側に入れる
 */
export function splitFirstKey(steps: readonly KeyStep[]): [KeyStep[], KeyStep[]] {
  const first: KeyStep[] = [];
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const [kind, arg = ""] = splitStep(step);
    if (kind === "wait") {
      first.push(step);
      continue;
    }
    if (kind === "romaji" && arg.length > 1) {
      return [[...first, `romaji:${arg[0]}`], [`romaji:${arg.slice(1)}`, ...steps.slice(index + 1)]];
    }
    return [[...first, step], steps.slice(index + 1)];
  }
  return [first, []];
}

function splitStep(step: KeyStep): [string, string | undefined] {
  const at = step.indexOf(":");
  return at < 0 ? [step, undefined] : [step.slice(0, at), step.slice(at + 1)];
}

/**
 * 本物の IME の試しを1件流す：VS Code を前に出して起こし、試しの前の控えを取り、本体を走らせ、
 * **落ちても必ず**試しの後の戻しをする。台が整っていない（IME の部品が無い・Setsuna で始まらない・
 * 前面を取れない）ときは、落とさずに理由を出して飛ばす（`ctx.skip`）。
 *
 * - 殻の記録の位置は **VS Code を起こす前に**取る。殻が起きた行（`process …`・`mode on=…`）は、
 *   窓が初めて入力を受け取るときに書かれ、打つ直前に取ると範囲の外になって毎回「Setsuna でない」と取り違える
 * - 窓の題名に印（`TITLE_MARK`）を入れる（IME の側の台本が題名でも確かめる）
 */
export async function runRealImeTest(
  ctx: TestContext,
  name: string,
  episodes: readonly FixtureEpisode[],
  body: (session: E2ESession, ime: RealIme) => Promise<void>,
  options: LaunchOptions = {}
): Promise<void> {
  const missing = missingScripts();
  if (missing) skipBecause(ctx, missing);
  try {
    const launchMark = await shellMark();
    await withVsCode(
      `本物のIME ${name}`,
      episodes,
      async (session) => {
        await trialBefore(session.workFolder);
        let failed = true;
        try {
          await body(session, new RealIme(session, launchMark));
          failed = false;
        } finally {
          // 本体が落ちていても戻す。戻しが落ちたときは、本体の失敗を隠さないよう、本体が通ったときだけ投げる
          try {
            await trialAfter();
          } catch (error) {
            if (!failed) throw error;
            console.error(`[本物のIME] ${String(error)}`);
          }
        }
      },
      {
        ...options,
        foreground: true,
        settings: { "window.title": `${TITLE_MARK} \${activeEditorShort}`, ...options.settings },
      }
    );
  } catch (error) {
    if (error instanceof RigNotReady || error instanceof ForegroundRefusedError) skipBecause(ctx, error.message);
    throw error;
  }
}

function skipBecause(ctx: TestContext, reason: string): never {
  const note = `台が整っていないので流しませんでした：${reason}`;
  console.error(`[本物のIME] ${note}`);
  return ctx.skip(note);
}

/** 失敗の文に添える、殻の合図の要約（括弧の対・カーソルの置き直し・殻が受けたキーの数） */
export function describeSignals(signals: ShellSignals): string {
  return `殻の合図：pairs ${JSON.stringify(signals.pairs)}・carets ${JSON.stringify(signals.carets)}・keys ${signals.keys}・editFailed ${signals.editFailed}`;
}
