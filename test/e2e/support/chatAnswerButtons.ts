/**
 * 相談の答えのボタン（束 E18：実機確認リスト 6504・6546）の見本と、偽の Ollama の答え。
 *
 * 答えはどれも、製品の検算へ通したときに**狙いどおり残る**形にしてある
 * （作るときに一時の単体テストで確かめた。コミットはしていない）：
 * - 相談の答え：`parseWorkChatAnswer` → `parseChatEdit`（ok）・`relatedChatRun`（質問の「表記」で残る）・
 *   `parseChatLocate`（ok）・`parseChatReload` → `matchReloadTarget`（アジャーノに当たる）
 * - 再読込の答え：`parseEnrichResult` → `checkEnrichProposals`（紹介・役割の2件が提案に残る）
 *
 * **答えの出来（実機の AI がボタンを付けるか）は見えない**——それは AI の測定の側。
 * ここで見るのは、答えにボタンが付いたあと、押して何が起きるかだけ。
 */
import { emptyCharacter, type Character } from "../../../src/models/character";
import type { FakeOllamaRequest } from "./fakeOllama";

/* ── 相談の答えの形 ── */

/** 相談の答えに載せられるもの（`prompts/workChat.ts` の WORK_CHAT_SCHEMA。全項目を返す） */
export interface ChatAnswerParts {
  reply: string;
  options?: string[];
  edit?: { target: string; content: string; label: string | null } | null;
  run?: string | null;
  locate?: { path: string | null; text: string | null; label: string | null } | null;
  reloadRecord?: { kind: string; name: string; notes: string | null } | null;
}

/** 相談の答え（JSON の文字列）。載せないものは null（製品の形どおり、項目は全部置く） */
export function chatAnswer(parts: ChatAnswerParts): string {
  return JSON.stringify({
    reply: parts.reply,
    options: parts.options ?? [],
    needFiles: null,
    edit: parts.edit ?? null,
    run: parts.run ?? null,
    locate: parts.locate ?? null,
    reloadRecord: parts.reloadRecord ?? null,
    profileSignals: null,
    writerStyleSignals: null,
  });
}

/** 場面探しの検索語づくり（P-22）への答え。語は返さない（質問文のまま探す） */
export const SEARCH_TERMS_ANSWER = JSON.stringify({ terms: [] });

/** 再読込（設定資料パネルの「AIで再読込」）の頼みか。頼みの書き出し（`buildEnrichPrompt`）で見分ける */
export function isEnrichRequest(request: FakeOllamaRequest): boolean {
  return request.user.includes("設定資料の各項目に入れる内容を提案してください");
}

/* ── 6504：大きい画面の答えのボタン（選択肢・書き込み・機能起動・そこを見せて） ── */

export const BUTTONS_EPISODE = "001_星.txt";
/** 「沢山」1回・「たくさん」2回。表記ゆれの組はこの1組だけ（checkOpensMemoPanel.test.ts と同じ形） */
export const BUTTONS_BODY = ["　空には沢山の星があった。", "　たくさんの星が見えた。", "　たくさん、と彼女は言った。", ""].join("\n");

/**
 * 1問目。**「表記」を含める**——AI が付けた実行ボタン（checkNotation）は、作者の言葉と話題が
 * 合わないと黙って落ちる（`relatedChatRun`）。頼みの形（ください）にもしてある
 */
export const BUTTONS_QUESTION = "テーマを「星を数える夜」にして書いておいてください。表記ゆれも気になります";
export const BUTTONS_REPLY = "偽のAIの答えです：テーマを書き込みました。表記ゆれは検知で確かめられます。";

/** 書き込み（plot.md の「テーマ」）。括弧で包まない・伏せ字を使わない（案内文として落ちないように） */
export const EDIT_THEME = "星を数える夜に、失くしたものを思い出す";
export const EDIT_TARGET = "plot.theme";

/** 機能起動：表記ゆれの検知（AI を使わない）。押すと詳細メニューと同じコマンドが走る */
export const RUN_KIND = "checkNotation";
export const RUN_BUTTON_TEXT = "表記ゆれを検知する（AIを使いません）";

/** そこを見せて：2行目 */
export const LOCATE_QUOTE = "たくさんの星が見えた";
export const LOCATE_LABEL = "星の場面を見せて";

/** 選択肢。1つ目を押すと、その字がそのまま次の質問として送られる */
export const BUTTON_OPTIONS = ["星の数をもっと具体的にしたい", "彼女の台詞を増やしたい"];
export const OPTION_REPLY = "偽のAIの答えです：星は七つにすると数えやすくなります。";

export const BUTTONS_ANSWER = chatAnswer({
  reply: BUTTONS_REPLY,
  options: BUTTON_OPTIONS,
  edit: { target: EDIT_TARGET, content: EDIT_THEME, label: null },
  run: RUN_KIND,
  locate: { path: `本文/${BUTTONS_EPISODE}`, text: LOCATE_QUOTE, label: LOCATE_LABEL },
});

export const OPTION_ANSWER = chatAnswer({ reply: OPTION_REPLY });

/* ── 6546：アジャーノの再読込 ── */

export const RELOAD_EPISODE = "001_港.txt";
export const RELOAD_BODY = [
  "　アジャーノは港の倉庫で荷を数えていた。",
  "　殿下が城から使いを寄こしたのは、その日の夕方だった。",
  "　アジャーノは使いの手紙を読み、黙って頷いた。",
  "",
].join("\n");

/** 皇子の情報が混ざった記録（実機の混同の形。設計書6.31） */
export const AJANO: Character = {
  ...emptyCharacter("char_001", "アジャーノ"),
  gender: "男",
  summary: "港で働く冒険者。皇子でもある",
  role: "冒険者、皇子",
  appearedChapters: [1],
};

export const DENKA: Character = {
  ...emptyCharacter("char_002", "殿下"),
  gender: "男",
  role: "皇子",
  appearedChapters: [1],
};

export const RELOAD_QUESTION = "アジャーノに殿下の情報が混ざっているみたいです";
export const RELOAD_REPLY = "偽のAIの答えです：アジャーノの記録を本文から読み直すと、皇子の記述を分けられます。";
/** 留意点。設定資料パネルの欄と、再読込の頼みへ、この字のまま引き継がれるか見る */
export const RELOAD_NOTES = "他の登場人物『殿下』の情報が混入しています。";
export const RELOAD_BUTTON_TEXT = "「アジャーノ」をAIで再読込（AIを使います）";

export const RELOAD_CHAT_ANSWER = chatAnswer({
  reply: RELOAD_REPLY,
  reloadRecord: { kind: "character", name: "アジャーノ", notes: RELOAD_NOTES },
});

/** 再読込の答えで、提案に残る値（いまの値と違う・話数を挙げない・口調は返さない） */
export const ENRICH_SUMMARY = "港の倉庫で荷を数える冒険者";
export const ENRICH_ROLE = "冒険者";

export const ENRICH_ANSWER = JSON.stringify({
  gender: null,
  summary: ENRICH_SUMMARY,
  affiliation: null,
  role: ENRICH_ROLE,
  personality: null,
  speechStyle: null,
  appearance: null,
  misattributed: [],
});
