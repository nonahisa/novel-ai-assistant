import { AIWRITER_DIR } from "../models/types";

/**
 * 窓の札（MCP の道具 `windows.list`。作者の依頼、2026-09-22）。
 *
 * **なぜ要るか。** 2台（母艦・ノートPC）で実機確認をしていると、
 * 「いまどの窓がどの版で動いているか」を機械のセッションが知りたくなる。
 * MCP サーバーは VS Code の外で走る別プロセスなので、拡張機能ホストの中は
 * 見えない。そこで**拡張機能が起動のたびに札を書き、MCP がそれを読む。**
 *
 * **置き場所は保管庫（`globalStorageUri`）の下。** 助言方針の控え・MCP の束の
 * 写しと同じ場所で、MCP は束の居場所からそこを知る
 * （`mcp/globalStorage.ts`。新しい道は作らない）。作品フォルダーへ置かないのは、
 * 札が「どの機械のどの窓か」という**その機械だけの話**で、GitHub で
 * 同期されると別の機械の窓が混ざって見えるからである。
 *
 * ここは**形と判定だけ**を持つ。VS Code にも Node にも依存しないので、
 * 書く側（`features/windowCard.ts`）と読む側（`mcp/tools/windows.ts`）が
 * 同じものを見る——写しを作ると、片方だけ直る日が来る。
 */

/** 札の置き場（保管庫からの相対）。1窓1ファイル */
export const WINDOW_CARD_DIRECTORY = [AIWRITER_DIR, "windows"] as const;

/** 札の形の版。読めない版は「壊れた札」として扱う（直しにいかない） */
export const WINDOW_CARD_SCHEMA = 1;

/**
 * `updatedAt` を打ち直す間隔。
 *
 * **5分にしたのは、書く量と知りたい鮮度の釣り合い。** 窓が閉じたかを
 * 秒単位で知る用は無い（実機確認は分単位で進む）。短くするほど
 * 保管庫への書き込みが増える。
 */
export const WINDOW_CARD_HEARTBEAT_MS = 5 * 60_000;

/**
 * これより古い札は「たぶん閉じた」と印を付ける。
 *
 * **打ち直し3回ぶん。** 1回ぶんだと、機械が重いときやタイマーが
 * 間引かれたとき（VS Code が裏に回ったとき）に、開いている窓まで
 * 閉じたように見える。**消すのではなく印を付けるだけ**なので、
 * 外れても害は小さい——閉じる前に消せなかった札（`deactivate` は
 * 待たれないことがある）を、開いている窓と見分けられれば足りる。
 */
export const WINDOW_CARD_STALE_AFTER_MS = 3 * WINDOW_CARD_HEARTBEAT_MS;

export interface WindowCard {
  schema: number;
  /** 拡張機能ホストのプロセス番号。**札のファイル名の鍵** */
  pid: number;
  /** 拡張機能の版（`package.json` の `version`） */
  extensionVersion: string;
  /** VS Code の版（`vscode.version`） */
  vscodeVersion: string;
  /** `vscode.env.appName`（「Visual Studio Code」など） */
  appName: string;
  /**
   * `vscode.workspace.name`。**フォルダーを開いていない窓では `null`**
   * （`undefined` だと JSON から項目ごと消え、「無い」と「読めない」の
   * 見分けが付かない）。
   */
  workspaceName: string | null;
  /**
   * 開発ホスト（F5 で立ち上げた「拡張機能開発ホスト」）か。
   *
   * **いちばん知りたい項目。** 同じ版の番号でも、開発ホストは手元の
   * ソースを、普段の窓は入れた VSIX を動かしている。
   */
  developmentHost: boolean;
  /**
   * 開いている作品の置き場（ワークスペースのフォルダー）。
   *
   * **登録簿（`WorkRegistry`）ではなく、窓が開いているフォルダーを書く。**
   * 登録簿は `globalState` にあって窓をまたいで同じなので、全部の窓が
   * 同じ一覧を名乗ってしまい、窓の見分けに使えない。
   */
  folders: string[];
  /** この窓で拡張機能が起動した時刻（ISO） */
  startedAt: string;
  /** 最後に札を打ち直した時刻（ISO）。**古さの判定はこれだけで決める** */
  updatedAt: string;
}

export interface WindowCardInput {
  pid: number;
  extensionVersion: string;
  vscodeVersion: string;
  appName: string;
  workspaceName: string | undefined;
  developmentHost: boolean;
  folders: readonly string[];
  startedAt: Date;
  now: Date;
}

/** 札を組み立てる。**時刻は引数で受ける**（テストで固定できるように） */
export function buildWindowCard(input: WindowCardInput): WindowCard {
  return {
    schema: WINDOW_CARD_SCHEMA,
    pid: input.pid,
    extensionVersion: input.extensionVersion,
    vscodeVersion: input.vscodeVersion,
    appName: input.appName,
    workspaceName: input.workspaceName ?? null,
    developmentHost: input.developmentHost,
    folders: [...input.folders],
    startedAt: input.startedAt.toISOString(),
    updatedAt: input.now.toISOString(),
  };
}

/** 札のファイル名。**プロセス番号だけで決める**（1窓1ファイル） */
export function windowCardFileName(pid: number): string {
  return `${pid}.json`;
}

export function serializeWindowCard(card: WindowCard): string {
  return `${JSON.stringify(card, null, 2)}\n`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * 札を読む。**形が合わなければ `undefined`**（直しにいかない）。
 *
 * 壊れた札（書きかけ・別の版・手で触られたもの）で一覧ぜんたいを
 * 止めないために、投げずに `undefined` を返す。何が読めなかったかは
 * 読む側が一覧に添える。
 */
export function parseWindowCard(text: string): WindowCard | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  if (value.schema !== WINDOW_CARD_SCHEMA) return undefined;
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid)) {
    return undefined;
  }
  if (
    typeof value.extensionVersion !== "string" ||
    typeof value.vscodeVersion !== "string" ||
    typeof value.appName !== "string" ||
    typeof value.developmentHost !== "boolean" ||
    typeof value.startedAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return undefined;
  }
  if (value.workspaceName !== null && typeof value.workspaceName !== "string") {
    return undefined;
  }
  if (!isStringArray(value.folders)) return undefined;
  return {
    schema: WINDOW_CARD_SCHEMA,
    pid: value.pid,
    extensionVersion: value.extensionVersion,
    vscodeVersion: value.vscodeVersion,
    appName: value.appName,
    workspaceName: value.workspaceName,
    developmentHost: value.developmentHost,
    folders: value.folders,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
  };
}

export interface WindowCardView extends WindowCard {
  /**
   * たぶん閉じた（`updatedAt` が `WINDOW_CARD_STALE_AFTER_MS` より古い）。
   *
   * **「たぶん」である。** 札は閉じるときに消すが、`deactivate` は
   * 待たれないことがあり、消し損ねた札が残る。逆に、機械が眠っていた
   * 窓は起きれば打ち直す。**消さずに印を付けるだけ**にしてある。
   */
  probablyClosed: boolean;
  /** 最後に打ち直してからの経過（分、切り捨て）。読めない時刻は `null` */
  minutesSinceUpdate: number | null;
}

/**
 * 一覧に並べる形へ直す。**新しく打ち直した窓が先。**
 *
 * **読めない時刻は「たぶん閉じた」側へ倒す。** 開いている窓なら
 * 5分以内に正しい時刻で書き直すので、そのまま残り続ける札は
 * 閉じた窓のものである見込みが高い。
 */
export function describeWindowCards(
  cards: readonly WindowCard[],
  now: Date
): WindowCardView[] {
  const views = cards.map((card): WindowCardView => {
    const at = Date.parse(card.updatedAt);
    if (Number.isNaN(at)) {
      return { ...card, probablyClosed: true, minutesSinceUpdate: null };
    }
    // 先の時刻（機械の時計のずれ）は「いま打ち直した」とみなす
    const elapsed = Math.max(0, now.getTime() - at);
    return {
      ...card,
      probablyClosed: elapsed > WINDOW_CARD_STALE_AFTER_MS,
      minutesSinceUpdate: Math.floor(elapsed / 60_000),
    };
  });
  return views.sort((a, b) => {
    const left = Date.parse(a.updatedAt);
    const right = Date.parse(b.updatedAt);
    // 読めない時刻は後ろへ
    if (Number.isNaN(left) && Number.isNaN(right)) return a.pid - b.pid;
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    return right - left || a.pid - b.pid;
  });
}
