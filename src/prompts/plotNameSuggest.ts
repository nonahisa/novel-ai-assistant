import type { NameOriginPlan } from "../core/nameOriginFit";
import {
  NAME_ORIGINS,
  NAME_SUGGEST_HINTS,
  UNSET_MATERIAL,
  extractJson,
  readCandidates,
  scriptInstruction,
  type NameCandidate,
  type NameOrigin,
} from "./nameSuggest";

/**
 * P-45 プロットの役名だけの人物に、名前の候補をまとめて出す
 * （設計書6.4.8「名前の候補を出す」。作者の依頼、2026-09-25）。
 *
 * P-29（名前の点検の「候補を出す」）は**1人の名前を付け直す**ためのもので、
 * 相手は既に名前のある人物である。こちらは**まだ名前の無い何人か**に、
 * 1回の呼び出しでまとめて出す。材料も違う——P-29 は性別・役割・所属の欄、
 * こちらはプロットに書かれた説明の一文である。だから番号を分けた。
 *
 * ## P-29 と同じにしたところ
 *
 * - **響きの重なりはコードで落とす**（`screenNameCandidates`）。頼むだけでは守られない
 * - **系統はコードが先に決めて渡す**（`planNameOrigin`）。答えの頭で1つ名乗らせ、
 *   **全員を同じ系統で揃える**（人物ごとに系統が変わると、作品の世界が割れる）
 * - 表記の指示・指示語のなぞりの弾き方・候補の読み方は P-29 の部品をそのまま使う
 *
 * プロンプトを変更したら version を上げること。
 */
export const PLOT_NAME_SUGGEST_VERSION = "1.0";

/** 送るときの温度。P-29 と同じく広く出させる。当たり外れは作者が選ぶ */
export const PLOT_NAME_SUGGEST_TEMPERATURE = 0.8;

/**
 * 1人あたりの候補の数。P-29 の10件より少なくする——5人いれば50件を
 * 1回で書かせることになり、小さいモデルは後ろの人物ほど雑になる
 */
export const PLOT_NAME_SUGGEST_COUNT = 6;

/**
 * 指示語のなぞり（CLAUDE.md「繰り返し起きた失敗」3番）。P-29 の語に、
 * この指示文だけが使う語を足す。**名前として返ってきたら落とす**
 */
export const PLOT_NAME_SUGGEST_HINTS = [
  ...NAME_SUGGEST_HINTS,
  "役名",
  "説明",
  "番号",
  "人物",
] as const;

export const PLOT_NAME_SUGGEST_SYSTEM_PROMPT = `あなたは日本語の小説のプロットに出てくる登場人物に、名前の候補を出すアシスタントです。

【絶対に守る原則】
1. 出すのは名前の候補だけです。作品の内容・設定・展開について論評しないこと。
2. 既に使われている名前と、その別名を候補にしないこと。
3. 指定された系統だけで出すこと。複数の文化圏を混ぜないこと。人物ごとに系統を変えないこと。
4. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。`;

/** 名前を付ける1人 */
export interface PlotNamePerson {
  /** 答えと突き合わせる番号（"1" から） */
  id: string;
  /** 役名（「主人公」） */
  role: string;
  /** プロットに書かれた説明。無ければ空文字 */
  summary: string;
}

export interface PlotNameSuggestPromptInput {
  workTitle: string;
  /** 作品の世界観・舞台（`plot.md` の該当の節）。無ければ空文字 */
  setting: string;
  /** 既存の全名前と読み（「名前（よみ）」）。避けるべき響きの一覧 */
  existingNames: string[];
  people: PlotNamePerson[];
  /** 系統の決め方（`planNameOrigin`） */
  plan: NameOriginPlan;
}

/**
 * 系統を決める手がかりが無いときの、現代ものの見立て。
 *
 * 作者の実例（現代ダンジョンのインフラ担当。世界観は「現代。各地に
 * ダンジョンが出現した」、主人公は電気工事士の資格を目指す）で、
 * gemma4:e4b も gemma4:26b も**ドイツ**と見立て、全員にドイツの名前を出した
 * （2026-09-25）。日本語で書かれた現代ものは、国の名前が書かれていなければ
 * 日本の話である。
 */
export const MODERN_JAPAN_HINT =
  "世界観に外国や架空の世界と書かれていない現代・近代の話なら、日本の話として和風と見立ててください。";

function value(text: string): string {
  return text.trim() || UNSET_MATERIAL;
}

export function buildPlotNameSuggestPrompt(input: PlotNameSuggestPromptInput): string {
  const plan = input.plan;
  const only = plan.choices.length === 1 ? plan.choices[0] : undefined;
  const originInstruction = only
    ? `【系統】\n${only}` +
      (plan.chosen ? "" : `（この作品に合わせて決めました。根拠：${plan.basis}）`) +
      `\n全員をこの系統だけで出してください。他の文化圏の名前を混ぜないこと。\n` +
      `origin と、各候補の origin には「${only}」と書いてください。`
    : `【系統】\n指定なし（${plan.basis}）。作品の世界観に合う系統を、` +
      `${plan.choices.join("・")}のいずれか1つと見立て、` +
      `全員をその1つだけで出してください。複数を混ぜないこと。\n` +
      (plan.choices.includes("和風") ? `${MODERN_JAPAN_HINT}\n` : "") +
      `見立てた系統を先に origin に書き、各候補の origin にも同じものを書いてください。`;

  const people = input.people
    .map(
      (person) =>
        `id：${person.id}\n役名：${person.role}\n説明：${value(person.summary)}`
    )
    .join("\n\n");

  return `次の小説のプロットで、まだ名前が無く役名だけで書かれている登場人物に、名前の候補を出してください。1人につき${PLOT_NAME_SUGGEST_COUNT}件ずつです。

【作品タイトル】
${input.workTitle}

【世界観・舞台】
${value(input.setting)}

${originInstruction}

【既に使われている名前】（この響きと重なるものは出さないこと）
${input.existingNames.length > 0 ? input.existingNames.join("\n") : UNSET_MATERIAL}

【名前を付ける登場人物】
${people}

【守ること】
- people には上の登場人物を全員、同じ順に並べ、id には上の id をそのまま書いてください。
- 名前は、その人物の説明（年齢・立場・人柄・人間かどうか）に合うものにしてください。
- 上に挙げた既に使われている名前と、読んだときの響きが近いものを出さないこと。
  別の登場人物の候補どうしでも、同じ名前や響きの近い名前を出さないこと。
${scriptInstruction(plan)}
- reading はひらがなだけで書いてください。カタカナ・漢字を混ぜないこと。
- note には、その名前の由来か、その人物に合う理由を20字以内で1つだけ書いてください。
- 1人の${PLOT_NAME_SUGGEST_COUNT}件はすべて違う名前にしてください。
- 役名そのもの（上の「役名」の言葉）を名前として書かないこと。
- ${PLOT_NAME_SUGGEST_HINTS.map((hint) => `「${hint}」`).join(
    "・"
  )}のような、この指示文に出てくる語を
  そのまま答えに書かないこと。書くのは実際に使える名前だけです。`;
}

/**
 * 構造化出力のスキーマ。**すべて required**（任意にすると小さいモデルは落とす）。
 * 系統（`origin`）を人物より先に置き、全員をその系統へ寄せる（P-29 の 1.2 と同じ理由）。
 */
export function buildPlotNameSuggestSchema(choices: readonly NameOrigin[] = NAME_ORIGINS) {
  return {
    type: "object",
    properties: {
      origin: { type: "string", enum: [...choices] },
      people: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            candidates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  reading: { type: "string" },
                  origin: { type: "string", enum: [...choices] },
                  note: { type: "string" },
                },
                required: ["name", "reading", "origin", "note"],
                additionalProperties: false,
              },
            },
          },
          required: ["id", "candidates"],
          additionalProperties: false,
        },
      },
    },
    required: ["origin", "people"],
    additionalProperties: false,
  } as const;
}

export interface PlotNameSuggestAnswer {
  /** 見立てた系統。無ければ空文字 */
  origin: string;
  /** id ごとの候補。**渡した id に当たらないものは捨てる** */
  people: Map<string, NameCandidate[]>;
  /** 渡した id に当たらなかった答えの数（ログに残す） */
  unmatched: number;
  /** id が読めず、並びの位置で人物に当てた答えの数（ログに残す） */
  byOrder: number;
}

/**
 * 応答を読む。
 *
 * - id は数字だけを見て突き合わせる（"1"・1・"id：1" を同じと読む）。
 *   読めなければ並びの位置で当てる（下の本文）
 * - **指示語のなぞりは名前として採らない**（P-29 の `readCandidates` と、
 *   この指示文だけの語）。同じ名前は先勝ち
 * - 同じ id が2度来たら、先のものに足す
 */
export function parsePlotNameSuggestAnswer(
  text: string,
  ids: readonly string[]
): PlotNameSuggestAnswer {
  const empty: PlotNameSuggestAnswer = {
    origin: "",
    people: new Map(),
    unmatched: 0,
    byOrder: 0,
  };
  const source = extractJson(text);
  if (!source) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return empty;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.people)) return empty;

  const known = new Set(ids);
  const people = new Map<string, NameCandidate[]>();
  const add = (id: string, entries: readonly unknown[]): void => {
    const candidates = readCandidates(entries).filter(
      (candidate) =>
        !(PLOT_NAME_SUGGEST_HINTS as readonly string[]).includes(candidate.name)
    );
    const previous = people.get(id) ?? [];
    const seen = new Set(previous.map((candidate) => candidate.name));
    people.set(id, [
      ...previous,
      ...candidates.filter((candidate) => !seen.has(candidate.name)),
    ]);
  };

  /** id が読めなかった答え（並びの位置つき） */
  const orphans: Array<{ index: number; candidates: unknown[] }> = [];
  let unmatched = 0;
  parsed.people.forEach((entry, index) => {
    if (!isRecord(entry) || !Array.isArray(entry.candidates)) {
      unmatched++;
      return;
    }
    const id = String(entry.id ?? "").replace(/[^0-9０-９]/gu, "").normalize("NFKC");
    if (known.has(id)) add(id, entry.candidates);
    else orphans.push({ index, candidates: entry.candidates });
  });

  /*
    **id が読めない答えは、並びの位置で当てる。** gemma4:26b は id に
    「،」（アラビア文字の読点）を書いて返し、5人ぶんの候補が全部捨てられた
    （2026-09-25）。プロンプトで「同じ順に並べる」と頼んであるので、その位置の
    人物に当てる。**ただし、その人物が id で既に当たっていれば当てない**
    （順が崩れている答えを位置で読むと、別の人の候補を混ぜる）
  */
  let byOrder = 0;
  for (const orphan of orphans) {
    const id = ids[orphan.index];
    if (id === undefined || people.has(id)) {
      unmatched++;
      continue;
    }
    add(id, orphan.candidates);
    byOrder++;
  }

  const origin = typeof parsed.origin === "string" ? parsed.origin.trim() : "";
  return { origin, people, unmatched, byOrder };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
