// `paths.ts` ではなく純粋な部分を直に指す——ここは窓の札（`windowCard.ts`）を
// 通して MCP の束からも読まれ、`vscode` へ届いてはいけない（`mcpReach.test.ts`）
import { isPathInside, relative } from "./pathText";

/**
 * 原稿エディターの未送信の状態を、窓の札（MCP の `windows.list`）へ載せる形
 * （作者の裁定、2026-10-01。設計書6.25.9・6.87.17）。
 *
 * **なぜ要るか。** 2026-10-01 ノートPCで、拡張機能ホストが起動し直したあと
 * 打った約100字が原稿に届かず、作者が気づくまで外から分からなかった。
 * 画面の赤字の知らせ（6.25.9）は作者の目にしか届かない。外のセッションが
 * `windows.list` で「どの原稿で、何段目の知らせが、何秒出ているか」を
 * 読めるようにする。
 *
 * **本文は載せない。** 札は保管庫に平文で置かれ、外のセッションが読む。
 * 載せるのは数と真偽と時刻だけで、画面からの知らせも決めた項目だけを拾う
 * （`parseManuscriptStatusMessage`）——書き手が誤って本文を足しても札へ流れない。
 *
 * ここは**形と判定だけ**を持つ（VS Code にも Node にも依存しない）。
 */

/** 知らせの段。0＝出ていない／1＝送り直し中／2＝入らない（開き直す） */
export type UnsentStage = 0 | 1 | 2;

/**
 * 画面（原稿エディターの WebView）が知らせてくる状態。
 *
 * **画面が送るのは、知らせの出し下げ・段の変化・控えの有無が変わったときだけ**
 * （打鍵のたびには送らない）。便の数や字数の差は、その時点の値である。
 */
export interface ManuscriptStatusReport {
  /** 「打った字が原稿に入っていない」の知らせが出ているか */
  unsent: boolean;
  stage: UnsentStage;
  /** 知らせが出てから、画面が知らせを送るまでの長さ（ミリ秒）。出ていなければ null */
  shownMs: number | null;
  /** 返事（`editApplied`）の来ていない便の数（送り直しの便も1便と数える） */
  pendingEdits: number;
  /** 画面の字数 − 画面へ最後に届いた文書の字数。文書がまだ届いていなければ null */
  lengthGap: number | null;
  /** 画面の状態（`setState` の `rescue`）に控えがあるか */
  rescueKept: boolean;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 画面からの知らせを確かめる。**決めた項目だけを拾う**（本文が混ざっていても捨てる）。
 * 形が違えば `undefined`（WebView から来るものは信用しない）。
 */
export function parseManuscriptStatusMessage(
  value: unknown
): ManuscriptStatusReport | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.unsent !== "boolean" || typeof record.rescueKept !== "boolean") {
    return undefined;
  }
  if (record.stage !== 0 && record.stage !== 1 && record.stage !== 2) return undefined;
  if (record.shownMs !== null && !isFiniteNumber(record.shownMs)) return undefined;
  if (!isFiniteNumber(record.pendingEdits)) return undefined;
  if (record.lengthGap !== null && !isFiniteNumber(record.lengthGap)) return undefined;
  return {
    unsent: record.unsent,
    stage: record.stage,
    shownMs: record.shownMs === null ? null : Math.max(0, record.shownMs),
    pendingEdits: Math.max(0, Math.floor(record.pendingEdits)),
    lengthGap: record.lengthGap === null ? null : Math.trunc(record.lengthGap),
    rescueKept: record.rescueKept,
  };
}

/**
 * 拡張機能が持っている、開いている原稿エディター1つぶんの控え（札を組む材料）。
 */
export interface ManuscriptEditorSnapshot {
  /** 作品の題。作品の外なら null */
  work: string | null;
  /** 作品からの相対。作品の外なら URI（`manuscriptLocation`） */
  location: string;
  /** 画面から最後に届いた状態。まだ届いていなければ undefined */
  report: ManuscriptStatusReport | undefined;
  /** その状態が届いた時刻 */
  reportedAt: Date | undefined;
  /** 拡張機能が最後に「入った」（`editApplied` の ok）と返した時刻 */
  lastAppliedAt: Date | undefined;
  /** この画面から何か（打鍵の便・カーソル・状態）が最後に届いた時刻 */
  lastHeardAt: Date | undefined;
}

/** 原稿エディターのタブ1つ（`vscode.window.tabGroups` から拾う） */
export interface ManuscriptTabSnapshot {
  /** 比べるための鍵（`manuscriptLedgerKey`） */
  key: string;
  work: string | null;
  location: string;
  /** そのグループで前に出ているタブか（＝画面が作られているはず） */
  visible: boolean;
}

/** 札に載せる、原稿エディター1つぶん */
export interface ManuscriptEditorCardEntry {
  work: string | null;
  location: string;
  unsent: boolean;
  stage: UnsentStage;
  /** 知らせが出た時刻（ISO）。出ていなければ null */
  unsentSince: string | null;
  /** 返事の来ていない便の数。画面から状態がまだ届いていなければ null */
  pendingEdits: number | null;
  /** 画面の字数 − 最後に届いた文書の字数。分からなければ null */
  lengthGap: number | null;
  /**
   * 最後に「入った」と返した時刻（ISO）。**拡張機能の側で記録する**——
   * 画面がその返事を受け取ったかまでは見ない（受け取れない状態では、画面は
   * 札へ何も伝えられない）
   */
  lastAppliedAt: string | null;
  /** 画面の状態に控えがあるか。分からなければ null */
  rescueKept: boolean | null;
  /** この画面から最後に何か届いた時刻（ISO） */
  lastHeardAt: string | null;
}

/** 拡張機能が受け持っていない原稿エディターのタブ */
export interface OrphanManuscriptTab {
  work: string | null;
  location: string;
  visible: boolean;
}

/** 札の `manuscripts` */
export interface ManuscriptEditorsCard {
  /** この拡張機能ホストが受け持っている原稿エディター */
  editors: ManuscriptEditorCardEntry[];
  /**
   * タブはあるのに、この拡張機能ホストが受け持っていない原稿エディター。
   *
   * **拡張機能ホストが起動し直すと、画面は生きたまま受け手を失い、新しい
   * ホストには `resolveCustomTextEditor` が呼ばれ直さない**（2026-10-01 の件。
   * 送り直しても届かなかった）。新しいホストはタブの一覧からしか、その画面が
   * あることを知れない。**前に出ていないタブ**は、再読み込みのあと画面が
   * まだ作られていないだけのこともある（`visible: false`）。
   */
  orphanTabs: OrphanManuscriptTab[];
  /** 受け持っていない原稿エディターがあり、その状態が分からない */
  stateUnknown: boolean;
  /** 状態が分からないときの説明。分かるときは null */
  note: string | null;
  /** 原稿エディターから最後に何か届いた時刻（閉じた画面のぶんも含む）。ISO */
  lastHeardAt: string | null;
}

export const MANUSCRIPT_STATE_UNKNOWN_NOTE =
  "原稿エディターの状態は不明です。開いている原稿エディターのうち、" +
  "この拡張機能ホストが受け持っていないものがあります（orphanTabs）。" +
  "拡張機能ホストが起動し直したあとの画面なら、打った字は原稿に届きません。" +
  "visible: false のタブは、まだ画面が作られていないだけのこともあります。";

function iso(date: Date | undefined): string | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function buildManuscriptEditorsCard(input: {
  editors: readonly ManuscriptEditorSnapshot[];
  tabs: readonly ManuscriptTabSnapshot[];
  ownedKeys: Iterable<string>;
  lastHeardAt: Date | undefined;
}): ManuscriptEditorsCard {
  const editors = input.editors.map((editor): ManuscriptEditorCardEntry => {
    const report = editor.report;
    const unsentSince =
      report?.unsent && report.shownMs !== null && editor.reportedAt
        ? iso(new Date(editor.reportedAt.getTime() - report.shownMs))
        : null;
    return {
      work: editor.work,
      location: editor.location,
      unsent: report?.unsent ?? false,
      stage: report?.stage ?? 0,
      unsentSince,
      pendingEdits: report ? report.pendingEdits : null,
      lengthGap: report ? report.lengthGap : null,
      lastAppliedAt: iso(editor.lastAppliedAt),
      rescueKept: report ? report.rescueKept : null,
      lastHeardAt: iso(editor.lastHeardAt),
    };
  });

  // 同じ文書のタブが2つのグループにあれば1件にまとめ、見えているほうを残す
  const owned = new Set(input.ownedKeys);
  const orphans = new Map<string, OrphanManuscriptTab>();
  for (const tab of input.tabs) {
    if (owned.has(tab.key)) continue;
    const known = orphans.get(tab.key);
    if (known) {
      known.visible = known.visible || tab.visible;
      continue;
    }
    orphans.set(tab.key, { work: tab.work, location: tab.location, visible: tab.visible });
  }
  const orphanTabs = [...orphans.values()];
  const stateUnknown = orphanTabs.length > 0;
  return {
    editors,
    orphanTabs,
    stateUnknown,
    note: stateUnknown ? MANUSCRIPT_STATE_UNKNOWN_NOTE : null,
    lastHeardAt: iso(input.lastHeardAt),
  };
}

/**
 * 札に書く文書の場所。**作品の中なら作品からの相対、外なら URI。**
 *
 * 絶対パスを書かないのは、家のフォルダーの場所（ユーザー名を含む）を札へ
 * 入れないため（`windowCard.ts` の `machineName` と同じ線引き）。作品の外の
 * ファイルは相対にしようがないので、VS Code の URI のまま書く。
 */
export function manuscriptLocation(
  filePath: string,
  uriString: string,
  work: { title: string; folderPath: string } | undefined
): { work: string | null; location: string } {
  if (work && isPathInside(work.folderPath, filePath)) {
    return {
      work: work.title,
      location: relative(work.folderPath, filePath).split("\\").join("/"),
    };
  }
  return { work: null, location: uriString };
}

/* ── 読む側（古い札は欠けた項目を null で埋める） ── */

/** 有るのに型が違う（壊れた札）の印。`false` と取り違えないよう専用の値にする */
const BAD = Symbol("bad");

function nullableString(value: unknown): string | null | typeof BAD {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : BAD;
}

function nullableNumber(value: unknown): number | null | typeof BAD {
  if (value === undefined || value === null) return null;
  return isFiniteNumber(value) ? value : BAD;
}

function nullableBoolean(value: unknown): boolean | null | typeof BAD {
  if (value === undefined || value === null) return null;
  return typeof value === "boolean" ? value : BAD;
}

function parseEntry(value: unknown): ManuscriptEditorCardEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.location !== "string") return undefined;
  const work = nullableString(raw.work);
  const unsentSince = nullableString(raw.unsentSince);
  const lastAppliedAt = nullableString(raw.lastAppliedAt);
  const lastHeardAt = nullableString(raw.lastHeardAt);
  const pendingEdits = nullableNumber(raw.pendingEdits);
  const lengthGap = nullableNumber(raw.lengthGap);
  const rescueKept = nullableBoolean(raw.rescueKept);
  const unsent = nullableBoolean(raw.unsent);
  if (
    work === BAD ||
    unsentSince === BAD ||
    lastAppliedAt === BAD ||
    lastHeardAt === BAD ||
    pendingEdits === BAD ||
    lengthGap === BAD ||
    rescueKept === BAD ||
    unsent === BAD
  ) {
    return undefined;
  }
  const stage = raw.stage === undefined || raw.stage === null ? 0 : raw.stage;
  if (stage !== 0 && stage !== 1 && stage !== 2) return undefined;
  return {
    work,
    location: raw.location,
    unsent: unsent ?? false,
    stage,
    unsentSince,
    pendingEdits,
    lengthGap,
    lastAppliedAt,
    rescueKept,
    lastHeardAt,
  };
}

function parseOrphan(value: unknown): OrphanManuscriptTab | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const work = nullableString(raw.work);
  if (work === BAD || typeof raw.location !== "string") return undefined;
  if (raw.visible !== undefined && typeof raw.visible !== "boolean") return undefined;
  return { work, location: raw.location, visible: raw.visible === true };
}

/**
 * 札の `manuscripts` を読む。**無ければ `null`**（古い版の札）、
 * **形が違えば `false`**（壊れた札）。中の項目が欠けていれば null で埋める。
 */
export function parseManuscriptEditorsCard(
  value: unknown
): ManuscriptEditorsCard | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const editorsRaw = raw.editors ?? [];
  const orphansRaw = raw.orphanTabs ?? [];
  if (!Array.isArray(editorsRaw) || !Array.isArray(orphansRaw)) return false;
  const editors: ManuscriptEditorCardEntry[] = [];
  for (const item of editorsRaw) {
    const entry = parseEntry(item);
    if (!entry) return false;
    editors.push(entry);
  }
  const orphanTabs: OrphanManuscriptTab[] = [];
  for (const item of orphansRaw) {
    const orphan = parseOrphan(item);
    if (!orphan) return false;
    orphanTabs.push(orphan);
  }
  const note = nullableString(raw.note);
  const lastHeardAt = nullableString(raw.lastHeardAt);
  if (note === BAD || lastHeardAt === BAD) return false;
  if (raw.stateUnknown !== undefined && typeof raw.stateUnknown !== "boolean") return false;
  return {
    editors,
    orphanTabs,
    stateUnknown: raw.stateUnknown === true || orphanTabs.length > 0,
    note,
    lastHeardAt,
  };
}

/* ── 見せ方（windows.list） ── */

export interface ManuscriptEditorCardEntryView extends ManuscriptEditorCardEntry {
  /** 知らせが出てからの秒数（読んだ時点）。出ていない・読めなければ null */
  unsentSeconds: number | null;
  /** この画面から最後に何か届いてからの秒数。読めなければ null */
  silentSeconds: number | null;
}

export interface ManuscriptEditorsCardView extends ManuscriptEditorsCard {
  editors: ManuscriptEditorCardEntryView[];
  /** 原稿エディターから最後に何か届いてからの秒数。読めなければ null */
  silentSeconds: number | null;
}

function secondsSince(at: string | null, now: Date): number | null {
  if (at === null) return null;
  const time = Date.parse(at);
  if (Number.isNaN(time)) return null;
  // 先の時刻（時計のずれ）は「いま」とみなす
  return Math.floor(Math.max(0, now.getTime() - time) / 1000);
}

export function describeManuscriptEditorsCard(
  card: ManuscriptEditorsCard,
  now: Date
): ManuscriptEditorsCardView {
  return {
    ...card,
    editors: card.editors.map((editor) => ({
      ...editor,
      unsentSeconds: editor.unsent ? secondsSince(editor.unsentSince, now) : null,
      silentSeconds: secondsSince(editor.lastHeardAt, now),
    })),
    silentSeconds: secondsSince(card.lastHeardAt, now),
  };
}
