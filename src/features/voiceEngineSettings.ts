import * as vscode from "vscode";
import {
  ENGINE_URL_SETTING,
  isVoiceEngineId,
  LEGACY_ENGINE_URL_SETTING,
  legacyVoiceEngine,
  type EngineUrlSettings,
  type VoiceEngineId,
} from "../core/voiceEngine";

/**
 * 人物の声の接続先の設定と、［声］の欄の選択を読む（設計書6.42.3。0.146.0）。
 *
 * `features/voiceReading.ts` は使うときに初めて読む（動的 import）ので、画面を開いたときに
 * 要る「どのエンジンを選んでいるか」はここに分けて置く（`extension.ts` から静的に読める軽い部品）。
 */

/** ［声］の欄の選択。OSの声か、どちらかのエンジン */
export type ReadAloudEngineChoice = "os" | VoiceEngineId;

export function isReadAloudEngineChoice(value: unknown): value is ReadAloudEngineChoice {
  return value === "os" || isVoiceEngineId(value);
}

/**
 * 設定に**作者が書いた**値だけを読む（既定の値は入れない）。古い設定を「既定のまま」か
 * 「書き換えた」かで扱いを分けるので、`get` でなく `inspect` で見る
 */
export function readEngineUrlSettings(): EngineUrlSettings {
  const config = vscode.workspace.getConfiguration("novelai");
  const written = (key: string): string | undefined => {
    const seen = config.inspect<string>(key);
    return seen?.workspaceFolderValue ?? seen?.workspaceValue ?? seen?.globalValue;
  };
  return {
    aivisSpeechUrl: written(ENGINE_URL_SETTING.aivisspeech),
    voicevoxUrl: written(ENGINE_URL_SETTING.voicevox),
    legacyUrl: written(LEGACY_ENGINE_URL_SETTING),
  };
}

/**
 * 端末に覚えた［声］の選択（globalState の `novelai.readAloud.engine`）を読む。
 *
 * - 0.146.0 からはエンジンの名前（`"aivisspeech"`・`"voicevox"`）を書く。OSの声は `false` のまま
 *   （前の版へ戻したとき、文字列の `"os"` が「人物の声を選んだ」と読まれないように）
 * - 前の版の `true`（人物の声）は、古い接続先の設定が指している側（作者の決定 2026-11-08）
 */
export function readAloudEngineChoiceOf(
  stored: unknown,
  settings: EngineUrlSettings = readEngineUrlSettings()
): ReadAloudEngineChoice {
  if (isVoiceEngineId(stored)) return stored;
  if (stored === true) return legacyVoiceEngine(settings);
  return "os";
}

/** globalState へ書く値（OSの声は false。上の理由） */
export function storedReadAloudEngine(choice: ReadAloudEngineChoice): VoiceEngineId | false {
  return choice === "os" ? false : choice;
}
