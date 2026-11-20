import * as vscode from "vscode";
import { endpointHostKey, isLoopbackEndpoint } from "../core/loopbackHost";

/**
 * 手元のAI（Ollama・LM Studio）の宛先がこの PC の外を指すとき、初回だけ確かめて答えを覚える
 * （セキュリティ点検 2026-11-21。設計書6.78）。
 *
 * 手元のAIは有料でないので、料金の確認（`confirmPaidUsage`）は出ない。宛先の設定が別の機械を
 * 指していると、本文は黙ってそこへ送られていた。宛先の設定は `machine` で作品フォルダーからは
 * 書けないので、ここで見るのは「作者が書いた宛先を、作者が分かって使っているか」である。
 *
 * **覚えるのは「送る」と答えたときだけ。** 断った答えを覚えると、あとで送りたくなったときに
 * 解く道が無い。ホストと口（`192.168.1.20:11434`）ごとに覚える——口が違えば別のサーバーである。
 *
 * **覚えは拡張機能の保管（`globalState`）に置く。** 作品フォルダーに書くと、共有リポジトリから
 * 「訊かない」を仕込める。書くのは確かめる包み（`verifiedState`。設計書5.7.8）を通した保管で、
 * `extension.ts` が起動時に1回だけ渡す（`decisionMemory.ts` と同じ形）。「以降は訊かない」の
 * 覚え書き（`core/confirmMemory.ts`）に載せないのは、あちらは作者が窓で選んで覚えさせるもので、
 * ここは答えそのものを覚えるため（扱いを混ぜると、見直しの画面の説明が合わなくなる）。
 */

const STORAGE_KEY = "novelai.localAiRemoteHosts";

/** 覚えておく数の上限（古いものから捨てる。手元のAIを置く機械はそう増えない） */
const LIMIT = 50;

let memento: vscode.Memento | undefined;

export function rememberLocalAiHostApproval(storage: vscode.Memento): void {
  memento = storage;
}

export interface LocalAiTarget {
  /** 「Ollama」「LM Studio」 */
  displayName: string;
  /** 設定の名前（`novelai.ollama.endpoint`） */
  settingKey: string;
  endpoint: string;
}

const SEND = "送る";

/** 送ってよいなら true。この PC の中なら訊かない */
export async function confirmLocalAiHost(target: LocalAiTarget): Promise<boolean> {
  if (isLoopbackEndpoint(target.endpoint)) return true;
  const key = endpointHostKey(target.endpoint) ?? target.endpoint.trim();
  const approved = readApproved();
  if (approved.includes(key)) return true;

  const picked = await vscode.window.showWarningMessage(
    `${target.displayName}の接続先が、このパソコンの外（${key}）を指しています。本文をそこへ送りますか？`,
    {
      modal: true,
      detail:
        `［${SEND}］を押すと、このホストへは次から訊きません。` +
        `心当たりのないホストなら、送らないでください（接続先は設定 ${target.settingKey} で変えられます）。`,
    },
    SEND
  );
  if (picked !== SEND) return false;

  if (memento) {
    const next = [...approved.filter((entry) => entry !== key), key].slice(-LIMIT);
    await memento.update(STORAGE_KEY, next);
  }
  return true;
}

function readApproved(): string[] {
  const value = memento?.get<unknown>(STORAGE_KEY);
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
