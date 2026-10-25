import type { WorkAnnounceConfig } from "../models/types";
import { authorOnlyPage } from "./postingSiteUrls";

/**
 * 更新告知（設計書6.41）の設定と履歴の読み方。**VS Code にも Node にも依存しない。**
 *
 * 2026-10-16 に `workRegistry.ts`（`config.json` の読み）と `announcementHistory.ts`
 * （履歴の読み）から切り出した。MCP の `novel.run`（`feature: announce`）が
 * **製品と同じ読み方**で、ハッシュタグ・作品URL・前に出した告知を拾うため
 * ——写すと、タグの揃え方が片方だけ変わる日が来る。
 */

/**
 * 更新告知の設定（`config.json` の `announce`）を読む。
 *
 * **壊れていても投げない。** ここは告知文を作るときにしか使わない欄で、
 * 手で書き間違えたせいで作品そのものが開けなくなるほうが困る。
 * 読めない形なら `announce` ごと無かったことにして、他の欄は読む。
 */
export function parseAnnounceConfig(raw: unknown): WorkAnnounceConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;

  // 欄そのものの型が違うときは、作者が何を意図したか決められない。
  // 半端に読むと「設定したはずのタグが黙って消える」ので、丸ごと捨てる
  if (value.hashtags !== undefined && !Array.isArray(value.hashtags)) {
    return undefined;
  }
  if (value.workUrl !== undefined && typeof value.workUrl !== "string") {
    return undefined;
  }

  // **揃えてから重ねを落とす。** 「創作」と「#創作」は書き方が違うだけで
  // 同じタグなので、そのまま並べると投稿に同じものが2つ出る。
  // `Set` は先に入れたほうを残すので、作者が書いた順が保たれる
  const hashtags = [
    ...new Set(
      ((value.hashtags as unknown[] | undefined) ?? [])
        .filter((item: unknown): item is string => typeof item === "string")
        .map(normalizeHashtag)
        .filter((tag: string) => tag.length > 0)
    ),
  ];

  return {
    hashtags,
    workUrl: typeof value.workUrl === "string" ? value.workUrl.trim() : "",
  };
}

/**
 * 「SNS告知設定」の作品URLの欄に、最初に出しておく値（2026-10-25 の実機確認）。
 *
 * 作者はクリップボードに残っていた作者用の投稿ページを入れ、告知に載った。
 * 台帳（投稿状態.json）の作品の番号から読者向けの作品ページを組み立てられるなら、
 * 欄の初期値に出しておけば、作者は Enter を押すだけで済む。
 *
 * - **保存してある値はそのまま出す。** 作者用のページでも差し替えない——欄の
 *   初期値が保存値と違うと、開いただけで書き換えたように見える。作者用なら
 *   欄の下の検査（`authorOnlyPageNotice`）が直す先を言う
 * - **空のときは、候補が1つに決まるときだけ出す。** どのサイトへ誘導したいかは
 *   その作者の都合で、こちらでは選ばない（`resolveWorkListUrl` と同じ考え）
 * - 台帳の候補が作者用のページなら、読者向けへ直してから数える。直せなければ外す
 *
 * **初期値は下書きで、Enter を押すまで保存しない。**
 *
 * @param current 保存してある作品URL（未設定なら空）
 * @param candidates 台帳から組み立てた作品ページのURL
 */
export function announceWorkUrlDraft(
  current: string | undefined,
  candidates: readonly string[]
): string {
  const saved = (current ?? "").trim();
  if (saved) return saved;
  const readerUrls = new Set(
    candidates.flatMap((url) => {
      const page = authorOnlyPage(url);
      if (!page) return [url.trim()];
      return page.readerUrl ? [page.readerUrl] : [];
    })
  );
  return readerUrls.size === 1 ? [...readerUrls][0] : "";
}

/**
 * ハッシュタグを1つの形に揃える。
 *
 * 作者は「創作」とも「#創作」とも書く。**空白はタグを切ってしまう**ので
 * 落とす（「# 創作」と書かれても1つのタグとして通す）。
 *
 * **全角の「＃」も落とす。** 日本語入力ではこちらがそのまま出るので、
 * 半角だけを見ていると「#＃創作」になり、投稿サイトではタグとして
 * 扱われない。先頭の `#`／`＃` をまとめて落としてから半角を1つ付けるので、
 * 何度通しても同じ形になる。
 */
export function normalizeHashtag(raw: string): string {
  const body = raw.replace(/\s+/gu, "").replace(/^[#＃]+/u, "");
  return body ? `#${body}` : "";
}

/**
 * これまでに作った告知（X用の本文）の履歴の置き場（`.aiwriter/` の下）。
 * **作品の内容ではない**ので設定資料には置かず、Gitでも同期しない（キャッシュと同じ扱い）。
 */
export const ANNOUNCEMENT_HISTORY_SUBPATH = ["cache", "announcements.json"] as const;

/** 履歴を読む。**読めなければ空**（履歴は無くても告知は作れる） */
export function parseAnnouncementHistory(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

/** 覚えておく件数。増やしすぎるとプロンプトが膨らむ */
export const ANNOUNCEMENT_HISTORY_MAX = 20;

/**
 * 履歴へ足した後の並びを決める。**製品の［更新SNS告知文作成］と MCP の告知文
 * （novel.run feature: announce）が同じ関数を通す**（作者の裁定 2026-10-16 夜の2。
 * 外部AIが作った告知も履歴へ足す）。写すと、片方だけ重ね落としや件数が変わる日が来る。
 *
 * 前後の空白を落とし、空は捨て、同じ文は前に出たほうを残して1つにし、直近の
 * `ANNOUNCEMENT_HISTORY_MAX` 件だけを持つ。
 */
export function mergeAnnouncementHistory(
  existing: readonly string[],
  texts: readonly string[]
): string[] {
  return [...new Set([...existing, ...texts.map((text) => text.trim())])]
    .filter(Boolean)
    .slice(-ANNOUNCEMENT_HISTORY_MAX);
}

/** 履歴のファイルの中身（製品が書いてきた形のまま：2字下げのJSONの配列＋末尾の改行） */
export function formatAnnouncementHistory(history: readonly string[]): string {
  return `${JSON.stringify(history, null, 2)}\n`;
}
