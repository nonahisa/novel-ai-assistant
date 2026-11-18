import * as net from "node:net";
import { execFile } from "node:child_process";
import {
  ImeLinkLineSplitter,
  imeLinkHelloLine,
  nextImeLinkDelay,
  parseImeLinkCommit,
  parseImeLinkWelcome,
  sidFromWhoami,
  type ImeLinkCommit,
  type ImeLinkEnd,
} from "./imeAppLink";

/**
 * 六徳 IME のアプリ連動の口の、パイプの客（設計書6.13.8）。
 *
 * **Node 専用である。** 拡張機能からは、Windows の手元の VS Code であることを確かめて
 * から**動的 import** する（実装ルール7。静的に書くと、ブラウザ版は読み込んだ瞬間に
 * 落ちる。`test/unit/cross/browserReach.test.ts` が見張る）。`vscode` は引き込まない。
 *
 * 行の形・待ち時間・確かめ方は `imeAppLink.ts`（純粋な部分）。ここはつなぐ・送る・
 * 受ける・切れたら間をおいてつなぎ直す、だけ。
 */

/** いまのつながりの状態（変わったときだけ呼び手がログへ1行書く） */
export type ImeLinkState =
  /** つながらない（IME が居ない・パイプが無い・取り込み中で空きが無い） */
  | "absent"
  /** つながったが、確定の知らせは許されていない */
  | "denied"
  /** 確定の知らせを許されてつながっている */
  | "granted"
  /** 許されてつながっていたが、切れた */
  | "lost"
  /** 止めた */
  | "stopped";

export interface ImeLinkClientOptions {
  pipeName: string;
  /** 確かめを通った確定1つ */
  onCommit(commit: ImeLinkCommit): void;
  /** 状態が変わった */
  onState(state: ImeLinkState): void;
  /** つなぎ直すまでの間を決める（試しで短くする。省くと `nextImeLinkDelay`） */
  delay?: (end: ImeLinkEnd, previous: number | undefined) => number;
  /** welcome を待つ上限（ミリ秒）。来なければ切ってつなぎ直す */
  welcomeTimeoutMs?: number;
}

export interface ImeLinkClient {
  /** いま確定の知らせを許されてつながっているか */
  granted(): boolean;
  /**
   * 待っている最中なら、待ちを飛ばしてすぐ1回つなぎ直す（窓に焦点が戻ったとき。作者が
   * IME の設定のアプリで許した直後に、5分待たせない）。つながっている・つなぎに行っている
   * 最中・止めたあとは何もしない
   */
  retryNow(): void;
  /** 切る。このあとはつなぎ直さない */
  stop(): void;
}

/** welcome を待つ上限の既定。エンジンは hello を受けてすぐ返すので、長くは待たない */
const DEFAULT_WELCOME_TIMEOUT_MS = 10_000;

export function startImeLinkClient(options: ImeLinkClientOptions): ImeLinkClient {
  const delayOf = options.delay ?? nextImeLinkDelay;
  let stopped = false;
  let state: ImeLinkState | undefined;
  let socket: net.Socket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastDelay: number | undefined;

  const setState = (next: ImeLinkState): void => {
    if (state === next) return;
    state = next;
    try {
      options.onState(next);
    } catch {
      // 呼び手の失敗で、つなぎ直しの輪を止めない
    }
  };

  const schedule = (end: ImeLinkEnd): void => {
    if (stopped) return;
    // 伸ばすのは「つながらない」が続く間だけ。許されなかった・切れたあとは初めから数え直す
    const wait = delayOf(end, end === "absent" ? lastDelay : undefined);
    lastDelay = end === "absent" ? wait : undefined;
    timer = setTimeout(() => {
      timer = undefined;
      connect();
    }, wait);
  };

  const connect = (): void => {
    if (stopped) return;
    const splitter = new ImeLinkLineSplitter();
    let welcomed: boolean | undefined;
    let ended = false;
    const current = net.connect({ path: options.pipeName });
    socket = current;
    const welcomeTimer = setTimeout(() => {
      // welcome が来ない相手（別のものが同じ名前を開いた・詰まった）は切ってやり直す
      if (welcomed === undefined) current.destroy();
    }, options.welcomeTimeoutMs ?? DEFAULT_WELCOME_TIMEOUT_MS);

    const finish = (): void => {
      if (ended) return;
      ended = true;
      clearTimeout(welcomeTimer);
      if (socket === current) socket = undefined;
      if (stopped) return;
      if (welcomed === true) {
        setState("lost");
        schedule("lost");
      } else if (welcomed === false) {
        // grants に commit が無い。相手が切るので、長めに間をおく
        schedule("denied");
      } else {
        setState("absent");
        schedule("absent");
      }
    };

    current.on("connect", () => {
      current.write(imeLinkHelloLine());
    });
    current.on("data", (chunk: Buffer) => {
      for (const line of splitter.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length))) {
        if (welcomed === undefined) {
          const welcome = parseImeLinkWelcome(line);
          if (!welcome) continue;
          welcomed = welcome.granted;
          clearTimeout(welcomeTimer);
          if (welcome.granted) {
            setState("granted");
          } else {
            setState("denied");
          }
          continue;
        }
        if (welcomed !== true) continue;
        const commit = parseImeLinkCommit(line);
        if (!commit) continue;
        try {
          options.onCommit(commit);
        } catch {
          // 受け手の失敗で、つながりを切らない
        }
      }
    });
    // **error の受け口を必ず付ける**——付けないと、IME の居ない機械でつなぐたびに
    // 拡張機能ホストへ投げられた例外になる。つながらない理由は問わず「静かに待つ」へ倒す
    current.on("error", () => {
      current.destroy();
    });
    current.on("close", finish);
  };

  connect();

  return {
    granted: () => state === "granted",
    retryNow: () => {
      if (stopped || !timer) return;
      clearTimeout(timer);
      timer = undefined;
      connect();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      socket?.destroy();
      socket = undefined;
      setState("stopped");
    },
  };
}

/**
 * いまのユーザーの SID（`S-1-5-21-…`）を whoami から読む。読めなければ undefined
 * （パイプの名前が作れないので、つながない）。
 *
 * エンジンは自分のトークンから SID を取る（`setsuna_pipe::win::user_sid`）。同じユーザーの
 * 同じ値になるので、名前がそろう
 */
export function readWindowsUserSid(): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        "whoami",
        ["/user", "/fo", "csv", "/nh"],
        { windowsHide: true, timeout: 5000 },
        (error, stdout) => {
          if (error) {
            resolve(undefined);
            return;
          }
          resolve(sidFromWhoami(String(stdout)));
        }
      );
    } catch {
      resolve(undefined);
    }
  });
}
