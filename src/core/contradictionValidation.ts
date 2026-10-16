import type { Chunk } from "./chunker";
import { normalizeForComparison } from "./groundedEvidence";
import { decodeByteFallback } from "./byteFallback";
import { lineHoldingQuote } from "./relocateQuote";
import { CHARACTER_AS_OF_FIELDS } from "./contradictionMaterial";
import {
  CONTRADICTION_CATEGORIES,
  SPEECH_INSTRUCTION_TEXTS,
  type ContradictionCategory,
} from "../prompts/contradictionCheck";

/**
 * 矛盾検知の応答の検証（設計書6.10.1）。
 *
 * **AIの出力を信用しない。** とくに矛盾検知は、
 *
 * - **本文に無い箇所を「引用」してくる。** 照らし合わせる材料が多いほど、
 *   材料側の文をそのまま引いて「本文にこうある」と言う
 * - **設定に無いことまで矛盾にする。** 照らし合わせる相手が無ければ
 *   矛盾とは言えない
 *
 * 前者はここで弾ける（本文に実在するかを見る）。後者はプロンプトでしか
 * 抑えられないので、**確信度を残して作者に判断させる。**
 *
 * VS Code APIに依存しない。
 */

export interface ExtractedContradiction {
  line: number;
  excerpt: string;
  category: ContradictionCategory;
  settingSays: string;
  textSays: string;
  note: string;
  severity: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
}

export interface AcceptedContradiction extends ExtractedContradiction {
  filePath: string;
  chunkHash: string;
}

export interface RejectedContradiction {
  raw: unknown;
  reason:
    | "shape"
    | "line_out_of_range"
    | "excerpt_not_found"
    | "unknown_category"
    | "empty_comparison"
    /** 補足に「矛盾していません」と書いてある */
    | "self_denied"
    /** 設定と本文に同じことが書いてある */
    | "not_different"
    /** 設定の側が「設定が無い」と言っている */
    | "no_setting"
    /** 設定・本文の欄が、プロンプトに書いた指示の写し（1.8 の口調の指示） */
    | "instruction_echo";
}

/**
 * 答えの欄が、プロンプトに書いた口調の指示（1.8）の写しか。
 *
 * **指示の言葉は、答えの中身として返ってくる**（CLAUDE.md「繰り返し起きた
 * 失敗」3番）。「台詞は、話している人物の設定の…と照らし合わせる」を
 * `textSays` に写した指摘は、何が食い違ったのかを述べていない。
 *
 * 写しと見るのは、欄が指示の文を丸ごと含むときと、欄全体が指示の文の
 * 一部をそのまま切り出したもの（8字以上）のとき。短い一致（「一人称」）は
 * 本物の指摘にも出るので見ない。
 */
export function echoesInstruction(text: string): boolean {
  const field = normalizeForComparison(text);
  if (!field) return false;
  return SPEECH_INSTRUCTION_TEXTS.some((instruction) => {
    const guide = normalizeForComparison(instruction);
    return field.includes(guide) || ([...field].length >= 8 && guide.includes(field));
  });
}

/**
 * 「これは矛盾ではない」と自分で書いている指摘を見分ける。
 *
 * **実データで実際に返ってきた。** 出力の配列があると、モデルは
 * 何かを埋めようとする。補足に「矛盾していません」と書きながら
 * 指摘として並べてくるので、コード側で落とす。
 *
 * **2026-09-20 に語を足した。** 抑制をゆるめて測ったとき、唯一の
 * 余計な指摘が「暦の上では約1か月であり、**整合性は取れているが**」
 * と書いていた。**「矛盾していない」は知っていたのに、同じことを
 * 別の言い方でされると素通りしていた**（引継ぎ書8章）。
 *
 * **2026-09-24 に、疑問と理由の形を外した**（縛りの洗い出し1番）。
 * 「一致している」「整合している」は言い切りなら否定だが、
 * 「一致して**いるか**確認が必要」（疑問）や「文体が一致して**いるため**、
 * 誤記の可能性が高い」（理由）は矛盾を否定していない。答え付きの台で、
 * **仕込みの正解（第3話「僕」・第4話「右足」）がこの形で落ちていた。**
 * 「整合しているように見えるが」は外さない——実測では罠（第4話の
 * 「一か月」）に付いた余計な指摘がこの形だった。
 *
 * 同じ日に「**矛盾というより**…」を足した。自分で矛盾ではないと
 * 書いているのに、どの語にも当たらず通っていた（第1話の余計な指摘と、
 * 作者の作品の「矛盾というよりは…表現である」）。
 */
/*
 * 2026-09-25 に「合致している」「矛盾点はない」「矛盾は指摘しない」を足した。
 * 矛盾検知で口調を照らすよう頼んだ（P-12 1.8）あと、gemma4:e4b が台詞を
 * 1つずつ挙げ、**設定の欄に**「この発言は設定と合致している」「口調の矛盾は
 * 指摘しない」と書いてきた（同じ理由で、設定の欄も否定の網に掛けるようにした。
 * `validateContradictions`）。
 */
/*
 * 2026-09-26 に「（設定の〜）に一致。」「〜として適切。」を足した（文の終わりで言い切った
 * 形だけ）。さくら Qwen3.6-35B-A3B が台詞を1つずつ挙げ、補足にこの形で食い違いを
 * 打ち消した指摘が、作者の作品の写しの第6話だけで57件通っていた。「一致しない」
 * 「一致しているため」は文の終わりの形ではないので当たらない。
 * 同じ日に「設定通り。」「問題なし。」「このエントリは不要」も足した（さくら Kimi-K2.6 が
 * 本文の欄に考えを書き連ね、「設定通り。問題なし。このエントリは不要。削除する。」で
 * 終わる指摘が通っていた）。「問題ないが〜」「設定通りなら〜」は文の終わりではないので当たらない。
 */
/*
 * 2026-10-11 に、「整合する。」「整合性あり。」「〜は正しい。」「不自然ではない。」
 * 「食い違わない」「矛盾する確証はない」を足した（`SELF_CLEARED_PATTERN`）。
 */
const DENIAL_PATTERN =
  /((矛盾|食い違い?)(で)?は?(あり)?(し)?(て)?(い)?(ない|ませ|なく)|(矛盾|食い違い?)(点|箇所)(は|が)?(あり)?(ない|ませ)|(矛盾|食い違い?)(点|箇所)?は?指摘し(ない|ませ)|矛盾というより|(一致|合致)してい(る|ます)(?!の?か|ため|ので|から)|[にと](一致|合致)(する|します)?(。|$)|として(適切|自然|妥当)(である|です|だ)?(。|$)|設定(の)?(通|どお)り(。|$)|問題(は)?(なし|ない)(。|$)|(この)?(エントリ|指摘|項目)は不要|問題(は)?(あり)?ませ|整合(性)?(は|が)?(取|と)れて(いる|います)(?!の?か|ため|ので|から)|整合してい(る|ます)(?!の?か|ため|ので|から)|齟齬(は)?(あり)?(ませ|ない)|破綻(は)?(し)?(て)?(い)?(ない|ませ))/;

/**
 * 説明の中で「問題ない」と言い切った形（2026-10-11 に足した）。
 *
 * **実データで通っていた。** さくら Kimi-K2.6 で口調の台を撃つと、台詞を
 * 1つずつ挙げ、説明に「老人のぶっきらぼうな口調と整合する。」「計算上は
 * 正しい。」「設定と矛盾する確証はない。」と書いた指摘が、2回で 5件・8件
 * 検算を抜けた。罠（第3話の蓬田「なんだ、そんな顔をするな」）も1回この形で
 * 作者へ届く所だった（`docs/measurements/2026-10-11-contradiction-speech-sakura_kimi.json`）。
 *
 * **拾いすぎない。** 「整合する」「正しい」「不自然ではない」は、**文の終わりで
 * 言い切った形だけ**を見る。「〜とは整合する**が**、〜とは食い違う」は片方と
 * 食い違うと言っているので当たらない。「整合しない」「整合性が崩れている」
 * 「設定通りではない」も当たらない。「〜**が**正しい。」は、設定の側を正しいと
 * 言う本物の指摘の形（「設定の右目が正しい。」）なので入れない——見るのは
 * 「〜**は**正しい。」「〜**として**正しい。」だけ。長い考えの途中の否定で
 * 本物を落とした前例（設計書の P-12「残った検算の穴」、負傷の仕込み）が
 * あるので、文の途中の形は足さない。
 */
/*
 * 2026-10-12 に「（口調|性格|設定）は維持されている。」を足した。Kimi の第1話57行が
 * 「〜との整合性はあるが、千夏の口調設定は維持されている」で通っていた。「〜が、」の
 * 前半は上の理由で見ないので、文の終わりの言い切りで受ける。「維持されていない」は当たらない。
 */
const SELF_CLEARED_PATTERN =
  /((口調|性格|設定)(は|が)?(維持|保持)されて(いる|います)(。|\s|$)|[にとで]は?整合(する|します)?(。|$)|整合性(は|が)?(あり|ある|あります)(。|$)|(は|として)正し(い|いです)(。|$)|不自然(では|じゃ)(ない|ありません)(。|$)|食い違(わ|って(い)?)(ない|ませ|ず|なく)(?!か)|(矛盾|食い違[いうっ])(する|している|の)?(という)?(確証|根拠|証拠)(は|が)?(ない|ありませ|なし)|設定(の)?(通|どお)り(です|である|だ)(。|$))/;

/**
 * 断定を避けた否定——「矛盾とは言えません」「矛盾とは断定できません」。
 *
 * **2026-09-21 に足した。** gemma4:26b の実データ（教科書チート_確認用
 * 第5話）で、この形の2件が**そのまま作者に出ていた**。上の網は
 * 「矛盾**では**ありません」しか見ておらず、**「矛盾**とは**言えません」は
 * 通していた**（`矛盾` の直後が `と` の形）。
 *
 * **プロンプトの【判断の注意】に書いた言い回しが、そのまま返ってきている**
 * ——「照らし合わせる相手が無いものは矛盾とは言えません」「指摘は断定形に
 * しないこと」。指示の言葉が答えの中身として返る型なので、**プロンプトに
 * 書いた否定の言い方はぜんぶ網に入れる。**
 *
 * 「断定しにくい」は 2026-09-24 に足した（同じ保留の形。答え付きの台の
 * 第2話で、仕込みの無い所に付いた余計な指摘2件がこの形だった）。
 *
 * **保留の形は、明示の否定と同じく落とす。** 2026-09-24 に「明示の否定
 * だけにする」案もあったが、実測の落とした答え56件のうち、
 * 保留だけで落ちていたのは本物1件（第5話「二週間」）に対し、余計な指摘が
 * 10件あった。本物のほうは食い違いを「乖離」と言い切っているので、
 * 言い切りの網（`AFFIRMATION_PATTERN`）で拾う。
 */
const HEDGED_DENIAL_PATTERN =
  /(矛盾|食い違い?)と(まで)?は?(((言|い)(え|い切れ)|断定でき|判断でき)(ない|ませ|ず|なく)|(断定|判断)し(にく|づら))/;

/**
 * 判断の保留——「矛盾しているかは不明です」「矛盾かどうかは判断できません」。
 *
 * 同じ実データで返ってきたもう1つの形。**「分からない」は「矛盾がある」では
 * ない**ので、指摘として出さない（迷いは確信度ではなく、ここで落とす）。
 *
 * 2026-09-24 に「一致しているかは不明確」「整合しているかは分からない」の
 * 形を足した。上の網から疑問の形（「一致しているか確認が必要」）を外した
 * ところ、この保留の形が通るようになった（過去の測定の答えで当て直して
 * 見つけた）。「確認が必要」「重要」は保留ではないので入れない。
 */
const UNSURE_DENIAL_PATTERN =
  /(矛盾|食い違[いっ]|一致|整合)(し?て)?(いる|います)?(のか|か)(どうか)?(は|が)?(不明|判断でき(ない|ませ|ず)|(分|わ)か(ら|り)(ない|ませ|ず)|定かで(は)?(ない|ありませ))/;

/**
 * 「ここは食い違っている」と言い切っている部分。
 *
 * **落としすぎないための歯止め。** `note` は補足欄なので、作者向けの
 * 但し書き（「断定はできないが」）が混ざりやすい。「矛盾とは言えない部分も
 * あるが、ここは食い違っている」を落とすと、**本物の指摘が消える**——
 * 取りこぼすより、落としすぎるほうが怖い。
 *
 * `(?![かの])` は「矛盾している**か**は不明」を言い切りと読まないため。
 *
 * 「矛盾の可能性が高い」「乖離がある」は 2026-09-24 に足した。仕込みの
 * 正解（第4話「右足」・第5話「二週間」）がこの言い方で食い違いを
 * 言い切りながら、但し書きの保留で落ちていた。「矛盾**ではない**可能性が
 * 高い」は当たらない（「矛盾」の直後に「の」か「して」が要る）。
 */
/*
 * 2026-10-11：「矛盾する**確証**はない」「矛盾する**可能性**」（「が高い」の付かない
 * もの）を言い切りと読まないようにした。前は「矛盾する」の4字で言い切りと
 * みなし、否定の網へ届く前に通していた（Kimi の第1話47行「設定と矛盾する確証は
 * ない」、補足は「矛盾する可能性」だけ）。「矛盾する可能性が高い」は言い切りのまま。
 */
const AFFIRMATION_PATTERN =
  /(矛盾してい(る|ます|た)(?![かの])|矛盾する(?![かの]|確証|根拠|証拠|可能性(?!が高))|食い違ってい(る|ます|た)(?![かの])|矛盾の可能性が高|乖離(が|は)?(あ|見|生じ|し))/;

export function deniesContradiction(text: string): boolean {
  // 打ち消しの言葉が混ざっていても、どこかで言い切っていれば本物の指摘
  if (AFFIRMATION_PATTERN.test(text)) return false;
  return (
    DENIAL_PATTERN.test(text) ||
    SELF_CLEARED_PATTERN.test(text) ||
    HEDGED_DENIAL_PATTERN.test(text) ||
    UNSURE_DENIAL_PATTERN.test(text)
  );
}

/**
 * 設定の側が、実は設定を述べていないものを見分ける。
 *
 * **実データで返ってきた。**「設定情報なし」「本文からは読み取れない」を
 * `settingSays` に書いて指摘してくる。**照らし合わせる相手が無いのだから、
 * それは矛盾ではない。**
 *
 * 「不明」は 2026-09-24 に「設定は不明」「詳細は不明」の形と単独だけに
 * 絞った。「行方不明になった」「生死不明」は設定そのものである。
 *
 * 「言及なし」は 2026-10-12 に足した（さくら Kimi-K2.6 の口調の台、第3話37行
 * 「設定に切手の金額…についての言及なし。」が通っていた）。
 *
 * 「該当なし」は 2026-10-16 に足した（gemma4:e4b、作者の作品の写しの第7話で
 * 設定の欄が「（該当なし）」の指摘が3件通っていた。どれも設定と食い違わない地の文）。
 * 欄まるごとが「該当なし」のときだけ当てる——「該当」の語だけでは設定の中身にも出る。
 */
const NO_SETTING_PATTERN =
  /(設定(情報)?(は)?(が)?(特に)?(あり)?(記載)?(され)?(て)?(い)?(ない|ませ|なし)|記述(は)?(あり)?(ませ|ない)|見当たり?(ませ|ない)|読み取れ(ない|ませ)|(設定|記述|記載|情報|詳細|言及)(は|が)?(特に)?不明|^不明$|言及(は)?(され)?(て)?(い)?(ない|ませ)|言及(は)?(なし|無し)|^(特に)?(なし|無し|ありません)$|^該当(する)?(もの|設定|記述)?(は)?(なし|無し|ありません|しない|しません)$)/;

/**
 * 文と「〜が、」の区切り。設定を述べたあとに不在を言い添える形
 * （「左足首を骨折したとあるが、右足に関する記述はない」）を分けて見るため
 */
const SETTING_CLAUSE_BREAK = /[。．！!？?\n]|(?:が|けれど|けど|ものの)、/;
/** 本文の側を述べている区切り。設定の中身としては数えない */
const TEXT_SIDE_CLAUSE = /^本文(中)?(で|に)?(は|では)/;

/**
 * 設定の欄が「設定が無い」としか言っていないか。
 *
 * **2026-09-24 に、区切りごとに見るようにした**（縛りの洗い出し2番）。
 * 前は欄のどこかに不在の言い回しがあれば落としていたので、設定を正しく
 * 引いたうえで「第2話で左足首を骨折したと記述されている。**右足に関する
 * 言及はない**」と、食い違う側の不在を添えただけの答えが落ちていた。
 * 答え付きの台で、仕込みの正解（第4話「右足」・第5話「ほくろ」）が
 * この形で5回落ちている。**中身のある区切りが1つでもあれば、照らす相手は
 * ある**ので通す。
 */
export function lacksSetting(settingSays: string): boolean {
  const clauses = settingSays
    .split(SETTING_CLAUSE_BREAK)
    .map((clause) =>
      clause.trim().replace(/^[\s（(「『【、]+|[\s）)」』】、]+$/gu, "")
    )
    .filter((clause) => clause.length > 0);
  if (clauses.length === 0) return false;
  return clauses.every(
    (clause) =>
      NO_SETTING_PATTERN.test(clause) || TEXT_SIDE_CLAUSE.test(clause)
  );
}

/**
 * 分類を1つに決める。
 *
 * **選択肢をそのまま写して返してくる**（`"人物|状態|時系列"`）。
 * 実データで3件すべてがこの形になり、**正しい指摘を全部捨てていた**。
 * プロンプトでも直したが、モデルは指示を無視するので両方で受ける。
 */
export function normalizeCategory(
  raw: string
): ContradictionCategory | undefined {
  const trimmed = raw.trim();
  if (CATEGORY_SET.has(trimmed)) return trimmed as ContradictionCategory;

  // 「人物|状態」「人物：一人称、口調…」のような形から、先頭の分類を拾う
  for (const candidate of CONTRADICTION_CATEGORIES) {
    if (trimmed.startsWith(candidate)) return candidate;
  }
  for (const candidate of CONTRADICTION_CATEGORIES) {
    if (trimmed.includes(candidate)) return candidate;
  }
  return undefined;
}

const LEVELS = new Set(["high", "medium", "low"]);
const CATEGORY_SET = new Set<string>(CONTRADICTION_CATEGORIES);

/**
 * 構造化出力でも前後に説明やコードフェンスが付くモデルがあるため、
 * 生のJSON、コードフェンス除去、最外の波括弧抽出の順で解析する。
 */
export function parseContradictionResult(
  text: string
): { contradictions: unknown[] } | null {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    extractBraces(text),
  ];

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (isRecord(parsed) && Array.isArray(parsed.contradictions)) {
        return { contradictions: parsed.contradictions };
      }
    } catch {
      // 次の候補を試す
    }
  }
  return null;
}

/** 引用の外側に付いた括弧・引用符（中身を照らすときは外す） */
const OUTER_QUOTES = /^[「『"“]+|[」』"”]+$/gu;

/**
 * 申告の行番号を、引用が実際にある行へ直す（設計書6.10.5、2026-10-10）。
 *
 * **AIは引用を正しく取っても、行番号を言い間違える。** 実測（gemma4:26b、
 * いじめられっ子の写しの第2話）で、36行目の台詞を正しく指摘しながら 28 と
 * 申告した。検証の段（P-12b）は申告の行の前後6行しか見せないので、引用の
 * 無い範囲を見た検証AIが「引用が本文と違う」で本物の指摘を取り下げていた。
 * 画面で指摘から本文へ飛ぶ位置もずれる。
 *
 * 申告の行が引用を含むならそのまま。含まなければ、引用を含む行のうち申告に
 * 最も近い行へ直す（同じ距離なら前の行）。**どの1行にも収まらない引用
 * （行をまたぐ）は申告のまま残す**——どこへ動かすのが正しいか決められない。
 * 番号の振り方は `withLineNumbers` と同じ（まとめたチャンクでも通し番号）。
 *
 * 探し方は誤字脱字・逸脱検知と同じ部品（`lineHoldingQuote`）に寄せてある
 * （0.101.3）。片方だけ直されて食い違うのを避けるため。
 */
function lineHoldingExcerpt(excerpt: string, chunk: Chunk, line: number): number {
  return lineHoldingQuote(chunk.text, excerpt, line, chunk.startLine + 1);
}

/**
 * 引用が本文にあれば、本文に実在する形の引用を返す。無ければ undefined。
 *
 * まず書かれたまま照らし、無ければ**外側の括弧を外して**照らす
 * （2026-09-25）。AIは台詞の途中だけを「」で包んで返すことがある——
 * 本文が「依頼料がかかるだろうが。俺はオカネが…」のとき、
 * 「俺はオカネが減るのは大嫌いなんだよ」と包むと、開き括弧の位置が本文と
 * 合わない。実測（gemma4:26b）で、口調の正しい指摘が2件ともこの形で
 * 落ちていた。**外すのは外側だけ**で、中身は本文に逐語で無ければ落とす。
 * 外して通したときは、外した形を引用として持つ（画面で本文の位置を
 * 探すのに使うので、本文に無い形のまま残さない）。
 */
function excerptInChunk(
  excerpt: string,
  normalizedChunk: string
): string | undefined {
  if (normalizedChunk.includes(normalizeForComparison(excerpt))) return excerpt;
  const inner = excerpt.trim().replace(OUTER_QUOTES, "").trim();
  if (!inner || inner === excerpt.trim()) return undefined;
  return normalizedChunk.includes(normalizeForComparison(inner)) ? inner : undefined;
}

export function validateContradictions(
  raw: unknown,
  chunk: Chunk
): {
  accepted: AcceptedContradiction[];
  rejected: RejectedContradiction[];
} {
  const accepted: AcceptedContradiction[] = [];
  const rejected: RejectedContradiction[] = [];

  const list = isRecord(raw) && Array.isArray(raw.contradictions)
    ? raw.contradictions
    : [];

  const normalizedChunk = normalizeForComparison(chunk.text);
  const lineCount = chunk.text.split("\n").length;
  const firstLine = chunk.startLine + 1;
  const lastLine = chunk.startLine + lineCount;

  for (const item of list) {
    if (!isRecord(item)) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }

    // **バイトの札（`<0xE3><0x80><0x80>`）は字へ戻してから持つ**（2026-09-26 の比べ）。
    // 照合（`normalizeForComparison`）は札を落として比べるので通るが、戻さないと
    // 作者の画面に札のまま出る（gemma4:31b が全角空白をこの形で書いた）
    const excerpt = decodeByteFallback(asString(item.excerpt));
    const settingSays = decodeByteFallback(asString(item.settingSays));
    const textSays = decodeByteFallback(asString(item.textSays));
    const category = normalizeCategory(asString(item.category));
    const line = typeof item.line === "number" ? Math.round(item.line) : NaN;

    if (!excerpt || !Number.isFinite(line)) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }
    if (!category) {
      rejected.push({ raw: item, reason: "unknown_category" });
      continue;
    }
    // **「これは矛盾ではありません」と書いてある指摘を通さない。**
    // 配列があると何か埋めようとするモデルがあり、実データで
    // 補足に「矛盾していません」と書いた指摘が返ってきた
    //
    // **設定の欄も見る**（2026-09-25）。gemma4:e4b が設定の欄に「この発言は
    // 設定と合致している」と書いた指摘を並べてきた。設定の欄は設定を述べる
    // 所で、そこで食い違いを否定しているなら指摘として成り立たない
    if (deniesContradiction(`${settingSays} ${textSays} ${asString(item.note)}`)) {
      rejected.push({ raw: item, reason: "self_denied" });
      continue;
    }
    // **設定の側が「設定が無い」と言っているものを通さない。**
    // 照らし合わせる相手が無いのだから、それは矛盾ではない
    if (lacksSetting(settingSays)) {
      rejected.push({ raw: item, reason: "no_setting" });
      continue;
    }
    // **口調の指示（1.8）を写しただけの欄を通さない。** 何が食い違ったのかを
    // 述べていない（`echoesInstruction`）
    if (echoesInstruction(settingSays) || echoesInstruction(textSays)) {
      rejected.push({ raw: item, reason: "instruction_echo" });
      continue;
    }
    // 設定と本文に同じことが書いてあれば、食い違っていない
    if (
      normalizeForComparison(settingSays) === normalizeForComparison(textSays)
    ) {
      rejected.push({ raw: item, reason: "not_different" });
      continue;
    }
    // **並べるものが片方しか無ければ、指摘として成り立たない。**
    // 「設定ではこう」だけでは、本文の何が問題なのか分からない
    if (!settingSays || !textSays) {
      rejected.push({ raw: item, reason: "empty_comparison" });
      continue;
    }
    if (line < firstLine || line > lastLine) {
      rejected.push({ raw: item, reason: "line_out_of_range" });
      continue;
    }
    // **引用が本文に実在するかを見る。** 材料側（設定やあらすじ）の文を
    // そのまま引いて「本文にこうある」と言うことがある
    const found = excerptInChunk(excerpt, normalizedChunk);
    if (found === undefined) {
      rejected.push({ raw: item, reason: "excerpt_not_found" });
      continue;
    }

    accepted.push({
      line: lineHoldingExcerpt(found, chunk, line),
      excerpt: found,
      category: category as ContradictionCategory,
      settingSays,
      textSays,
      note: decodeByteFallback(asString(item.note)),
      // 読めない値は low に寄せる。**強い指摘として扱わない**
      severity: level(item.severity),
      confidence: level(item.confidence),
      filePath: chunk.filePath,
      chunkHash: chunk.hash,
    });
  }

  return { accepted, rejected };
}

/**
 * 見せる順を決める。
 *
 * **確信度の高いものを上に。** 下のほうは読まれないので、
 * 迷っている指摘を上に置くと、確かな指摘が埋もれる。
 * 同じ確信度なら重さの順、それも同じなら本文の順に並べる。
 */
export function sortContradictions(
  items: AcceptedContradiction[]
): AcceptedContradiction[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return [...items].sort((left, right) => {
    if (left.confidence !== right.confidence) {
      return rank[left.confidence] - rank[right.confidence];
    }
    if (left.severity !== right.severity) {
      return rank[left.severity] - rank[right.severity];
    }
    if (left.filePath !== right.filePath) {
      return left.filePath.localeCompare(right.filePath);
    }
    return left.line - right.line;
  });
}

/**
 * 無視した指摘を覚えるための鍵。
 *
 * **本文の中身（チャンクのハッシュ）を含める。** 本文を書き直したら、
 * 同じ場所でも別の指摘になりうる。含めないと、直したあとの本当の矛盾まで
 * 黙って捨てることになる。
 */
export function contradictionKey(item: AcceptedContradiction): string {
  return [
    item.chunkHash,
    item.line,
    item.category,
    normalizeForComparison(item.excerpt),
  ].join("\u0000");
}

function level(raw: unknown): "high" | "medium" | "low" {
  const value = asString(raw);
  return LEVELS.has(value) ? (value as "high" | "medium" | "low") : "low";
}

function asString(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

/**
 * 「どの値が何話で分かるか」の索引（設計書6.10.5）。
 *
 * ## なぜ鍵を1か所に集めるか
 *
 * 以前は、書く側（`checkContradictions.ts` の索引作り）と読む側
 * （`knownAtFor`）が**それぞれ**テンプレートリテラルで鍵を組み立てていた。
 * 書く側は空白区切り、読む側はNUL区切りになっており、**読みは一度も
 * 当たっていなかった**——裏取りプロンプトの「この設定が分かる話」は
 * 常に「（不明）」だった（0.22.10で修正）。索引の形を1つの関数で作れば、
 * ずれること自体が起きない。
 *
 * ## 変化の記録に無い設定も載せる（2026-10-17）
 *
 * 変化の記録（`changes`）だけを索引にしていた頃は、**一人称・口調のように
 * 変化の記録に載らない設定**は、どう引いても「（不明）」だった。確かめの段の
 * 26b は、その「（不明）」を「まだ明かされていない」と読んで、作者の作品の
 * 写しの第10話「わたくし」（設定の一人称は「ボク」）を落とした。
 *
 * そこで、本体の値（`CHARACTER_AS_OF_FIELDS`）と一人称を**その人物が初めて
 * 出た話**で載せる。検出の段の材料（`contradictionMaterial.ts`）は、初出が
 * その話以前の人物しか載せないので、検出の段が見た設定は「初出の時点で
 * 分かっていたもの」として扱える。**変化の記録にある値は、その記録の話数が
 * 勝つ**（初出は話数の分からない値の補いにすぎない）。一人称の使い分けは
 * 自前の話数を持つので、そちらを使う。登場話の記録が無い人の、話数の分から
 * ない値は載せない（分からないものを「第何話」と言わない）。
 */
export interface KnownAtEntry {
  /** どの項目の値か（`role`・`firstPerson` など） */
  field: string;
  /** 前後の空白を除いた値 */
  value: string;
  /** その値が分かる話（昇順） */
  chapters: number[];
  /** 持ち主の名前と別名。指摘の文に名前が出ていれば、その人に絞る */
  owners: string[];
  /** 持ち主の登場話。名前が出ていなければ、その話に出ている人に絞る */
  appeared: number[];
}

export interface KnownAtIndex {
  readonly entries: readonly KnownAtEntry[];
}

/** 索引に載せる人物の形。製品の `Character` をそのまま渡せる */
export interface KnownAtPerson {
  name?: string;
  aliases?: readonly string[];
  appearedChapters?: readonly number[];
  firstPerson?: {
    default: string | null;
    variants: ReadonlyArray<{ form: string; chapters: readonly number[] }>;
  };
  changes: readonly RecordChangeLike[];
  // 本体の値（`CHARACTER_AS_OF_FIELDS`）。変化の記録に無ければ初出の話で載せる
  summary?: string | null;
  role?: string | null;
  personality?: string | null;
  speechStyle?: string | null;
  appearance?: string | null;
  gender?: string | null;
  affiliation?: string | null;
}

interface RecordChangeLike {
  field: string;
  value: string;
  chapters: readonly number[];
}

export function buildKnownAtIndex(
  people: ReadonlyArray<KnownAtPerson>
): KnownAtIndex {
  const entries: KnownAtEntry[] = [];
  for (const person of people) {
    const owners = [person.name ?? "", ...(person.aliases ?? [])]
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const appeared = sortedChapters(person.appearedChapters ?? []);
    const firstAppearance = appeared.length > 0 ? [appeared[0]] : [];
    const add = (field: string, value: string | null | undefined, chapters: readonly number[]): void => {
      const trimmed = (value ?? "").trim();
      const at = sortedChapters(chapters);
      if (!trimmed || at.length === 0) return;
      entries.push({ field, value: trimmed, chapters: at, owners, appeared });
    };
    const recorded = new Set<string>();
    for (const change of person.changes) {
      add(change.field, change.value, change.chapters);
      recorded.add(entryKey(change.field, change.value));
    }
    // 本体の値は、変化の記録に同じ値が無いときだけ初出の話で補う。
    // 項目の並びは材料の組み立てと同じもの（`CHARACTER_AS_OF_FIELDS`）を見るので、項目名で読む
    const fields = person as unknown as Record<string, unknown>;
    for (const field of CHARACTER_AS_OF_FIELDS) {
      const value = fields[field];
      if (typeof value !== "string") continue;
      if (recorded.has(entryKey(field, value))) continue;
      add(field, value, firstAppearance);
    }
    const firstPerson = person.firstPerson;
    if (firstPerson) {
      add("firstPerson", firstPerson.default, firstAppearance);
      for (const variant of firstPerson.variants) {
        const own = variant.chapters.filter(Number.isFinite);
        add("firstPerson", variant.form, own.length > 0 ? own : firstAppearance);
      }
    }
  }
  return { entries };
}

/** 索引を引く（項目と値の両方が分かるとき）。見つからなければ空配列 */
export function lookupKnownAt(
  index: KnownAtIndex,
  field: string,
  value: string
): number[] {
  const key = entryKey(field, value);
  return index.entries.find((entry) => entryKey(entry.field, entry.value) === key)?.chapters ?? [];
}

/**
 * 項目名が分からないとき、値だけで索引を引く（値が丸ごと一致するときだけ）。
 *
 * 以前は "role" と決め打ちで引いており、外見や状態の指摘では
 * **当たりようがなかった**。
 */
export function lookupKnownAtValue(
  index: KnownAtIndex,
  value: string
): number[] {
  const wanted = value.trim();
  return index.entries.find((entry) => entry.value === wanted)?.chapters ?? [];
}

/** 指摘がどの話のものか（人物を絞るのに使う） */
export interface KnownAtScope {
  chapterStart: number | null;
  chapterEnd: number | null;
  /** 名前を探すのに一緒に見る文（引用・本文の欄） */
  alsoText?: string;
}

/**
 * 検出の段が書いた `settingSays` のまま、その設定が何話で分かるかを引く
 * （2026-10-17）。見つからなければ空配列。
 *
 * 検出の段は値をそのまま写さず、「一人称: ボク」「一人称は「ボク」である。」
 * 「第2話にて「左の足首を折った」と記述されている。」のような文で書く。
 * 値の丸ごと一致（`lookupKnownAtValue`）では、実データではほぼ当たらなかった。
 *
 * 1. 文から候補を切り出す——全体・最初の「:」の後ろ・かぎ括弧の中
 * 2. まず候補と値の**丸ごと一致**で探す（1〜3字の値はこれでしか引かない。
 *    「俺」を含むだけの文に当たると、どの指摘にも話数が付いてしまう）
 * 3. 無ければ、4字以上の候補と値の**包含**（どちら向きでも）で探す
 * 4. 名前が文に出ている人がいればその人に、いなければその話に出ている人に絞る
 *    （「俺」を使う人が何人もいるとき、別の人の初出を言わないため）
 *
 * 見つかった値ごとに**いちばん早い話**を返す——確かめの段が知りたいのは
 * 「いつから分かっているか」で、何話で繰り返されたかではない。
 */
export function lookupSettingKnownAt(
  index: KnownAtIndex,
  settingSays: string,
  scope?: KnownAtScope
): number[] {
  const candidates = settingCandidates(settingSays, index);
  if (candidates.length === 0) return [];

  let matched = index.entries.filter((entry) =>
    candidates.includes(normalizeSettingValue(entry.value))
  );
  if (matched.length === 0) {
    const long = candidates.filter((item) => [...item].length >= MIN_CONTAIN_CHARS);
    matched = index.entries.filter((entry) => {
      const value = normalizeSettingValue(entry.value);
      const valueChars = [...value].length;
      return long.some(
        (item) =>
          value.includes(item) ||
          // 文のほうが値を含む向きは、値が文の大半を占めるときだけ。「冒険者ギルド」
          // （所属）が、世界観の「冒険者ギルドは報酬の4割を差し引く」に当たった
          // （写しの e4b、2026-10-17）——固有名詞を含むだけの別の設定である
          (valueChars >= MIN_CONTAIN_CHARS &&
            valueChars * 10 >= [...item].length * MIN_COVER_TENTHS &&
            item.includes(value))
      );
    });
  }
  if (matched.length === 0) return [];

  const haystack = `${settingSays}\n${scope?.alsoText ?? ""}`.replace(/\s+/g, "");
  const named = matched.filter((entry) =>
    entry.owners.some((owner) => {
      const name = owner.replace(/\s+/g, "");
      return [...name].length >= 2 && haystack.includes(name);
    })
  );
  if (named.length > 0) {
    matched = named;
  } else if (scope && scope.chapterStart !== null) {
    const start = scope.chapterStart;
    const end = scope.chapterEnd ?? start;
    const present = matched.filter((entry) =>
      entry.appeared.some((at) => at >= start && at <= end)
    );
    if (present.length > 0) matched = present;
  }

  return [...new Set(matched.map((entry) => entry.chapters[0]))].sort((a, b) => a - b);
}

/** 包含で引くときの、候補と値の最小の字数 */
const MIN_CONTAIN_CHARS = 4;

/** 文のほうが値を含むとき、値が文の何割以上を占めていれば同じ設定と見るか */
const MIN_COVER_TENTHS = 6;

function settingCandidates(settingSays: string, index: KnownAtIndex): string[] {
  const raw: string[] = [settingSays];
  const colon = settingSays.search(/[:：]/);
  if (colon >= 0) raw.push(settingSays.slice(colon + 1));
  // 「相沢春人は、左の足首を折った。」のように、持ち主の名前を頭に付けて書いてくる
  // （台B の e4b）。名前と助詞を外した残りも候補にする。名前の空白（「相沢 春人」）は
  // 書き手によって付いたり付かなかったりするので、空白を除いて比べる
  const compact = settingSays.trim().replace(/\s+/g, "");
  const owners = new Set(index.entries.flatMap((entry) => entry.owners));
  for (const owner of owners) {
    const name = owner.replace(/\s+/g, "");
    if ([...name].length < 2 || !compact.startsWith(name)) continue;
    const rest = compact.slice(name.length).replace(/^[はのがも][、，,]?/, "");
    if (rest !== compact.slice(name.length)) raw.push(rest);
  }
  for (const match of settingSays.matchAll(/[「『"“]([^「」『』"“”]+)[」』"”]/g)) {
    raw.push(match[1]);
  }
  const out: string[] = [];
  for (const item of raw) {
    const normalized = normalizeSettingValue(item);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/** 比べる前に、前後の空白・かぎ括弧・文末の句点を落とす */
function normalizeSettingValue(value: string): string {
  return value
    .trim()
    .replace(/^[「『"“]+/, "")
    .replace(/[」』"”]+$/, "")
    .replace(/[。．.、，,\s]+$/u, "")
    .trim();
}

function sortedChapters(chapters: readonly number[]): number[] {
  return [...new Set(chapters.filter(Number.isFinite))].sort((a, b) => a - b);
}

/**
 * 区切りは項目名にも値にも現れないNULにする（`characterUnify.ts` と同じ理由。
 * エスケープで書く——生のまま置くとgit/grepがバイナリ扱いし、差分も検索も効かない）。
 */
function entryKey(field: string, value: string): string {
  return `${field}\u0000${value.trim()}`;
}
