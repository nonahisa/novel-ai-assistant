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

/** 試し用の VS Code の本体の exe の名前（`.vscode-test` の Code.exe） */
function exeName(session: E2ESession): string {
  const spawned = session.app.process().spawnfile;
  return spawned ? path.basename(spawned) : "Code.exe";
}

/**
 * 1つの試しの中で、本物の IME で打つ口。`runRealImeTest` が作って本体へ渡す。
 *
 * **最初の1打だけを別に送り、殻の合図で Setsuna かを確かめてから残りを送る**（打つ先が Setsuna でなければ、
 * 残りの打鍵はほかの入力の打鍵になるだけなので打たない）。変換中の字は台本の呼び出しをまたいで続く
 */
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
  async type(frame: Frame, steps: readonly KeyStep[]): Promise<void> {
    if (Date.now() - this.refreshedAt > REFRESH_AFTER_MS) {
      await trialRefresh(this.session.workFolder);
      this.refreshedAt = Date.now();
    }
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

  private async send(frame: Frame, steps: readonly KeyStep[]): Promise<void> {
    // **台本を呼ぶ直前に毎回**、焦点が試し用の窓（とその原稿エディターの面）にあるかを確かめる
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
