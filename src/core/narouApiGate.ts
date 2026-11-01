import { NAROU_GUIDELINE_URL } from "./narouApi";

/**
 * なろう小説APIを使う前の関所（作者の指示 2026-11-02）。**判定だけで、保管庫には触らない**
 * （VS Code API に依存しない。試験で時刻と保管庫の中身を渡して確かめる）。
 *
 * ## 同意
 *
 * - ガイドラインのリンクを押して**開くまで**、同意のチェックは入れられない
 *   （作者の指示「リンクを開いていない状態だとチェックが入らないようにして」）
 * - 開いたこと・同意したことは、利用者ごとに拡張機能の保管庫（globalState）に覚え、
 *   作品をまたいで効く。チェックを外せば同意だけ取り消す（開いた記録は残す）
 * - **ガイドラインの URL を記録と一緒に持つ。** URL（`NAROU_GUIDELINE_URL`）を変えたら、
 *   前の記録は「開いていない・同意していない」と読む——前のページへの同意を、新しい
 *   ページへの同意に読み替えない
 * - 既定はチェックなし（ボタンは押せない）
 *
 * ## 回数の上限（作者が運営へ約束した「1作品につき1日に数回まで」をコードで守る）
 *
 * - 同じ作品（Nコード）は、前に押してから `NAROU_API_INTERVAL_MINUTES` 分は取りにいかない
 * - 同じ作品は、手元の暦日で1日に `NAROU_API_DAILY_LIMIT` 回まで
 * - **数えるのは押して取りにいった回**（成功・失敗・同じ数で積まなかった回のどれも）。
 *   台帳の記録から数えると、同じ数で積まなかった回や失敗した回が数に入らず、上限が効かない
 */

/** 保管庫の鍵：同意（全作品で1つ） */
export const NAROU_API_CONSENT_KEY = "novelai.narouApi.consent";
/** 保管庫の鍵：取りにいった時刻（Nコード → 時刻の並び） */
export const NAROU_API_ATTEMPTS_KEY = "novelai.narouApi.attempts";

/** 同じ作品を続けて取りにいかない間（分） */
export const NAROU_API_INTERVAL_MINUTES = 60;
/** 同じ作品を1日に取りにいく回数の上限 */
export const NAROU_API_DAILY_LIMIT = 5;

/** 保管庫に置く同意の記録 */
export interface NarouApiConsentRecord {
  /** 開いた・同意したガイドラインの URL。定数と違えば、記録ごと無効 */
  guidelineUrl: string;
  /** ガイドラインを開いた日時（ISO8601） */
  openedAt?: string;
  /** 同意した日時（ISO8601）。取り消せば欄ごと消える */
  agreedAt?: string;
}

/** 画面へ渡す同意の状態 */
export interface NarouApiConsentView {
  /** ガイドラインを開いたか（今の URL で） */
  opened: boolean;
  /** 同意しているか（今の URL で） */
  agreed: boolean;
  agreedAt: string | null;
}

/** 保管庫の値を読む。**形が違えば「何も無い」**（直して書き戻さない。次に押したとき書き直る） */
export function readNarouApiConsent(
  raw: unknown,
  guidelineUrl: string = NAROU_GUIDELINE_URL
): NarouApiConsentView {
  const none: NarouApiConsentView = { opened: false, agreed: false, agreedAt: null };
  if (typeof raw !== "object" || raw === null) return none;
  const record = raw as Partial<NarouApiConsentRecord>;
  // URL が変わったら、前のページを開いた記録も同意も使わない
  if (record.guidelineUrl !== guidelineUrl) return none;
  const opened = typeof record.openedAt === "string" && record.openedAt.length > 0;
  // 開いた記録の無い同意は同意として読まない（開く前に同意できない決まりの裏返し）
  const agreed = opened && typeof record.agreedAt === "string" && record.agreedAt.length > 0;
  return { opened, agreed, agreedAt: agreed ? (record.agreedAt as string) : null };
}

/** ガイドラインを開いた（`openExternal` が成功した）ことを書き足す。同意はそのまま */
export function withGuidelineOpened(
  raw: unknown,
  at: string,
  guidelineUrl: string = NAROU_GUIDELINE_URL
): NarouApiConsentRecord {
  const view = readNarouApiConsent(raw, guidelineUrl);
  return {
    guidelineUrl,
    openedAt: at,
    ...(view.agreedAt ? { agreedAt: view.agreedAt } : {}),
  };
}

/**
 * チェックを入れた・外した。**開いていなければ同意は入れない**（`changed: false` を返す。
 * 画面ではチェックを押せないが、ほかの道から届いても入れない）。外すのはいつでもできる。
 */
export function withAgreement(
  raw: unknown,
  agreed: boolean,
  at: string,
  guidelineUrl: string = NAROU_GUIDELINE_URL
): { record: NarouApiConsentRecord; changed: boolean } {
  const view = readNarouApiConsent(raw, guidelineUrl);
  const base: NarouApiConsentRecord = {
    guidelineUrl,
    ...(view.opened ? { openedAt: (raw as NarouApiConsentRecord).openedAt } : {}),
  };
  if (!agreed) {
    return { record: base, changed: view.agreed };
  }
  if (!view.opened) return { record: base, changed: false };
  if (view.agreed) return { record: { ...base, agreedAt: view.agreedAt as string }, changed: false };
  return { record: { ...base, agreedAt: at }, changed: true };
}

/** 取りにいってよいかの答え */
export type NarouApiAttemptVerdict =
  | { allowed: true }
  | { allowed: false; message: string; waitMinutes?: number };

/** 保管庫の「取りにいった時刻」を読む（形の違うものは捨てる） */
export function readNarouApiAttempts(raw: unknown, ncode: string): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const list = (raw as Record<string, unknown>)[ncode.toLowerCase()];
  return Array.isArray(list)
    ? list.filter((entry): entry is string => typeof entry === "string" && !Number.isNaN(Date.parse(entry)))
    : [];
}

/** 手元の暦日（日の区切りは 0:00。押した回数を数える日） */
function localDay(time: Date): string {
  return `${time.getFullYear()}-${time.getMonth() + 1}-${time.getDate()}`;
}

/**
 * 今、その作品を取りにいってよいか。
 *
 * @param attempts これまでに取りにいった時刻（`readNarouApiAttempts`）
 */
export function judgeNarouApiAttempt(
  attempts: readonly string[],
  now: Date
): NarouApiAttemptVerdict {
  const times = attempts.map((entry) => new Date(entry)).filter((time) => !Number.isNaN(time.getTime()));
  const last = times.reduce<Date | undefined>(
    (latest, time) => (!latest || time > latest ? time : latest),
    undefined
  );
  if (last) {
    const elapsedMs = now.getTime() - last.getTime();
    const intervalMs = NAROU_API_INTERVAL_MINUTES * 60_000;
    // 時計が戻った（前の時刻が未来にある）ときも待たせる——上限を緩める向きに倒さない
    if (elapsedMs < intervalMs) {
      const waitMinutes = Math.max(1, Math.ceil((intervalMs - Math.max(0, elapsedMs)) / 60_000));
      return {
        allowed: false,
        waitMinutes,
        message:
          `なろうのサーバーに負担をかけないよう、同じ作品は${NAROU_API_INTERVAL_MINUTES}分に1回までにしています。` +
          `${waitMinutes}分後にもう一度押せます。`,
      };
    }
  }
  const today = localDay(now);
  const todayCount = times.filter((time) => localDay(time) === today).length;
  if (todayCount >= NAROU_API_DAILY_LIMIT) {
    return {
      allowed: false,
      message:
        `同じ作品は1日に${NAROU_API_DAILY_LIMIT}回までにしています（今日はもう${todayCount}回取りました）。` +
        "明日もう一度押せます。",
    };
  }
  return { allowed: true };
}

/** 取りにいった時刻を書き足した保管庫の値（その作品の分は直近の数件だけ持つ） */
export function withNarouApiAttempt(
  raw: unknown,
  ncode: string,
  at: string
): Record<string, string[]> {
  const base: Record<string, string[]> = {};
  if (typeof raw === "object" && raw !== null) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        base[key] = value.filter((entry): entry is string => typeof entry === "string");
      }
    }
  }
  const key = ncode.toLowerCase();
  const list = [...(base[key] ?? []), at];
  // 1日の上限を数えるのに足りる分だけ残す（保管庫を膨らませない）
  base[key] = list.slice(-(NAROU_API_DAILY_LIMIT * 2));
  return base;
}
