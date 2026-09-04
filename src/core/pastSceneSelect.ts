import { Bm25Index } from "./bm25";
import { sha1Text } from "./hash";
import type { ExcerptSource } from "./mentionExcerpts";
import { splitPassages } from "./retrievalCorpus";

/**
 * 矛盾検知へ渡す「過去の関連場面」を選ぶ（設計書6.74）。
 *
 * 矛盾検知は設定資料（人物・場所・世界観）と直近のあらすじを頼りに調べるが、
 * **過去の話の本文そのもの**は見ていない。「第3話では傷は左腕だったのに
 * 第15話で右腕になっている」は、設定資料に腕の記述が無ければ拾えない。
 * チャンクに出てくる名前で過去の場面を引き、抜粋として渡す。
 *
 * ## ベクトル（意味検索）は使わない
 *
 * 語句一致（BM25）だけで引く（設計書6.27.5の禁）。意味検索は既定切・
 * Ollama限定で、3社中2社では動かない。語句一致なら全プロバイダ・全環境で
 * 同じに動き、「切っていても良くなる」（6.19.4）を保てる。
 *
 * ## 空にしない工夫はしない
 *
 * 世界観（`worldviewSelect`）は「材料が空だと本文だけを見て矛盾を作り出す」
 * ため1件は必ず残すが、**過去の場面は逆である。** 関連が無いのに本文を
 * 足すと、無関係な場面と突き合わせた誤検知が増える。当たらなければ
 * 何も渡さない（＝欄ごと出さず、従来と同じ入力に戻る）。
 *
 * VS Code APIに依存しない。同じ入力からは必ず同じ文字列を返す
 * （キャッシュの鍵に抜粋のハッシュを混ぜるので、選抜が揺れると
 * 同じ鍵に違う材料の答えが入る）。
 */

export interface PastScene {
  /** 索引の中で一意。出典が同名でも重ならないよう連番を前に置く */
  id: string;
  /** AIに示す出典（「第3話 再会」） */
  label: string;
  /** この場面が書かれている話数。**これより後のチャンクにだけ渡す** */
  chapter: number;
  text: string;
}

/**
 * 1チャンクへ載せる過去の場面の上限（字数の頭打ち）。
 *
 * **世界観（30,000字）より小さくしてある。** 本文の抜粋は1件が長く、
 * しかも「渡さなくても従来どおり動く」補助の材料である。まず控えめに
 * 渡して、`usage.md` の実測を見てから広げるほうが安全である
 * （広げるのはいつでもできるが、送りすぎて時間切れを増やすと
 * 作者の手元では「矛盾検知が使えなくなった」としか見えない）。
 */
export const PAST_SCENE_MAX_CHARS = 6000;

/**
 * 過去の場面にまわしてよい、モデルの上限に対する割合。
 *
 * 世界観は0.25（`worldviewSelect`）。本文の抜粋はそれより後から足した
 * 材料なので、**既にある材料を押しのけない**ところに置く。0.10なら
 * 131,072のモデルで9,175字ぶんの枠があり、頭打ちの6,000字が先に効く。
 * 32,768のモデルでは2,293字（＝場面4〜5件）まで自動で縮む。
 */
const PAST_SCENE_CONTEXT_RATIO = 0.1;

/**
 * 検索語の数の上限。
 *
 * 1チャンクに20人が出てくることはあり、全員で引くと上位が
 * 「よく出てくる名前」だけで埋まる。先に出てきたものから採る。
 */
export const PAST_SCENE_MAX_TERMS = 12;

/**
 * 1チャンクへ渡す場面の件数の上限。
 *
 * 字数の上限だけでも頭は打つが、**細かい場面を並べるほど1件ずつの
 * 吟味が薄まる**（未来の事実を20行で切っているのと同じ理屈）。
 */
export const PAST_SCENE_MAX_COUNT = 8;

/** 場面と場面の区切り */
const SEPARATOR = "\n\n";

/**
 * そのモデルで過去の場面に使ってよい字数を決める。
 *
 * コンテキスト長が分からないときは固定の頭打ちを返す（`worldviewMaxChars`
 * と同じ流儀。0.7字/トークンで換算する）。
 */
export function pastSceneMaxChars(contextWindow: number | undefined): number {
  if (!contextWindow || contextWindow <= 0) return PAST_SCENE_MAX_CHARS;
  const fromModel = Math.floor(contextWindow * PAST_SCENE_CONTEXT_RATIO * 0.7);
  return Math.min(PAST_SCENE_MAX_CHARS, fromModel);
}

/**
 * 出典つきの本文（`loadExcerptSources`）を、検索できる場面の単位へ割る。
 *
 * **話数の読めない出典は落とす。** 前後を決められないものを混ぜると、
 * 「いま調べている話より前だけ」を守れない（番外編・あとがき・
 * ファイル名から話数を読めない話）。
 *
 * 割り方は相談パネルの検索単位（`splitPassages`。400字・重なり100字）を
 * そのまま使う。**同じ作品を2通りに切ると、片方で引けた場面が
 * もう片方では引けない**という説明のつかない差が出る。
 */
export function buildPastScenes(
  sources: readonly ExcerptSource[]
): PastScene[] {
  const scenes: PastScene[] = [];
  for (const source of sources) {
    const chapter = source.chapter;
    if (typeof chapter !== "number" || !Number.isFinite(chapter)) continue;
    for (const text of splitPassages(source.text)) {
      if (!text.trim()) continue;
      scenes.push({
        id: `${scenes.length}:${source.label}`,
        label: source.label,
        chapter,
        text,
      });
    }
  }
  return scenes;
}

export interface PastSceneSelection {
  /** いま調べているチャンクの話数。**分からなければ渡さない** */
  chapter: number | null;
  /** 検索語（チャンクに出てくる人物・場所の呼び名） */
  terms: readonly string[];
  maxChars: number;
  maxScenes?: number;
}

/**
 * 過去の場面の索引。
 *
 * **1回の検知で1つだけ作る。** 索引作りは全話の読み込みを伴うので、
 * チャンクごとに作り直すと作品の大きさぶんだけ二乗で効いてくる。
 */
export class PastSceneIndex {
  private readonly scenes: readonly PastScene[];
  private readonly index: Bm25Index;
  /** id → 元の並び順。点が同じときの前後を決めるのに使う */
  private readonly orderById: Map<string, number>;

  constructor(scenes: readonly PastScene[]) {
    this.scenes = scenes;
    this.index = new Bm25Index(
      scenes.map((scene) => ({ id: scene.id, text: scene.text }))
    );
    this.orderById = new Map(scenes.map((scene, at) => [scene.id, at]));
  }

  get size(): number {
    return this.scenes.length;
  }

  /**
   * そのチャンクへ渡す抜粋を組み立てる。当たらなければ空文字。
   *
   * 母集団（前の話）を先に絞ってから引く。**引いたあとでふるうのでは
   * 足りない**——序盤のチャンクでは全体の上位が後の話ばかりになり、
   * ふるった結果が空になる（`Bm25Index.search` の `allowedIds` の注釈）。
   */
  select(options: PastSceneSelection): string {
    const { chapter, maxChars } = options;
    const maxScenes = options.maxScenes ?? PAST_SCENE_MAX_COUNT;
    if (chapter === null || maxChars <= 0 || maxScenes <= 0) return "";

    // **いま調べている話より前だけ。** 後の話を渡すと「あとで判明する
    // 事実」との整合が壊れ、誤検知の種になる（futureFacts と同じ理屈）
    const allowed = new Set<string>();
    for (const scene of this.scenes) {
      if (scene.chapter < chapter) allowed.add(scene.id);
    }
    if (allowed.size === 0) return "";

    const terms = searchTerms(options.terms);
    if (terms.length === 0) return "";

    // **語ごとに引いて点を足す。** 検索語をつなげて1つの質問にすると、
    // 2つ組みの索引では語と語のまたぎ（「灯白」のような組み）が生まれ、
    // 本文に無い並びで点が付く
    const scores = new Map<string, number>();
    const perTerm = Math.max(maxScenes * 4, 20);
    for (const term of terms) {
      for (const hit of this.index.search(term, perTerm, allowed)) {
        scores.set(hit.id, (scores.get(hit.id) ?? 0) + hit.score);
      }
    }
    if (scores.size === 0) return "";

    const ranked = [...scores]
      // 点が同じなら元の並び順。**同点の順が揺れると鍵も揺れる**
      .sort(
        (left, right) =>
          right[1] - left[1] || this.orderOf(left[0]) - this.orderOf(right[0])
      )
      .slice(0, maxScenes)
      .map(([id]) => id);

    const chosen: string[] = [];
    let total = 0;
    // 詰めるのは点の高い順、出すのは話数の順（下の sort）
    for (const id of ranked) {
      const at = this.orderOf(id);
      const text = render(this.scenes[at]);
      const size = chosen.length === 0 ? text.length : SEPARATOR.length + text.length;
      // **1件も入らないなら、はみ出させずに諦める。** 世界観と違って
      // 空でよい材料なので、上限を破ってまで渡す理由が無い
      if (total + size > maxChars) break;
      chosen.push(id);
      total += size;
    }
    if (chosen.length === 0) return "";

    return chosen
      .sort((left, right) => this.orderOf(left) - this.orderOf(right))
      .map((id) => render(this.scenes[this.orderOf(id)]))
      .join(SEPARATOR);
  }

  private orderOf(id: string): number {
    return this.orderById.get(id) ?? 0;
  }
}

/**
 * 検索語を整える。
 *
 * **1文字の語は落とす。** 索引は文字2つ組みなので、1文字では組みが
 * 作れず引きようがない（`bigrams`）。落とさずに渡すと、当たらないのに
 * 検索語の枠だけを埋めることになる。
 */
function searchTerms(terms: readonly string[]): string[] {
  const unique: string[] = [];
  for (const term of terms) {
    const trimmed = term.trim();
    if (trimmed.length < 2) continue;
    if (unique.includes(trimmed)) continue;
    unique.push(trimmed);
    if (unique.length >= PAST_SCENE_MAX_TERMS) break;
  }
  return unique;
}

/**
 * キャッシュの鍵（プロンプトの版）へ、渡した抜粋の中身を混ぜる
 * （設計書6.74）。
 *
 * **過去の話を書き直したら、同じチャンクでも答えが変わりうる。**
 * 混ぜないと、書き直す前の抜粋で出した指摘が出続ける
 * （`settingsFingerprint` を混ぜているのと同じ理屈）。
 *
 * **0件のときは混ぜない。** 抜粋を渡していないチャンクの鍵まで変えると、
 * これまで処理済みだったぶんが無駄に飛ぶ（有料AIなら費用がかかる）。
 */
export function promptVersionWithPastScenes(
  promptVersion: string,
  pastScenes: string
): string {
  if (!pastScenes) return promptVersion;
  return `${promptVersion}:past${sha1Text(pastScenes).slice(0, 16)}`;
}

/** 出典を添えて1件ぶんにする。**出典が無いと根拠として使えない** */
function render(scene: PastScene): string {
  return `【${scene.label}】\n${scene.text}`;
}
