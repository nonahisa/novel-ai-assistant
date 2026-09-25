import {
  NAME_ORIGINS,
  type NameCandidate,
  type NameOrigin,
} from "../prompts/nameSuggest";
import { originMismatchReason } from "./nameOriginLexicon";

/**
 * 名前の候補（P-29）の系統を、作品に合わせて揃える（設計書6.37.2）。
 *
 * **作者の裁定（2026-09-25 朝）**：系統の指定が無ければ、作品の世界観
 * （設定資料・既存の人物名）に合わせて揃える。
 *
 * それまでは「指定なし」のとき、系統の見立てをAIに任せ、揃っているかを
 * 確かめていなかった。測定（引継ぎ書8章「【測定】2026-09-25 深夜（2巡目）」）で、
 * gemma4:e4b は1回の10件に7系統を混ぜ、gemma4:26b は外国系の名前を英字
 * （Lukas・Friedrich）で返した。**頼むだけでは揃わない**（実装ルール3）。
 *
 * ## 何をコードが決めるか
 *
 * - **表記（漢字かカタカナか）はコードが決める。** 既にある人物名を数える
 *   だけで分かり、AIの見立てより確かである
 * - 系統が1つに決まるなら（漢字の作品は和風、世界観に「北欧」などと
 *   はっきり書いてある、人物名で決まらない現代・近代の話は和風）、
 *   **AIへは1つだけ渡す**
 * - **名前点検（P-29）もプロットモード（P-45）も、ここ1か所で決める。**
 *   片方の指示文にだけ見立てを書くと、同じ作品で2つの機能が違う系統を出す
 * - カタカナの作品で、どの国の響きかまでは数えても分からない。
 *   **カタカナで書く系統だけを並べてAIに1つ選ばせ**、返ってきた候補の
 *   系統が選んだものと揃っているかをコードで確かめて、外れたものを落とす
 * - 英字の名前は、AIが付けたひらがなの読みからカタカナに直す
 *   （読みが無ければ落とす）。**直したことは作者へ見せる**
 *
 *
 * ## カタカナの作品の系統は、作品ごとに覚える（作者の裁定、2026-09-25 昼）
 *
 * カタカナの作品では系統をAIに選ばせるので、**同じ作品でも回ごとに変わった**
 * （gemma4:e4b で、ギルドの作品がフランス → ドイツ）。最初に決まった系統
 * （AIが選んだもの、または作者が選んだもの）を作品の設定に覚え、次からは
 * それ1つで出す。変えるときは作者が系統を選び直す（選んだものを覚え直す）。
 * 覚える・読むのは `nameOriginStore.ts`、ここは**決め方だけ**を持つ。
 *
 * VS Code API に依存しない（MCP の束からも使う）。
 */

/** 名前の表記。漢字（ひらがなを含む）か、カタカナか */
export type NameScript = "kanji" | "katakana";

/** 系統をどう決めたか。AIへ渡す選択肢と、作者・AIへ見せる根拠 */
export interface NameOriginPlan {
  /** AIに選ばせる系統。1つに決まっていれば1件 */
  choices: readonly NameOrigin[];
  /** 名前の表記。決まらなければ undefined（AIが選んだ系統から決める） */
  script?: NameScript;
  /** 決めた根拠（「既にある人物名がカタカナ中心（カタカナ11・漢字4）」） */
  basis: string;
  /** 作者が系統を選んだか */
  chosen: boolean;
  /** この作品で覚えている系統を使ったか（`remembered` を渡して、それで決めた） */
  remembered?: boolean;
  /**
   * 系統を覚える作品か。**カタカナの作品で、コードが1つに決められない**
   * （AIに選ばせる）ときだけ true。漢字の作品・世界観に系統が書いてある作品は、
   * 毎回同じ決め方で同じ系統になるので覚えなくてよい
   */
  fixable?: boolean;
}

/** 覚えている系統を使ったときの根拠（画面とAIへの指示の両方に出る） */
export const REMEMBERED_ORIGIN_BASIS = "この作品で前に決まった系統";

/**
 * 設定ファイルに書かれた系統を読む。**知らない値は無かったことにする**
 * （作品の種類 `kind` と同じ扱い。新しい版で系統が増えたあと古い版で開いても、
 * 作品は開ける）。
 */
export function parseNameOrigin(raw: unknown): NameOrigin | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return (NAME_ORIGINS as readonly string[]).includes(value)
    ? (value as NameOrigin)
    : undefined;
}

/** 系統ごとの表記。朝鮮はどちらでも書かれるので決めない */
export function scriptOfOrigin(origin: NameOrigin | undefined): NameScript | undefined {
  if (origin === "和風" || origin === "中華") return "kanji";
  if (origin === "朝鮮" || origin === undefined) return undefined;
  return "katakana";
}

/** カタカナで書く系統（カタカナの作品で、AIに1つ選ばせるときの並び） */
const KATAKANA_ORIGINS = NAME_ORIGINS.filter(
  (origin) => scriptOfOrigin(origin) === "katakana"
);

/**
 * 世界観にはっきり書いてあれば、その系統に決める印。
 *
 * **「〜風」などの言い切りだけを見る。** 「日本」「皇帝」のような語は、
 * 異世界に転移した日本人の話や西洋風の帝国にも出るので印にしない。
 */
const ORIGIN_MARKERS: ReadonlyArray<readonly [NameOrigin, RegExp]> = [
  // 「現代日本」はここに置かない。「異世界に転移した現代日本の高校生」にも出るので、
  // 外国や架空の世界の語を確かめる現代ものの見立て（下の `MODERN_WORLD`）で見る
  ["和風", /和風/u],
  ["中華", /中華|古代中国/u],
  ["朝鮮", /朝鮮風|韓国風/u],
  ["英語圏", /英国風|イギリス風|アメリカ風/u],
  ["ドイツ", /ドイツ風/u],
  ["フランス", /フランス風/u],
  ["北欧", /北欧/u],
  ["イタリア・スペイン", /イタリア風|スペイン風/u],
  ["スラブ", /スラブ|ロシア風/u],
  ["アラビア", /アラビア風|アラブ風|中東風/u],
];

/** 系統までは決めないが、表記がカタカナだと分かる印 */
const KATAKANA_WORLD = /西洋|ヨーロッパ|欧州/u;

/**
 * 現代・近代の日本の話だと読める語（作者の裁定、2026-09-25 午前）。
 *
 * 日本語で書かれた現代ものは、外国や架空の世界と書かれていなければ日本の話である。
 * 作者の実例（現代ダンジョン。世界観は「現代。各地にダンジョンが出現した」）で、
 * 系統をAIに見立てさせると gemma4:e4b も 26b も**ドイツ**と見立てた。
 * 0.87.0 ではプロットモード（P-45）の指示文にだけ「和風と見立てて」と書いて
 * いたが、**頼むより、コードが決めて名前点検（P-29）と同じ決め方にする**。
 *
 * 「日本」は上の `ORIGIN_MARKERS` では印にしない（異世界に転移した日本人の話にも
 * 出る）が、ここでは下の `FOREIGN_OR_FICTIONAL_WORLD` が無いときだけ採るので使える。
 */
const MODERN_WORLD = /現代|近代|日本|東京|大阪|京都|明治|大正|昭和|平成|令和/u;

/**
 * 外国や架空の世界を示す語。**1つでもあれば、現代ものの見立てを使わない**
 * （「異世界に転移した現代日本の高校生」「現代のロンドン」「近代化を進める王国」）。
 *
 * 「帝国」は「大日本帝国」を除く（近代の日本の話である）。
 * 「ファンタジー」「ダンジョン」「魔法」は入れない——「現代ファンタジー」は
 * 現代の日本を舞台にした話を指す言い方で、作者の実例もダンジョンの出る現代ものである。
 */
const FOREIGN_OR_FICTIONAL_WORLD =
  /異世界|別世界|架空|王国|(?<!日本)帝国|王都|大陸|外国|海外|西洋|欧米|ヨーロッパ|欧州|アメリカ|イギリス|英国|ロンドン|パリ|フランス|ドイツ|イタリア|スペイン|ロシア|中国|中華|韓国|朝鮮|北欧|中東|アラブ|アラビア/u;

/**
 * 既にある名前1つの表記。数えないものは undefined。
 *
 * - **「の」を含む呼び名は数えない**（「指輪の男」「宰相の側近」）。
 *   役どころの呼び名で、作品の名前の系統を映さない
 * - **カタカナが2字以上あればカタカナ**（「勇者アジャン」「精霊姫ナイン」も、
 *   名前の部分はカタカナ）
 * - ひらがなだけ（「おっさん」「おばあさん」）は呼び名のことが多いので数えない
 */
function scriptOfExistingName(name: string): NameScript | undefined {
  const body = name.replace(/[\s・･＝=]/gu, "");
  if (!body || body.includes("の")) return undefined;
  const katakana = (body.match(/[\p{Script=Katakana}ー]/gu) ?? []).length;
  if (katakana >= 2) return "katakana";
  if (/\p{Script=Han}/u.test(body)) return "kanji";
  return undefined;
}

/**
 * 系統をどう決めるか。
 *
 * @param chosen 作者が選んだ系統（「指定なし」なら undefined）
 * @param remembered この作品で覚えている系統（`nameOriginStore.ts`）。
 *   **カタカナの作品で、コードが1つに決められないときだけ**使う。人物名や
 *   世界観で決まる作品では、覚えているものより作品の実際を採る
 * @param existingNames 既にある**人物**の名前（付け替える本人は除く）
 * @param setting 世界観・舞台の節（`plot.md`）
 */
export function planNameOrigin(input: {
  chosen?: NameOrigin;
  remembered?: NameOrigin;
  existingNames: readonly string[];
  setting: string;
}): NameOriginPlan {
  // 作者が選んだときも、覚える作品かどうかは作品の実際から決める
  const auto = planAutomatically(input.existingNames, input.setting);
  const fixable = auto.script === "katakana" && auto.choices.length > 1;

  if (input.chosen) {
    return {
      choices: [input.chosen],
      script: scriptOfOrigin(input.chosen),
      basis: "作者が選んだ系統",
      chosen: true,
      fixable,
    };
  }
  if (fixable && input.remembered && auto.choices.includes(input.remembered)) {
    return {
      choices: [input.remembered],
      script: "katakana",
      basis: REMEMBERED_ORIGIN_BASIS,
      chosen: false,
      remembered: true,
      fixable,
    };
  }
  return { ...auto, fixable };
}

/**
 * 系統を覚え直すなら、その系統（覚えなくてよければ undefined）。
 *
 * - 覚える作品（`fixable`）でなければ覚えない
 * - **作者が選んだカタカナの系統は、覚えている系統を置き換える**
 *   （作者の裁定「変えるときは作者が選び直す」）。和風・中華のような漢字の
 *   系統は、カタカナの作品で1人だけ別の出自にしたい回なので覚えない
 * - AIが選んだ系統は、**まだ何も覚えていないときだけ**、候補が1つでも残った
 *   ときに覚える（全部落ちた回の名乗りは当てにならない）
 *
 * @param current いま覚えている系統
 * @param fitted 揃えた系統（`fitNameCandidates` の `origin`）
 * @param kept 残った候補の数
 */
export function originToRemember(
  plan: NameOriginPlan,
  current: NameOrigin | undefined,
  fitted: NameOrigin | undefined,
  kept: number
): NameOrigin | undefined {
  if (!plan.fixable || plan.remembered) return undefined;
  const origin = plan.chosen ? plan.choices[0] : fitted;
  if (!origin || scriptOfOrigin(origin) !== "katakana" || origin === current) {
    return undefined;
  }
  if (!plan.chosen && (current !== undefined || kept === 0)) return undefined;
  return origin;
}

/** 人物名と世界観だけから決める（作者の選択・覚えている系統を見ない） */
function planAutomatically(
  existingNames: readonly string[],
  setting: string
): NameOriginPlan {
  const input = { existingNames, setting };
  let kanji = 0;
  let katakana = 0;
  for (const name of input.existingNames) {
    const script = scriptOfExistingName(name);
    if (script === "kanji") kanji++;
    if (script === "katakana") katakana++;
  }
  const byNames: NameScript | undefined =
    katakana > kanji ? "katakana" : kanji > katakana ? "kanji" : undefined;
  const namesBasis =
    byNames === "katakana"
      ? `既にある人物名がカタカナ中心（カタカナ${katakana}・漢字${kanji}）`
      : `既にある人物名が漢字中心（漢字${kanji}・カタカナ${katakana}）`;

  /*
    **世界観の印は、人物名の表記と食い違わないときだけ採る。** 書いてある
    名前のほうが作品の実際で、世界観の一言は昔の構想のことがある
  */
  const marked = ORIGIN_MARKERS.filter(([, pattern]) => pattern.test(input.setting));
  if (marked.length === 1) {
    const [origin, pattern] = marked[0];
    const script = scriptOfOrigin(origin);
    if (byNames === undefined || script === undefined || script === byNames) {
      const word = pattern.exec(input.setting)?.[0] ?? origin;
      return {
        choices: [origin],
        script: script ?? byNames,
        basis: `世界観に「${word}」とある`,
        chosen: false,
      };
    }
  }

  if (byNames === "kanji") {
    // 漢字の作品は和風に決める。中華・朝鮮の作品は、世界観にそう書くか作者が選ぶ
    return { choices: ["和風"], script: "kanji", basis: namesBasis, chosen: false };
  }
  if (byNames === "katakana") {
    return { choices: KATAKANA_ORIGINS, script: "katakana", basis: namesBasis, chosen: false };
  }
  if (KATAKANA_WORLD.test(input.setting)) {
    return {
      choices: KATAKANA_ORIGINS,
      script: "katakana",
      basis: "世界観が西洋風",
      chosen: false,
    };
  }
  /*
    **人物名で決まらないときだけ**、現代・近代の話を和風と見立てる。
    人物名がカタカナ中心なら、現代ものでもそちらを採る（書いてある名前のほうが
    作品の実際。上の世界観の印と同じ考え）
  */
  const modern = MODERN_WORLD.exec(input.setting);
  if (modern && !FOREIGN_OR_FICTIONAL_WORLD.test(input.setting)) {
    return {
      choices: ["和風"],
      script: "kanji",
      basis: `世界観に「${modern[0]}」とあり、外国や架空の世界と書かれていないので、日本の話と見立てました`,
      chosen: false,
    };
  }
  return { choices: NAME_ORIGINS, basis: "決める手がかりが無い", chosen: false };
}

/** 候補を揃えた結果。**落としたもの・直したものは理由つきで残す**（黙って減らさない） */
export interface FittedNameCandidates {
  kept: NameCandidate[];
  dropped: Array<{ candidate: NameCandidate; reason: string }>;
  /** 英字からカタカナに直した名前 */
  converted: Array<{ from: string; to: string }>;
  /** 揃えた系統。決まらなければ undefined */
  origin?: NameOrigin;
}

/** ひらがなをカタカナに（ゔ → ヴ も同じずらしで届く） */
export function toKatakana(text: string): string {
  return text.replace(/[ぁ-ゖ]/gu, (char) =>
    String.fromCharCode(char.charCodeAt(0) + 0x60)
  );
}

const LATIN = /\p{Script=Latin}/u;
const KATAKANA_ONLY = /^[\p{Script=Katakana}ー・･＝=\s]+$/u;

/**
 * 漢字のあいだに挟まる「ノ」「ヶ」「ケ」「ヵ」（一ノ瀬・霞ヶ浦・三ケ田・八ヵ岳）は
 * 日本の名前の一部なので、カタカナとは数えない。数えると漢字の作品の候補から
 * 落ちる（2026-09-25、26b の「一ノ瀬 莉子」が「カタカナを含む」で落ちた）
 */
const NAME_JOINT = /(?<=\p{Script=Han})[ノヶケヵ](?=\p{Script=Han})/gu;

function hasKatakanaOutsideJoints(name: string): boolean {
  return /\p{Script=Katakana}/u.test(name.replace(NAME_JOINT, ""));
}
const HIRAGANA_READING = /^[\p{Script=Hiragana}ー・\s]+$/u;

function isOrigin(value: string | undefined): value is NameOrigin {
  return (NAME_ORIGINS as readonly string[]).includes(value ?? "");
}

/**
 * 揃える系統を決める。1つに決まっていればそれ、AIが申告した系統が選択肢に
 * あればそれ、無ければ候補の系統の多数（同数なら先に出たほう）。
 */
function decideOrigin(
  candidates: readonly NameCandidate[],
  plan: NameOriginPlan,
  declared: string | undefined
): NameOrigin | undefined {
  if (plan.choices.length === 1) return plan.choices[0];
  if (isOrigin(declared) && plan.choices.includes(declared)) return declared;
  const counts = new Map<NameOrigin, number>();
  for (const candidate of candidates) {
    const origin = candidate.origin;
    if (isOrigin(origin) && plan.choices.includes(origin)) {
      counts.set(origin, (counts.get(origin) ?? 0) + 1);
    }
  }
  let best: NameOrigin | undefined;
  for (const [origin, count] of counts) {
    // Map は入れた順に回るので、同数なら先に出た系統が残る
    if (best === undefined || count > (counts.get(best) ?? 0)) best = origin;
  }
  return best;
}

/**
 * 返ってきた候補の系統と表記を揃える（実装ルール3「AIの出力を信用しない」）。
 *
 * 1. 英字の名前は、ひらがなの読みからカタカナに直す（漢字の作品では落とす）
 * 2. 系統の申告が揃える系統と違えば落とす。**申告が空なら系統では落とさない**
 *    （表記だけで確かめる。空を外れと数えると、欄を書かないモデルで全部落ちる）
 * 3. 表記が作品と違えば落とす（カタカナの作品に漢字、漢字の作品にカタカナ）
 * 4. 札は揃っていても、中身が英語の言葉か、ほかの系統でよく使う名前なら落とす
 *    （`nameOriginLexicon.ts` の短い表。表に無い名前は落とさない）
 *
 * @param declared AIが見立てた系統（答えの `origin`）
 */
export function fitNameCandidates(
  candidates: readonly NameCandidate[],
  plan: NameOriginPlan,
  declared?: string
): FittedNameCandidates {
  const origin = decideOrigin(candidates, plan, declared);
  const script = plan.script ?? scriptOfOrigin(origin);
  const result: FittedNameCandidates = { kept: [], dropped: [], converted: [], origin };
  const seen = new Set<string>();

  for (const candidate of candidates) {
    let name = candidate.name.trim();
    if (LATIN.test(name)) {
      if (script === "kanji") {
        result.dropped.push({ candidate, reason: "英字の名前は、漢字の名前の並びと揃いません" });
        continue;
      }
      const reading = candidate.reading.trim();
      if (!reading || !HIRAGANA_READING.test(reading)) {
        result.dropped.push({
          candidate,
          reason: "英字の名前で、ひらがなの読みも無いため、カタカナに直せません",
        });
        continue;
      }
      const converted = toKatakana(reading).replace(/\s+/gu, "・");
      result.converted.push({ from: name, to: converted });
      name = converted;
    }

    if (origin && candidate.origin && candidate.origin !== origin) {
      result.dropped.push({
        candidate,
        reason: `系統が揃っていません（${candidate.origin}。この作品は${origin}で揃えます）`,
      });
      continue;
    }
    if (script === "katakana" && !KATAKANA_ONLY.test(name)) {
      result.dropped.push({
        candidate,
        reason: "漢字・ひらがなを含む名前は、カタカナの名前の並びと揃いません",
      });
      continue;
    }
    if (script === "kanji" && hasKatakanaOutsideJoints(name)) {
      result.dropped.push({
        candidate,
        reason: "カタカナを含む名前は、漢字の名前の並びと揃いません",
      });
      continue;
    }
    // **札だけ揃えて、中身は別の系統**（3巡目、e4b の「ドイツ」の札のギヨーム・
    // エリオット、「北欧」の札のシングル・フレイム）。表で言い切れるものだけ落とす
    // （`nameOriginLexicon.ts`。表に無い名前は何も言わない）。カタカナの名前だけ見る
    if (KATAKANA_ONLY.test(name)) {
      const mismatch = originMismatchReason(name, origin);
      if (mismatch) {
        result.dropped.push({ candidate, reason: mismatch });
        continue;
      }
    }
    if (seen.has(name)) {
      result.dropped.push({
        candidate,
        reason: "英字をカタカナに直すと、ほかの候補と同じ名前になります",
      });
      continue;
    }
    seen.add(name);
    result.kept.push(name === candidate.name ? candidate : { ...candidate, name });
  }
  return result;
}
