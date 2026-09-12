/**
 * 「以降は訊かない」にした確認の覚え書き（作者の依頼 2026-09-12）。
 *
 * 作者の言葉：「拡張機能側からユーザーに選択を求める場合で、**以降も
 * 同様の処理が繰り返されるもの**である場合、一度選んだ選択肢を固定する
 * 『以降は出さない』チェックボックスをつけて、以降は自動で進むように
 * してください。解除、変更は設定管理画面で。」
 *
 * **覚えるのは「実行した」ときだけ。** 「中止」を覚える道は作らない。
 * 中止を固定すると、その機能を押しても何も起きない状態が続き、
 * 作者は**壊れたと受け取る**（どこで止まっているかは画面に出ない）。
 * 押しても進まない機能は、解除の場所を知っていなければ二度と使えない。
 *
 * **覚えてよい確認は、この一覧に載っているものだけ**（`isRememberable`）。
 * 呼び出し側が id を書き間違えたときに、**知らない確認が黙って固定される**
 * のを防ぐ。載せてよいのは「訊かれても答えが毎回同じ」もの——AIを走らせて
 * よいか（処理量・料金）、競合したファイルを外して続けるか、どこまで見るか、
 * といった**やり直せる**確認である。
 *
 * **危ない操作は載せない。** 次のものは、一度固定すると取り返しがつかない。
 *
 * - **GitHubへの送信**（`gitSync`）・**まとめて同期**（`syncAllWorks`）
 *   ——外へ出したものは引っ込められない。公開前の原稿が出ることもある
 * - **人物の統合**（`unifyCharacters`）——2人を1人に畳むと、
 *   分かれていた呼び名・登場話数・作者の書き込みが混ざる
 * - **ファイルや索引の削除**（`deleteEpisodeFile`・`clearVectorIndex`）
 *   ——消したものは戻らない
 * - **チャットの提案を原稿へ書き込む**（`workChatPanel`）
 *   ——AIの文が、確認なしで作者の本文へ入る
 * - **初回コミット**（`gitOnboarding`）——履歴の始まりは選び直せない
 * - **外で変わった資料の扱い**（`watchSettings`）——どちらを残すかは
 *   そのときの中身で決まるので、前回と同じ答えが正しいとは限らない
 *
 * 一覧に載せてよいかの線引きは `test/unit/confirmMemory.test.ts` が見張る
 * （上の名前を含む id は落ちる）。**うっかりでは足せない形にしてある。**
 *
 * ここは `vscode` に依存しない。読み書きは `features/confirmMemoryStore.ts`
 * が受け持つ（依存の向きは `features` → `core`）。
 */

/** 覚えてよい確認ひとつ */
export interface RememberableConfirm {
  /** 覚え書きの鍵。`ai.run.<機能名>` / `ai.paid.<機能名>` のように揃える */
  id: string;
  /** 設定画面と見直しの一覧に出す日本語。作者が読んで機能を思い出せる言葉で */
  label: string;
}

/**
 * 覚えてよい確認の一覧。
 *
 * **id は呼び出し側と1対1。** 足すときは、呼び出し側に
 * `remember: { id }` を渡すところまでを一組にする。
 */
export const REMEMBERABLE_CONFIRMS: readonly RememberableConfirm[] = [
  // ── AIを走らせてよいか（処理量と料金の確認）──
  { id: "ai.run.checkTypos", label: "誤字脱字の検知：処理量の確認" },
  { id: "ai.run.extractCharacters", label: "設定資料の抽出：処理量の確認" },
  { id: "ai.run.generateAnnouncement", label: "更新告知文を作る：処理量の確認" },
  { id: "ai.run.generateBlurb", label: "作品紹介文を作る：処理量の確認" },
  {
    id: "ai.run.generateCatchphrase",
    label: "キャッチコピーを作る：処理量の確認",
  },
  { id: "ai.run.generateSynopses", label: "各話あらすじを作る：処理量の確認" },
  { id: "ai.run.proposeChapters", label: "章立てを提案する：処理量の確認" },
  {
    id: "ai.run.proposeChapterName",
    label: "章の名前の案を出す：処理量の確認",
  },
  { id: "ai.run.dictationClean", label: "口述したものを整える：処理量の確認" },
  { id: "ai.run.checkContradictions", label: "矛盾の検知：処理量の確認" },
  {
    id: "ai.run.checkFactContradictions",
    label: "矛盾の検知（事実の照合）：処理量の確認",
  },
  { id: "ai.run.checkForeshadows", label: "伏線の検知：処理量の確認" },
  {
    id: "ai.run.checkForeshadowResolutions",
    label: "伏線の回収の確認：処理量の確認",
  },
  { id: "ai.run.checkDeviations", label: "プロット逸脱の検知：処理量の確認" },
  { id: "ai.run.checkProofread", label: "推敲：処理量の確認" },
  {
    id: "ai.run.checkEpisodePlotDesign",
    label: "単話プロットの検査：処理量の確認",
  },
  {
    id: "ai.run.checkEpisodePlotContrast",
    label: "単話プロットと本文の照合：処理量の確認",
  },
  { id: "ai.run.generatePlot", label: "プロットを組み立て直す：処理量の確認" },

  // ── 有料のAIを使う断り（`confirmPaidUsage`）──
  { id: "ai.paid.checkOpening", label: "冒頭診断：料金の確認" },
  { id: "ai.paid.nameCheck", label: "名前の候補：料金の確認" },
  { id: "ai.paid.measureContext", label: "AIチューニング：料金の確認" },
  { id: "ai.paid.notationAdvice", label: "表記ゆれの相談：料金の確認" },
  { id: "ai.paid.chatSettingsSync", label: "相談を資料へ反映：料金の確認" },
  { id: "ai.paid.proposalPanel", label: "指摘の再チェック：料金の確認" },
  { id: "ai.paid.settingsPanel", label: "設定資料パネルのAI：料金の確認" },
  { id: "ai.paid.workChat", label: "AIへの相談：料金の確認" },

  // ── 未解決の競合があるファイルを外して続けるか ──
  {
    id: "conflict.skip.checkTypos",
    label: "誤字脱字の検知：競合したファイルを外して続ける",
  },
  {
    id: "conflict.skip.extractCharacters",
    label: "設定資料の抽出：競合したファイルを外して続ける",
  },
  {
    id: "conflict.skip.checkNotation",
    label: "表記ゆれの検知：競合したファイルを外して続ける",
  },
  {
    id: "conflict.skip.nameRename",
    label: "名前の置き換え：競合したファイルを外して続ける",
  },

  // ── 選択肢が2つあるもの ──
  { id: "scope.typoCheck", label: "誤字脱字の検知：どこまで見るか" },
  { id: "decision.notationVariants", label: "表記ゆれ：揃え方の決め方" },

  // ── 原稿の画面から出る案内 ──
  {
    id: "suggest.markdownConversion",
    label: "原稿の画面：本文を .md にする案内",
  },
  { id: "suggest.eolUnify", label: "原稿の画面：改行コードを揃える案内" },
];

/**
 * 覚えている答え。鍵は確認の id、値は**押されたボタンの文言**。
 *
 * ボタンの文言をそのまま持つのは、**文言が変わったら覚え直させる**ため。
 * 「実行」から別の言葉へ変えた確認を、古い答えで素通りさせない。
 */
export type ConfirmMemory = Readonly<Record<string, string>>;

const REMEMBERABLE_IDS = new Set(REMEMBERABLE_CONFIRMS.map((item) => item.id));

/** その確認は、覚えてよいものとして登録されているか */
export function isRememberable(id: string): boolean {
  return REMEMBERABLE_IDS.has(id);
}

/**
 * 覚えている答えを引く。
 *
 * **一覧から外した確認は、設定に残っていても効かせない。**
 * 危ないものへ id を付け替えた場合に、古い設定が生き残らないようにする。
 */
export function rememberedAnswer(
  memory: ConfirmMemory,
  id: string
): string | undefined {
  if (!isRememberable(id)) return undefined;
  const answer = memory[id];
  return typeof answer === "string" && answer.length > 0 ? answer : undefined;
}

/**
 * 答えを覚えた新しい覚え書きを作る。
 *
 * 一覧に無い id は**覚えない**（元のまま返す）。呼び出し側の書き間違いで
 * 危ない確認が固定されるのを、ここで止める。
 */
export function withRemembered(
  memory: ConfirmMemory,
  id: string,
  answer: string
): ConfirmMemory {
  if (!isRememberable(id)) return memory;
  return { ...memory, [id]: answer };
}

/** ひとつ忘れる */
export function withoutRemembered(
  memory: ConfirmMemory,
  id: string
): ConfirmMemory {
  if (!(id in memory)) return memory;
  const next = { ...memory };
  delete next[id];
  return next;
}

/** すべて忘れる */
export function withoutAll(): ConfirmMemory {
  return {};
}

/** 一覧に無い id を見直しの画面に出すときの名前 */
export const UNKNOWN_CONFIRM_LABEL = "（いまは使われていない確認）";

/**
 * いま覚えているものを、人が読める形で並べる。
 *
 * **一覧に無い id も落とさない。** 設定を手で書き換えた作者が、
 * 「消したいのに一覧に出ない」状態にならないようにする。
 */
export function describeRemembered(
  memory: ConfirmMemory
): Array<{ id: string; label: string; answer: string }> {
  const labels = new Map(
    REMEMBERABLE_CONFIRMS.map((item) => [item.id, item.label])
  );
  return Object.entries(memory)
    .filter(([, answer]) => typeof answer === "string" && answer.length > 0)
    .map(([id, answer]) => ({
      id,
      label: labels.get(id) ?? `${UNKNOWN_CONFIRM_LABEL} ${id}`,
      answer,
    }));
}
