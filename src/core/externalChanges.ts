import * as path from "./paths";

/**
 * 設定資料が外部で書き換えられたことを見分ける。
 *
 * 作者は別のプラグインのAI（Copilot・Claude Code など）に更新を頼むことがある。
 * それらは `設定/` のJSONを直接書くので、拡張機能は気づかないままになる。
 *
 * ただし**拡張機能自身の書き込みも同じ監視に引っかかる**。
 * 区別しないと、自分が保存するたびに「外部で変更されました」と出る。
 * 書き込む直前にパスを登録しておき、そこから短い間に来た通知は自分のものとみなす。
 *
 * 時間で区切るのは、監視の通知が書き込みより遅れて届くためである。
 * 取りこぼしても害は小さい（自分の変更を外部と誤認して確認を求めるだけ）。
 */

/** 自分の書き込みとみなす猶予。ファイル監視の通知はやや遅れて届く */
const SELF_WRITE_WINDOW_MS = 3000;

export class SelfWriteTracker {
  private readonly recent = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** これから書き込むパスを控える。書き込みの直前に呼ぶ */
  markWriting(filePath: string): void {
    this.recent.set(normalize(filePath), this.now());
  }

  /** 自分が書いたものか。監視の通知を受けたときに呼ぶ */
  isSelfWrite(filePath: string): boolean {
    const at = this.recent.get(normalize(filePath));
    if (at === undefined) return false;

    const fresh = this.now() - at <= SELF_WRITE_WINDOW_MS;
    // 古い記録は残さない。作品を開いたままだと際限なく溜まる
    if (!fresh) this.recent.delete(normalize(filePath));
    return fresh;
  }

  /** 反映が終わったら忘れる */
  forget(filePath: string): void {
    this.recent.delete(normalize(filePath));
  }

  /** 溜まった記録を掃除する。猶予を過ぎたものだけ消す */
  prune(): void {
    const limit = this.now() - SELF_WRITE_WINDOW_MS;
    for (const [key, at] of this.recent) {
      if (at <= limit) this.recent.delete(key);
    }
  }
}

/**
 * 監視の対象にするか。
 *
 * 生成物と、拡張機能が自分で使う場所は対象外にする。
 * これらが変わっても作者に確認を求める意味がない。
 */
export function isWatchedSettingsFile(filePath: string): boolean {
  const normalized = normalize(filePath);
  if (!normalized.endsWith(".json")) return false;

  const segments = normalized.split("/");
  // AI向けの定義は生成物。書き換えても次の生成で消える
  if (segments.includes("_schema")) return false;
  // 承認待ち・キャッシュ・回復先は拡張機能の作業場所
  if (segments.includes(".aiwriter")) return false;
  if (segments.includes(".novelai-recovery")) return false;

  return true;
}

/** 設定ファイルのパスから、どの種別かを見分ける */
export type WatchedKind =
  | "character"
  | "ability"
  | "organization"
  | "location"
  | "world"
  | "customFields";

/**
 * 保存先のフォルダ名と種別の対応。
 *
 * **設定資料の種類を増やしたら、ここにも足すこと。**
 * 足し忘れると、外部のAIがそのJSONを書き換えても作者に何も知らせないまま進む。
 * 実際に世界観（`world`）が抜けていた。
 * フォルダ名は `abilityStore.ts` の `directoryName` と揃える。
 */
const DIRECTORY_KINDS: Array<[string, WatchedKind]> = [
  ["characters", "character"],
  ["abilities", "ability"],
  ["organizations", "organization"],
  ["locations", "location"],
  ["world", "world"],
];

/**
 * 設定資料が入っているフォルダ名の一覧。
 *
 * **上の対応表から作る。** 別に並べ直すと、種類を増やしたときに
 * 片方だけ直す事故が起きる（世界観が抜けていたのが実例）。
 */
export const SETTINGS_DIRECTORY_NAMES: readonly string[] = DIRECTORY_KINDS.map(
  ([directory]) => directory
);

export function kindOfSettingsFile(
  filePath: string
): WatchedKind | undefined {
  const normalized = normalize(filePath);
  if (normalized.endsWith("/custom_fields.json")) return "customFields";

  const segments = normalized.split("/");
  const parent = segments[segments.length - 2];
  return DIRECTORY_KINDS.find(([directory]) => directory === parent)?.[1];
}

/** Windowsの区切りと大文字小文字を吸収する */
function normalize(filePath: string): string {
  const normalized = path.normalize(filePath).split(path.sep).join("/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
