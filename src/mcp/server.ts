import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_NAME, SERVER_VERSION } from "./version";
import { McpToolError, describeError } from "./tools/shared";
import { VALIDATE_NOTE } from "./tools/run";
import {
  recordExternalAccess,
  setExternalClientName,
} from "./tools/accessLog";
import { assertExternalAccessAllowed } from "./tools/permission";
import { setSamplingHost } from "./tools/sampling";
import { WORK_SCAN_INPUT, workScan } from "./tools/workScan";
import {
  OLLAMA_GENERATE_INPUT,
  ollamaGenerate,
  type OllamaGenerateInput,
} from "./tools/ollama";
import {
  PROOFREAD_PROMPT_INPUT,
  PROOFREAD_RUN_INPUT,
  PROOFREAD_VALIDATE_INPUT,
  proofreadPrompt,
  proofreadRun,
  proofreadValidate,
} from "./tools/proofread";
import {
  TYPO_PROMPT_INPUT,
  TYPO_RUN_INPUT,
  TYPO_VALIDATE_INPUT,
  typoPrompt,
  typoRun,
  typoValidate,
} from "./tools/typo";
import {
  CONTRADICTION_MATERIAL_INPUT,
  CONTRADICTION_PROMPT_INPUT,
  CONTRADICTION_RUN_INPUT,
  CONTRADICTION_VALIDATE_INPUT,
  contradictionMaterial,
  contradictionPrompt,
  contradictionRun,
  contradictionValidate,
} from "./tools/contradiction";
import {
  FORESHADOW_PROMPT_INPUT,
  FORESHADOW_RUN_INPUT,
  FORESHADOW_VALIDATE_INPUT,
  foreshadowPrompt,
  foreshadowRun,
  foreshadowValidate,
} from "./tools/foreshadow";
import {
  CHAT_PROMPT_INPUT,
  CHAT_RUN_INPUT,
  CHAT_VALIDATE_INPUT,
  chatPrompt,
  chatRun,
  chatValidate,
} from "./tools/chat";
import {
  SETTINGS_PROMPT_INPUT,
  SETTINGS_RUN_INPUT,
  SETTINGS_VALIDATE_INPUT,
  settingsPrompt,
  settingsRun,
  settingsValidate,
} from "./tools/settings";
import {
  DEVIATION_PROMPT_INPUT,
  DEVIATION_RUN_INPUT,
  DEVIATION_VALIDATE_INPUT,
  EPISODE_PLOT_PROMPT_INPUT,
  EPISODE_PLOT_RUN_INPUT,
  EPISODE_PLOT_VALIDATE_INPUT,
  SYNOPSIS_PROMPT_INPUT,
  SYNOPSIS_RUN_INPUT,
  SYNOPSIS_VALIDATE_INPUT,
  deviationPrompt,
  deviationRun,
  deviationValidate,
  episodePlotPrompt,
  episodePlotRun,
  episodePlotValidate,
  synopsisPrompt,
  synopsisRun,
  synopsisValidate,
} from "./tools/episode";
import {
  NOTATION_DETECT_INPUT,
  NOTATION_PROMPT_INPUT,
  NOTATION_RUN_INPUT,
  NOTATION_VALIDATE_INPUT,
  notationDetect,
  notationPrompt,
  notationRun,
  notationValidate,
} from "./tools/notation";

/**
 * Claude Code から、製品のプロンプトと検算をツールとして呼ぶ（設計書6.87.8）。
 *
 * **ここは転送層だけ。** 判断は `tools/*.ts` にあり、単体テストは
 * そちらを直に呼ぶ（`test/unit/mcpTools.test.ts`）。混ぜると、
 * ツールの中身を確かめるのに stdio を立てなければならなくなる。
 *
 * **`vscode` を1つでも静的に import すると、この束は読み込んだ瞬間に落ちる。**
 * `test/unit/mcpReach.test.ts` が、この入口から辿って届かないことを見張る。
 *
 * **読む・測る・提案するだけ**（6.87.7）。原稿も設定資料も書き換えない。
 */

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

/** 結果をそのまま JSON で返す。失敗は作者に読める日本語で */
function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown): CallToolResult {
  // **握りつぶさない。** 予期しない失敗でも、何が起きたかは必ず返す
  const message =
    error instanceof McpToolError ? error.message : describeError(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * ツールの中身を1か所で包む。
 *
 * 包む用は3つある。
 *
 * 0. **許可を確かめる**（設計書6.87.10）。**既定は拒否**で、作者が意思確認を
 *    していない作品は1文字も読ませない。道具が動く前に断る
 * 1. **失敗の返し方を揃える**
 * 2. **外から触られたことを1行残す**（設計書6.87.9）。道具ごとに書くと
 *    新しい道具を足した人が忘れ、**忘れたことは作者には見えない**。
 *    名前をここへ渡しているのはそのためで、渡し忘れは
 *    `test/unit/mcpAccessLog.test.ts` が止める
 *
 * **成功しても失敗しても残す。** 失敗した試みも、試みには違いない。
 */
function tool<Args>(
  name: string,
  handler: (args: Args) => unknown | Promise<unknown>
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args) => {
    /*
      **まず許可を確かめる**（設計書6.87.10。作者の指示、2026-09-15）。
      既定は拒否で、作者が意思確認をしていない作品は1文字も読ませない。
      **道具が動く前に断る**ので、断られた呼び出しではファイルを開かない。
    */
    try {
      assertExternalAccessAllowed(args);
    } catch (error) {
      // **ノックされたことを残す。** 許可した回より、作者が知りたいこと
      recordExternalAccess({ tool: name, args, ok: false, denied: true });
      return fail(error);
    }

    try {
      const value = await handler(args);
      recordExternalAccess({ tool: name, args, ok: true });
      return ok(value);
    } catch (error) {
      const result = fail(error);
      recordExternalAccess({
        tool: name,
        args,
        ok: false,
        failure:
          error instanceof McpToolError ? error.message : describeError(error),
      });
      return result;
    }
  };
}

server.registerTool(
  "mcp.version",
  {
    title: "MCPサーバーの版",
    description:
      "このMCPサーバー（＝統合小説執筆環境の束）の版を返します。" +
      "拡張機能の版と一致しているはずで、ずれていたら束ね直し（npm run build）が要ります。",
  },
  tool("mcp.version", () => ({
    version: SERVER_VERSION,
    name: SERVER_NAME,
    /*
      **呼んでいる相手が何をできるかを返す**（0.64.9）。

      使い道は2つ。①記録（6.87.9）に残る名乗りと突き合わせられる
      ②**`sampling` を名乗るかが分かる**——サーバーからクライアントへ
      「これを考えてほしい」と頼めるかどうかは、**実際に繋いで訊くまで
      分からない**（対応は実装ごとに違う）。外の状態を文書だけで判断しない
      （CLAUDE.md の「繰り返し起きた失敗」4）。

      **名乗りは自己申告**なので、身元の証明ではない。
    */
    client: server.server.getClientVersion() ?? null,
    clientCapabilities: server.server.getClientCapabilities() ?? null,
  }))
);

server.registerTool(
  "work.scan",
  {
    title: "作品フォルダーを走査する",
    description:
      "作品フォルダーの本文（`本文/` が無ければ直下）の .txt / .md を読み、" +
      "話数・サブタイトル・字数を返します。合本（1ファイルに複数話）は話ごとに分けます。" +
      "**読むだけ**で、何も書き換えません。",
    inputSchema: WORK_SCAN_INPUT,
  },
  tool("work.scan", workScan)
);

server.registerTool(
  "proofread.prompt",
  {
    title: "推敲のプロンプトを組む",
    description:
      "製品と同じ手順（作品の書き方をまとめる → プロンプトを組む）で、" +
      "推敲（P-09）のプロンプトをチャンクごとに返します。" +
      `応答は proofread.validate へ戻してください。${VALIDATE_NOTE}`,
    inputSchema: PROOFREAD_PROMPT_INPUT,
  },
  tool("proofread.prompt", proofreadPrompt)
);

server.registerTool(
  "proofread.validate",
  {
    title: "推敲の応答を検算する",
    description:
      "AIの応答を製品の検算（原文が本文に実在するか・指示の言葉がそのまま返っていないか・" +
      `作者が「直さない」と決めた語を巻き込んでいないか）に通します。${VALIDATE_NOTE}`,
    inputSchema: PROOFREAD_VALIDATE_INPUT,
  },
  tool("proofread.validate", proofreadValidate)
);

server.registerTool(
  "proofread.run",
  {
    title: "推敲を通す",
    description:
      "runner が ollama なら、手元の Ollama でプロンプト → 応答 → 検算まで通し、" +
      "**検算済みの結果だけ**を返します（原稿はこの機械から出ません）。" +
      "runner が claude ならプロンプトだけを返すので、読んだ応答を proofread.validate へ戻してください" +
      "（このとき本文は Anthropic へ渡ります）。runner が sampling なら、**呼び出し元に考えてもらって検算まで通します**（往復が要らず、検算を飛ばせません。対応していない呼び出し元では使えません）。**runner は省略できません。**",
    inputSchema: PROOFREAD_RUN_INPUT,
  },
  tool("proofread.run", proofreadRun)
);

server.registerTool(
  "typo.prompt",
  {
    title: "誤字脱字のプロンプトを組む",
    description:
      "製品と同じ手順（固有名詞の辞書と作品の書き方をまとめる → プロンプトを組む）で、" +
      "誤字脱字の検知（P-08）のプロンプトをチャンクごとに返します。" +
      `応答は typo.validate へ戻してください。${VALIDATE_NOTE}`,
    inputSchema: TYPO_PROMPT_INPUT,
  },
  tool("typo.prompt", typoPrompt)
);

server.registerTool(
  "typo.validate",
  {
    title: "誤字脱字の応答を検算する",
    description:
      "AIの応答を製品の検算（原文が本文に実在するか・固有名詞を誤字と言っていないか・" +
      "助詞の範囲・代名詞の入れ替え・文語の言い換えでないか・" +
      `作者が「直さない」と決めた語を巻き込んでいないか）に通します。${VALIDATE_NOTE}`,
    inputSchema: TYPO_VALIDATE_INPUT,
  },
  tool("typo.validate", typoValidate)
);

server.registerTool(
  "typo.run",
  {
    title: "誤字脱字の検知を通す",
    description:
      "runner が ollama なら、手元の Ollama でプロンプト → 応答 → 検算まで通し、" +
      "**検算済みの結果だけ**を返します（原稿はこの機械から出ません）。" +
      "runner が claude ならプロンプトだけを返すので、読んだ応答を typo.validate へ戻してください" +
      "（このとき本文は Anthropic へ渡ります）。runner が sampling なら、**呼び出し元に考えてもらって検算まで通します**（往復が要らず、検算を飛ばせません。対応していない呼び出し元では使えません）。**runner は省略できません。**",
    inputSchema: TYPO_RUN_INPUT,
  },
  tool("typo.run", typoRun)
);

server.registerTool(
  "contradiction.material",
  {
    title: "矛盾検知の材料を組む",
    description:
      "本文に出てくる人物・場所・世界観だけを、**その話の時点で分かっていることに巻き戻して**返します" +
      "（先の話で判明した値を渡すと、それを矛盾として挙げてしまうため）。",
    inputSchema: CONTRADICTION_MATERIAL_INPUT,
  },
  tool("contradiction.material", contradictionMaterial)
);

server.registerTool(
  "contradiction.prompt",
  {
    title: "矛盾検知のプロンプトを組む",
    description:
      "材料を組んでから、矛盾検知（P-12）のプロンプトをチャンクごとに返します。" +
      "突き合わせる相手が無いチャンクは飛ばします（材料なしで問うと矛盾を作り出すため）。" +
      `応答は contradiction.validate へ戻してください。${VALIDATE_NOTE}`,
    inputSchema: CONTRADICTION_PROMPT_INPUT,
  },
  tool("contradiction.prompt", contradictionPrompt)
);

server.registerTool(
  "contradiction.validate",
  {
    title: "矛盾検知の応答を検算する",
    description: `AIの応答を製品の検算に通します。${VALIDATE_NOTE}`,
    inputSchema: CONTRADICTION_VALIDATE_INPUT,
  },
  tool("contradiction.validate", contradictionValidate)
);

server.registerTool(
  "contradiction.run",
  {
    title: "矛盾検知を通す",
    description:
      "runner が ollama なら手元の Ollama で検算まで通します（原稿は外へ出ません）。" +
      "claude ならプロンプトだけを返します（本文が Anthropic へ渡ります）。" +
      "runner が sampling なら、**呼び出し元に考えてもらって検算まで通します**（往復が要らず、検算を飛ばせません。対応していない呼び出し元では使えません）。**runner は省略できません。**",
    inputSchema: CONTRADICTION_RUN_INPUT,
  },
  tool("contradiction.run", contradictionRun)
);

server.registerTool(
  "foreshadow.prompt",
  {
    title: "伏線のプロンプトを組む",
    description:
      "mode が detect なら本文から伏線の配置を拾うプロンプト（P-25）、" +
      "resolve なら台帳の未回収分がこの本文で回収されたかを見るプロンプト（P-26）を返します。" +
      `応答は foreshadow.validate へ戻してください。${VALIDATE_NOTE}`,
    inputSchema: FORESHADOW_PROMPT_INPUT,
  },
  tool("foreshadow.prompt", foreshadowPrompt)
);

server.registerTool(
  "foreshadow.validate",
  {
    title: "伏線の応答を検算する",
    description:
      "AIの応答を製品の検算（引用が本文に実在するか・台帳と重なっていないか・" +
      `返ってきた id が実在するか）に通します。${VALIDATE_NOTE}`,
    inputSchema: FORESHADOW_VALIDATE_INPUT,
  },
  tool("foreshadow.validate", foreshadowValidate)
);

server.registerTool(
  "foreshadow.run",
  {
    title: "伏線を通す",
    description:
      "runner が ollama なら手元の Ollama で検算まで通します（原稿は外へ出ません）。" +
      "claude ならプロンプトだけを返します（本文が Anthropic へ渡ります）。" +
      "runner が sampling なら、**呼び出し元に考えてもらって検算まで通します**（往復が要らず、検算を飛ばせません。対応していない呼び出し元では使えません）。**runner は省略できません。** 台帳は書き換えません。",
    inputSchema: FORESHADOW_RUN_INPUT,
  },
  tool("foreshadow.run", foreshadowRun)
);

server.registerTool(
  "chat.prompt",
  {
    title: "相談のプロンプトを組む",
    description:
      "AIへの相談（P-21）のシステムの指示と問いを、製品と同じ順で組みます。" +
      "**3つの診断のうち、読めるのはターゲット読者だけです**" +
      "（作品の `設定/読者像.json` にあるため）。助言方針と執筆スタイルは" +
      "VS Code の globalState にあってMCPからは読めないので、" +
      "診断の答え（adviceAnswers / writerStyle）を渡すと足します。" +
      `**渡さない軸は1字も送りません**（未診断の作者と同じ扱い）。${VALIDATE_NOTE}`,
    inputSchema: CHAT_PROMPT_INPUT,
  },
  tool("chat.prompt", chatPrompt)
);

server.registerTool(
  "chat.validate",
  {
    title: "相談の応答を読み解く",
    description:
      "AIの応答を製品の解析（`parseWorkChatAnswer`）に通し、答えと選択肢を返します。" +
      "**書き込みや実行の提案が入っていたかも知らせますが、MCPは実行しません**" +
      `（読む・測る・提案するまで）。${VALIDATE_NOTE}`,
    inputSchema: CHAT_VALIDATE_INPUT,
  },
  tool("chat.validate", chatValidate)
);

server.registerTool(
  "chat.run",
  {
    title: "相談を通す",
    description:
      "runner が ollama なら、手元の Ollama で問い → 応答 → 解析まで通します" +
      "（原稿はこの機械から出ません）。claude ならプロンプトだけを返すので、" +
      "読んだ応答を chat.validate へ戻してください（本文が Anthropic へ渡ります）。" +
      "runner が sampling なら、**呼び出し元に考えてもらって検算まで通します**（往復が要らず、検算を飛ばせません。対応していない呼び出し元では使えません）。**runner は省略できません。** 原稿も台帳も書き換えません。",
    inputSchema: CHAT_RUN_INPUT,
  },
  tool("chat.run", chatRun)
);

server.registerTool(
  "settings.prompt",
  {
    title: "設定資料の抽出のプロンプトを組む",
    description:
      "製品と同じ手順（既にいる人物・能力・場所・組織・世界観の名前を集める → " +
      "プロンプトを組む）で、設定資料の抽出（P-04a）のプロンプトをチャンクごとに返します。" +
      "prompt は1回ごとに独立しているので、作品全体を測るなら settings.run を使ってください。" +
      `応答は settings.validate へ戻してください。${VALIDATE_NOTE}`,
    inputSchema: SETTINGS_PROMPT_INPUT,
  },
  tool("settings.prompt", settingsPrompt)
);

server.registerTool(
  "settings.validate",
  {
    title: "設定資料の抽出の応答を検算する",
    description:
      "AIの応答を製品の検算（本文に根拠があるか・説明的な名前でないか・" +
      "体を共有している相手を別名にしていないか・途中で切れた別名でないか）に通します。" +
      `マージと保存は行いません。${VALIDATE_NOTE}`,
    inputSchema: SETTINGS_VALIDATE_INPUT,
  },
  tool("settings.validate", settingsValidate)
);

server.registerTool(
  "settings.run",
  {
    title: "設定資料の抽出を通す",
    description:
      "runner が ollama なら、手元の Ollama でチャンクを順に回し、前のチャンクで見つけた名前を " +
      "次の既知へ足しながら検算まで通します（製品と同じ）。claude ならプロンプトだけを返します。" +
      "sampling なら呼び出し元に考えてもらい、同じように既知名を育てながら検算まで通します。" +
      "runner は省略できません。マージと保存は行いません。",
    inputSchema: SETTINGS_RUN_INPUT,
  },
  tool("settings.run", settingsRun)
);

server.registerTool(
  "episode.synopsisPrompt",
  {
    title: "各話あらすじのプロンプトを組む",
    description:
      "その話を丸ごと渡して、各話あらすじ（P-06）のプロンプトを組みます。" +
      "前の話までのあらすじと、登録済みの人物名を材料に添えます。" +
      `応答は episode.synopsisValidate へ戻してください。${VALIDATE_NOTE}`,
    inputSchema: SYNOPSIS_PROMPT_INPUT,
  },
  tool("episode.synopsisPrompt", synopsisPrompt)
);

server.registerTool(
  "episode.synopsisValidate",
  {
    title: "各話あらすじの応答を検算する",
    description: `AIの応答を製品の検算（字数の上限・サブタイトルの形）に通します。${VALIDATE_NOTE}`,
    inputSchema: SYNOPSIS_VALIDATE_INPUT,
  },
  tool("episode.synopsisValidate", synopsisValidate)
);

server.registerTool(
  "episode.synopsisRun",
  {
    title: "各話あらすじを通す",
    description: "runner が ollama なら手元の Ollama で検算まで通します（原稿は外へ出ません）。" +
      "claude ならプロンプトだけを返します（本文が Anthropic へ渡ります）。" +
      "sampling なら呼び出し元に考えてもらい、検算まで通します。" +
      "runner は省略できません。",
    inputSchema: SYNOPSIS_RUN_INPUT,
  },
  tool("episode.synopsisRun", synopsisRun)
);

server.registerTool(
  "episode.deviationPrompt",
  {
    title: "プロット逸脱のプロンプトを組む",
    description:
      "プロット（設定/plot.md）とその話を突き合わせる、逸脱検知（P-11）のプロンプトを組みます。" +
      "プロットが無ければ止めます（突き合わせる相手が無いまま問うと、筋書きの不在を逸脱として挙げ始めるため）。" +
      `応答は episode.deviationValidate へ戻してください。${VALIDATE_NOTE}`,
    inputSchema: DEVIATION_PROMPT_INPUT,
  },
  tool("episode.deviationPrompt", deviationPrompt)
);

server.registerTool(
  "episode.deviationValidate",
  {
    title: "プロット逸脱の応答を検算する",
    description:
      "AIの応答を製品の検算（引用が本文に実在するか・指したプロットの箇所が実在するか）に通します。" +
      `${VALIDATE_NOTE}`,
    inputSchema: DEVIATION_VALIDATE_INPUT,
  },
  tool("episode.deviationValidate", deviationValidate)
);

server.registerTool(
  "episode.deviationRun",
  {
    title: "プロット逸脱を通す",
    description: "runner が ollama なら手元の Ollama で検算まで通します（原稿は外へ出ません）。" +
      "claude ならプロンプトだけを返します（本文が Anthropic へ渡ります）。" +
      "sampling なら呼び出し元に考えてもらい、検算まで通します。" +
      "runner は省略できません。",
    inputSchema: DEVIATION_RUN_INPUT,
  },
  tool("episode.deviationRun", deviationRun)
);

server.registerTool(
  "episode.plotPrompt",
  {
    title: "単話プロットの緩みを見るプロンプトを組む",
    description:
      "作者が書いた単話プロット（視点・目標・展開の箇条書き）を読み、緩みを見る（P-27）プロンプトを組みます。" +
      "展開がまだ書かれていなければ止めます。" +
      `応答は episode.plotValidate へ戻してください。${VALIDATE_NOTE}`,
    inputSchema: EPISODE_PLOT_PROMPT_INPUT,
  },
  tool("episode.plotPrompt", episodePlotPrompt)
);

server.registerTool(
  "episode.plotValidate",
  {
    title: "単話プロットの応答を検算する",
    description:
      "AIの応答を製品の検算（指した箇条書きが実在するか・同じ箇所を重ねていないか）に通します。" +
      `${VALIDATE_NOTE}`,
    inputSchema: EPISODE_PLOT_VALIDATE_INPUT,
  },
  tool("episode.plotValidate", episodePlotValidate)
);

server.registerTool(
  "episode.plotRun",
  {
    title: "単話プロットの緩みを通す",
    description: "runner が ollama なら手元の Ollama で検算まで通します（原稿は外へ出ません）。" +
      "claude ならプロンプトだけを返します（本文が Anthropic へ渡ります）。" +
      "sampling なら呼び出し元に考えてもらい、検算まで通します。" +
      "runner は省略できません。",
    inputSchema: EPISODE_PLOT_RUN_INPUT,
  },
  tool("episode.plotRun", episodePlotRun)
);

server.registerTool(
  "notation.detect",
  {
    title: "表記ゆれを探す",
    description:
      "作品ぜんたいの本文から、2通り以上の書き方で出ている語を探します。" +
      "探すのはコードで、AIは使いません。片方しか出ていない語は返しません。",
    inputSchema: NOTATION_DETECT_INPUT,
  },
  tool("notation.detect", notationDetect)
);

server.registerTool(
  "notation.prompt",
  {
    title: "表記ゆれの揃え先を問うプロンプトを組む",
    description:
      "notation.detect が返した組を1件渡すと、どちらへ揃えるのがよいかを問うプロンプトを組みます。" +
      `応答は notation.validate へ戻してください。${VALIDATE_NOTE}`,
    inputSchema: NOTATION_PROMPT_INPUT,
  },
  tool("notation.prompt", notationPrompt)
);

server.registerTool(
  "notation.validate",
  {
    title: "表記ゆれの応答を検算する",
    description:
      "AIが選んだ揃え先が、渡した表記のどれかであることを確かめます。" +
      `本文に無い表記は受け取りません。${VALIDATE_NOTE}`,
    inputSchema: NOTATION_VALIDATE_INPUT,
  },
  tool("notation.validate", notationValidate)
);

server.registerTool(
  "notation.run",
  {
    title: "表記ゆれの揃え先を通す",
    description: "runner が ollama なら手元の Ollama で検算まで通します（原稿は外へ出ません）。" +
      "claude ならプロンプトだけを返します（本文が Anthropic へ渡ります）。" +
      "sampling なら呼び出し元に考えてもらい、検算まで通します。" +
      "runner は省略できません。",
    inputSchema: NOTATION_RUN_INPUT,
  },
  tool("notation.run", notationRun)
);

server.registerTool(
  "ollama.generate",
  {
    title: "手元のOllamaへ投げる",
    description:
      "num_ctx を必ず明示して（省略すると入力が黙って切り捨てられます）、" +
      "スキーマで形式を強制し、思考モードを切って投げます。" +
      "宛先が localhost 以外のときは allowRemote: true が要ります（本文が機械の外へ出るため）。",
    inputSchema: OLLAMA_GENERATE_INPUT,
  },
  tool("ollama.generate", (args: OllamaGenerateInput) => ollamaGenerate(args))
);

async function main(): Promise<void> {
  /*
    **呼んだ相手の名乗りを控える**（設計書6.87.9）。記録に「誰が」が
    無いと、作者は Claude Code からの操作と、繋いだ覚えのない何かからの
    操作を見分けられない。**名乗りは自己申告**なので身元の証明ではないが、
    見分けが付かないよりはよい。
  */
  server.server.oninitialized = () => {
    const client = server.server.getClientVersion();
    if (client?.name) setExternalClientName(client.name);
  };

  /*
    **呼び出し元に考えてもらう道**（設計書6.87.12）を使えるようにする。
    ここから渡すのは、`tools/sampling.ts` から `server.ts` を参照すると
    読み込みが循環するためである。**対応しているかは向こうの宣言次第**なので、
    渡すだけで使えるとは限らない（使う側が毎回確かめる）。
  */
  setSamplingHost(server.server);

  // stdio。VS Code が起動していなくても動く（設計書6.87.8 の3）
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  // **標準出力はプロトコルが使う。** 失敗は標準エラーへ出す
  process.stderr.write(`MCPサーバーを起動できませんでした: ${describeError(error)}\n`);
  process.exit(1);
});
