import type { ContestListing } from "./contestListing";

/**
 * 作品と公募を読み比べるための文（設計書6.3.6.4・6.3.6.5）。
 *
 * AIの提案（P-42）とベクトル検索の近さの**両方がここを使う**——材料が
 * 2つの道で違うと、「近い順」と「AIの提案」が別の物差しで並ぶ。
 *
 * VS Code API には依存しない。
 */

/** 作品の概要（プロット・紹介文・種類から集めたもの）。書かれていない項目は空 */
export interface WorkProfile {
  readonly title: string;
  /** 作品の種類（小説・台本…。設計書6.109） */
  readonly kind: string;
  /** プロットの「形式」（短編・長編…） */
  readonly format: string;
  readonly genre: string;
  readonly logline: string;
  /** プロットの「あらすじ」 */
  readonly outline: string;
  /** 作品紹介文（`設定/synopsis.md`） */
  readonly blurb: string;
}

/** 項目ごとに渡す字数の上限（AIへ送る量と、埋め込みの長さを抑える） */
export const WORK_PROFILE_LIMITS = {
  genre: 200,
  logline: 200,
  outline: 1500,
  blurb: 600,
} as const;

/** 比べる材料があるか。**種類・形式だけでは中身が分からない**ので数えない */
export function hasWorkProfile(profile: WorkProfile): boolean {
  return Boolean(profile.genre || profile.logline || profile.outline || profile.blurb);
}

/** 作品の概要を1つの文にする（空の項目は出さない） */
export function workProfileText(profile: WorkProfile): string {
  const lines: string[] = [];
  const push = (label: string, value: string, limit?: number) => {
    const text = value.trim();
    if (!text) return;
    lines.push(`${label}：${limit ? cut(text, limit) : text}`);
  };
  push("種類", profile.kind);
  push("形式", profile.format);
  push("ジャンル", profile.genre, WORK_PROFILE_LIMITS.genre);
  push("ログライン", profile.logline, WORK_PROFILE_LIMITS.logline);
  push("あらすじ", profile.outline, WORK_PROFILE_LIMITS.outline);
  push("紹介文", profile.blurb, WORK_PROFILE_LIMITS.blurb);
  return lines.join("\n");
}

/**
 * 公募の「何を募っているか」の文。名前・募集作品・説明の書き出し・分類。
 * 締切と字数は入れない（近さは中身で測る。締切と字数はコードが先に選り分けている）。
 */
export function contestMatchText(contest: ContestListing): string {
  return [
    contest.name,
    contest.genre ? `募集作品：${contest.genre}` : "",
    contest.summary ? `説明：${contest.summary}` : "",
    contest.section ? `分類：${contest.section}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function cut(text: string, limit: number): string {
  const chars = [...text];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : text;
}
