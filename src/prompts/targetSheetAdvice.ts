import {
  describeReaderGap,
  READER_AXIS_ENDS,
  READER_AXIS_LABELS,
  READER_AXIS_ORDER,
  READER_TYPES,
  type ReaderAxis,
} from "../core/readerTarget";
import {
  ADVICE_ITEM_MAX,
  ADVICE_OVERALL_MAX,
  type AdviceDirection,
  type TargetSheetAdviceMaterial,
} from "../core/targetSheetAdvice";
import type { TargetSheetDirection } from "../core/targetSheet";

/**
 * P-46 ターゲットシートの助言（設計書6.108.4 の第3段）
 *
 * 作者の言葉（2026-09-21）：「作者が希望するターゲット層と作品を分析して
 * 一致やズレを判定し、アドバイスができるターゲットシート」。一致度・ずれ・
 * 向かう先（拡大／収束）は機械が出している。ここで AI に頼むのは、
 * **それを作者の狙いの理由に沿って、どちらへ寄せると狙いに近づくかの
 * 言葉にする**ことだけである。
 *
 * ## 何を頼み、何を頼まないか
 *
 * - **頼む**：総評1文・狙いに合っている所・軸ごとの寄せ方（1軸1件まで）
 * - **頼まない**：数字（一致度・点はシートの欄が持つ。材料に無い数字は
 *   コードが捨てる）／軸の向きの判断（材料に書いた組み合わせから選ばせ、
 *   逆はコードが捨てる）／本文の書き換え案／作品の良し悪し
 *
 * ## 狙いの理由が要の材料
 *
 * 「なぜその読者か」が無いと、助言は層の一般的な好みの言い直しになる
 * （設計書6.108.6 の⑤への答え）。**理由が書かれていないときは、無いと
 * はっきり書いて控えめに言わせる**——AI が理由を作って、作者の考えとして
 * 語るのを防ぐ。
 *
 * ## 層の説明は狙いの層だけ
 *
 * 11層を全部渡すと、どの層にも効く助言を混ぜて返す（P-38 の
 * `READER_TYPE_PROMPTS`、P-41 と同じ理由）。
 *
 * プロンプトを変更したら version を上げること。
 */
/**
 * 変更履歴（要点だけ。詳しくはプロンプト設計書 P-46）
 * - 1.0: 初版（配布前の測定だけ）
 * - 1.1: 向きの英語の値（up・down）を材料の文から外し、文に書かないよう指示。
 *   本文から読み取れなかった軸を材料で断り、寄せる先から外した（0.98.8。
 *   e4b が「「down」に寄せる」と書き、仮の点の軸へ寄せ方を書いたため）
 */
export const TARGET_SHEET_ADVICE_VERSION = "1.1";

/**
 * 揺らしすぎると、同じ材料で作り直すたびに寄せる向きの言い方が大きく
 * 変わる。向きはコードが縛るので、言い回しが少し動く程度に留める。
 */
export const TARGET_SHEET_ADVICE_TEMPERATURE = 0.3;

export const TARGET_SHEET_ADVICE_SYSTEM_PROMPT = `あなたは、小説の作者が「この読者に読んでもらいたい」と決めた狙いと、作品のいまの向き先を見比べて、どちらへ寄せると狙いに近づくかを短く伝える助言役です。

【絶対に守る原則】
1. **材料に書かれていることだけで答えること。** 数字は材料にあるものだけを使い、新しい数字を作らないこと。
2. **作品の良し悪しを言わないこと。** どの読者層にも上下はありません。
3. **本文の書き換え案（こう書き直す、という文例）を書かないこと。** 寄せる方向だけを言葉にしてください。
4. **一般論を書かないこと。** どの作品にも言えること（「読者を引き込む工夫を」など）ではなく、この材料の狙い・理由・点に即して書いてください。
5. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・マークダウンのコードフェンスを一切含めないこと。`;

/**
 * 答え方の指示（1行ずつ）。**そのまま答えとして返ってきたら捨てる**ので、
 * 検算（`parseTargetSheetAdvice`）にも同じ行を渡す。
 */
export const TARGET_SHEET_ADVICE_RULES: readonly string[] = [
  `overall には、狙いと作品のいまの向き先がどれだけ揃っているかを1文で書いてください（${ADVICE_OVERALL_MAX}字以内）。`,
  `keep には、狙いにすでに合っている所を書いてください（1件${ADVICE_ITEM_MAX}字以内）。どの点や引用が、なぜ狙いの層に効いているかを具体的に書き、合っている所があれば省かないでください。`,
  `advice には、狙いへ近づけるために寄せる軸を、1つの軸につき1件まで書いてください（1件${ADVICE_ITEM_MAX}字以内）。axis と direction は【寄せてよい軸と向き】にある組み合わせからだけ選んでください。`,
  "直す所が見当たらなければ、advice は空の配列にしてください。件数を埋めるために作らないでください。",
  "文の中に「」で引用するときは、材料にある言葉をそのまま写してください。",
  "文は日本語で書き、up・down や軸の英語名を文の中に書かないでください。向きは「上げる」「下げる」と書いてください。",
];

/** 理由があるとき・無いときの一言。**無いときに理由を作らせない** */
const REASON_GIVEN_RULE =
  "作者の理由に沿って書いてください。理由と結びつかない助言は書かないでください。";
const REASON_MISSING_RULE =
  "作者の理由は書かれていません。理由を推測して作者の考えとして書かないでください。狙いの層に効くことと点のずれだけを根拠に、控えめに書いてください。";

const DIRECTION_WORDS: Record<AdviceDirection, string> = {
  up: "上げる",
  down: "下げる",
};

/**
 * 軸を動かす向きの説明（「上げる（「読み尽くしている」の側へ）」）。
 *
 * **英語の値（up・down）はここに書かない。** 書くと、文の中に
 * 「「down」に寄せる」とそのまま写される（2026-10-04、e4b）。英語の値は
 * 【寄せてよい軸と向き】の欄の組み合わせにだけ置く。
 */
function directionPhrase(axis: ReaderAxis, direction: AdviceDirection): string {
  const ends = READER_AXIS_ENDS[axis];
  const toward = direction === "up" ? ends.high : ends.low;
  return `${DIRECTION_WORDS[direction]}（「${toward}」の側へ）`;
}

function aimBlock(material: TargetSheetAdviceMaterial): string {
  return material.aims
    .map((aim) => {
      const info = READER_TYPES[aim.type];
      return [
        `${info.label}（一致度 ${aim.affinity}）`,
        info.summary,
        `- この層に効くこと：${info.works}`,
        `- この層が離れるところ：${info.loses}`,
      ].join("\n");
    })
    .join("\n\n");
}

function scoresBlock(material: TargetSheetAdviceMaterial): string {
  const origin =
    material.source === "actual"
      ? "本文の実像（AIが冒頭とプロットから読んだもの。読み違えていることがあります）"
      : "書き方の判断（作者が9問に答えたもの）";
  const lines = READER_AXIS_ORDER.map((axis) => {
    const ends = READER_AXIS_ENDS[axis];
    // 読み取れなかった軸は、点が「どちらとも言えない」の置き場であることを言う
    const note = material.unmeasured.includes(axis)
      ? "　※本文から読み取れなかった軸です。点は仮に置いたもので、寄せる根拠にしないでください"
      : "";
    return `- ${READER_AXIS_LABELS[axis]}：${material.scores[axis]}／6（0＝${ends.low} ／ 6＝${ends.high}）${note}`;
  });
  return [
    `点の出どころ：${origin}`,
    ...lines,
    `いちばん近い層：${READER_TYPES[material.top].label}`,
  ].join("\n");
}

function gapBlock(material: TargetSheetAdviceMaterial): string {
  return material.aims
    .map((aim) => {
      const label = READER_TYPES[aim.type].label;
      if (aim.gaps.length === 0) {
        return `${label}：どの軸も、ずれは2点未満です（揃っています）。`;
      }
      const lines = aim.gaps.map((gap) => {
        const direction: AdviceDirection = gap.diff > 0 ? "down" : "up";
        // 読み取れなかった軸のずれは、仮の点とのずれなので寄せる先として示さない
        const tail = material.unmeasured.includes(gap.axis)
          ? "（本文から読み取れなかった軸なので、寄せる先には数えません）"
          : `寄せるなら ${directionPhrase(gap.axis, direction)}`;
        return (
          `- ${READER_AXIS_LABELS[gap.axis]}：狙いの中心は${gap.center}、いまは${gap.scored}。` +
          tail
        );
      });
      return [`${label}：`, ...lines].join("\n");
    })
    .join("\n");
}

function directionLine(
  heading: string,
  direction: TargetSheetDirection | undefined
): string[] {
  if (!direction) return [];
  const toward = READER_TYPES[direction.toward].label;
  if (!direction.move) {
    return [`${heading}（${toward}へ）：${direction.note ?? "動かす軸はありません。"}`];
  }
  return [
    `${heading}（${toward}へ）：${READER_AXIS_LABELS[direction.move.axis]}を ` +
      `${directionPhrase(direction.move.axis, direction.move.direction)}`,
    ...direction.move.examples.map((example) => `  - 例：${example}`),
  ];
}

function allowedBlock(material: TargetSheetAdviceMaterial): string {
  const lines = READER_AXIS_ORDER.flatMap((axis) =>
    (material.allowed[axis] ?? []).map(
      (direction) =>
        `- axis: ${axis} ／ direction: ${direction}（${READER_AXIS_LABELS[axis]}を${DIRECTION_WORDS[direction]}）`
    )
  );
  return lines.length > 0
    ? lines.join("\n")
    : "（ありません。寄せる先として数えられる軸が無いので、advice は空の配列にしてください）";
}

/**
 * 材料の文（AI へ送る本文）。**検算はこの文と照らす**ので、
 * 送った文と照らした文が食い違わないよう、ここで1回だけ組む。
 */
export function buildTargetSheetAdvicePrompt(
  material: TargetSheetAdviceMaterial
): string {
  const reason = material.reason.trim();
  const sections = [
    `【作者の狙い】（作者が「この読者に読んでもらいたい」と選んだ層）\n${aimBlock(material)}`,
    `【作者が挙げた理由】\n${reason || "（書かれていません）"}`,
    `【作品のいまの点】\n${scoresBlock(material)}`,
    `【狙いとのずれ】\n${gapBlock(material)}`,
  ];

  const directions = [
    ...directionLine("広げる（拡大）", material.expand),
    ...directionLine("絞る（収束）", material.converge),
  ];
  if (directions.length > 0) {
    // 拡大は狙いと逆の向きになる軸がある。参考として見せ、advice には使わせない
    sections.push(
      `【機械が出した向かう先】（参考。どちらへ進むかは作者が決めます。advice に書けるのは【寄せてよい軸と向き】だけです）\n${directions.join("\n")}`
    );
  }
  if (material.judgementGaps.length > 0) {
    sections.push(
      `【書き方の判断と本文の実像のずれ】\n${material.judgementGaps
        .map((gap) => `- ${describeReaderGap(gap)}`)
        .join("\n")}`
    );
  }
  if (material.evidence.length > 0) {
    sections.push(
      `【本文の実像の根拠】（本文からの引用）\n${material.evidence
        .map((item) => `- ${READER_AXIS_LABELS[item.axis]}：「${item.quote}」`)
        .join("\n")}`
    );
  }
  sections.push(`【寄せてよい軸と向き】\n${allowedBlock(material)}`);

  const rules = [
    ...TARGET_SHEET_ADVICE_RULES,
    reason ? REASON_GIVEN_RULE : REASON_MISSING_RULE,
  ];

  return `次の材料を読んで、作者の狙いへの寄せ方を短く伝えてください。

${sections.join("\n\n")}

【答え方】
${rules.map((rule) => `- ${rule}`).join("\n")}`;
}

/** 検算へ渡す指示の行（理由の有無で変わる1行も含める） */
export function targetSheetAdviceInstructions(): readonly string[] {
  return [...TARGET_SHEET_ADVICE_RULES, REASON_GIVEN_RULE, REASON_MISSING_RULE];
}

/**
 * 受け取る形。
 *
 * **欄の名前に「助言」「合っている所」を使わない**——日本語の欄名は、
 * そのまま中身として返ってくる（CLAUDE.md「繰り返し起きた失敗」3番）。
 */
export const TARGET_SHEET_ADVICE_SCHEMA = {
  type: "object",
  properties: {
    overall: { type: "string" },
    keep: { type: "array", items: { type: "string" } },
    advice: {
      type: "array",
      maxItems: READER_AXIS_ORDER.length,
      items: {
        type: "object",
        properties: {
          axis: { type: "string", enum: [...READER_AXIS_ORDER] },
          direction: { type: "string", enum: ["up", "down"] },
          text: { type: "string" },
        },
        required: ["axis", "direction", "text"],
      },
    },
  },
  required: ["overall", "keep", "advice"],
} as const;
