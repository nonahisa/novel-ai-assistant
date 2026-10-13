/**
 * 独り言（設計書6.21・6.21.4）の画面の自動テストが使う見本（`e2e/chatterIdle.test.ts`）。
 *
 * テストの外へ出してあるのは、**偽の AI の答えを本物の検算に通して確かめるため**
 * （`parseChatterComment` → `validateChatterComment`。答えを作ったときに一時の単体テストで通した）。
 * テストのファイルを読み込むと VS Code が起きてしまうので、値だけをここに置く。
 */

/** 見本の話のファイル名 */
export const CHATTER_EPISODE = "001_はじまり.txt";

/**
 * 見本の本文。**末尾の抜き出しが200字以上になる長さにする**——感想を取りに行く側
 * （`features/chatterComment.ts`）は、抜き出しが `CHATTER_COMMENT_MIN_CHARS`（200字）に
 * 満たないと AI を呼ばずに黙る。短い本文だと「出ない」の原因が関門か長さか分からなくなる
 */
export const CHATTER_EPISODE_TEXT = [
  "　朝の駅は静かだった。始発を待つ人の影はまばらで、改札の向こうから冷えた風が吹き込んでくる。",
  "　少女は切符を握りしめたまま、時刻表の前に立っていた。行き先の欄には、聞いたことのない港の名前が並んでいる。",
  "　駅員が帽子を直しながら近づいてきて、どこまで行くのかと尋ねた。少女は少し迷ってから、いちばん遠い駅の名前を口にした。",
  "　駅員は驚いた顔をしたが、何も言わずに頷いた。ホームの端で、古い灯りが一つ、まだ消えずに揺れている。",
  "　やがて遠くから汽笛が聞こえた。少女は顔を上げ、まだ暗い線路の先をじっと見つめた。",
  "",
].join("\n");

/** 保存の基準を置いたあとに打ち足す字（その日の執筆量を0より大きく、1,000字未満にする） */
export const CHATTER_TYPED = "あ".repeat(30);

/**
 * 最初に出る独り言：誤字脱字の申し出（`core/chatter.ts` の `idleTypos`）。
 *
 * **感想（AI の一言）より前に、必ずこれが出る。** 候補の並びで感想は最後に置かれ、
 * 条件（保存した本文があり、その日に書いている）は申し出と同じなので、
 * 新しい起動の初回の様子見では申し出が選ばれる（単体 `chatter.test.ts`「ほかに言うことが無いときだけ取りに行く」）
 */
export const IDLE_TYPOS_TEXT = "書き終えたところ、誤字脱字じゃないですか？　いま開いている話だけ見ておきましょうか。";
/** 申し出に付くボタン（`core/chatEdit.ts` の一覧の名前＋AIを使うかの添え書き） */
export const IDLE_TYPOS_BUTTON = "この話の誤字脱字を検知する（AIを使います）";

/** 偽の AI が返す感想（60字以内の1文。助言・指摘の語を含まない） */
export const CHATTER_COMMENT = "まだ暗い線路の先を見つめる少女の姿に、旅の始まりの高鳴りを感じます。";
/** 構造化出力の答え（`CHATTER_COMMENT_SCHEMA` の形） */
export const CHATTER_COMMENT_ANSWER = JSON.stringify({ comment: CHATTER_COMMENT });

/** 感想の頼みか（system の頭で見分ける。`prompts/chatterComment.ts` の `CHATTER_COMMENT_SYSTEM_PROMPT`） */
export function isChatterCommentRequest(request: { system: string }): boolean {
  return request.system.startsWith("あなたは、小説を書いている作者のそばで原稿を読んでいる読み手です。");
}
