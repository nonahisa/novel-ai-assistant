import {
  invalid,
  objectValue,
  optionalEnum,
  optionalString,
  requireNonEmptyString,
} from "./jsonValidation";

/**
 * AIが書いた掘り下げメモ。
 *
 * 抽出した設定（role / personality / description など）は本文に根拠がある事実だが、
 * 掘り下げは「本文からこう読める」という解釈であり、根拠の照合ができない。
 * 同じ場所に混ぜると、どこまでが本文に書いてあることなのか分からなくなる。
 * そのため既存の項目は一切書き換えず、別の入れ物に追記だけする。
 *
 * **作者が承認したものだけがここに入る。** AIが書いた直後は下書きで、
 * パネル上で内容を確認して「追記する」を押すまで保存しない。
 */
export interface AiNote {
  /** note_001 形式 */
  id: string;
  /** 追記した日時 (ISO8601) */
  createdAt: string;
  /** 掘り下げの観点。作者が入れた指示、またはチャットでの質問 */
  topic: string;
  /** AIが書いた本文。作者が手直ししてから承認することもある */
  text: string;
  /** どのモデルが書いたか。読み返すときの信頼度の目安になる */
  model: string;
  /** 掘り下げか、チャットの回答を保存したものか */
  source: AiNoteSource;
}

export type AiNoteSource = "deep_dive" | "chat";

export const AI_NOTE_SOURCES: readonly AiNoteSource[] = ["deep_dive", "chat"];

/** 新しいメモIDを採番する */
export function nextAiNoteId(existing: AiNote[]): string {
  let max = 0;
  for (const note of existing) {
    const matched = note.id.match(/^note_(\d+)$/);
    if (!matched) continue;
    const value = parseInt(matched[1], 10);
    if (value > max) max = value;
  }
  return `note_${String(max + 1).padStart(3, "0")}`;
}

/**
 * 作者が編集できるJSONを検証する。
 * 未指定なら空配列。壊れていれば例外を投げ、勝手に直さない。
 */
export function parseAiNotes(raw: unknown, path = "aiNotes"): AiNote[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) invalid(path);

  return raw.map((entry, index) => {
    const item = objectValue(entry, `${path}[${index}]`);
    requireNonEmptyString(item.id, `${path}[${index}].id`);
    if (!/^note_\d+$/.test(item.id as string)) invalid(`${path}[${index}].id`);
    requireNonEmptyString(item.text, `${path}[${index}].text`);
    optionalString(item.createdAt, `${path}[${index}].createdAt`);
    optionalString(item.topic, `${path}[${index}].topic`);
    optionalString(item.model, `${path}[${index}].model`);
    optionalEnum(item.source, `${path}[${index}].source`, [
      ...AI_NOTE_SOURCES,
    ]);

    return {
      id: item.id as string,
      createdAt: (item.createdAt as string | undefined) ?? "",
      topic: (item.topic as string | undefined) ?? "",
      text: item.text as string,
      model: (item.model as string | undefined) ?? "",
      source: (item.source as AiNoteSource | undefined) ?? "deep_dive",
    };
  });
}
