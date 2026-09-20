import { z } from "zod";
import {
  capabilityProfile,
  describeCapability,
  describeContradictionCapabilityForAuthor,
  type CapabilityProfile,
} from "../../ai/capability";
import type { CapabilityTier, ProviderId } from "../../ai/types";
import { FOLDER_INPUT, McpToolError } from "./shared";

/**
 * 実行前に画面へ出る「断り」を、**走らせずに読む**（設計書6.87、0.72.0）。
 *
 * ## なぜ要るか
 *
 * 実機確認の手だては「ファイル → テスト → MCP → computer-use → 作者」の
 * 順で選ぶ（スキル `field-check`）。矛盾検知の確認画面に出る断り
 * ——「このモデルでは、確信が持てない箇所も挙げます」——は**モデルの
 * 大きさで切り替わる**のに、読むには画面を押すしかなかった。
 * いちばん新しい仕組みの出口なのに、機械で確かめる道が無い。
 *
 * ## AIは呼ばない。本文も送らない
 *
 * ここがするのは、**渡された申告（プロバイダ・モデル・大きさ・ティア）から
 * `ai/capability.ts` の判断を組み立てて、文字列にして返す**だけである。
 * 作品フォルダーは**許可の鍵としてだけ**要る（記録も作品ごとに残る）ので、
 * 原稿も設定資料も1文字も読まない。
 *
 * **判断は写さない。** 文言は `describeContradictionCapabilityForAuthor` と
 * `describeCapability` が持っているものをそのまま返す——ここで組み直すと、
 * 「画面と同じものを読んだ」ことにならない（写した側だけが古くなる）。
 */

/** いまのところ、地力で断りが変わるのはこの2つだけ（`ai/capability.ts` と同じ並び） */
const NOTICE_FEATURES = ["contradiction", "deviation"] as const;
type NoticeFeature = (typeof NOTICE_FEATURES)[number];

const PROVIDER_IDS = [
  "ollama",
  "lmstudio",
  "gemini",
  "claude",
  "openai",
  "sakura",
  "vscode-lm",
] as const satisfies readonly ProviderId[];

const TIERS = ["high", "standard", "light"] as const satisfies
  readonly CapabilityTier[];

export const NOVEL_NOTICE_INPUT = {
  ...FOLDER_INPUT,
  feature: z
    .enum(NOTICE_FEATURES)
    .describe(
      "どの機能か。contradiction＝矛盾検知／deviation＝プロット逸脱検知。" +
        "地力で断りが変わるのはこの2つだけです"
    ),
  providerId: z.enum(PROVIDER_IDS).describe("AIのプロバイダID"),
  model: z.string().describe("モデル名"),
  parameterSize: z
    .string()
    .optional()
    .describe(
      '"25.2B" のような申告。省略＝取れなかった扱い（手元は抑える側、クラウドはゆるめる側）'
    ),
  tier: z
    .enum(TIERS)
    .optional()
    .describe("モデルの地力。省略＝取れなかった扱い（ollama だけを軽量とみなす）"),
  /*
    **時間の目安（`estimateRunTimeText`）はまだ返せない**（0.72.0）。口だけ
    先に開けない——受け取って捨てる `count` は、呼んだ側からは「効かなかった」
    ではなく「届いていない」と同じに見える（`novel.material` の `options` で
    一度踏んだ穴）。理由は2つ。

    1. **`vscode` へ届く**……`estimateRunTimeText` 自体は使っていないが、
       引いている台帳（`core/modelTuning.ts`・`core/featureOutputTokens.ts`）
       がどちらも `vscode` を静的 import している（実装ルール7）
    2. **届いても、この束からは同梱の値しか見えない**……台帳の実体は
       拡張機能の保管庫のファイルで、置き場は VS Code から渡る
       （`setTuningStoreRoot`）。別プロセスのこの束では空のままなので、
       画面が「これまでの実測から」と出す場面で「同梱」と返る。
       **画面と違うものを返すなら、確かめたことにならない**
  */
};

export interface NoticeInput {
  folder: string;
  feature: NoticeFeature;
  providerId: ProviderId;
  model: string;
  parameterSize?: string;
  tier?: CapabilityTier;
}

export interface NoticeResult {
  /**
   * **作者向けの断り**（実行前の確認画面に並ぶもの）。
   *
   * 抑制の断りは矛盾検知にしか無いので、プロット逸脱では空になる
   * ——`describeContradictionCapabilityForAuthor` を呼ぶのが矛盾検知だけ
   * だからで、ここで「逸脱にも出す」と決め直さない。
   */
  forAuthor: string;
  /** **ログ向けの一言**（`describeCapability`。開始のログに出るもの） */
  forLog: string;
  /** どの切り替えが立っているか（`capabilityProfile` の中身そのまま） */
  profile: CapabilityProfile;
}

export function novelNotice(input: NoticeInput): NoticeResult {
  if (!input.folder?.trim()) {
    throw new McpToolError(
      "folder が要ります（許可を確かめる先が分からないため断りました）。"
    );
  }
  if (!input.model?.trim()) {
    throw new McpToolError(
      "model が要ります（断りはモデルごとに変わるため、名前が要ります）。"
    );
  }

  /*
    **製品と同じ形で渡す**（`features/checkContradictions.ts`・
    `checkDeviations.ts` がモデル情報から組んでいるものと同じ3つ）。
    `parameterSize` は「取れなかった」を `undefined` ではなく `null` で
    表す場面があるが、`capabilityProfile` はどちらも同じに扱う。
  */
  const capabilityInput = {
    tier: input.tier,
    providerId: input.providerId,
    parameterSize: input.parameterSize,
  };
  const profile = capabilityProfile(capabilityInput);

  return {
    // **矛盾検知のときだけ中身が入る。** 逸脱の確認画面はこの断りを出さない
    forAuthor:
      input.feature === "contradiction"
        ? describeContradictionCapabilityForAuthor(profile)
        : "",
    forLog: describeCapability(capabilityInput, profile, input.feature),
    profile,
  };
}
