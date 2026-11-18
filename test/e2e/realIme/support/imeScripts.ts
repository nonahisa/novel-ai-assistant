/**
 * 本物の日本語入力（オリジナルIME。殻は Setsuna）で打つ試しの、**IME の側の台本を呼ぶ口**（2026-11-15 作者の依頼）。
 *
 * 台本は別のリポジトリ（novel-ime の `試作/本物のIMEの試し/`）にあり、ここでは読んで呼ぶだけ。
 * どれも `powershell -NoProfile -ExecutionPolicy Bypass -File <台本> …` で呼ぶと1行の JSON を出し、
 * 終わりの番号は 0＝済んだ・1＝使い方の誤り（置き場が無いなど）・2＝打つ先が試し用の窓でないので止めた。
 *
 * このファイルは Playwright を読み込まない（走りの最初と最後の片づけ `globalSetup.ts` からも使うため）。
 * 打つ部品は `imeBridge.ts`。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * 門：環境変数 `NOVELAI_REAL_IME=1` が無ければ、どの試しも流さない。
 *
 * 本物の打鍵は前に出ている窓へ届く。うっかり流して、作者が使っている窓へ打たないため。
 * 台本が PowerShell と Windows のキーの注入なので、Windows でだけ開く
 */
export const REAL_IME_ENABLED = process.env.NOVELAI_REAL_IME === "1" && process.platform === "win32";

/**
 * 台本の置き場。環境変数 `NOVEL_IME_TRIAL_DIR` があればそこ（ノートPCは展開先が違う）、
 * 無ければ作者の機械の置き場（ホームの Documents の下の rittoku-ime。改名前の novel-ime しか無ければそちら。
 * リポジトリの改名は IME の改名の最後の段で、日はまだ決まっていない。2026-11-18 夜）
 */
export function trialDir(): string {
  if (process.env.NOVEL_IME_TRIAL_DIR) return process.env.NOVEL_IME_TRIAL_DIR;
  const docs = path.join(homedir(), "Documents");
  const renamed = path.join(docs, "rittoku-ime", "試作", "本物のIMEの試し");
  return existsSync(renamed) ? renamed : path.join(docs, "novel-ime", "試作", "本物のIMEの試し");
}

export const SCRIPT_SEND_KEYS = "キーを送る.ps1";
export const SCRIPT_SHELL_SIGNALS = "殻の合図.ps1";
export const SCRIPT_BEFORE_AFTER = "試しの前後.ps1";

/**
 * 台が整っていない（IME の部品が無い・Setsuna で始まらない・前面を取れない など）。
 * **製品の不具合ではない**ので、試しは落とさずに理由を出して飛ばす
 */
export class RigNotReady extends Error {}

/** 台本が3つとも置き場にあるか。無ければ、その理由 */
export function missingScripts(): string | undefined {
  const dir = trialDir();
  const missing = [SCRIPT_SEND_KEYS, SCRIPT_SHELL_SIGNALS, SCRIPT_BEFORE_AFTER].filter(
    (name) => !existsSync(path.join(dir, name))
  );
  if (missing.length === 0) return undefined;
  return `IME の側の台本が置き場にありません（${missing.join("・")}。置き場：${dir}。別の置き場なら環境変数 NOVEL_IME_TRIAL_DIR で渡す）`;
}

export interface ScriptRun<T> {
  /** 終わりの番号（0・1・2。台本が動かなかったときは -1） */
  code: number;
  /** 出した1行の JSON（読めなければ undefined） */
  json: T | undefined;
  stdout: string;
  stderr: string;
}

/**
 * 台本を1つ呼ぶ。終わりの番号が 0 でなくても投げずに返す（番号ごとの扱いは呼び手が決める）。
 *
 * - **shell を通さない**（`execFile`）。引数の「||」や日本語の道を cmd に読み替えさせない
 * - **`windowsHide`**：PowerShell の黒い窓が前に出ると、試し用の窓から焦点を奪い、毎回「試し用の窓でない」で止まる
 * - 出力は台本が UTF-8 にしている（`[Console]::OutputEncoding`）。最後の空でない行を JSON として読む
 */
export function runTrialScript<T>(script: string, args: readonly string[], timeoutMs = 180_000): Promise<ScriptRun<T>> {
  const file = path.join(trialDir(), script);
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args],
      { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const raw = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const code = raw === null ? 0 : typeof raw.code === "number" ? raw.code : -1;
        const line = stdout
          .split(/\r?\n/)
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "")
          .pop();
        let json: T | undefined;
        try {
          json = line === undefined ? undefined : (JSON.parse(line) as T);
        } catch {
          json = undefined;
        }
        resolve({ code, json, stdout, stderr: stderr + (raw && code === -1 ? `\n${String(raw.message)}` : "") });
      }
    );
  });
}

/** 失敗の文に添える、台本の出力の写し（長すぎる分は切る） */
export function describeRun(script: string, run: ScriptRun<unknown>): string {
  const cut = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 600);
  return `${script} の終わりの番号 ${run.code}、出力 ${cut(run.stdout)}、エラー出力 ${cut(run.stderr)}`;
}

/* ── 試しの前と後（作者の IME の状態を控えて戻す） ── */

interface BeforeAfterJson {
  error?: string;
}

/** 試しの作品として知らせるときの題（IME の側の記録に出る。作者の作品の題と取り違えない名前） */
const TRIAL_TITLE = "本物のIMEの試し";

/**
 * 試しの前：作者の IME の状態を控え、`workDir` を試しの作品（workUid＝test-realime）として知らせる。
 * 試しのあいだに学習した語が作者の作品へ入らないようにするため。
 *
 * **`-Force` は付けない。** 控えが残っているのは前の試しの後始末が走らなかったときで、その控えが
 * 作者の本当の状態である。上書きすると失われるので、残っていたら台が整っていないとして止める
 * （走りの最初の片づけ `globalSetup.ts` が、先に `-After` で戻しておく）
 */
export async function trialBefore(workDir: string): Promise<void> {
  const run = await runTrialScript<BeforeAfterJson>(SCRIPT_BEFORE_AFTER, [
    "-Before",
    "-TestWorkDir",
    workDir,
    "-TestTitle",
    TRIAL_TITLE,
  ]);
  if (run.code === 0 && !run.json?.error) return;
  throw new RigNotReady(`試しの前の控えを取れませんでした（${run.json?.error ?? "理由不明"}）。${describeRun(SCRIPT_BEFORE_AFTER, run)}`);
}

/** 15分を超える試しで、試しの作品の知らせの時刻を書き直す（IME の側が古い知らせを見なくなるため） */
export async function trialRefresh(workDir: string): Promise<void> {
  const run = await runTrialScript<BeforeAfterJson>(SCRIPT_BEFORE_AFTER, [
    "-Before",
    "-Refresh",
    "-TestWorkDir",
    workDir,
    "-TestTitle",
    TRIAL_TITLE,
  ]);
  if (run.code !== 0 || run.json?.error) throw new Error(`試しの作品の知らせを書き直せませんでした。${describeRun(SCRIPT_BEFORE_AFTER, run)}`);
}

/**
 * 試しの後：控えから作者の状態へ戻し、試しの作品の学習を消す。
 *
 * @param lenient 控えが無いとき（前の試しで戻し済み）を失敗にしない。走りの最初と最後の片づけで使う
 * @returns 戻したか（控えが無くて何もしなかったときは false）
 */
export async function trialAfter(lenient = false): Promise<boolean> {
  const run = await runTrialScript<BeforeAfterJson>(SCRIPT_BEFORE_AFTER, ["-After"]);
  if (run.code === 0 && !run.json?.error) return true;
  if (lenient && run.code === 1 && (run.json?.error ?? "").includes("控えが無い")) return false;
  throw new Error(`試しの後の戻しが通りませんでした（作者の IME の状態が試しのまま残っているおそれ）。${describeRun(SCRIPT_BEFORE_AFTER, run)}`);
}

/* ── 殻の合図 ── */

export interface ShellMark {
  tsf: number;
  req: number;
}

export interface ShellSignals {
  /** 殻がキーを受けた数 */
  keys: number;
  consumed: number;
  /** 殻の編集が断られた数 */
  editFailed: number;
  /** 括弧の対の行（"closers=1 next=seen" など） */
  pairs: string[];
  /** カーソルの置き直しの行（"at caret"・"after closer" など） */
  carets: string[];
  /** 殻が起きたプロセス（exe の名前） */
  activated: string[];
  /** 殻が日本語の入力で起きたか */
  modeOn: boolean;
  requests?: unknown;
  /**
   * 最後に出した候補の窓（novel-ime 2cb1301）。list は候補の並び、selected は選んでいる番目（0 から）、shown は窓を出した回数。
   * 窓が無ければ null。並びは作者の学習で替わるので、番目を決め打ちせずにここから読む
   */
  lastCandidates?: { list: string[]; selected: number; shown: number } | null;
}

/** いまの殻の記録の行の数（打つ前に取り、打ったあと `shellSince` へ渡す） */
export async function shellMark(): Promise<ShellMark> {
  const run = await runTrialScript<ShellMark>(SCRIPT_SHELL_SIGNALS, ["-Mark"]);
  if (run.code !== 0 || typeof run.json?.tsf !== "number" || typeof run.json.req !== "number") {
    throw new RigNotReady(`殻の記録を読めませんでした。${describeRun(SCRIPT_SHELL_SIGNALS, run)}`);
  }
  return { tsf: run.json.tsf, req: run.json.req };
}

/** `mark` のあとに殻が残した合図 */
export async function shellSince(mark: ShellMark): Promise<ShellSignals> {
  const run = await runTrialScript<ShellSignals>(SCRIPT_SHELL_SIGNALS, [
    "-Since",
    String(mark.tsf),
    "-SinceReq",
    String(mark.req),
  ]);
  if (run.code !== 0 || !run.json) throw new Error(`殻の合図を読めませんでした。${describeRun(SCRIPT_SHELL_SIGNALS, run)}`);
  // PowerShell の ConvertTo-Json は、1件だけの並びを並びでなく出すことがあるので揃える
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)]);
  return {
    ...run.json,
    pairs: list(run.json.pairs),
    carets: list(run.json.carets),
    activated: list(run.json.activated),
    lastCandidates: run.json.lastCandidates
      ? { ...run.json.lastCandidates, list: list(run.json.lastCandidates.list) }
      : run.json.lastCandidates,
  };
}

/**
 * 殻の合図から、打った先で動いているのが Setsuna（オリジナルIME の殻）かを確かめる。違えば台が整っていないとして投げる。
 *
 * 新しく起こした VS Code が Setsuna で始まるかは、作者の機械の既定の入力しだい。**Win+Space で切り替えることは
 * しない**（作者の窓に効くおそれ）。殻がキーを受けていない（keys が 0）・殻が `exeName` で起きていない・
 * 日本語の入力で起きていない、のどれかなら止める
 */
export function assertSetsunaActive(signals: ShellSignals, exeName: string): void {
  const reasons: string[] = [];
  if (signals.keys === 0) reasons.push("殻がキーを受けていない（keys が 0）");
  if (!signals.activated.some((name) => name.toLowerCase() === exeName.toLowerCase())) {
    reasons.push(`殻が ${exeName} で起きていない（activated: ${JSON.stringify(signals.activated)}）`);
  }
  if (!signals.modeOn) reasons.push("殻が日本語の入力で起きていない（modeOn が false）");
  if (reasons.length > 0) {
    throw new RigNotReady(
      `試し用の VS Code の入力が Setsuna（オリジナルIME）で始まっていません：${reasons.join("・")}。` +
        "既定の入力をオリジナルIME にしてから流してください（Win+Space での切り替えは試しの側ではしません）"
    );
  }
}
