import { localIsoString } from "./contestInbox";
import { sha256Text } from "./hash";
import { IME_JOIN_GAP_MS, IME_TEXT_MAX, type CompositionPair } from "./imeReading";
import type { ImeCurrentWorkNotice, ImeWorksList } from "./imeCurrentWork";

/**
 * Rittoku IME の「アプリ連動の口」の、統合の側の純粋な部分（設計書6.13.8）。
 *
 * 形の正は IME のリポジトリの案（`novel-ime/docs/アプリ連動の口_設計の案.md` の 2章・5.2）
 * と、エンジンの実物（`core/src/link.rs`・`core/src/pick.rs`）。**案の 2.2 にある
 * `{"v":1,"type":…}` の形は古い**——エンジンが実際に読み書きするのは
 * `{"hello":{…}}`・`{"welcome":{…}}`・`{"commit":{…}}` の形なので、こちらに合わせる。
 *
 * 口は2本。状態はファイル（`stateDir\連携\novel-ai-assistant\`）、出来事はパイプ。
 * ここは `vscode` も `node:` も引き込まない（中身を組む・行を確かめる・どちらの道で
 * 拾うかを決めるだけ）。ファイルを書くのは `features/imeCurrentWork.ts`、パイプに
 * つなぐのは `core/imeLinkPipeNode.ts`（Node 専用。動的 import で読む）。
 */

/** この拡張機能のアプリID（エンジンの `valid_app_id` に通る形。前の形の知らせも同じ名前で読まれる） */
export const IME_APP_ID = "novel-ai-assistant";
/** 名乗りに載せる名前（設定のアプリの「確定した字を送るアプリ」の欄に出る） */
export const IME_APP_NAME = "統合小説執筆環境";
/**
 * 打つときの前面のプロセス名。エンジンはこれで「VS Code で打っているか」を見る。
 * Insiders（`Code - Insiders.exe`）などはまだ載せない（作者は通常版を使う）
 */
export const IME_APP_PROCESSES: readonly string[] = ["Code.exe"];
/** 置き場の下の連携のフォルダー（エンジンの `LINK_DIR`） */
export const IME_LINK_DIR = "連携";
export const IME_APP_FILE = "app.json";
export const IME_CONTEXT_FILE = "context.json";
export const IME_APP_WORKS_FILE = "works.json";
/** 名乗りの形のバージョン（エンジンは v が 1 でない app.json を読まない） */
const IME_APP_JSON_VERSION = 1;

/** 名乗り（案 2.3） */
export interface ImeAppJson {
  v: number;
  appId: string;
  name: string;
  processes: string[];
  version: string;
  at: string;
}

export function buildAppJson(input: { version: string; now: Date }): ImeAppJson {
  return {
    v: IME_APP_JSON_VERSION,
    appId: IME_APP_ID,
    name: IME_APP_NAME,
    processes: [...IME_APP_PROCESSES],
    version: input.version,
    at: localIsoString(input.now),
  };
}

/**
 * いまの作品（`context.json`）。前の形の知らせ（`integration-current-work.json`）と
 * **同じ欄に `appId` を足しただけ**——欄を写し分けると、片方だけ直したときにずれる
 */
export type ImeAppContext = ImeCurrentWorkNotice & { appId: string };

export function buildAppContext(notice: ImeCurrentWorkNotice): ImeAppContext {
  const { v, ...rest } = notice;
  return { v, appId: IME_APP_ID, ...rest };
}

/** 作品の一覧（`works.json`）。前の形の一覧と同じ欄に `appId` を足す */
export type ImeAppWorks = ImeWorksList & { appId: string };

export function buildAppWorks(list: ImeWorksList): ImeAppWorks {
  const { v, ...rest } = list;
  return { v, appId: IME_APP_ID, ...rest };
}

/** 名乗り・いまの作品・一覧をファイルの中身にする（LF・末尾に改行。前の形と同じ） */
export function serializeAppLinkJson(value: ImeAppJson | ImeAppContext | ImeAppWorks): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/* ── パイプ（案 5.2） ─────────────────────────────── */

/** 試しでパイプの名前を替える環境変数（エンジンと同じ名前） */
export const IME_LINK_PIPE_ENV = "RITTOKU_LINK_PIPE";
/** パイプの名前の頭。後ろにユーザーの SID の短い印（12字）が付く */
export const IME_LINK_PIPE_PREFIX = "\\\\.\\pipe\\rittoku-ime-link-";

/**
 * whoami などの出力から SID（`S-1-5-21-…`）を抜く。
 *
 * CSV を区切りで切らずに形で拾う——ユーザー名が日本語だと、コンソールの文字コードで
 * 名前の側が化けることがあるが、SID は英数字なので化けない
 */
export function sidFromWhoami(output: string): string | undefined {
  return /S-1-\d+(?:-\d+)+/.exec(output)?.[0];
}

/**
 * パイプの名前。試しの名前があればそれ、無ければ SID の UTF-8 の SHA-256 の頭6バイトを
 * 小文字16進で並べた12字を付ける（エンジンの `link::pipe_name` と同じ作り方。違うと
 * 黙ってつながらないままになる）
 */
export function imeLinkPipeName(input: {
  override?: string;
  sid: string | undefined;
}): string | undefined {
  const override = input.override?.trim();
  if (override) return override;
  if (!input.sid || !/^S-1-\d+(?:-\d+)+$/.test(input.sid)) return undefined;
  return `${IME_LINK_PIPE_PREFIX}${sha256Text(input.sid).slice(0, 12)}`;
}

/** つないだら最初に送る1行。欲しいのは確定の知らせだけ（消した確定・選び直しはまだ使わない） */
export function imeLinkHelloLine(): string {
  return `${JSON.stringify({ hello: { appId: IME_APP_ID, wants: ["commit"] } })}\n`;
}

/** welcome を読む。形が違えば undefined。grants に commit があれば許された */
export function parseImeLinkWelcome(line: string): { granted: boolean } | undefined {
  const value = parseObject(line);
  const welcome = value?.welcome;
  if (!isRecord(welcome)) return undefined;
  const grants = welcome.grants;
  if (!Array.isArray(grants) || !grants.every((item) => typeof item === "string")) {
    return undefined;
  }
  return { granted: grants.includes("commit") };
}

/** パイプから受けた確定1つ（字と読み。時刻は使わない） */
export interface ImeLinkCommit {
  text: string;
  reading: string;
}

/**
 * 読みとして通る形：ひらがな・カタカナ・長音・踊り字・中黒だけ。
 * **漢字・英字・空白の入った読みは捨てる**（IME の読み違い・鍵や URL のような字）
 */
const READING_SHAPE = /^[ぁ-ゖゝゞァ-ヺー・ヽヾ]+$/u;

/**
 * 確定の行を確かめる。**IME から届く値も信用しない**（実装ルール3と同じ考え方）。
 *
 * 字も読みも、原稿エディターの道と同じ上限（`IME_TEXT_MAX`）を超えたら捨てる——
 * 照合の側（`captureImeReading`）が同じ長さで切るので、長い確定は受けても使えない。
 * 制御文字を含む字・読みでない読みも捨てる。
 *
 * **読みが空の確定は `reading: ""` のまま返す**（変換を通らない確定。英字の Enter・記号など。
 * novel-ime 830b20b から届く）。打った読みが無いので控えには使わないが、受け手は
 * 「前の確定とのあいだに別の字が入った」ことを知る要がある（姓と名のつなぎを切る）。
 * 控えへ渡さないのは受け手（`features/imeCommitLink.ts`）。つながりは「許されている」のまま
 */
export function parseImeLinkCommit(line: string): ImeLinkCommit | undefined {
  const commit = parseObject(line)?.commit;
  if (!isRecord(commit)) return undefined;
  const { text, reading } = commit;
  if (typeof text !== "string" || typeof reading !== "string") return undefined;
  if (text.length === 0 || text.length > IME_TEXT_MAX) return undefined;
  if (reading.length > IME_TEXT_MAX) return undefined;
  if (hasControl(text)) return undefined;
  if (reading !== "" && !READING_SHAPE.test(reading)) return undefined;
  return { text, reading };
}

/** 1行の上限（エンジンの決まり。案 2.2） */
export const IME_LINK_LINE_MAX_BYTES = 64 * 1024;

/**
 * パイプから届くバイトを1行ずつに切る。
 *
 * **長すぎる行は次の改行まで捨てる**（溜め続けると、壊れた相手が改行を送らないだけで
 * 拡張機能ホストのメモリを食い続ける）。字の途中で塊が切れても、行の単位で
 * 復号するので化けない
 */
export class ImeLinkLineSplitter {
  private buffer: Uint8Array = new Uint8Array(0);
  private skipping = false;
  private readonly decoder = new TextDecoder("utf-8");

  push(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 0x0a) continue;
      const piece = chunk.subarray(start, index);
      start = index + 1;
      if (this.skipping) {
        this.skipping = false;
        this.buffer = new Uint8Array(0);
        continue;
      }
      const whole = concat(this.buffer, piece);
      this.buffer = new Uint8Array(0);
      if (whole.length > IME_LINK_LINE_MAX_BYTES) continue;
      lines.push(this.decoder.decode(whole).replace(/\r$/, ""));
    }
    const rest = chunk.subarray(start);
    if (!this.skipping) {
      if (this.buffer.length + rest.length > IME_LINK_LINE_MAX_BYTES) {
        this.skipping = true;
        this.buffer = new Uint8Array(0);
      } else if (rest.length > 0) {
        this.buffer = concat(this.buffer, rest);
      }
    }
    return lines;
  }

  /** 次の改行を待って溜めているバイト数（試しで、溜め続けていないことを見る） */
  pendingBytes(): number {
    return this.buffer.length;
  }
}

/**
 * つなぎ直すまでの間（ミリ秒）。
 *
 * - IME が居ない（つながらない）：30秒から倍にして5分で止める。IME の無い機械で
 *   30秒ごとに試し続けない
 * - 許されなかった（grants に commit が無い）：5分。作者が設定のアプリで許すまで
 *   変わらないので、短く試しても同じ答えが返るだけ
 * - 許されたあとで切れた（IME を入れ替えた・エンジンが起き直した）：初めの30秒から
 */
export const IME_LINK_RETRY = {
  absentFirstMs: 30_000,
  maxMs: 5 * 60_000,
  deniedMs: 5 * 60_000,
} as const;

export type ImeLinkEnd = "absent" | "denied" | "lost";

export function nextImeLinkDelay(end: ImeLinkEnd, previous: number | undefined): number {
  if (end === "denied") return IME_LINK_RETRY.deniedMs;
  if (end === "lost" || previous === undefined) return IME_LINK_RETRY.absentFirstMs;
  return Math.min(Math.max(previous, IME_LINK_RETRY.absentFirstMs / 2) * 2, IME_LINK_RETRY.maxMs);
}

/* ── 受けた確定の使い道（設計書6.42.2） ─────────────── */

/** 変換1回ぶん。どちらの道から来たかと、照合へ渡す材料 */
export interface ImeTypingItem {
  source: "pipe" | "composition";
  /** 打った話のファイル */
  filePath: string;
  /** 打った読み（パイプは IME の読み、composition は画面の推し量り） */
  kana: string;
  committed: string;
  previous?: CompositionPair;
  /** 変換を始めた所の直前の字（composition の道だけが持つ） */
  before?: string;
}

/**
 * composition の道の確定を預かる長さ（ミリ秒）。パイプの確定は IME が確定したすぐあとに
 * 届き、画面の compositionend もほぼ同じ時に来る。どちらが先でも1回に数えられるよう、
 * 打鍵の間より短く、届く遅れより長く取った
 */
export const IME_TYPING_HOLD_MS = 1500;

/**
 * 同じ確定を二重に数えないための突き合わせ（設計書6.42.2）。
 *
 * 「パイプがつながっている間は composition を止める」形にしないのは、つながっていても
 * パイプに確定が来ないことがあるため（MS-IME へ切り替えた・試しの作品・つないだあとで
 * 許しを外した）。そこで両方を受け、**同じ話・同じ字が預かる間に両方から来たら1回**にする。
 *
 * - composition が来たら、すぐ控えへ入れずに預かる。預かる間に同じ字のパイプが来たら、
 *   預かった方を捨ててパイプの方を使う（読みが確か）。来なければ `flush` で今までどおり出す
 * - パイプが先に来たら、すぐ出し、預かる間だけ覚えておく。そのあと同じ字の composition が
 *   来たら捨てる
 *
 * 時刻は呼び手が渡す（試しで時計を動かせるように）。`vscode` には触らない
 */
export class ImeTypingMerge {
  private held: Array<{ item: ImeTypingItem; at: number }> = [];
  private recentPipe: Array<{ filePath: string; committed: string; at: number }> = [];

  constructor(private readonly holdMs: number = IME_TYPING_HOLD_MS) {}

  /**
   * 1つ受ける。`emit` はいま照合へ渡すもの。`flushAfterMs` があれば、その後で `flush` を呼ぶ
   */
  offer(item: ImeTypingItem, now: number): { emit: ImeTypingItem[]; flushAfterMs?: number } {
    this.recentPipe = this.recentPipe.filter((one) => now - one.at <= this.holdMs);
    const committed = item.committed.trim();
    if (item.source === "pipe") {
      const index = this.held.findIndex(
        (one) =>
          one.item.filePath === item.filePath &&
          one.item.committed.trim() === committed &&
          now - one.at <= this.holdMs
      );
      if (index >= 0) {
        this.held.splice(index, 1);
      } else {
        this.recentPipe.push({ filePath: item.filePath, committed, at: now });
      }
      return { emit: [item] };
    }
    const match = this.recentPipe.findIndex(
      (one) => one.filePath === item.filePath && one.committed === committed
    );
    if (match >= 0) {
      this.recentPipe.splice(match, 1);
      return { emit: [] };
    }
    this.held.push({ item, at: now });
    return { emit: [], flushAfterMs: this.holdMs };
  }

  /** 預かる間を過ぎた composition の確定を、来た順に出す */
  flush(now: number): ImeTypingItem[] {
    const due = this.held.filter((one) => now - one.at >= this.holdMs);
    this.held = this.held.filter((one) => now - one.at < this.holdMs);
    return due.map((one) => one.item);
  }
}

/**
 * パイプの確定を当てる原稿（話のファイル）。**焦点のある原稿エディターが無ければ捨てる。**
 *
 * エンジンは VS Code で打った確定を、つながっている窓すべてへ送る。窓に焦点があり、
 * 前に出ている原稿エディターの面が active のときだけ受けることで、ほかのエディター・
 * 入力欄で打った字を拾わず、窓のあいだで二重にも数えない
 */
export function routeImePipeCommit(input: {
  windowFocused: boolean;
  front: { filePath: string; active: boolean } | undefined;
}): string | undefined {
  if (!input.windowFocused) return undefined;
  if (!input.front?.active) return undefined;
  return input.front.filePath;
}

/** 直前に受けたパイプの確定（姓と名を分けて確定する打ち方をつなぐため） */
export interface ImePipeLastCommit extends CompositionPair {
  filePath: string;
  /** 受けた時刻（ミリ秒） */
  at: number;
}

/**
 * 前の確定としてつないでよいか。同じ話で、`IME_JOIN_GAP_MS` の間に続いたときだけ。
 *
 * パイプからは「前の確定のすぐ後ろに打ったか」（原稿エディターの画面がカーソルで
 * 確かめていること）が来ないので、位置の守りは無い。誤ってつないでも、つないだ字が
 * まるごと名前と一致し、名前が2回の境目をまたぐときにしか採らない
 * （`captureJoinedImeReading`）ので、そちらの照合が守りになる
 */
export function pipePreviousCommit(
  last: ImePipeLastCommit | undefined,
  filePath: string,
  now: number
): CompositionPair | undefined {
  if (!last || last.filePath !== filePath) return undefined;
  if (now - last.at > IME_JOIN_GAP_MS) return undefined;
  return { kana: last.kana, committed: last.committed };
}

/* ── 小さな部品 ─────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function hasControl(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right.slice();
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}
