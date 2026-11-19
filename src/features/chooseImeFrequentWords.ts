import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { showQuickPickKeepingFocus } from "../views/pickerFocus";
import { imeExcludedKey, imeFrequentExcludedKey } from "../core/imeDictionary";
import { frequentSkipSurfaces, nextFrequentExcluded, type FrequentWord } from "../core/imeFrequent";
import { loadDictionaryForWork } from "./exportImeDictionary";
import { loadFrequentWords } from "./imeCurrentWork";

interface FrequentPickItem extends vscode.QuickPickItem {
  word: FrequentWord;
}

/**
 * Rittoku IME へ渡す「本文でよく使う語」を、作者が選ぶ（設計書6.13.7）。
 *
 * **3つの IME の書き出し（`exportImeDictionary`）とは別の鍵・別の窓**にする：あちらは
 * 設定資料の語から外した語を毎回作り直して覚えるので、ここの覚えを混ぜると消える。
 *
 * 覚えるのは外した語。前に外していて今回の一覧に出ない語（本文から減った等）の覚えは消さない
 * （`nextFrequentExcluded`）。設定資料の語と同じ表記は、そもそも一覧に出さない。
 *
 * @returns 覚えを書いたか（閉じた・語が無い・覚える場所が無いときは false）
 */
export async function chooseImeFrequentWords(
  work: WorkEntry,
  state: vscode.Memento | undefined
): Promise<boolean> {
  if (!state) return false;
  const loaded = await loadDictionaryForWork(work);
  if (!loaded.ok) {
    await vscode.window.showErrorMessage(
      "読み込めない設定ファイルがあるため、よく使う語を選べませんでした。" +
        `（${loaded.errorFiles.join("、")}）`
    );
    return false;
  }
  const settingsExcluded = state.get<string[]>(imeExcludedKey(work.id)) ?? [];
  const previous = state.get<string[]>(imeFrequentExcludedKey(work.id)) ?? [];
  // 一覧に出す語は、よく使う語として外した語も含めて数える（外してあるものを戻せるように）
  const words = await loadFrequentWords(
    work,
    frequentSkipSurfaces(
      loaded.built.entries.map((entry) => entry.surface),
      settingsExcluded,
      []
    )
  );
  if (words.length === 0) {
    void vscode.window.showInformationMessage("本文によく出る語は見つかりませんでした。");
    return false;
  }

  const excludedNow = new Set(previous);
  const items: FrequentPickItem[] = words.map((word) => ({
    label: word.surface,
    description: `${word.reading}・${word.count}回`,
    picked: !excludedNow.has(word.surface),
    word,
  }));
  const picked = await showQuickPickKeepingFocus(items, {
    title: `${work.title}のよく使う語（${words.length}件）`,
    placeHolder: "外したい語のチェックを外してください",
    canPickMany: true,
    ignoreFocusOut: true,
  });
  // 閉じたときは何もしない（作者が取りやめた）
  if (!picked) return false;

  await state.update(
    imeFrequentExcludedKey(work.id),
    nextFrequentExcluded(
      previous,
      words.map((word) => word.surface),
      picked.map((item) => item.word.surface)
    )
  );
  return true;
}
