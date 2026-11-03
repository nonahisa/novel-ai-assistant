import {
  postingEpisodeKey,
  type PostingEpisodeTargetLike,
  type PostingLedger,
  type PostingSiteId,
} from "../models/posting";
import type { LocalOutlineEpisode, OutlineEpisode } from "./chapterOutline";

/**
 * ヘルパー（Chrome 拡張「統合小説執筆環境ヘルパー」0.20.0）から届く、投稿した話の番号
 * （`novelai-posted` v1。設計書6.68.8）。
 *
 * ## なぜ受けるのか
 *
 * 台帳はサイトを読みにいかない（6.68.1）ので、サイトが振った話の番号を知る道は
 * ヘルパーが送り返す値しか無い。番号があれば、出し直しで話の編集画面を直に開ける
 * （`postingSiteUrls.ts` の `revisionPageUrl`）。作者の裁定 2026-11-03 昼「C-1」。
 *
 * ## 形
 *
 * ```json
 * { "novelai-posted": 1, "site": "kakuyomu", "workId": "1681…", "episodeId": "1681…123",
 *   "title": "第13話 星の落ちる夜", "postRef": "k7Qm2xP9", "readAt": "2026-11-03T21:40:00.000+09:00" }
 * { "novelai-posted": 1, "site": "narou", "novelNo": "1234567", "episodeId": "8765432", "readAt": "…" }
 * ```
 *
 * - **URL は届かない。** 編集画面の URL はこちらが番号から組み立てる（クリップボードから来た
 *   URL をそのまま開かないため）
 * - なろうでは `workId`（Nコード）・`title`・`postRef` は付かない。ヘルパーはアドレス欄の
 *   数字しか読まないため。付いていても読まない（使い道が無い値を台帳へ入れない）
 *
 * **直して受け取らない。** 版が違う・知らないサイト・番号の形が崩れている封筒は、
 * 理由を言って止める（`chapterEnvelope.ts` と同じ流儀）。
 *
 * VS Code API には依存しない。
 */

export const POSTED_MARKER = "novelai-posted";
export const POSTED_ENVELOPE_VERSION = 1;

/** 番号を送り返すサイト（ヘルパーとの取り決め。note は送らない） */
const POSTED_SITES = ["kakuyomu", "alphapolis", "narou"] as const;
export type PostedEnvelopeSite = (typeof POSTED_SITES)[number];

/** 話の番号の形。カクヨムは20桁前後あり、JavaScript の数にすると桁が落ちるので文字列で受ける */
const EPISODE_ID_PATTERN = /^\d{1,30}$/u;
/** なろうの小説番号（Nコードではなく、作者用の画面の URL に出る数字） */
const NOVEL_NO_PATTERN = /^\d{1,20}$/u;
/** 作品ID（`novelai-post` の workId と同じ書式） */
const WORK_ID_PATTERN = /^[0-9A-Za-z]{1,64}$/u;
/** 貼り込みの札（`postingEnvelope.ts` の `POST_REF_PATTERN` と同じ） */
const POST_REF_PATTERN = /^[0-9A-Za-z_-]{1,64}$/u;
/** 題の長さの上限（ヘルパーとの取り決め） */
const MAX_TITLE = 200;
/** クリップボードの長さの上限（欄が数個だけの封筒なので、これより長いものは封筒ではない） */
const MAX_CLIPBOARD = 20_000;

export interface PostedEnvelope {
  readonly site: PostedEnvelopeSite;
  /** 作品ID。カクヨム・アルファポリスでは必ずある。なろうでは無い */
  readonly workId?: string;
  /** なろうの小説番号。なろうでは必ずある */
  readonly novelNo?: string;
  /** 話の番号。なろうの作品の管理画面で押したときは無い */
  readonly episodeId?: string;
  /** 画面の題の欄の字（なろうでは無い） */
  readonly title?: string;
  /** 貼り込みの札（ヘルパーが覚えていなければ無い） */
  readonly postRef?: string;
  /** 読んだ時刻。読めなければ null（呼ぶ側が受け取った時刻で埋める） */
  readonly readAt: string | null;
}

export type PostedClipboardResult =
  | { readonly ok: true; readonly envelope: PostedEnvelope }
  /** この封筒ではない（中身には触れない。クリップボードは作者の私物） */
  | { readonly ok: false; readonly kind: "notFound" }
  /** この封筒だが、読めない形 */
  | { readonly ok: false; readonly kind: "invalid"; readonly reason: string };

export function parsePostedClipboard(text: string): PostedClipboardResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || trimmed.length > MAX_CLIPBOARD) {
    return { ok: false, kind: "notFound" };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { ok: false, kind: "notFound" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, kind: "notFound" };
  }
  const envelope = value as Record<string, unknown>;
  if (!(POSTED_MARKER in envelope)) return { ok: false, kind: "notFound" };

  const version = envelope[POSTED_MARKER];
  if (version !== POSTED_ENVELOPE_VERSION) {
    return invalid(
      `投稿した話の番号の形式の版（${String(version)}）が、この拡張機能の読める版（${POSTED_ENVELOPE_VERSION}）と違います。` +
        "統合小説執筆環境ヘルパーと統合小説執筆環境の両方を新しくしてから、もう一度お試しください。"
    );
  }
  const site = envelope.site;
  if (typeof site !== "string" || !POSTED_SITES.includes(site as PostedEnvelopeSite)) {
    return invalid("投稿した話の番号の出どころ（投稿サイト）が読めませんでした。");
  }
  const readAt = typeof envelope.readAt === "string" && envelope.readAt.trim() !== ""
    ? clean(envelope.readAt)
    : null;

  const episodeId = envelope.episodeId;
  if (episodeId !== undefined && !matches(episodeId, EPISODE_ID_PATTERN)) {
    return invalid("投稿した話の番号の形が正しくありません（数字だけのはずです）。");
  }

  if (site === "narou") {
    const novelNo = envelope.novelNo;
    if (!matches(novelNo, NOVEL_NO_PATTERN)) {
      return invalid("なろうの小説番号が入っていないか、形が正しくありません（数字だけのはずです）。");
    }
    return {
      ok: true,
      envelope: {
        site,
        novelNo: (novelNo as string).trim(),
        ...(typeof episodeId === "string" ? { episodeId: episodeId.trim() } : {}),
        readAt,
      },
    };
  }

  // カクヨム・アルファポリスは作品IDと話の番号が要る（どの作品のどの話かを照らすため）
  const workId = envelope.workId;
  if (!matches(workId, WORK_ID_PATTERN)) {
    return invalid("作品IDが入っていないか、形が正しくありません。");
  }
  if (typeof episodeId !== "string") {
    return invalid("投稿した話の番号が入っていませんでした。");
  }
  const postRef = envelope.postRef;
  /*
    **札の形が崩れていれば封筒ごと断る**（ヘルパーとの取り決め）。札はこちらが作って渡した
    値をそのまま返すだけなので、崩れているならどちらかの不具合で、話を決める手がかりに使えない
  */
  if (postRef !== undefined && !matches(postRef, POST_REF_PATTERN)) {
    return invalid("貼り込みの札の形が正しくありません。統合小説執筆環境ヘルパーを新しくしてください。");
  }
  const title = envelope.title;
  if (title !== undefined && typeof title !== "string") {
    return invalid("題の形が正しくありません。");
  }
  const cleanedTitle = typeof title === "string" ? clean(title) : "";
  return {
    ok: true,
    envelope: {
      site: site as PostedEnvelopeSite,
      workId: (workId as string).trim(),
      episodeId: episodeId.trim(),
      ...(cleanedTitle ? { title: cleanedTitle } : {}),
      ...(typeof postRef === "string" ? { postRef: postRef.trim() } : {}),
      readAt,
    },
  };
}

function invalid(reason: string): PostedClipboardResult {
  return { ok: false, kind: "invalid", reason };
}

function matches(value: unknown, pattern: RegExp): boolean {
  return typeof value === "string" && pattern.test(value.trim());
}

/**
 * **誰が作ったか分からない文字列**なので、制御文字を落として短く切る。
 * 制御文字は `\u0000`〜`\u001f` と `\u007f`（生のまま書かない。sourceHygiene）
 */
function clean(value: string): string {
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  return text.length > MAX_TITLE ? text.slice(0, MAX_TITLE) : text;
}

/* ── 番号を入れてよいか ─────────────────────────────────── */

/**
 * 話の番号を投稿の記録へ入れるとき、何が起きるか（設計書6.68.8）。
 *
 * - `add`：その話にまだ番号が無い（入れる）
 * - `same`：もう同じ番号が入っている（書かない。同じ封筒を2度受けても記録は増えない）
 * - `replace`：**別の番号が入っている。確かめずに上書きしない**（取り違えたとき戻す道が無くなる）
 * - `taken`：同じサイトの**別の話**がもうこの番号を持っている（どちらかの取り違え。書かない）
 * - `noPost`：その話・そのサイトの投稿の記録がまだ無い（番号を付ける先が無い）
 */
export type SiteEpisodeIdPlan =
  | { readonly kind: "add" }
  | { readonly kind: "same" }
  | { readonly kind: "replace"; readonly existing: string }
  | { readonly kind: "taken"; readonly holder: string }
  | { readonly kind: "noPost" };

export function planSiteEpisodeId(
  ledger: PostingLedger,
  target: PostingEpisodeTargetLike,
  site: PostingSiteId,
  episodeId: string
): SiteEpisodeIdPlan {
  const key = postingEpisodeKey(target);
  const id = episodeId.trim();
  const holder = ledger.posts.find(
    (post) =>
      post.site === site && post.siteEpisodeId === id && postingEpisodeKey(post) !== key
  );
  if (holder) return { kind: "taken", holder: holder.episodePath };
  const post = ledger.posts.find(
    (entry) => entry.site === site && postingEpisodeKey(entry) === key
  );
  if (!post) return { kind: "noPost" };
  if (!post.siteEpisodeId) return { kind: "add" };
  if (post.siteEpisodeId === id) return { kind: "same" };
  return { kind: "replace", existing: post.siteEpisodeId };
}

/** 章立てから写す番号1つ */
export interface OutlineEpisodeIdEntry {
  readonly target: PostingEpisodeTargetLike;
  readonly label: string;
  readonly episodeId: string;
}

/** 章立ての番号を投稿の記録へ写す計画（6.68.8。`novelai-chapters` の `episodeId`） */
export interface OutlineEpisodeIdPlan {
  /** まだ番号の無い話へ入れるもの */
  readonly add: readonly OutlineEpisodeIdEntry[];
  /** **別の番号がある話。訊かずに替えない** */
  readonly replace: readonly (OutlineEpisodeIdEntry & { readonly existing: string })[];
  /** もう同じ番号だった話の数 */
  readonly same: number;
  /** 投稿の記録が無い話の数（番号は捨てる） */
  readonly noPost: number;
  /** 同じ番号が別の話にある話（取り違えの疑い。書かない） */
  readonly taken: readonly OutlineEpisodeIdEntry[];
  /** 手元の話と照らせなかった行の数（番号は捨てる） */
  readonly unmatched: number;
}

/**
 * 章立ての行ごとの番号を、照らせた手元の話の投稿の記録へ写す計画を立てる（まだ書かない）。
 *
 * @param outline サイトの話の並び（`episodeId` のある行だけが対象）
 * @param matched `matchOutlineEpisodes` の結果（行ごとの手元の話）
 */
export function planOutlineEpisodeIds(
  outline: readonly OutlineEpisode[],
  matched: readonly (LocalOutlineEpisode | undefined)[],
  ledger: PostingLedger,
  site: PostingSiteId
): OutlineEpisodeIdPlan {
  const add: OutlineEpisodeIdEntry[] = [];
  const replace: (OutlineEpisodeIdEntry & { existing: string })[] = [];
  const taken: OutlineEpisodeIdEntry[] = [];
  let same = 0;
  let noPost = 0;
  let unmatched = 0;
  outline.forEach((episode, index) => {
    if (!episode.episodeId) return;
    const local = matched[index];
    if (!local) {
      unmatched++;
      return;
    }
    // 合本の中の話は、投稿キットと同じ鍵（話数か、読めなければ並び）で指す
    const target: PostingEpisodeTargetLike = local.collected
      ? { episodePath: local.relPath, chapter: local.collected.chapter, order: local.collected.order }
      : local.relPath;
    const entry = { target, label: local.label, episodeId: episode.episodeId };
    // 同じ封筒の中で先に入れると決めた番号も「別の話の番号」として見る
    const pending = add.find(
      (other) =>
        other.episodeId === entry.episodeId &&
        postingEpisodeKey(other.target) !== postingEpisodeKey(target)
    );
    if (pending) {
      taken.push(entry);
      return;
    }
    const plan = planSiteEpisodeId(ledger, target, site, episode.episodeId);
    switch (plan.kind) {
      case "add":
        add.push(entry);
        return;
      case "same":
        same++;
        return;
      case "noPost":
        noPost++;
        return;
      case "taken":
        taken.push(entry);
        return;
      case "replace":
        replace.push({ ...entry, existing: plan.existing });
        return;
    }
  });
  return { add, replace, same, noPost, taken, unmatched };
}

/** 題を比べる形（全角・半角と空白の違いだけを揃える。`chapterOutline.ts` の titleKey と同じ考え） */
export function postedTitleKey(title: string | null | undefined): string {
  return (title ?? "").normalize("NFKC").replace(/\s+/gu, "");
}

/**
 * 届いた題と同じ題の候補（設計書6.68.8。札が無いときの手がかり）。
 *
 * **ちょうど同じ題だけを拾う**（似ている・含むは拾わない）。拾えたのが1つのときだけ
 * 呼ぶ側が決めてよく、0か2つ以上なら作者に選んでもらう（推し量って決めない）。
 */
export function postedTitleMatches<T extends { readonly titles: readonly string[] }>(
  candidates: readonly T[],
  title: string | undefined
): T[] {
  const wanted = postedTitleKey(title);
  if (wanted === "") return [];
  return candidates.filter((candidate) =>
    candidate.titles.some((entry) => postedTitleKey(entry) === wanted)
  );
}
