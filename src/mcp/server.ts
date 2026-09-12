import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_NAME, SERVER_VERSION } from "./version";
import { McpToolError, describeError } from "./tools/shared";
import { VALIDATE_NOTE } from "./tools/run";
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

/** ツールの中身を1か所で包む（失敗の返し方を揃えるため） */
function tool<Args>(
  handler: (args: Args) => unknown | Promise<unknown>
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args) => {
    try {
      return ok(await handler(args));
    } catch (error) {
      return fail(error);
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
  tool(() => ({ version: SERVER_VERSION, name: SERVER_NAME }))
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
  tool(workScan)
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
  tool(proofreadPrompt)
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
  tool(proofreadValidate)
);

server.registerTool(
  "proofread.run",
  {
    title: "推敲を通す",
    description:
      "runner が ollama なら、手元の Ollama でプロンプト → 応答 → 検算まで通し、" +
      "**検算済みの結果だけ**を返します（原稿はこの機械から出ません）。" +
      "runner が claude ならプロンプトだけを返すので、読んだ応答を proofread.validate へ戻してください" +
      "（このとき本文は Anthropic へ渡ります）。**runner は省略できません。**",
    inputSchema: PROOFREAD_RUN_INPUT,
  },
  tool(proofreadRun)
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
  tool(contradictionMaterial)
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
  tool(contradictionPrompt)
);

server.registerTool(
  "contradiction.validate",
  {
    title: "矛盾検知の応答を検算する",
    description: `AIの応答を製品の検算に通します。${VALIDATE_NOTE}`,
    inputSchema: CONTRADICTION_VALIDATE_INPUT,
  },
  tool(contradictionValidate)
);

server.registerTool(
  "contradiction.run",
  {
    title: "矛盾検知を通す",
    description:
      "runner が ollama なら手元の Ollama で検算まで通します（原稿は外へ出ません）。" +
      "claude ならプロンプトだけを返します（本文が Anthropic へ渡ります）。" +
      "**runner は省略できません。**",
    inputSchema: CONTRADICTION_RUN_INPUT,
  },
  tool(contradictionRun)
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
  tool(foreshadowPrompt)
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
  tool(foreshadowValidate)
);

server.registerTool(
  "foreshadow.run",
  {
    title: "伏線を通す",
    description:
      "runner が ollama なら手元の Ollama で検算まで通します（原稿は外へ出ません）。" +
      "claude ならプロンプトだけを返します（本文が Anthropic へ渡ります）。" +
      "**runner は省略できません。** 台帳は書き換えません。",
    inputSchema: FORESHADOW_RUN_INPUT,
  },
  tool(foreshadowRun)
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
  tool((args: OllamaGenerateInput) => ollamaGenerate(args))
);

async function main(): Promise<void> {
  // stdio。VS Code が起動していなくても動く（設計書6.87.8 の3）
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  // **標準出力はプロトコルが使う。** 失敗は標準エラーへ出す
  process.stderr.write(`MCPサーバーを起動できませんでした: ${describeError(error)}\n`);
  process.exit(1);
});
