import { capabilityProfile, useSmallModelTypoPrompt } from "../../ai/capability";
import { inferTier, type CapabilityTier } from "../../ai/types";
import { ollamaParameterSize } from "./ollama";
import type { RunnerKind } from "./run";

/**
 * MCP の「モデルの大きさに合わせた頼み方」を、**製品と同じ判定で決める**
 * （作者の裁定 2026-10-10「製品と同じ判定にする」。設計書6.87.12）。
 *
 * ## なぜ要るか
 *
 * 製品は送り先のモデルの大きさで頼み方を変える（`ai/capability.ts`）。
 * MCP はこれまで「相手のモデルの素性を知らない」として、外の AI が指定しない
 * ときは固定の既定で組んでいた——誤字脱字・逸脱は大きいモデル向け、矛盾検知は
 * 「観点を絞る＋ゆるめる」。**矛盾検知の組み合わせは製品のどの大きさとも
 * 一致しない**うえ、手元の Ollama で回すときは**モデル名が分かっている**のに
 * 使っていなかった。2026-10-05・10-08 の e4b の誤字脱字は、製品が e4b へ
 * 送らない 1.2 の文で測られていた。
 *
 * ## 決め方
 *
 * | 道 | 決め方 |
 * |---|---|
 * | 外の AI が指定した | **指定に従う**（頼み方を振って比べる道を残す） |
 * | `runner: ollama`（モデル名あり） | `/api/show` の申告の大きさを製品の関数へそのまま渡す。取れなければ製品と同じく「大きさ不明の手元のAI」として判定する |
 * | `novel.prompt`・`runner: claude`・`sampling` | 大きさが取れない。**製品が大きいモデル（クラウドの主力）へ送る形**にする |
 *
 * 判定そのものは写さない（境目を引き直した日に MCP だけ古い線で回り続けるため）。
 * ここにあるのは「製品の判定の結果を、MCP の options の名前へ言い換える」ことだけ。
 */

/** 大きさで頼み方が変わる機能（`novel.run` の feature 名） */
export type SizeDependentFeature = "typo" | "deviation" | "contradiction";

/** 製品の判定の結果を、MCP の options の名前で持ったもの */
export interface SizeChoice {
  /** 誤字脱字：small＝小さいモデル向けの 1.1 の文 */
  readonly typoModelSize: "small" | "large";
  /** 逸脱：small＝「逸脱」だけ */
  readonly deviationModelSize: "small" | "large";
  /** 矛盾検知の観点：light＝3つ、all＝7つ */
  readonly categories: "light" | "all";
  /** 矛盾検知の抑制：strict＝確信の持てないものは挙げさせない */
  readonly suppression: "strict" | "loose";
}

/**
 * 製品の判定を、そのまま MCP の名前へ言い換える。
 *
 * **providerId は手元の Ollama に限る**（MCP の本文を送る道は Ollama だけ）。
 */
export function productSizeChoice(parameterSize: string | null): SizeChoice {
  const tier = inferTier(parameterSize, "ollama");
  // 大きさが取れなかったときは undefined で渡す——製品も「取れない」を
  // その形で判定へ渡し、手元のAIを抑える側へ倒す（`capability.ts` の suppressUncertain）
  const input = { tier, providerId: "ollama" as const, parameterSize };
  const profile = capabilityProfile(input);
  return {
    typoModelSize: useSmallModelTypoPrompt(input) ? "small" : "large",
    deviationModelSize: profile.narrowDeviationTypes ? "small" : "large",
    categories: profile.narrowContradictionCategories ? "light" : "all",
    suppression: profile.suppressUncertainContradictions ? "strict" : "loose",
  };
}

/**
 * 大きさが取れない道（`novel.prompt`・`claude`・`sampling`）の既定。
 *
 * **製品が大きいモデルへ送る形**（`capabilityProfile` の high・大きさ不明の
 * クラウド）と同じ。これらの道で答えを作るのは外の AI 自身か、それが借りる
 * クライアントのモデルで、ふつうはクラウドの大きいモデルである。
 * 写しが製品とずれていないことは `test/unit/mcp/mcpModelSizeDefault.test.ts` が見張る。
 */
export const UNKNOWN_MODEL_SIZE_CHOICE: SizeChoice = {
  typoModelSize: "large",
  deviationModelSize: "large",
  categories: "all",
  suppression: "loose",
};

/** どう決めたか。`novel.run` の結果に出す（記録から製品の条件かどうかを読めるように） */
export interface ModelSizeDecision {
  /**
   * - `product`……手元の Ollama の申告の大きさから、製品と同じ判定で決めた
   * - `unknownModel`……大きさの取れない道。製品の大きいモデル向けの形にした
   */
  readonly source: "product" | "unknownModel";
  /** 申告の大きさ。取れなかった・問い合わせていなければ null */
  readonly parameterSize: string | null;
  /** 製品のティア（`product` のときだけ） */
  readonly tier?: CapabilityTier;
  /** 判定で決めた値（指定があった項目も含めた、判定の結果そのもの） */
  readonly product: SizeChoice;
  /** 外の AI が指定したので判定より優先した項目 */
  readonly given: readonly string[];
  /** 1行の説明 */
  readonly note: string;
}

export interface ModelSizeRunnerInput {
  runner: RunnerKind;
  endpoint?: string;
  model?: string;
}

/**
 * `novel.run` の頼み方を決める。
 *
 * **指定がすべて揃っていれば問い合わせない**（余計な往復をしない）。
 * `given` には、外の AI が指定した options の名前を渡す。
 */
export async function decideModelSize(
  input: ModelSizeRunnerInput,
  given: readonly string[],
  needed: readonly string[]
): Promise<{ choice: SizeChoice; decision: ModelSizeDecision }> {
  const givenNames = needed.filter((name) => given.includes(name));
  const allGiven = givenNames.length === needed.length;

  if (input.runner !== "ollama" || !input.model || allGiven) {
    const reason =
      input.runner !== "ollama"
        ? `runner: ${input.runner} ではモデルの大きさが分からないので、製品が大きいモデルへ送る形にしました`
        : allGiven
          ? "指定に従いました（モデルの大きさは問い合わせていません）"
          : "モデル名が無いので、製品が大きいモデルへ送る形にしました";
    return {
      choice: UNKNOWN_MODEL_SIZE_CHOICE,
      decision: {
        source: "unknownModel",
        parameterSize: null,
        product: UNKNOWN_MODEL_SIZE_CHOICE,
        given: givenNames,
        note: reason,
      },
    };
  }

  const parameterSize = await ollamaParameterSizeSafely(input.endpoint, input.model);
  const choice = productSizeChoice(parameterSize);
  const tier = inferTier(parameterSize, "ollama");
  return {
    choice,
    decision: {
      source: "product",
      parameterSize,
      tier,
      product: choice,
      given: givenNames,
      note:
        parameterSize === null
          ? "モデルの大きさを取れなかったので、製品と同じく「大きさ不明の手元のAI」として決めました"
          : `申告の大きさ ${parameterSize} から、製品と同じ判定で決めました`,
    },
  };
}

/**
 * 大きさの問い合わせ。**失敗しても止めない**（取れなかったものとして判定する）。
 *
 * 単体テストが `./ollama` を差し替えてこの関数を持たせていないときも、
 * ここで受け止めて「取れなかった」に倒す。
 */
async function ollamaParameterSizeSafely(
  endpoint: string | undefined,
  model: string
): Promise<string | null> {
  try {
    return await ollamaParameterSize({ endpoint, model });
  } catch {
    return null;
  }
}

/** options の中で、外の AI が実際に値を渡した名前（空文字は渡していないものとみなす） */
export function givenOptionNames(
  options: Record<string, unknown>
): string[] {
  return Object.entries(options)
    .filter(([, value]) => {
      if (value === undefined) return false;
      if (typeof value === "string" && value.trim() === "") return false;
      return true;
    })
    .map(([name]) => name);
}
