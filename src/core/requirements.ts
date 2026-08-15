/**
 * 「初期状態から何を足せば使えるようになるか」の一覧。
 *
 * ## なぜ一覧にするか
 *
 * この拡張機能を入れただけでは、AIを使う機能は動かない。足りないものは
 * Ollama本体・会話モデル・埋め込みモデル・Git・GitHub CLIと複数あり、
 * どれが欠けても作者からは「AIが動かない」としか見えない。
 * **何が要って、何のために要るのかを1か所に書く。**
 *
 * ## 必須と任意を分ける
 *
 * 全部を必須にすると、クラウドAIだけ使う作者にも十数GBの取得を強いる。
 * 逆に全部を任意にすると、何から始めればよいか分からない。
 * **「これが無いと何ができないか」を項目ごとに書く。**
 *
 * VS Code APIに依存しない（判定の材料は呼び出し側が渡す）。
 */

export type RequirementId =
  | "ollama"
  | "chatModel"
  | "embeddingModel"
  | "git"
  | "gh";

export type RequirementLevel =
  /** 無いとAI機能がまったく使えない */
  | "必須"
  /** 無くても使えるが、できないことがある */
  | "任意";

export interface Requirement {
  id: RequirementId;
  label: string;
  /** 何のために要るのか。作者が入れるかどうかを判断する材料 */
  purpose: string;
  /** 無いと何ができないか */
  withoutIt: string;
  level: RequirementLevel;
  /** 取得の目安。作者が待ち時間と容量を見積もれるように */
  size?: string;
  /** winget のパッケージID。モデルは winget では入らないので持たない */
  wingetId?: string;
}

/** 最初に薦める会話モデル。作者の環境（8B・131072文脈）で実績がある */
export const RECOMMENDED_CHAT_MODEL = "gemma4:e4b";
/** 埋め込みモデル。日本語を含む多言語向け */
export const RECOMMENDED_EMBEDDING_MODEL = "bge-m3";

export const REQUIREMENTS: Requirement[] = [
  {
    id: "ollama",
    label: "Ollama（AIの実行環境）",
    purpose:
      "自分のパソコンの中でAIを動かします。**無料で、原稿を外部へ送りません。**",
    withoutIt:
      "AIを使う機能は、Claude・ChatGPT・GeminiのAPIキーを登録しないと使えません（こちらは従量課金です）。",
    level: "必須",
    size: "約1GB",
    wingetId: "Ollama.Ollama",
  },
  {
    id: "chatModel",
    label: `会話モデル（${RECOMMENDED_CHAT_MODEL}）`,
    purpose:
      "設定資料の抽出、あらすじ・紹介文の生成、誤字脱字の検知、AIへの相談に使います。",
    withoutIt: "Ollamaは動いてもAIの機能が何も使えません。",
    level: "必須",
    size: "約9.6GB",
  },
  {
    id: "embeddingModel",
    label: `埋め込みモデル（${RECOMMENDED_EMBEDDING_MODEL}）`,
    purpose:
      "相談のときに、**質問に近い場面を作品全体から探す**ために使います（意味検索）。" +
      "「妬ましさを感じる場面は？」のような言い換えでも見つけられるようになります。",
    withoutIt:
      "相談は語句一致で場面を探します。**これでも十分に使えます**（実データで6問中4問。入れると5問）。" +
      "非力なパソコンでは入れないほうが軽く動きます。",
    level: "任意",
    size: "約1.2GB",
  },
  {
    id: "git",
    label: "Git",
    purpose:
      "複数のパソコンで同じ作品を書くために使います。過去の版へ戻すこともできます。",
    withoutIt: "GitHubでの同期と、過去の版への復元ができません。",
    level: "任意",
    size: "約60MB",
    wingetId: "Git.Git",
  },
  {
    id: "gh",
    label: "GitHub CLI",
    purpose:
      "**非公開の**リポジトリをGitHubへ作ったり取り寄せたりするために使います。",
    withoutIt:
      "GitHubの同期は使えますが、リポジトリの新規作成と非公開リポジトリの取り寄せは手作業になります。",
    level: "任意",
    size: "約12MB",
    wingetId: "GitHub.cli",
  },
];

export interface RequirementState {
  id: RequirementId;
  /** 入っているか */
  present: boolean;
  /** 入っていない理由や補足（版が古いなど） */
  note?: string;
}

export interface SetupPlanEntry {
  requirement: Requirement;
  present: boolean;
  note?: string;
}

export interface SetupPlan {
  entries: SetupPlanEntry[];
  /** 足りない必須のもの */
  missingRequired: SetupPlanEntry[];
  /** 足りない任意のもの */
  missingOptional: SetupPlanEntry[];
  /** すべて揃っているか（任意も含めて） */
  complete: boolean;
}

/**
 * 状態から、何を足せばよいかを組み立てる。
 *
 * **会話モデルは、Ollamaが入っていないときは「足りない」と数えない。**
 * Ollamaが無ければモデルは取得しようがなく、2件並べて見せると
 * 作者はどちらから手を付けるべきか分からなくなる。
 */
export function buildSetupPlan(states: readonly RequirementState[]): SetupPlan {
  const byId = new Map(states.map((state) => [state.id, state]));
  const ollamaPresent = byId.get("ollama")?.present ?? false;

  const entries: SetupPlanEntry[] = REQUIREMENTS.map((requirement) => {
    const state = byId.get(requirement.id);
    return {
      requirement,
      present: state?.present ?? false,
      note: state?.note,
    };
  });

  const needsOllamaFirst = (id: RequirementId): boolean =>
    (id === "chatModel" || id === "embeddingModel") && !ollamaPresent;

  const missing = entries.filter(
    (entry) => !entry.present && !needsOllamaFirst(entry.requirement.id)
  );

  return {
    entries,
    missingRequired: missing.filter((e) => e.requirement.level === "必須"),
    missingOptional: missing.filter((e) => e.requirement.level === "任意"),
    complete: entries.every((entry) => entry.present),
  };
}

/**
 * 作者に見せる一覧。
 *
 * **「入っている・いない」だけでなく、何のために要るのかを併記する。**
 * 名前だけ並べても、入れるかどうかを判断できない。
 */
export function describeSetupPlan(plan: SetupPlan): string {
  const lines: string[] = [];
  for (const entry of plan.entries) {
    const mark = entry.present ? "済" : entry.requirement.level === "必須" ? "要" : "任意";
    const size = entry.requirement.size ? `／${entry.requirement.size}` : "";
    lines.push(`[${mark}] ${entry.requirement.label}${entry.present ? "" : size}`);
    lines.push(`     ${entry.requirement.purpose}`);
    if (!entry.present) {
      lines.push(`     入れない場合：${entry.requirement.withoutIt}`);
    }
    if (entry.note) lines.push(`     ${entry.note}`);
  }
  return lines.join("\n");
}

/** まとめて入れるときの合計の目安。作者が待ち時間を見積もれるように */
export function totalSizeLabel(entries: readonly SetupPlanEntry[]): string {
  const sizes = entries
    .map((entry) => entry.requirement.size)
    .filter((size): size is string => Boolean(size));
  if (sizes.length === 0) return "";
  return sizes.join(" ＋ ");
}
