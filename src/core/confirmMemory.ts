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
 * 一覧に載せてよいかの線引きは `test/unit/core/confirmMemory.test.ts` が見張る
 * （上の名前を含む id は落ちる）。**うっかりでは足せない形にしてある。**
 *
 * ここは `vscode` に依存しない。読み書きは `features/confirmMemoryStore.ts`
 * が受け持つ（依存の向きは `features` → `core`）。
 *
 * **例外がひとつだけある——人物の声の送り先**（`voice.remoteHost.<ホスト:ポート>`。
 * 作者の答え 2026-11-05）。この PC の外の音声エンジンへ本文を送ってよいか、の確認である。
 * 一覧の外で「この形の id だけ」を覚えてよいことにしている。
 * 送る**中身**は毎回違うが、確認しているのは**送り先**で、作者が一度確かめたホストなら
 * 毎回同じ答えになる。危ないのは知らないホスト・変わったホストで、それは id に
 * ホストとポートを含めることで**別の確認**になり、覚えていても必ず訊き直す。
 * 形が合わないもの（`voice.remoteHostX`・ホストの無いもの）は覚えない。
 * 断った答えは覚えない（上の約束どおり）。
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
  { id: "ai.run.readerAdvice", label: "読者の反応の助言：処理量の確認" },

  // ── 有料のAIを使う断り（`confirmPaidUsage`）──
  { id: "ai.paid.checkOpening", label: "冒頭診断：料金の確認" },
  { id: "ai.paid.nameCheck", label: "名前の候補：料金の確認" },
  {
    id: "ai.paid.plotNameSuggest",
    label: "プロットの人物の名前の候補：料金の確認",
  },
  { id: "ai.paid.measureContext", label: "AIチューニング：料金の確認" },
  { id: "ai.paid.notationAdvice", label: "表記ゆれの相談：料金の確認" },
  { id: "ai.paid.findingAdvice", label: "推敲の指摘の相談：料金の確認" },
  { id: "ai.paid.chatSettingsSync", label: "相談を資料へ反映：料金の確認" },
  { id: "ai.paid.proposalPanel", label: "指摘の再チェック：料金の確認" },
  { id: "ai.paid.settingsPanel", label: "設定資料パネルのAI：料金の確認" },
  { id: "ai.paid.workChat", label: "AIへの相談：料金の確認" },
  { id: "ai.paid.plotAdvice", label: "プロットの相談：料金の確認" },
  { id: "ai.paid.readingDictionary", label: "読み上げの読みの確かめ：料金の確認" },
  { id: "ai.paid.voiceCast", label: "朗読の台詞の話者と感情：料金の確認" },

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
export type ConfirmMemory = Readonly<Record<string, RememberedEntry>>;

/**
 * 「以降は訊かない」を覚えたときのAIひとつ（セキュリティ点検「中」、2026-11-21）。
 *
 * **AIを送る確認は、どのAIで覚えたかまで覚える。** 無料の Ollama で覚えた答えのまま、
 * 既定のAIを有料のクラウドへ替えると、次の実行が確認なしで全チャンクを外へ送っていた。
 * ブラウザ版で割当の Ollama が使えず既定のAIへ落ちるときも同じ道を通る。
 * 照らし合わせるのはプロバイダIDとモデル名。`paid` は古い形の扱いと、記録を読む人のために添える
 * （手元かどうかはIDから決める。`isLocalProviderId`）。
 */
export interface ConfirmAi {
  readonly providerId: string;
  readonly model: string;
  readonly paid: boolean;
}

/**
 * 覚えている答えひとつ。
 *
 * - 文字列：AIを使わない確認と、AIを入れる前の古い形
 * - `{ answer, ai }`：AIを送る確認。`ai` は**作者が［以降は訊かない］を押したAIの全部**
 *   （別のAIで押し直すと足していく。どれも作者が一度確かめたAIなので、行き来しても訊き直さない。
 *   事実の照合のように、取り出しと判定で別のAIが同じ id の確認を出す機能もある）
 */
export type RememberedEntry =
  | string
  | { readonly answer: string; readonly ai: readonly ConfirmAi[] };

/** 渡し方の揺れ（1つか複数か）をそろえる */
export function confirmAiList(
  ai: ConfirmAi | readonly ConfirmAi[] | undefined
): readonly ConfirmAi[] {
  if (ai === undefined) return [];
  return isConfirmAiArray(ai) ? ai : [ai];
}

function isConfirmAiArray(ai: ConfirmAi | readonly ConfirmAi[]): ai is readonly ConfirmAi[] {
  return Array.isArray(ai);
}

/** 確認へ渡すAIを、プロバイダとモデルから作る（`ai/` を引き込まないよう形だけ受ける） */
export function confirmAiOf(
  provider: { readonly id: string; readonly isPaid: boolean },
  model: string
): ConfirmAi {
  return { providerId: provider.id, model, paid: provider.isPaid };
}

/** ログに出す形（`ollama/gemma4:e4b`） */
export function describeConfirmAi(ai: readonly ConfirmAi[]): string {
  return ai.length === 0
    ? "（記録なし）"
    : ai.map((item) => `${item.providerId}/${item.model}`).join("・");
}

/**
 * AIを送る確認の id か。**AIを渡さずに呼ばれたら、覚えていても訊く**ための目印。
 * 呼び出し側の渡し忘れで、どのAIへ送るか分からないまま素通りさせない
 */
export function isAiSendingConfirm(id: string): boolean {
  return id.startsWith("ai.run.") || id.startsWith("ai.paid.");
}

function sameAi(a: ConfirmAi, b: ConfirmAi): boolean {
  return a.providerId === b.providerId && a.model === b.model;
}

function entryAnswer(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry.length > 0 ? entry : undefined;
  if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
    const answer = (entry as { answer?: unknown }).answer;
    return typeof answer === "string" && answer.length > 0 ? answer : undefined;
  }
  return undefined;
}

function isConfirmAi(value: unknown): value is ConfirmAi {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.providerId === "string" &&
    item.providerId.length > 0 &&
    typeof item.model === "string" &&
    typeof item.paid === "boolean"
  );
}

/** 覚えているAI。古い形（文字列）なら undefined */
export function rememberedAi(
  memory: ConfirmMemory,
  id: string
): readonly ConfirmAi[] | undefined {
  const entry: unknown = memory[id];
  if (typeof entry !== "object" || entry === null) return undefined;
  const ai: unknown = (entry as { ai?: unknown }).ai;
  return Array.isArray(ai) ? ai.filter(isConfirmAi) : [];
}

/**
 * 設定から読んだ生の値を覚え書きの形へそろえる。**形の合わないものは捨てる**
 * （手で書き換えられる場所なので、数値や壊れた入れ物があっても落ちない）。
 * AIの並びに壊れた項目があれば、その項目だけ落とす——残ったAIで照らすので、
 * 落ちたAIで走るときは訊き直す側に倒れる
 */
export function normalizeConfirmMemory(raw: unknown): ConfirmMemory {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, RememberedEntry> = {};
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry === "string") {
      result[id] = entry;
      continue;
    }
    const answer = entryAnswer(entry);
    if (answer === undefined) continue;
    const ai: unknown = (entry as { ai?: unknown }).ai;
    result[id] = { answer, ai: Array.isArray(ai) ? ai.filter(isConfirmAi) : [] };
  }
  return result;
}

/** 覚えた答えで素通りさせてよいかの判断（`views/notify.ts` の確認が1か所で使う） */
export type RememberedRunDecision =
  /** 覚えていない（ボタンの文言が違う・一覧に無い） */
  | { readonly kind: "ask" }
  /** 覚えたときと同じ条件なので素通りさせてよい */
  | { readonly kind: "skip" }
  /**
   * 覚えてはいるが、**いまのAIは覚えたときのAIに入っていない**。確認を出す。
   * `before` は覚えていたAI（古い形なら空）、`now` はいまのAI（渡されなければ空）
   */
  | {
      readonly kind: "aiChanged";
      readonly before: readonly ConfirmAi[];
      readonly now: readonly ConfirmAi[];
    };

/**
 * 覚えた答えを、いまのAIと照らす。**判断はここだけ**に置く（機能の側はAIを渡すだけ）。
 *
 * - AIを送る確認（`ai.run.*`・`ai.paid.*`）でAIが渡されなければ、訊く
 * - AIの入った覚え書き：いまのAIが**全部**、覚えたAIのどれかとプロバイダIDもモデル名も
 *   同じときだけ素通り。同じ Ollama でもモデルが違えば訊く（モデルで料金も送る量も変わる）
 * - 古い形（文字列）：いまのAIが全部手元のAI（`isLocal`）で無料なら素通り。
 *   有料かクラウドが1つでも入れば訊く——古い答えをどのAIで覚えたかは分からないので、
 *   外へ送る・お金がかかる側だけ確かめ直す。手元のAIなら料金も外への送信も起きないので、
 *   これまでどおり素通りさせる
 * - AIを使わない確認：これまでどおり答えの文言だけで決める
 */
export function decideRememberedRun(params: {
  memory: ConfirmMemory;
  id: string;
  runLabel: string;
  ai: readonly ConfirmAi[];
  isLocal: (providerId: string) => boolean;
}): RememberedRunDecision {
  const { memory, id, runLabel, ai, isLocal } = params;
  if (rememberedAnswer(memory, id) !== runLabel) return { kind: "ask" };

  const before = rememberedAi(memory, id);
  if (ai.length === 0) {
    return isAiSendingConfirm(id)
      ? { kind: "aiChanged", before: before ?? [], now: [] }
      : { kind: "skip" };
  }
  if (before === undefined) {
    const allLocalFree = ai.every((item) => isLocal(item.providerId) && !item.paid);
    return allLocalFree ? { kind: "skip" } : { kind: "aiChanged", before: [], now: ai };
  }
  const allKnown = ai.every((item) => before.some((known) => sameAi(known, item)));
  return allKnown ? { kind: "skip" } : { kind: "aiChanged", before, now: ai };
}

const REMEMBERABLE_IDS = new Set(REMEMBERABLE_CONFIRMS.map((item) => item.id));

/** 人物の声の送り先の確認の id の頭（後ろに `ホスト[:ポート]` が続く） */
export const VOICE_REMOTE_HOST_PREFIX = "voice.remoteHost.";

/**
 * `ホスト` か `ホスト:ポート`。ホストは名前・IPv4（英数字と . と -）か、角括弧の IPv6。
 * 空白・スラッシュ・制御文字は通さない（`URL.host` が返す形だけを受ける）。
 */
const REMOTE_HOST_SHAPE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** 人物の声の送り先の確認の id を作る（`host` は `URL.host`＝ホスト[:ポート]） */
export function voiceRemoteHostConfirmId(host: string): string {
  return `${VOICE_REMOTE_HOST_PREFIX}${host}`;
}

/** 人物の声の送り先の確認の id なら、後ろのホスト[:ポート]を返す。形が合わなければ undefined */
function voiceRemoteHostOf(id: string): string | undefined {
  if (!id.startsWith(VOICE_REMOTE_HOST_PREFIX)) return undefined;
  const host = id.slice(VOICE_REMOTE_HOST_PREFIX.length);
  return REMOTE_HOST_SHAPE.test(host) ? host : undefined;
}

/** その確認は、覚えてよいものとして登録されているか */
export function isRememberable(id: string): boolean {
  return REMEMBERABLE_IDS.has(id) || voiceRemoteHostOf(id) !== undefined;
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
  return entryAnswer(memory[id]);
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
  answer: string,
  ai: readonly ConfirmAi[] = []
): ConfirmMemory {
  if (!isRememberable(id)) return memory;
  // AIを使わない確認は、今までどおり文字列で持つ（設定画面で読みやすく、古い版とも同じ形）
  if (ai.length === 0) return { ...memory, [id]: answer };
  // 同じ答えで覚えていたAIには足す。答えの文言が変わっていたら、前のAIは引き継がない
  const known =
    rememberedAnswer(memory, id) === answer ? rememberedAi(memory, id) ?? [] : [];
  const merged = [...known];
  for (const item of ai) {
    if (!merged.some((existing) => sameAi(existing, item))) merged.push(item);
  }
  return { ...memory, [id]: { answer, ai: merged } };
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

function voiceRemoteHostLabel(id: string): string | undefined {
  const host = voiceRemoteHostOf(id);
  return host === undefined ? undefined : `人物の声の送り先：${host}へ本文を送る`;
}

/**
 * いま覚えているものを、人が読める形で並べる。
 *
 * **一覧に無い id も落とさない。** 設定を手で書き換えた作者が、
 * 「消したいのに一覧に出ない」状態にならないようにする。
 */
export function describeRemembered(
  memory: ConfirmMemory
): Array<{ id: string; label: string; answer: string; ai?: readonly ConfirmAi[] }> {
  const labels = new Map(
    REMEMBERABLE_CONFIRMS.map((item) => [item.id, item.label])
  );
  return Object.entries(memory).flatMap(([id, entry]) => {
    const answer = entryAnswer(entry);
    if (answer === undefined) return [];
    const ai = rememberedAi(memory, id);
    return [
      {
        id,
        label: labels.get(id) ?? voiceRemoteHostLabel(id) ?? `${UNKNOWN_CONFIRM_LABEL} ${id}`,
        answer,
        ...(ai && ai.length > 0 ? { ai } : {}),
      },
    ];
  });
}
