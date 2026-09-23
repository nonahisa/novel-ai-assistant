import {
  buildWriterStyle,
  parseWriterReviseStreak,
} from "./writerStyle";
import type { WriterProfile } from "./writerProfileStore";

/**
 * 執筆スタイル（作家タイプ診断の5問。設計書6.90）の控え（設計書6.86.7 と同じ形）。
 *
 * **なぜ要るか。** 執筆スタイルは `globalState` に在り、VS Code の外で走る
 * MCP サーバーからは読めない。そのため**外部AI経由の相談だけ、段取りと
 * 直す時期が、答えを明示したときにしか乗らず**、相談の中で読み取った直す時期
 * （`writerStyleSignals`）も書き戻されなかった（点検、2026-09-23）。
 * 助言方針の控え（`adviceProfileMirror.ts`）と同じ道で塞ぐ。
 *
 * **置き場所も同じ**——`globalStorageUri` の直下。作品フォルダーには置かない
 * （S3「設定は頭の中」・S4「まだ出し先を決めていない」は、編集部と共有する
 * 情報ではない。`writerProfileStore.ts` が `.aiwriter/` に置かない理由と同じ）。
 *
 * **ファイルを助言方針と分けた。** あちらは作品ごとの項目を並べる形で、
 * 執筆スタイルは作者に1つしか無い。同じファイルへ混ぜると、古い版の MCP が
 * 書き戻したときに知らない欄ごと落とす（`serializeAdviceMirror` は自分の
 * 欄しか書かない）。
 *
 * ここは形と突き合わせだけを持つ。VS Code にも Node にも依存しない。
 */

/** 控えのファイル名。`globalStorageUri` の直下に置く */
export const WRITER_MIRROR_FILE = "writer-profile.json";

/** 控えの形の版。読めない版は「無い」ものとして扱う（直しにいかない） */
export const WRITER_MIRROR_SCHEMA = 1;

export interface WriterMirrorFile {
  schema: number;
  /**
   * この控えを最後に書いた時刻（ISO）。**`WriterProfile.updatedAt`
   * （作者が5問に答えた日）とは別物**——推定で直す時期が動いても、あちらは
   * 動かない。どちらが新しいかを決める手掛かりは、この欄しか無い
   */
  updatedAt: string;
  /**
   * 最後に効かせた相談の答えの指紋。**同じ答えを二度効かせない**
   * （撃ち直しで「2回続けて読み取れたら反映」の歯止めを迂回させない）。
   * 無い控えは「まだ一度も効かせていない」と読む
   */
  lastSignalHash?: string;
  profile: WriterProfile;
}

export function serializeWriterMirror(file: WriterMirrorFile): string {
  const body: WriterMirrorFile = {
    schema: WRITER_MIRROR_SCHEMA,
    updatedAt: file.updatedAt,
    ...(file.lastSignalHash ? { lastSignalHash: file.lastSignalHash } : {}),
    profile: file.profile,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * 控えを読み解く。**壊れていたら `undefined`。直しにいかない**
 * （拡張機能が書き出したものなので、次の書き出しで作り直せばよい）。
 *
 * 5問の答えは `buildWriterStyle` を通す——知らない値が混ざった控えを
 * 読むと、答えていない値で助言の調子が決まる（`WriterProfileStore.get` と同じ）。
 */
export function parseWriterMirror(text: string): WriterMirrorFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.schema !== WRITER_MIRROR_SCHEMA) return undefined;
  if (typeof record.updatedAt !== "string" || record.updatedAt.length === 0) {
    return undefined;
  }

  const profile = parseWriterProfileValue(record.profile);
  if (!profile) return undefined;

  return {
    schema: WRITER_MIRROR_SCHEMA,
    updatedAt: record.updatedAt,
    ...(typeof record.lastSignalHash === "string"
      ? { lastSignalHash: record.lastSignalHash }
      : {}),
    profile,
  };
}

function parseWriterProfileValue(value: unknown): WriterProfile | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.style !== "object" || record.style === null) return undefined;
  const style = buildWriterStyle(record.style as Record<string, unknown>);
  if (!style) return undefined;
  if (typeof record.updatedAt !== "string") return undefined;
  // 数えが壊れていても答えは捨てない（`WriterProfileStore.get` と同じ）
  const reviseStreak = parseWriterReviseStreak(record.reviseStreak);
  return {
    style,
    updatedAt: record.updatedAt,
    ...(reviseStreak ? { reviseStreak } : {}),
  };
}

/**
 * 中身が同じかどうかを見る指紋。`JSON.stringify` をそのまま比べない
 * （鍵の並びは作った経路で変わる。`adviceProfileFingerprint` と同じ理由）。
 */
export function writerProfileFingerprint(profile: WriterProfile): string {
  const { style } = profile;
  const streak = profile.reviseStreak;
  return [
    style.situation,
    style.plan,
    style.revise,
    style.material,
    style.outlet,
    profile.updatedAt,
    streak ? `${streak.value}/${streak.count}` : "",
  ].join("|");
}
