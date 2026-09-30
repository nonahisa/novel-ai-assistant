import { normalizeForComparison } from "./paths";
import type { GitSyncStatus } from "./git";

/**
 * 記録済みで送れていないものを、回線が戻ったら送り直す——その判断だけ
 * （設計書5.5・6.15.1）。
 *
 * ## なぜ要るのか
 *
 * 2026-10-01、ノートPCで「すべて同期」を押したとき、記録は済んだが
 * スリープ明けで回線が無く、送信だけが失敗した。警告の窓は出たはずだが、
 * 作者は机のPCへ移っていて見ておらず、**3時間、第1話が GitHub に届かなかった。**
 * 「送らずに閉じた」印は、同じ機械で開き直すまで効かない。
 *
 * 作者の裁定（2026-10-01）：**回線が戻ったら自動で送り直す。送るだけで、
 * 取り込み（pull）や合流はしない。**
 *
 * ## ここで決めること
 *
 * 送ってよい置き場か（`resendDecision`）、置き場ごとに1回へまとめる
 * （`pickResendTargets`）、スリープ明けと見なすか（`looksLikeWake`）、
 * 間隔の丸め（`normalizeResendIntervalMinutes`）、完了の一言
 * （`describeResent`）。**git は呼ばない**——見張りが持っている控えを読むだけ。
 *
 * VS Code APIに依存しない（`import type` だけなので `core/git.ts` も読み込まない）。
 */

/** 自動の送り直しの間隔の既定値（分） */
export const DEFAULT_RESEND_INTERVAL_MINUTES = 5;

/**
 * 見張りの鼓動（ミリ秒）。**この鼓動そのものは git を呼ばない**——控えを
 * 読んで、送るものが無ければそれで終わる。スリープ明けを見分けるのに、
 * 間隔より細かく刻んでおく必要がある。
 */
export const RESEND_HEARTBEAT_MS = 60_000;

/**
 * 鼓動の間がこれ以上空いたら、機械が眠っていたと見なす。
 *
 * 鼓動は1分ごとなので、3分空くのは「処理が重かった」では説明がつかない。
 * 眠っていた機械は、起きた直後に回線がまだ戻っていないことが多いので、
 * **起きた直後と、その次の鼓動の2回**を間隔に関わらず試す（`AutoResender`）。
 */
export const WAKE_GAP_MS = RESEND_HEARTBEAT_MS * 3;

/**
 * ウィンドウへ戻ったときに試す最小の間（ミリ秒）。
 *
 * 別のアプリと行き来するたびに試すと、1分に何度も git を起こしうる。
 */
export const FOCUS_MIN_GAP_MS = 30_000;

/** 送らない理由。ログと試験で見分けるために名前を付ける */
export type ResendSkipReason =
  /** 上流のある枝ではない（gitが無い・リポジトリでない・上流が無い等） */
  | "not_tracked"
  /** 送るものが無い */
  | "nothing_to_send"
  /** 別の環境のほうが進んでいる。**分かれている場合もここに入る** */
  | "behind"
  /** 競合が解けていない */
  | "unmerged";

export type ResendDecision =
  | { send: true; ahead: number }
  | { send: false; reason: ResendSkipReason };

/**
 * その置き場を、自動で送ってよいか。
 *
 * **遅れているなら送らない**（分かれているときも含む）。送っても GitHub に
 * 拒まれるうえ、ここで取り込みや合流へ進むのは作者の裁定の外である
 * （「送るだけ」）。**押し付け（force push）は決してしない。**
 *
 * **記録していない変更（dirty）は妨げにしない。** 送るのは記録済みの分だけで、
 * 書きかけが外へ出ることはない。
 */
export function resendDecision(status: GitSyncStatus): ResendDecision {
  if (status.kind !== "tracked") return { send: false, reason: "not_tracked" };
  if (status.unmerged > 0) return { send: false, reason: "unmerged" };
  if (status.behind > 0) return { send: false, reason: "behind" };
  if (status.ahead <= 0) return { send: false, reason: "nothing_to_send" };
  return { send: true, ahead: status.ahead };
}

/** 送り直す置き場1つぶん */
export interface ResendTarget<W> {
  /** gitを動かす場所（置き場の根） */
  root: string;
  /** その置き場に入っている作品（見張りの控えを作り直すのに使う） */
  works: W[];
  /** 控えの上での、送っていない記録の数 */
  ahead: number;
}

/**
 * 作品ごとの控えから、送ってよい置き場を**置き場ごとに1つ**だけ拾う。
 *
 * 書庫では11作品が同じ置き場に入る。作品ごとに送ると、同じ `git push` を
 * 11回走らせることになる。
 */
export function pickResendTargets<W>(
  entries: ReadonlyArray<{ work: W; status: GitSyncStatus | undefined }>
): ResendTarget<W>[] {
  const byRoot = new Map<string, ResendTarget<W>>();
  // 同じ置き場の作品のうち1つでも「送らない」と読めたら、その置き場は送らない
  // （控えの古さが作品ごとに違うことがある。慎重なほうへ倒す）
  const refused = new Set<string>();
  for (const { work, status } of entries) {
    if (!status || !("root" in status)) continue;
    const key = normalizeForComparison(status.root);
    const decision = resendDecision(status);
    if (!decision.send) {
      // 送るものが無いだけの作品は、同じ置き場の他の作品を止めない
      if (decision.reason !== "nothing_to_send") refused.add(key);
      continue;
    }
    const found = byRoot.get(key);
    if (found) {
      found.works.push(work);
      found.ahead = Math.max(found.ahead, decision.ahead);
    } else {
      byRoot.set(key, { root: status.root, works: [work], ahead: decision.ahead });
    }
  }
  return [...byRoot.entries()]
    .filter(([key]) => !refused.has(key))
    .map(([, target]) => target);
}

/**
 * 前の鼓動から、機械が眠っていたと見なせるほど間が空いたか。
 *
 * 前の鼓動が無い（始めたばかり）なら眠っていたとは言えない。
 */
export function looksLikeWake(
  previousBeatAt: number | undefined,
  now: number
): boolean {
  if (previousBeatAt === undefined) return false;
  return now - previousBeatAt >= WAKE_GAP_MS;
}

/**
 * 設定の間隔（分）を丸める。**0や負値・数でない値は既定へ戻す。**
 *
 * 設定の誤りで回線を叩き続ける状態を作らない（自動fetchの間隔と同じ考え方）。
 */
export function normalizeResendIntervalMinutes(configured: unknown): number {
  return typeof configured === "number" &&
    Number.isFinite(configured) &&
    configured >= 1
    ? configured
    : DEFAULT_RESEND_INTERVAL_MINUTES;
}

/**
 * 送れたときの一言（ステータスバー）。
 *
 * **窓は出さない。** 作者は別の作業をしているかもしれず、済んだことを
 * 知らせるだけなら消える知らせで足りる。
 */
export function describeResent(
  sent: ReadonlyArray<{ label: string; ahead: number }>
): string | undefined {
  if (sent.length === 0) return undefined;
  const total = sent.reduce((sum, one) => sum + one.ahead, 0);
  const where =
    sent.length === 1 ? `（${sent[0].label}）` : `（${sent.length}か所）`;
  return `$(cloud-upload) 送れていなかった ${total}件を GitHub へ送りました${where}`;
}

/**
 * 同期そのものが走っている最中とみなすコマンド（自動の送り直しを控える）。
 *
 * **同じ置き場へ git を2本走らせない。** `exclusiveCommands.ts` の同期の系に、
 * 塞いではいないが git を書き換える操作（取り込む・送る・履歴から戻す）を足した。
 * ここに並べるIDは `package.json` に実在するもの（`autoResendPlan.test.ts` が突き合わせる）。
 */
export const SYNC_BUSY_COMMANDS: readonly string[] = [
  "novelai.syncAllWorks",
  "novelai.saveAndSync",
  "novelai.gitSync",
  "novelai.gitPull",
  "novelai.gitPush",
  "novelai.gitRestore",
  "novelai.resolveConflicts",
  "novelai.resolveDivergence",
];

export function isSyncBusyCommand(id: string): boolean {
  return SYNC_BUSY_COMMANDS.includes(id);
}
