import {
  postingSiteInfo,
  siteProfile,
  type PostingLedger,
  type PostingSiteId,
} from "../models/posting";
import { alphapolisWorkId } from "./postingSiteUrls";
import { readerStatsDeclineKey } from "./readerStatsHelperLink";
import type { ReaderStatsEnvelope } from "./readerStatsEnvelope";
import { normalizeWorkTitle, type BackupIdentity } from "./backupMatch";

/**
 * ヘルパーで「自分の作品」と読んだが、まだ登録していない作品（作者の指示 2026-11-01）。
 *
 * 作者「自分の作品としてヘルパーに登録された作品（作品の作者管理画面からのみ可能）で、
 * まだ統合小説執筆環境に登録されていない作品は、一覧に枠だけ用意して、
 * バックアップ取得のリンクをつけてください」。
 *
 * ## 置き場は作品フォルダーの外（端末ごと）
 *
 * 投稿状態の台帳は作品ごとのもので、**未登録の作品には台帳が無い**。作品フォルダーを
 * 勝手に作るわけにもいかないので、拡張機能の保管庫（`globalState`）に置く。
 * 覚えるのは **サイト・作品ID・題・覚えた理由・最後に見た日時**だけで、数は覚えない
 * （数は登録したあとに台帳へ取り込むもの）。加えて、作者が［この作品を一覧に出さない］を
 * 選んだ印と、作者が入れたなろうの内部の数字ID（バックアップの画面の番号）を持つ。
 *
 * ## 出すのは「本人しか開けない画面で読んだ」作品だけ
 *
 * 封筒の省いてよい欄 `ownedVia` が `"owner-page"` のもの。`"approved"`（作者が手で
 * 「自分の作品」と認めた）は、他人の作品の公開ページでも付けられるので出さない
 * ——作品一覧に他人の作品の枠が並ぶと、作者は自分の書庫が壊れたと思う。
 *
 * VS Code API には依存しない（`globalState` へ書くのは features の側）。
 */

/** 覚えておく1作品 */
export interface UnregisteredOwnWork {
  readonly site: PostingSiteId;
  readonly workId: string;
  /** サイトでの作品名。封筒に無ければ持たない */
  readonly title?: string;
  readonly ownedVia: "owner-page";
  /** 最後にヘルパーから届いた日時（封筒の `readAt`） */
  readonly lastSeenAt: string;
  /** 作者が［この作品を一覧に出さない］を選んだ */
  readonly hidden?: true;
  /**
   * なろうのバックアップの画面の番号（`https://syosetu.com/backup/top/ncode/{これ}/`）。
   * **Nコードではない**ので、ヘルパーからは取れない。作者が入れたものだけ
   */
  readonly narouBackupId?: string;
}

/** 覚えておく数の上限。古いもの（最後に見た日時が古い順）から忘れる（保管庫を太らせない） */
export const MAX_UNREGISTERED_OWN_WORKS = 100;

/** 同じ作品かを見分ける鍵。なろうの大文字小文字の揺れは台帳の照合と同じ基準でそろえる */
export function ownWorkKey(site: PostingSiteId, workId: string): string {
  return readerStatsDeclineKey(site, workId);
}

/**
 * 保管庫から読んだ値を、使える形に直す。**形の違う項目は捨てる**（全体は捨てない）。
 * 保管庫は作者が手で触らない場所だが、版の違う拡張機能が書いた値が残ることはある。
 */
export function readUnregisteredOwnWorks(value: unknown): UnregisteredOwnWork[] {
  if (!Array.isArray(value)) return [];
  const out: UnregisteredOwnWork[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const site = entry.site;
    if (site !== "narou" && site !== "kakuyomu" && site !== "alphapolis" && site !== "note") {
      continue;
    }
    if (typeof entry.workId !== "string" || entry.workId.trim() === "") continue;
    if (entry.ownedVia !== "owner-page") continue;
    if (typeof entry.lastSeenAt !== "string") continue;
    out.push({
      site,
      workId: entry.workId.trim(),
      ...(typeof entry.title === "string" && entry.title.trim() !== ""
        ? { title: entry.title.trim() }
        : {}),
      ownedVia: "owner-page",
      lastSeenAt: entry.lastSeenAt,
      ...(entry.hidden === true ? { hidden: true as const } : {}),
      ...(typeof entry.narouBackupId === "string" && narouBackupIdFrom(entry.narouBackupId)
        ? { narouBackupId: narouBackupIdFrom(entry.narouBackupId) }
        : {}),
    });
  }
  return out;
}

/**
 * 封筒のうち、覚えておく作品を選ぶ（作品が決まらなかったものだけを渡すこと）。
 *
 * - `ownedVia` が `"owner-page"` で、作品IDのあるもの
 * - **管理画面から届いたもの（`source` が無い封筒）だけ。** Narou.fun などは他人の作品の
 *   ページも開けるので、`ownedVia` が付いていても枠にしない（作品IDの登録の道と同じ線。
 *   作者の裁定 2026-10-11「管理画面からのものだけ」）
 */
export function ownWorkCandidates(
  envelopes: readonly ReaderStatsEnvelope[]
): ReaderStatsEnvelope[] {
  return envelopes.filter(
    (envelope) =>
      envelope.ownedVia === "owner-page" &&
      envelope.source === undefined &&
      typeof envelope.workId === "string" &&
      envelope.workId.trim() !== ""
  );
}

/**
 * 届いた封筒で、覚えを更新する。
 *
 * - 新しい作品は足す。知っている作品は**最後に見た日時と題だけ**を新しくする
 * - 題は、より新しい封筒の分を使う（サイトで改題していれば、いまの名前のほうが近い）
 * - **作者が「出さない」を選んだ印となろうの数字IDは消さない**
 *
 * @returns 変わったら新しい並び、変わらなければ同じ配列（書かずに済ませるため）
 */
export function noteUnregisteredOwnWorks(
  list: readonly UnregisteredOwnWork[],
  envelopes: readonly ReaderStatsEnvelope[]
): readonly UnregisteredOwnWork[] {
  let next = [...list];
  let changed = false;
  for (const envelope of ownWorkCandidates(envelopes)) {
    const workId = (envelope.workId ?? "").trim();
    const key = ownWorkKey(envelope.site, workId);
    const at = next.findIndex((entry) => ownWorkKey(entry.site, entry.workId) === key);
    if (at < 0) {
      next.push({
        site: envelope.site,
        workId,
        ...(envelope.title ? { title: envelope.title } : {}),
        ownedVia: "owner-page",
        lastSeenAt: envelope.readAt,
      });
      changed = true;
      continue;
    }
    const known = next[at];
    // 古い封筒（束の中の溜めた順の前のほう）で、新しい覚えを巻き戻さない
    if (envelope.readAt < known.lastSeenAt) continue;
    const title = envelope.title ?? known.title;
    if (known.lastSeenAt === envelope.readAt && known.title === title) continue;
    next[at] = {
      ...known,
      ...(title ? { title } : {}),
      lastSeenAt: envelope.readAt,
    };
    changed = true;
  }
  if (!changed) return list;
  if (next.length > MAX_UNREGISTERED_OWN_WORKS) {
    // 「出さない」の印のものも同じ基準で忘れる（もう届かない作品の印を抱え続けない）
    next = [...next]
      .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0))
      .slice(0, MAX_UNREGISTERED_OWN_WORKS);
  }
  return next;
}

/** 1作品の覚えを書き換える（無ければ同じ配列） */
function updateOne(
  list: readonly UnregisteredOwnWork[],
  site: PostingSiteId,
  workId: string,
  change: (entry: UnregisteredOwnWork) => UnregisteredOwnWork | undefined
): readonly UnregisteredOwnWork[] {
  const key = ownWorkKey(site, workId);
  const at = list.findIndex((entry) => ownWorkKey(entry.site, entry.workId) === key);
  if (at < 0) return list;
  const replaced = change(list[at]);
  const next = [...list];
  if (replaced) next[at] = replaced;
  else next.splice(at, 1);
  return next;
}

/** ［この作品を一覧に出さない］ */
export function hideUnregisteredOwnWork(
  list: readonly UnregisteredOwnWork[],
  site: PostingSiteId,
  workId: string
): readonly UnregisteredOwnWork[] {
  return updateOne(list, site, workId, (entry) => ({ ...entry, hidden: true }));
}

/** なろうのバックアップの画面の番号を覚える */
export function setNarouBackupId(
  list: readonly UnregisteredOwnWork[],
  site: PostingSiteId,
  workId: string,
  narouBackupId: string
): readonly UnregisteredOwnWork[] {
  return updateOne(list, site, workId, (entry) => ({ ...entry, narouBackupId }));
}

/** 取り込んで登録したので忘れる（登録した作品の台帳に作品IDが入った） */
export function forgetUnregisteredOwnWork(
  list: readonly UnregisteredOwnWork[],
  site: PostingSiteId,
  workId: string
): readonly UnregisteredOwnWork[] {
  return updateOne(list, site, workId, () => undefined);
}

/**
 * 登録した作品の台帳から、サイトと作品IDの組を集める（枠から外す相手）。
 * 読めなかった台帳は渡さないこと（その作品は「作品IDの無い作品」と同じに扱う）
 */
export function registeredSiteWorkKeys(ledgers: readonly PostingLedger[]): Set<string> {
  const keys = new Set<string>();
  for (const ledger of ledgers) {
    for (const entry of ledger.siteProfiles) {
      const workId = siteProfile(ledger, entry.site)?.workId?.trim();
      if (workId) keys.add(ownWorkKey(entry.site, workId));
    }
  }
  return keys;
}

/**
 * 一覧に枠として出す作品。**出さないを選んだもの・登録済み（台帳のサイトと作品IDが同じ）
 * ものは出さない。** 並びはサイト、題の順（届いた順は作者には意味が無い）
 */
export function visibleUnregisteredOwnWorks(
  list: readonly UnregisteredOwnWork[],
  registered: ReadonlySet<string>
): UnregisteredOwnWork[] {
  const order: PostingSiteId[] = ["narou", "kakuyomu", "alphapolis", "note"];
  return list
    .filter((entry) => !entry.hidden && !registered.has(ownWorkKey(entry.site, entry.workId)))
    .sort(
      (a, b) =>
        order.indexOf(a.site) - order.indexOf(b.site) ||
        ownWorkLabel(a).localeCompare(ownWorkLabel(b), "ja")
    );
}

/** 枠に出す名前。題が無ければ作品IDで言う */
export function ownWorkLabel(entry: Pick<UnregisteredOwnWork, "title" | "workId">): string {
  return entry.title ?? `作品ID ${entry.workId}`;
}

/* ── バックアップの入口 ───────────────────────────── */

/**
 * バックアップを取る画面（2026-11-01 ヘルパーのセッションが作者の Chrome で確かめた形）。
 *
 * - `download`：開くとそのまま落ちる（アルファポリス）
 * - `page`：画面を開いて、作者に押してもらう（カクヨム。中身は CSRF つきの POST なので直のリンクにできない）
 * - `needNarouId`：なろうの内部の数字IDが要る（作者に入れてもらう）
 * - `unsupported`：組み立てられない（作品IDの形が違う・バックアップの無いサイト）
 *
 * **開くだけで、サイトへ HTTP は送らない。** 組み立てるのは形が確かめられたものだけ
 * （推測のURLを開かせない。`postingSiteUrls.ts` と同じ線）。
 */
export type BackupEntry =
  | { readonly kind: "download"; readonly url: string }
  | { readonly kind: "page"; readonly url: string; readonly hint: string }
  | { readonly kind: "needNarouId" }
  | { readonly kind: "unsupported"; readonly reason: string };

/** カクヨムの作品管理の画面で押すところ（案内の文言。押した答えの見分けには使わない） */
export const KAKUYOMU_BACKUP_HINT = "メニューの「小説をバックアップ」から";

export function backupEntryFor(
  site: PostingSiteId,
  workId: string,
  narouBackupId?: string
): BackupEntry {
  const trimmed = workId.trim();
  switch (site) {
    case "alphapolis": {
      // 9桁でなければ組まない（別の作品の書き出しを落とさせない。`alphapolisWorkId` の説明）
      const id = alphapolisWorkId(trimmed);
      return id
        ? {
            kind: "download",
            url: `https://www.alphapolis.co.jp/mypage/novel/export/${id}/UTF-8/LF`,
          }
        : { kind: "unsupported", reason: `アルファポリスの作品ID（${trimmed}）が9桁の数字ではありません。` };
    }
    case "kakuyomu":
      return /^\d+$/.test(trimmed)
        ? {
            kind: "page",
            url: `https://kakuyomu.jp/my/works/${trimmed}`,
            hint: KAKUYOMU_BACKUP_HINT,
          }
        : { kind: "unsupported", reason: `カクヨムの作品ID（${trimmed}）が数字ではありません。` };
    case "narou": {
      const id = narouBackupIdFrom(narouBackupId);
      return id
        ? { kind: "download", url: `https://syosetu.com/backup/top/ncode/${id}/` }
        : { kind: "needNarouId" };
    }
    case "note":
      return {
        kind: "unsupported",
        reason: `${postingSiteInfo(site).label}には作品のバックアップがありません。`,
      };
  }
}

/**
 * 作者が入れた、なろうのバックアップの画面の番号を読む。
 *
 * 数字だけか、なろうの作者用の画面のアドレス（`…/ncode/1702430/` の形）を受ける。
 * **Nコード（n1234ab）は受けない**——バックアップの画面は内部の数字で作品を指すので、
 * Nコードで組むと存在しない画面か、別の作品の画面になる。
 */
export function narouBackupIdFrom(input: string | null | undefined): string | undefined {
  const text = (input ?? "").trim().normalize("NFKC");
  if (/^\d{1,12}$/.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.hostname !== "syosetu.com" && !url.hostname.endsWith(".syosetu.com")) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  const at = parts.indexOf("ncode");
  const id = at >= 0 ? parts[at + 1] : undefined;
  return id && /^\d{1,12}$/.test(id) ? id : undefined;
}

/* ── 届いたファイルの名前 ───────────────────────────── */

/**
 * 書きかけのダウンロードの印（Chrome・Edge の `.crdownload`、Firefox の `.part` など）。
 * 書き終わると名前が変わるので、この名前のうちは見ない
 */
const PARTIAL_DOWNLOAD = /\.(crdownload|part|partial|download|tmp)$/i;

/** ダウンロードの重複の印（「題 (1).txt」）と、カクヨムの日付（「題_20260919.zip」）を落とした幹 */
function backupNameStem(fileName: string): { stem: string; ext: string } {
  const dot = fileName.lastIndexOf(".");
  const ext = dot < 0 ? "" : fileName.slice(dot + 1).toLowerCase();
  let stem = dot < 0 ? fileName : fileName.slice(0, dot);
  stem = stem.replace(/\s*[(（]\d+[)）]$/, "");
  stem = stem.replace(/_\d{8}$/, "");
  return { stem, ext };
}

/**
 * この作品のバックアップらしい名前か。**名前だけを見る**（中身は［取り込む］が押されるまで読まない）。
 *
 * 実物の名前（作者のダウンロードのフォルダーにあったもの）：
 * - なろう：`N4190FX.zip`（Nコード）
 * - カクヨム：`転生した受験生の異世界成り上がり　～別視点バージョ_20260919.zip`（題の頭＋日付）
 * - アルファポリス：`転生受験生の教科書チート生活　～その知識、学校で習いましたよ？～ (1).txt`（題）
 *   ——アルファポリスの書き出しの名前の決まりは、この1件から読んだもので未確認
 *
 * 拡張子は取り込みが受けるもの（zip・txt・md）だけ。そのうえで、なろうはNコード、
 * どのサイトも**題の頭（4字以上）が名前の頭と合う**ものを拾う。合わない名前は、
 * 拡張子が合っていても見ない（別の作品の ZIP や手元のメモに「届きました」と言わない）。
 */
export function looksLikeBackupOf(
  fileName: string,
  target: Pick<UnregisteredOwnWork, "site" | "workId" | "title">
): boolean {
  if (PARTIAL_DOWNLOAD.test(fileName)) return false;
  const { stem, ext } = backupNameStem(fileName);
  if (!["zip", "txt", "md"].includes(ext)) return false;
  if (target.site === "narou" && stem.toLowerCase() === target.workId.trim().toLowerCase()) {
    return true;
  }
  const name = normalizeWorkTitle(stem);
  const title = normalizeWorkTitle(target.title ?? "");
  if (name.length < 4 || title.length < 4) return false;
  // カクヨムは題を切って名前にするので、名前が題の頭になっている。逆（題が名前の頭）も受ける
  return title.startsWith(name) || name.startsWith(title);
}

/* ── 取り込む前に照らす ─────────────────────────────── */

/** バックアップの中身が枠の作品と合うか */
export type OwnWorkBackupCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * 取り込む前に、ファイルの中身（題・サイト・なろうならNコード）を枠の作品と照らす。
 *
 * **食い違えば止めて訊く**ために、理由を作者の言葉で返す。照らし方は相談パネルの
 * 照合（`backupMatch.ts`）と同じ題のそろえ方を使う。題の一部だけが合うもの
 * （本編と「〜別視点バージョン〜」）は合ったことにしない。
 */
export function checkBackupAgainstOwnWork(
  identity: BackupIdentity,
  target: Pick<UnregisteredOwnWork, "site" | "workId" | "title">
): OwnWorkBackupCheck {
  const siteLabel = postingSiteInfo(target.site).label;
  if (identity.site && identity.site !== target.site) {
    return {
      ok: false,
      reason: `このファイルは${postingSiteInfo(identity.site).label}のバックアップに見えます（枠の作品は${siteLabel}）。`,
    };
  }
  if (identity.workId && target.site === "narou") {
    return identity.workId.toLowerCase() === target.workId.trim().toLowerCase()
      ? { ok: true }
      : {
          ok: false,
          reason: `Nコードが違います（ファイルは ${identity.workId.toUpperCase()}、枠の作品は ${target.workId.toUpperCase()}）。`,
        };
  }
  const name = normalizeWorkTitle(identity.title);
  const title = normalizeWorkTitle(target.title ?? "");
  if (title === "") {
    return { ok: false, reason: "枠の作品の題が分からないため、照らせませんでした。" };
  }
  if (name === title) return { ok: true };
  const [shorter, longer] = name.length <= title.length ? [name, title] : [title, name];
  if (shorter.length >= 4 && longer.includes(shorter)) {
    return {
      ok: false,
      reason: `題の一部だけが同じです（ファイルは「${identity.title}」、枠の作品は「${target.title}」）。`,
    };
  }
  return {
    ok: false,
    reason: `題が違います（ファイルは「${identity.title}」、枠の作品は「${target.title}」）。`,
  };
}
