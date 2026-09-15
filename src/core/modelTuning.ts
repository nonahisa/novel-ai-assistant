import * as vscode from "vscode";
import { logLine } from "./logger";
import { bundledTuningByKey, bundledTuningKeys } from "./bundledTuning";
// **型だけを借りる。** 実体は引き込まない（`import type` は消える）ので、
// 台帳が測定の仕組みを抱え込むことにはならない。それでも写しは作らない
// ——「tokens か words か」の定義は `core/contextProbe.ts` の1つだけ
import type { ProbeMeasureMethod } from "./contextProbe";

/**
 * AIチューニング——**モデルごと**の上限と待ち時間の台帳（設計書6.49）。
 *
 * 「AIが実際に読める長さを測る」は、測った値を `sakura.contextWindow` のような
 * **プロバイダ単位の設定1つ**へ書いていた。同じさくらのAIでも
 * `gpt-oss-120b` と 31B のモデルでは読める長さも要る待ち時間も違うので、
 * **モデルを切り替えた瞬間に、別のモデルで測った値が使われてしまう。**
 *
 * そこで鍵を `プロバイダID/モデル名` にした台帳を持つ。作者が
 * 「モデルを変更したら切り替わる」ことを求めたが、**切り替えの仕組みは要らない**
 * ——引くときの鍵にモデル名が入っているので、モデルを変えれば自然に別の値を引く。
 *
 * **VS Codeの設定（`novelai.modelTuning`）に置く。** `globalState` だと
 * 作者からは存在すら見えず、おかしくなっても消せない。設定なら一覧に出て、
 * 手で直せて、要らなければ丸ごと消せば測る前の状態へ戻る。
 */

/**
 * 出力の速さが、どこから来た値か（設計書6.65.14）。
 *
 * **同じ「トークン/秒」でも重みが違う。** 一覧に並べるだけだと、
 * 字数から換算しただけの推定値が「最速」の座に着くことがある。
 *
 * - `tuning`……「書ける量の測定」で測った値（`features/measureContext.ts`）
 * - `call`……普段のAI呼び出しで採れた値。応答の `usage` が出力トークン数を
 *   返したもの（`ai/meteredProvider.ts` の関所）
 * - `estimated`……同じく普段の呼び出しだが、`usage` が無いので**出力の
 *   字数から換算**したもの。換算の係数ぶんの誤差が乗る
 */
export type SpeedSource = "tuning" | "call" | "estimated";

/** 一覧・保存の両方が同じ値だけを扱うための一覧（読み込みの検査に使う） */
const SPEED_SOURCES: readonly SpeedSource[] = ["tuning", "call", "estimated"];

/** 読める長さの測り方。読み込みの検査に使う（`SPEED_SOURCES` と同じ役目） */
const MEASURE_METHODS: readonly ProbeMeasureMethod[] = ["tokens", "words"];

/** 1モデルぶんの調整値。**どれも省略できる**（測れたものだけ入る） */
export interface ModelTuning {
  /** 実効のコンテキスト長（トークン）。測って分かった値 */
  readonly contextWindow?: number;
  /** 1回の呼び出しで待つ秒数 */
  readonly timeoutSeconds?: number;
  /** 先頭と末尾の合言葉が両方返った、最大の字数 */
  readonly measuredChars?: number;
  /**
   * その測定が**測れる上限まで届いてしまった**か（作者の指摘、2026-09-13）。
   *
   * **`false` は「測ったが、天井には届かなかった」である。** 測るたびに
   * 必ず書く欄なので、`undefined`（＝印が付く前の古い台帳）とは意味が違う。
   * 省いて書いていた頃は、前の測定で立った `true` が差分の書き込みをすり
   * 抜けて残り続け、**天井に届かなかった強い測定が、前回の弱い印を着たまま
   * 一覧に並んでいた**（実機、2026-09-13。gemma4:12b が 194,288字・天井
   * 362,191字なのに「これ以上は試していません」と出た）。
   *
   * 二分探索には天井がある（申告の文脈長か、既定の上限）。そこまで全部
   * 通ってしまったときの `measuredChars` は、**そのモデルの限界ではなく
   * 検査の限界**である。「ここまでは確かめた」という下限値でしかない。
   *
   * 実機の一覧（2026-09-13）では、クラウドの31Bと手元の12Bが
   * **1字まで同じ 183,239字**になっていた。素性のまるで違う2つが一致
   * するのは、どちらも 128K の天井で止まった印である。同じ行の
   * 「文脈の実効長 261,770トークン」と並べると、半分以下しか
   * 測っていないことが読める。
   *
   * **一覧では、実測と下限値を見分けられるようにする。** 同じ列に
   * 混ぜたままでは、小さいモデルのほうが多く読めるように見える
   * （12Bが天井・26Bが実測だと、表の上では12Bが優秀に見えた）。
   *
   * **無い台帳は従来どおり**——印が付く前に測った値は、これまでと
   * 同じ扱いのままにする（読み側の互換。`outputMeasureTimedOut` と同じ）。
   */
  readonly contextHitCeiling?: boolean;
  /**
   * 読める長さを**何で測ったか**（作者の依頼、2026-09-13）。
   *
   * - `tokens`……AIが申告した**入力トークン数の伸び**。どこまで届いたかを
   *   直に見ているので、モデルの協力が要らない
   * - `words`……**合言葉**。トークン数を返さないAI・設定のための道で、
   *   実機では**長さと関係なく気まぐれに落ちた**（2,750字で通り4,000字で
   *   落ち、8,000字で通り30,000字で落ちた）。`contextHitCeiling` と
   *   同じく、そういう値だと分かるように印を残す
   *
   * **無い台帳は従来どおり**——印が付く前に測った値は、これまでと同じ
   * 扱いのままにする（読み側の互換。`contextHitCeiling` と同じ）。
   */
  readonly contextMeasuredBy?: ProbeMeasureMethod;
  /**
   * 読める長さが、**分あたりの上限（`rate_limited`）で頭打ちになったか**
   * （作者の裁定、2026-09-13夜）。
   *
   * 実機の Gemini（無料枠）は、60秒待って送り直してもなお上限に当たる長さが
   * あった。そこは「その長さでは送れない」として探索を降りる——**長さの
   * 限界ではなく、1分のあいだに送れる量の限界である。** 印を付けずに
   * 降りていたのが 0.61.1 以前の問題だったので、降りた測定には必ず印を残す。
   *
   * **`contextHitCeiling` とは印の意味が逆である。** 天井の印は「本当は
   * もっと読めるかもしれない（下限値）」、こちらは「待てばもっと長くなる
   * かもしれない（低めに出ている）」——どちらも数字が弱いことを言うが、
   * 弱い理由が違うので、一覧でも選ぶ画面でも別の言葉で出す。
   *
   * **測るたびに必ず書く**（`contextHitCeiling` と同じ約束）。台帳は差分で
   * 書かれるので、省くと前回の `true` が残り、**上限に当たらなかった強い
   * 測定が弱い印を着たまま並ぶ**（0.61.0 で天井の印を省いて踏んだ穴）。
   */
  readonly contextLimitedByRate?: boolean;
  /**
   * 1回の応答で書けた、実測の出力トークン数（設計書6.65.14の1）。
   *
   * **読める長さ（`measuredChars`）と違い、確認なしで自動的に保存される**
   * ——まとめ送信の上限を絞るためだけに使う参考値で、`contextWindow` や
   * `timeoutSeconds` のように呼び出しの挙動そのものを変える設定ではない。
   * 台帳へ繋いだ理由は設計書6.65.14（作者の指摘「設定に入れないのは
   * なぜでしょうか？　チューニングの意味がないように思う」）。
   */
  readonly measuredOutputTokens?: number;
  /**
   * その測定に**時間切れの回が混じっていた**か（設計書6.77の第2段）。
   *
   * `measureOutputLimit` は時間切れを「その量は書けない」と数える。
   * 待っても返らない長さは作者にとって書けないのと同じ、という判断だが、
   * **「書けない」の証拠としては弱い**——遅いだけのモデルでは、実際には
   * 書けるのに数百トークンで探索が終わる。
   *
   * 0.32.11から実測が**実送信のハード上限**になったので、この弱い値を
   * そのまま上限にすると「測っただけで以後すべての応答が切られ、設定を
   * 上げても直らない」状態が作れてしまう。だから印を残し、
   * **上限としては使わない**（見込みや まとめ送信の絞り込みでは使う。
   * あちらは小さく見るぶんには安全側である）。
   *
   * **無い台帳は従来どおり**——印が付く前に測った値は、これまでと同じ
   * 扱いのままにする（読み側の互換）。
   */
  readonly outputMeasureTimedOut?: boolean;
  /**
   * 出力の実測の速さ（トークン/秒。小数1桁）。
   *
   * **書き手は2つある**（設計書6.65.14。作者の裁定、2026-09-06）。
   *
   * 1. 「書ける量」の測定（`features/measureContext.ts`）——時間切れでない、
   *    いちばん長く書けた回の「出力トークン数 ÷ 所要秒」
   * 2. **普段のAI呼び出し**（`ai/meteredProvider.ts` の関所）——毎回の応答から
   *    同じ式で採る
   *
   * 1つ目だけだったとき、あれは**手元のAIしか測らない**機能なので、
   * クラウド（Gemini・さくら・Claude・ChatGPT）は永久に「—」のままだった。
   * 関所は全プロバイダ・全機能が通るので、そこで採れば6つとも埋まる。
   *
   * **平均しない。値は直近の実測をそのまま入れる。** 同じ機械でもほかの
   * 処理の負荷で変わるものなので、均した数より「いつの値か」
   * （`speedMeasuredAt`）が分かるほうが読める。
   *
   * **呼び出しの挙動は変えない。** 見せるためだけの参考値であり、
   * 待ち時間や上限のように送り方を決める値ではない。
   *
   * **無い台帳は従来どおり**——速度を測る前に取った値は、これまでと
   * 同じ扱いのままにする（読み側の互換）。
   */
  readonly outputTokensPerSecond?: number;
  /** その速度がどこから来たか。**推定値を実測と並べない**ための札 */
  readonly speedSource?: SpeedSource;
  /**
   * 実測の字/トークン（小数3桁。設計書6.77）。
   *
   * **速度（`outputTokensPerSecond`）とまったく同じ流儀**である——普段の
   * 呼び出しから自動で採り、確認なしで保存する参考値で、呼び出しの挙動を
   * 決める設定（`contextWindow`・`timeoutSeconds`）ではない。
   *
   * 製品はこれまで、字↔トークンを当て推量（0.7字/トークン）で見ていた。
   * 作者の送信量の記録437件で突き合わせると、**実測はその倍**
   * （全体1.461、いちばん悪いモデルでも1.277）だった。見積りが小さすぎると、
   * 入るのに入らないと判断して本文を細かく切ることになる。
   *
   * **平均しない。これまでの最小値を覚える。** 内容によって変わる値なので
   * （指示やJSONが多い回は大きく、地の文だけの回は小さい）、平均を採ると
   * 本文を多く送る回——まさに見積りが要る回——で甘くなる。最小値なら
   * 単純で、外れ値に強く、必ず安全側に倒れる。
   *
   * **無い台帳は従来どおり**——実測が入るまでは 0.7 のまま動く
   * （読み側の互換。`outputTokensPerSecond` と同じ）。
   */
  readonly charsPerToken?: number;
  /**
   * 上の値を、何回ぶんから採ったか。**少ないうちは信じない**
   * （`core/sizeBudget.ts` の `MIN_CHARS_PER_TOKEN_SAMPLES`）。
   *
   * **台帳へ実際に書いた回の数であって、呼び出し回数そのものではない。**
   * 設定ファイルへの書き込みを抑えるため、書くのは「しきい値に達するまで」と
   * 「最小値が下がったとき」だけにしてある（`ai/meteredProvider.ts`）。
   * 少なめに出るぶんには、信じ始めるのが遅れるだけで安全側である。
   */
  readonly charsPerTokenSamples?: number;
  /**
   * 速度を採った時刻（ISO 8601）。
   *
   * **`measuredAt` と混ぜない。** あちらはチューニング（読める長さ・
   * 書ける長さ）を測った時刻で、速度は普段の呼び出しからも更新される
   * ため、いつの値かが別々に動く。1つの欄にすると、測っていない項目まで
   * 新しく測ったように見える。
   */
  readonly speedMeasuredAt?: string;
  /** 測った時刻（ISO 8601）。古い測定だと分かるように残す */
  readonly measuredAt?: string;
  /**
   * この行に**同梱の初期値が混ざっている**か（`core/bundledTuning.ts`）。
   *
   * **読むときにだけ付く印で、台帳には書かない。** `writeModelTuning` が
   * `BUNDLED_MARKS` を弾くので、読んだ行をそのまま保存へ回しても
   * 設定ファイルへは入らない（作者の守り1「台帳へ書き写さない」）。
   */
  readonly bundled?: true;
  /** 同梱の値を測った日（`bundled` が立っているときだけ） */
  readonly bundledAt?: string;
  /**
   * **どの欄が同梱から来たか**（`bundled` が立っているときだけ）。
   *
   * 行の印だけでは足りない——同じ行に、作者が測った速さと、同梱の
   * 字/トークンが混ざることがある。一覧でどの数字が誰のものか読めるよう、
   * 欄の名前で持つ。
   */
  readonly bundledFields?: readonly string[];
}

/**
 * 読むときにだけ付ける印。**保存へは回さない。**
 *
 * 台帳へ書き写さないことを、書き込み側で機械的に守る
 * （`core/bundledTuning.ts` の表を参照）。
 */
const BUNDLED_MARKS: readonly string[] = [
  "bundled",
  "bundledAt",
  "bundledFields",
];

/**
 * 台帳の行へ、同梱の初期値を**欄ごとに**混ぜる。
 *
 * **作者の実測が常に勝つ**（作者の守り2）。埋めるのは、その欄が台帳に
 * 無いときだけである。行ごと差し替えないのは、台帳の欄が別々に育つ
 * ため——速さは普段の呼び出しから、読める長さは測定から入る。
 * 行単位で判断すると「速さだけ測ってある」モデルが同梱の字/トークンを
 * 受け取れない。
 */
function mergeBundledTuning(
  key: string,
  entry: ModelTuning | undefined
): ModelTuning | undefined {
  const seed = bundledTuningByKey(key);
  if (!seed) return entry;

  const filled: Record<string, unknown> = { ...(entry ?? {}) };
  const fields: string[] = [];
  const fill = (name: string, value: number | boolean | undefined): void => {
    if (value === undefined) return;
    if (filled[name] !== undefined) return;
    filled[name] = value;
    fields.push(name);
  };

  fill("charsPerToken", seed.charsPerToken);
  fill("measuredChars", seed.measuredChars);
  fill("contextHitCeiling", seed.contextHitCeiling);
  /*
    **`charsPerTokenSamples` も添える。** 読む側（`probeCharsPerToken` /
    `resolveCharsPerToken`）は「何回ぶんから採ったか」で信じるかを決めるので、
    回数が無いと同梱の値は使われないまま終わる。安全側の
    `resolveCharsPerToken` が求める件数（5件）を満たす数を入れる——
    **同梱しているのは、その件数より多くの実測から決めた値である。**
  */
  if (seed.charsPerToken !== undefined) {
    fill("charsPerTokenSamples", BUNDLED_CHARS_PER_TOKEN_SAMPLES);
  }

  if (fields.length === 0) return entry;
  return {
    ...(filled as ModelTuning),
    bundled: true,
    bundledAt: seed.measuredAt,
    bundledFields: fields,
  };
}

/**
 * 同梱の字/トークンに添える「何回ぶん」。
 *
 * 安全側の `resolveCharsPerToken`（`core/sizeBudget.ts`）は5件貯まるまで
 * 実測を使わない。**同梱の値はその件数より多くの呼び出しから決めている**
 * ので、しきい値を満たす数を添える。添えないと、同梱しても
 * チャンクの大きさは当て推量（0.7）のままで、**入れた意味が無い。**
 */
const BUNDLED_CHARS_PER_TOKEN_SAMPLES = 5;

/**
 * 待ち時間の下限。**いまの既定（180秒）を下回らせない。**
 *
 * 測定で使う合言葉の出力は極端に短いので、そのまま採ると
 * 「30秒で足りる」という結論になりかねない。実際の機能（誤字脱字の
 * 指摘一覧など）はもっと長い出力を返すので、測定が速くても縮めない。
 */
export const MIN_TIMEOUT_SECONDS = 180;

/**
 * 待ち時間の上限。これ以上待たせるくらいなら、モデルかチャンクの
 * 大きさを見直すほうが作者のためになる。
 */
export const MAX_TIMEOUT_SECONDS = 600;

/**
 * **測定のあいだだけ**使う、待ち時間の上限（作者の依頼、2026-09-13）。
 *
 * **ふだんの呼び出しと同じ上限でよい理由が無い。**
 *
 * - 測定は**1回きり**で、作者はその場で結果を待っている。長く待つのは
 *   「もっと読めるかもしれない」を確かめるための待ち時間である
 * - ふだんの呼び出しは**何十回も走る**（チャンクごとに1回）。途中で
 *   ハングすると、その回数ぶん作者の作業が詰まる
 *
 * 0.60.1 で測定の天井が倍近くへ広がり、1回に送る量が増えた。実機の
 * gemma4:12b はいちばん遅い回が273秒で、`recommendTimeoutSeconds` の
 * ×3が **600秒に頭打ち**になっていた——測定の側だけが窮屈になっている。
 *
 * **`MAX_TIMEOUT_SECONDS` のほうは動かさない。** 台帳へ書く待ち時間
 * （`recommendTimeoutSeconds`）は従来どおり600秒止まりで、ここで延ばした
 * 値がふだんの呼び出しへ持ち込まれることはない。
 */
export const PROBE_MAX_TIMEOUT_SECONDS = 1800;

/**
 * いま、台帳の待ち時間を読むときに掛ける上限。
 *
 * **ふだんは `MAX_TIMEOUT_SECONDS`。** 測定のあいだだけ
 * `PROBE_MAX_TIMEOUT_SECONDS` へ上げる（`raiseTimeoutCeilingForProbe`）。
 */
let timeoutCeilingSeconds: number = MAX_TIMEOUT_SECONDS;

/**
 * 測定のあいだだけ、待ち時間の読み出し上限を上げる。返った関数で元へ戻す。
 *
 * **これが無いと、延ばした待ち時間が効かない。** 測り直しのために台帳へ
 * 1,200秒と書いても、読む側（`tunedTimeoutSeconds`）が600秒で挟むので、
 * プロバイダは600秒しか待たない。**書いたのに効かない**——「ビルドが
 * 通った」と「動く」が違う、この作品でくり返した失敗の6番そのものになる。
 *
 * 上げるのは測定のあいだだけで、`measureContext` の `finally` が必ず戻す。
 * 戻し忘れても、台帳のほうは600秒を超える値を持たない（反映は
 * `recommendTimeoutSeconds` が挟み、反映しなければ元の値へ戻す）ので、
 * ふだんの呼び出しが長く待つようにはならない。
 */
export function raiseTimeoutCeilingForProbe(): () => void {
  const before = timeoutCeilingSeconds;
  timeoutCeilingSeconds = PROBE_MAX_TIMEOUT_SECONDS;
  return () => {
    timeoutCeilingSeconds = before;
  };
}

/**
 * これを下回るコンテキスト長は、台帳に入っていても使わない。
 *
 * **`novelai.modelTuning` は `object` の設定なので、`minimum` が効かない**
 * （プロバイダごとの `contextWindow` には効いている）。手で `5` と書けば、
 * 送る前から失敗が決まった値でその機能が丸ごと使えなくなる。
 * さくら・ChatGPTの設定が持っている下限と同じ値にしてある。
 */
const MIN_CONTEXT_WINDOW = 1024;

/** 作者が設定画面で読みやすいように、この刻みへ丸める */
const TIMEOUT_STEP_SECONDS = 30;

/**
 * 測った応答時間に掛ける倍率。
 *
 * **測定の出力は合言葉2つだけで、極端に短い。** 生成にかかる時間の
 * 大半は出力側なので、入力の処理時間しか測っていないこの数字を
 * そのまま使うと、実際の機能では必ず足りない。
 */
const RESPONSE_TIME_MARGIN = 3;

/** 台帳を引くときの鍵。**モデル名まで含めるのが要点** */
export function modelTuningKey(providerId: string, model: string): string {
  return `${providerId}/${model}`;
}

/**
 * 設定に入っている台帳を読む。
 *
 * **壊れていても投げない。** ここは作者が手で編集できる設定であり、
 * 書き間違いのせいでAIが呼べなくなるほうが困る。読めない項目は
 * その項目だけ捨てて、ほかは読む（`workRegistry.ts` の
 * `parseAnnounceConfig` と同じ方針）。
 *
 * **欄の単位で捨てる。** 時刻の書き間違いくらいで、測り直さないと
 * 戻らない `contextWindow` まで道連れにしない。使える欄が1つも
 * 残らなかったときだけ、その項目ごと落とす。
 */
export function parseModelTuning(raw: unknown): Map<string, ModelTuning> {
  const result = new Map<string, ModelTuning>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return result;
  }

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.trim().length === 0) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    const contextWindow = positiveNumber(entry.contextWindow);
    const timeoutSeconds = positiveNumber(entry.timeoutSeconds);
    const measuredChars = positiveNumber(entry.measuredChars);
    const measuredOutputTokens = positiveNumber(entry.measuredOutputTokens);
    // **0は読まない。** 「0トークン/秒」は測れていないのと同じ意味に
    // なるが、一覧では「測っていない」と区別が付かなくなる
    const outputTokensPerSecond = positiveNumber(entry.outputTokensPerSecond);
    // **知らない出どころは読まない。** 一覧は決まった3つしか言葉へ
    // 直せないので、読んでしまうと生の値が表に出る
    const speedSource = SPEED_SOURCES.find((id) => id === entry.speedSource);
    const speedMeasuredAt = nonEmptyText(entry.speedMeasuredAt);
    // **0は読まない**（速度と同じ理由）。「0字/トークン」は測れていないのと
    // 同じ意味だが、そのまま読むと換算が無限大になる
    const charsPerToken = positiveNumber(entry.charsPerToken);
    const charsPerTokenSamples = positiveNumber(entry.charsPerTokenSamples);
    /*
      0.36.3 の `firstTokenSeconds` は**欄ごと削った**。流し受信を断つ
      測定では最初のトークンの時刻を知る手立てが無く、普段の呼び出しの
      関所でも所要時間しか手に入らない——**書き手のいない欄**だった。

      ここで読まないだけで、設定に残っている値は消えない
      （`saveModelTuning` は知らない欄をそのまま残す）。
    */
    // **true のときだけ持つ。** 「印が無い」と「印が false」を分けても
    // 使い道が無いうえ、false を書き戻すと設定に意味の無い欄が並ぶ
    const outputMeasureTimedOut =
      entry.outputMeasureTimedOut === true ? true : undefined;
    /*
      **0.58.0 では、書いているのに読んでいなかった。**

      `features/measureContext.ts` の `offerToSave` は天井の印を書いて
      いたのに、ここで読み落としていたため、一覧（`core/tuningStats.ts`）
      には一度も出なかった。書き手と読み手が揃って初めて印になる。

      **`false` も読む**（作者の依頼、2026-09-13）。この欄は測るたびに
      必ず書かれるので、`false` は「測ったが天井には届かなかった」という
      れっきとした中身である。`undefined` へ潰すと、表の見た目こそ同じでも
      「読めているか」を確かめられなくなる——0.58.0 の読み落としは、まさに
      そこを見ていなかったせいで半年ぶん気づかれなかった。
    */
    const contextHitCeiling =
      typeof entry.contextHitCeiling === "boolean"
        ? entry.contextHitCeiling
        : undefined;
    /*
      **こちらも `false` を読む**（`contextHitCeiling` と同じ理由）。

      測るたびに必ず書かれる欄なので、`false` は「測ったが、分あたりの
      上限では降りなかった」というれっきとした中身である。ここで
      `undefined` へ潰すと、表の見た目は同じでも「読めているか」を
      確かめられなくなる——0.58.0 で天井の印を**書いているのに読んで
      いなかった**のは、まさにそこを見ていなかったせいである。
    */
    const contextLimitedByRate =
      typeof entry.contextLimitedByRate === "boolean"
        ? entry.contextLimitedByRate
        : undefined;
    // **知らない測り方は読まない**（`speedSource` と同じ理由）。一覧は
    // 決まった2つしか言葉へ直せないので、読むと生の値が表に出る
    const contextMeasuredBy = MEASURE_METHODS.find(
      (method) => method === entry.contextMeasuredBy
    );
    const measuredAt = nonEmptyText(entry.measuredAt);

    const tuning: ModelTuning = {
      // **持っている欄だけを置く。** `undefined` を常に置くと、書き戻した
      // ときに設定へ空の欄が現れて、作者には壊れて見える
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      ...(measuredChars !== undefined ? { measuredChars } : {}),
      ...(measuredOutputTokens !== undefined ? { measuredOutputTokens } : {}),
      ...(outputTokensPerSecond !== undefined ? { outputTokensPerSecond } : {}),
      ...(speedSource !== undefined ? { speedSource } : {}),
      ...(speedMeasuredAt !== undefined ? { speedMeasuredAt } : {}),
      ...(charsPerToken !== undefined ? { charsPerToken } : {}),
      ...(charsPerTokenSamples !== undefined ? { charsPerTokenSamples } : {}),
      ...(outputMeasureTimedOut !== undefined ? { outputMeasureTimedOut } : {}),
      ...(contextHitCeiling !== undefined ? { contextHitCeiling } : {}),
      ...(contextLimitedByRate !== undefined ? { contextLimitedByRate } : {}),
      ...(contextMeasuredBy !== undefined ? { contextMeasuredBy } : {}),
      ...(measuredAt !== undefined ? { measuredAt } : {}),
    };
    // 何も読めなかった項目は、持っていても引く値が無い
    if (Object.keys(tuning).length === 0) continue;
    result.set(key, tuning);
  }

  return result;
}

/**
 * 正の有限数のときだけ返す。
 *
 * 0や負や `"131072"` のような文字列は、**読まずに捨てる。** 半端に
 * 読むと「上限0トークン」のような、送る前から失敗が決まった値になる。
 */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** 中身のある文字列のときだけ返す。空白だけの時刻は「無い」と同じ */
function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/**
 * 測った応答時間から、設定してよい待ち時間を決める。
 *
 * `Math.min(600, Math.max(180, Math.ceil(秒 * 3 / 30) * 30))`。
 * 掛ける3・下限180・上限600・30秒刻みの理由は、それぞれ上の定数に書いた。
 */
export function recommendTimeoutSeconds(longestResponseSeconds: number): number {
  if (
    !Number.isFinite(longestResponseSeconds) ||
    longestResponseSeconds <= 0
  ) {
    // 測れていないなら、いまの既定を動かす根拠が無い
    return MIN_TIMEOUT_SECONDS;
  }
  const raw = longestResponseSeconds * RESPONSE_TIME_MARGIN;
  const rounded = Math.ceil(raw / TIMEOUT_STEP_SECONDS) * TIMEOUT_STEP_SECONDS;
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, rounded));
}

const CONFIG_SECTION = "novelai";
const TUNING_SETTING = "modelTuning";

/** プロバイダごとの待ち時間の設定名。6つとも同じ形をしている */
export function timeoutSettingKey(providerId: string): string {
  return `${providerId}.timeoutSeconds`;
}

function readTuningTable(): Map<string, ModelTuning> {
  return parseModelTuning(
    vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(TUNING_SETTING)
  );
}

/**
 * 台帳の**全部**。実測の一覧（`core/tuningStats.ts`）が使う。
 *
 * **解釈の仕方を持ち出させない。** 一覧側が設定を直接読むと
 * `parseModelTuning` の写しがそこにでき、壊れた欄の扱いが2か所に散る。
 */
export function allModelTuning(): Map<string, ModelTuning> {
  const table = readTuningTable();
  /*
    **同梱の初期値も並べる**（`core/bundledTuning.ts`）。台帳に行が無い
    モデルでも、選ぶ画面と実測の一覧に「読める ◯字（同梱）」と出す——
    出さないと、**効いているのに見えない値**になる（作者の守り3）。
  */
  for (const key of bundledTuningKeys()) {
    const merged = mergeBundledTuning(key, table.get(key));
    if (merged) table.set(key, merged);
  }
  return table;
}

/** そのモデルの調整値。**測っていなければ undefined**（従来の設定へ落とす） */
export function modelTuning(
  providerId: string,
  model: string
): ModelTuning | undefined {
  const key = modelTuningKey(providerId, model);
  return mergeBundledTuning(key, readTuningTable().get(key));
}

/**
 * **同梱の初期値を混ぜずに**、台帳そのものを引く。
 *
 * 使うのは、**作者自身の実測を作る側**だけである（読める長さの測定
 * `features/measureContext.ts`、普段の呼び出しから字/トークンを採る
 * `ai/meteredProvider.ts` の書き込み）。
 *
 * **混ぜたものを土台にすると、同梱の値が作者の測定を汚す。**
 *
 * - **回数が水増しされる**……同梱に添えた5回を数え始めの値にすると、
 *   1回測っただけで「6回ぶん」になる
 * - **最小値が作者の実測に勝ってしまう**……字/トークンは最小値を覚える
 *   決まりなので、同梱の 1.065 を previous として渡すと、作者が
 *   1.5 と測っても同梱の値が残る。**これは「作者の実測が常に勝つ」
 *   （作者の守り2、2026-09-13）を真正面から破る**
 * - **測り直しの起点がずれる**……クラウドの同梱値（339,804字）を
 *   「前回の測定」として読むと、まだ一度も測っていない機械で
 *   そこから降り始める
 *
 * 使うほう（チャンクの大きさ・一覧の表示）は `modelTuning` でよい。
 */
export function modelTuningRaw(
  providerId: string,
  model: string
): ModelTuning | undefined {
  return readTuningTable().get(modelTuningKey(providerId, model));
}

/**
 * 同じ注意を何度も書かないための覚え。
 *
 * 台帳は**呼び出しのたびに読む**ので、挟んだことを毎回書くとログが
 * その1行で埋まり、ほかの失敗が見えなくなる。
 */
const reportedOnce = new Set<string>();

function noteOnce(message: string): void {
  if (reportedOnce.has(message)) return;
  reportedOnce.add(message);
  logLine(message);
}

/**
 * 測って分かった実効のコンテキスト長（トークン）。無ければ undefined。
 *
 * **小さすぎる値は使わない。** 設定の型が `object` なので、VS Code側の
 * `minimum` が効かない（上の `MIN_CONTEXT_WINDOW` に理由）。無視したときは
 * 呼び出し側が従来の設定へ落ちる。
 */
export function tunedContextWindow(
  providerId: string,
  model: string
): number | undefined {
  const tuned = modelTuning(providerId, model)?.contextWindow;
  if (tuned === undefined) return undefined;
  if (tuned < MIN_CONTEXT_WINDOW) {
    // **黙って別の値を使わない。** 作者が書いた値が効いていないことは、
    // 「入力が切り捨てられた」形でしか現れないので、必ず言う
    noteOnce(
      `AIチューニング：${modelTuningKey(providerId, model)} のコンテキスト長 ` +
        `${tuned} は小さすぎるため使いません（${MIN_CONTEXT_WINDOW} 以上にしてください）。` +
        "設定のほうの値を使います。"
    );
    return undefined;
  }
  return tuned;
}

/**
 * 測って分かった待ち時間（秒）。無ければ undefined。
 *
 * **上限で挟む。** 手で `100000` と書くと、1回の呼び出しが27時間待つ。
 * 上限は書き込み側（`recommendTimeoutSeconds`）でしか守られていないので、
 * 読む側でも同じ線を引く。
 *
 * 挟む線は、ふだんは `MAX_TIMEOUT_SECONDS`。**測定のあいだだけ
 * `PROBE_MAX_TIMEOUT_SECONDS` まで上がる**（`raiseTimeoutCeilingForProbe`）。
 */
export function tunedTimeoutSeconds(
  providerId: string,
  model: string
): number | undefined {
  const tuned = modelTuning(providerId, model)?.timeoutSeconds;
  if (tuned === undefined) return undefined;
  const ceiling = timeoutCeilingSeconds;
  if (tuned > ceiling) {
    noteOnce(
      `AIチューニング：${modelTuningKey(providerId, model)} の待ち時間 ` +
        `${tuned} 秒は長すぎるため、${ceiling} 秒までに抑えます。`
    );
    return ceiling;
  }
  return tuned;
}

/**
 * そのモデルへの1回の呼び出しで待つ秒数。
 *
 * **順番を1か所で決める**——台帳（AIチューニング）→ プロバイダごとの設定 →
 * 既定。6つのプロバイダがそれぞれ順番を書いていると、片方だけ直したときに
 * 「Ollamaでは効くのにClaudeでは効かない」という食い違いが静かに生まれる。
 *
 * `fallbackSeconds` は**そのプロバイダのpackage.json上の既定**を渡す
 * （Claudeだけ300秒で、ほかは180秒）。設定が宣言されている限りVS Codeが
 * その既定を返すので実行時には使われないが、渡す値を変えると
 * 試験の中だけ挙動が変わってしまう。
 */
export function resolveTimeoutSeconds(
  providerId: string,
  model: string,
  fallbackSeconds: number = MIN_TIMEOUT_SECONDS
): number {
  const tuned = tunedTimeoutSeconds(providerId, model);
  if (tuned !== undefined) return tuned;
  const configured = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>(timeoutSettingKey(providerId), fallbackSeconds);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : fallbackSeconds;
}

/**
 * コンテキスト長の決め方。プロバイダごとに違うのは、この3つだけである。
 *
 * `resolveContextWindow` へ渡す。**値をここに書かない**——既定も設定名も
 * プロバイダ側の事情なので、持つのはプロバイダのファイルである。
 */
export interface ContextWindowSource {
  /** プロバイダごとの設定名（`novelai.` を除く） */
  readonly settingKey: string;
  /** 設定も台帳も無い／使えないときの既定 */
  readonly fallback: number;
  /**
   * これ未満の設定値は使わない（`package.json` の `minimum` と揃える）。
   * **0なら「正の数ならなんでも」**——LM Studioは読み込んだ長さに
   * 合わせる予備なので、小さい値も作者の意図として尊重する。
   */
  readonly minimum: number;
}

/**
 * そのモデルが読める長さ（トークン）。
 * **台帳（AIチューニング）→ プロバイダごとの設定 → 既定** の順で決める。
 *
 * ## 台帳を見るのは、申告しないプロバイダだけ
 *
 * ChatGPT・LM Studio・さくらのAIは、モデル一覧APIがコンテキスト長を
 * 返さない。だから「測って台帳へ書く」（設計書6.49）が要る。
 *
 * **Ollama・Gemini・ClaudeはAPIが申告するので、台帳を見ない。**
 * 申告のほうが正しく、モデルが差し替わればその場で新しい値になる。
 * ここへ台帳を挟むと、**古い実測が正しい申告を静かに上書きする**
 * ——モデルを入れ替えたのに前のモデルの長さで分割し続ける、という
 * 気づきようのない壊れ方になる。台帳は「申告できないプロバイダの
 * 実測の置き場」であって、全プロバイダ共通の上書き機構ではない。
 *
 * ## 3社が同じ順番を別々に書いていた
 *
 * 読み順・下限・落とし先が3か所に写されており、片方だけ直すと
 * 「ChatGPTでは効くのにさくらでは効かない」が静かに生まれる
 * （待ち時間の `resolveTimeoutSeconds` と同じ理由。設計書6.77の第2段）。
 */
export function resolveContextWindow(
  providerId: string,
  model: string,
  source: ContextWindowSource
): number {
  const tuned = tunedContextWindow(providerId, model);
  if (tuned !== undefined) return tuned;
  const configured = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>(source.settingKey, source.fallback);
  return Number.isFinite(configured) &&
    configured > 0 &&
    configured >= source.minimum
    ? configured
    : source.fallback;
}

/** `resolveTimeoutSeconds` のミリ秒版。プロバイダはこちらを使う */
export function resolveTimeoutMs(
  providerId: string,
  model: string,
  fallbackSeconds: number = MIN_TIMEOUT_SECONDS
): number {
  return resolveTimeoutSeconds(providerId, model, fallbackSeconds) * 1000;
}

/**
 * そのモデルぶんの調整値を、**指定した欄だけ差し替えて**書く。
 *
 * **土台にするのは生の設定値である。** `parseModelTuning` を通したものを
 * 書き戻すと、こちらが解釈できなかった欄が黙って消える。作者が
 * `{"contextWindow": "131072", "memo": "26Bはこれ"}` と手で書いていたら、
 * 測って戻すだけでその2つが消えることになる。**読めない欄・知らない欄は
 * そのまま残す**——こちらが読めないだけで、作者にとっては意味がある。
 *
 * ほかのモデルの項目も、当然ながら触らない。
 *
 * **欄を消したいときは `undefined` を渡す。** 測り直しのために一時的に
 * 延ばした待ち時間を元へ戻すとき、「元は欄が無かった」を表す手段が要る
 * （`{ timeoutSeconds: undefined }` を渡せば、その欄だけ消える）。
 * 残る欄が1つも無くなったら、その鍵ごと落とす——中身の無い鍵が設定に
 * 並ぶと、作者には「測ったのに何も入っていない」と読める。
 */
/**
 * 台帳への書き込みを、順番に1つずつ通す（作者の実機、2026-09-13）。
 *
 * ## 何が起きたか
 *
 * `ollama/qwen3.8:latest` の測定結果（`measuredChars: 76815`）が、
 * **保存を確認したあとで台帳から消えた。** ほかの7件は残っていた。
 *
 * 書き込みは「全体を読む → その1件を差し替える → 全体を書き戻す」で、
 * **読んだときと同じ中身がまだそこにあるかを確かめていなかった。**
 * 書き手は複数ある——測定の終わり（`offerToSave`）、普段の呼び出しごとの
 * 速度（`recordSpeed`）、同じく字/トークン（`recordCharsPerToken`）。
 * 読む瞬間と書く瞬間のあいだに別の書き込みが挟まれば、**挟まれたほうが
 * まるごと消える。**
 *
 * ## ほかの台帳は、みな守りを持っている
 *
 * 人物・設定資料・章立て・本の設計図は、読み込み時のハッシュ照合や
 * `assertSaveAllowed` を持つ（CLAUDE.mdの実装ルール2）。
 * **モデルの調整値だけが素通しだった。**
 *
 * ## 直し方は2段
 *
 * 1. **順番に通す**（この待ち行列）。同じ拡張機能ホストの中での競合を塞ぐ。
 *    手本は `core/logger.ts` の `writeQueue`
 * 2. **書く直前に読み直す**（`saveModelTuning` の中）。待っているあいだに
 *    外から変わっていることがある——作者が手で直す、別の窓、同期
 */
let tuningWriteQueue: Promise<void> = Promise.resolve();

export async function saveModelTuning(
  providerId: string,
  model: string,
  tuning: ModelTuning
): Promise<void> {
  // **並んでから触る。** 読む→直す→書くのあいだに、別の書き込みを
  // 挟ませない（挟まると、挟まれたほうの鍵がまるごと消える）
  const done = tuningWriteQueue.then(() =>
    writeModelTuning(providerId, model, tuning)
  );
  // 1つ失敗しても、次を止めない。列そのものは常に進める
  tuningWriteQueue = done.catch(() => undefined);
  return done;
}

async function writeModelTuning(
  providerId: string,
  model: string,
  tuning: ModelTuning
): Promise<void> {
  /*
    **待ってから、もう一度読む。** 列に並んでいるあいだに設定が
    変わっていることがある（作者が手で直す・別の窓・同期）。
    並ぶ前に読んだ表で書き戻すと、そのあいだの変更を巻き戻す。
  */
  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const table = asRecord(configuration.get<unknown>(TUNING_SETTING));

  const key = modelTuningKey(providerId, model);
  const entry = asRecord(table[key]);
  for (const [name, value] of Object.entries(tuning)) {
    /*
      **同梱の印は書かない**（作者の守り1「台帳へ書き写さない」）。
      読んだ行には `bundled` / `bundledAt` が付いていることがあり、
      それをそのまま保存へ回すと、同梱の値が台帳へ焼き付いて
      **次の版で表を直しても古い値が生き残る。**
    */
    if (BUNDLED_MARKS.includes(name)) continue;
    if (value === undefined) delete entry[name];
    else entry[name] = value;
  }
  if (Object.keys(entry).length === 0) {
    delete table[key];
  } else {
    table[key] = entry;
  }

  // **読まれる場所へ書く。** `get` は作品フォルダ（ワークスペース）の値を
  // 優先するのに、`update` を必ず機械全体へ向けると、書いても読まれない。
  // 作者からは「反映を押したのに何も変わらない」としか見えず、
  // 無言で効かない状態になる。
  //
  // 作品フォルダ側に値が無いときは、これまでどおり機械全体へ書く——
  // 読み込み方も契約も、作品ではなく環境の側の事情で決まる
  const hasWorkspaceValue =
    configuration.inspect(TUNING_SETTING)?.workspaceValue !== undefined;
  await configuration.update(
    TUNING_SETTING,
    table,
    hasWorkspaceValue
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global
  );

  /*
    **入ったかを確かめる。** 列に並べても、外から同時に書かれることは
    まだありうる（別の窓、同期、作者の手）。黙って諦めない
    （CLAUDE.md「エラーは握りつぶさない」）。

    **例外は投げない。** 測定の結果を作者へ見せる流れを、台帳の都合で
    止めない——見せるものは既に手元にあり、台帳はその控えである。
  */
  const saved = asRecord(
    asRecord(
      vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<unknown>(TUNING_SETTING)
    )[key]
  );
  const missing = Object.entries(tuning)
    .filter(([name, value]) =>
      value === undefined ? name in saved : saved[name] !== value
    )
    .map(([name]) => name);
  if (missing.length > 0) {
    logLine(
      `モデルの調整値：${key} の ${missing.join("・")} が書けませんでした` +
        "（別の窓か同期が同時に書いた可能性があります）。"
    );
  }
}

/** 素の物なら浅い写しを、そうでなければ空の物を返す（元は書き換えない） */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}
