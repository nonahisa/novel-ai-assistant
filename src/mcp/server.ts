import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_NAME, SERVER_VERSION } from "./version";
import {
  checkBundleStaleness,
  rememberBundleAtStartup,
  staleBundleLine,
  withStaleNote,
  type BundleStaleness,
} from "./staleness";
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
  NOVEL_DETECT_INPUT,
  NOVEL_MATERIAL_INPUT,
  NOVEL_PROMPT_INPUT,
  NOVEL_RUN_INPUT,
  NOVEL_VALIDATE_INPUT,
  novelDetect,
  novelMaterial,
  novelPrompt,
  novelRun,
  novelValidate,
  type FeatureCallInput,
} from "./tools/features";
import {
  OLLAMA_GENERATE_INPUT,
  OLLAMA_MODELS_INPUT,
  ollamaGenerate,
  ollamaModels,
  type OllamaGenerateInput,
  type OllamaModelsInput,
} from "./tools/ollama";
import { SETTINGS_PROPOSE_INPUT, settingsPropose } from "./tools/propose";
import {
  NOVEL_NOTICE_INPUT,
  novelNotice,
  type NoticeInput,
} from "./tools/notice";
import {
  GUIDE_SPOTLIGHT_INPUT,
  guideSpotlight,
  type SpotlightRequestInput,
} from "./tools/spotlight";
import { windowsList } from "./tools/windows";

/**
 * Claude Code から、製品のプロンプトと検算をツールとして呼ぶ（設計書6.87.8）。
 *
 * **ここは転送層だけ。** 判断は `tools/*.ts` にあり、単体テストは
 * そちらを直に呼ぶ（`test/unit/mcpTools.test.ts`）。混ぜると、
 * ツールの中身を確かめるのに stdio を立てなければならなくなる。
 *
 * **道具は13本**（0.72.0 で `novel.notice`、0.75.6 で `guide.spotlight`、
 * 0.75.x で `windows.list` を足した。0.66.7 の時点では10本）。
 * 56本あったものを
 * `feature` を引数に取る形へ束ねた——**AI は繋いだ瞬間にこの一覧を読む**ので、
 * 一覧そのものが会話のたびに払う費用だった（44,882字）。
 * 何をするかは `feature`、どこまで原稿が出るかは `runner` が決める。
 *
 * **`vscode` を1つでも静的に import すると、この束は読み込んだ瞬間に落ちる。**
 * `test/unit/mcpReach.test.ts` が、この入口から辿って届かないことを見張る。
 *
 * **読む・測る・提案するだけ**（6.87.7）。原稿も設定資料も書き換えない。
 */

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

/*
  **起動したときの束の姿を控える**（設計書6.87.15 の柱2の1）。ここで一度
  控えておかないと、あとから「この束は作り直されたか」を問えない。
  `main()` ではなくここで呼ぶのは、**繋ぐ前の状態を控えたい**からである。
*/
rememberBundleAtStartup();

/** 結果をそのまま JSON で返す。失敗は作者に読める日本語で */
function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown, staleness?: BundleStaleness): CallToolResult {
  // **握りつぶさない。** 予期しない失敗でも、何が起きたかは必ず返す
  const base =
    error instanceof McpToolError ? error.message : describeError(error);
  /*
    失敗の返事には `note` を足す先が無いので、断り書きは本文の末尾へ付ける。
    **古い束のまま直したはずの不具合を踏んでいる**ことがあり、そのときは
    失敗の理由より先に、束を繋ぎ直すことのほうが効く。
  */
  const message = staleness?.stale
    ? `${base}\n${staleBundleLine(staleness.reason)}`
    : base;
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
 * 1.5 **束が古ければ、返事に1行足す**（設計書6.87.15 の柱2の1）。
 *    道具ごとに書かないのは、記録や許可と同じ理由である
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
      **まず許可を確かめる**（設計書6.87.10・6.87.14。作者の指示、2026-09-15／16）。
      既定は拒否で、作者が意思確認をしていない作品は1文字も読ませない。
      **許可は接続元ごと・機能ごと**なので、道具の名前と `feature` を渡す
      ——ほかの機能を許していても、この機能は別に許可が要る（0.66.7）。
      **道具が動く前に断る**ので、断られた呼び出しではファイルを開かない。
    */
    try {
      assertExternalAccessAllowed(args, name);
    } catch (error) {
      // **ノックされたことを残す。** 許可した回より、作者が知りたいこと
      recordExternalAccess({ tool: name, args, ok: false, denied: true });
      return fail(error, checkBundleStaleness());
    }

    try {
      const value = await handler(args);
      recordExternalAccess({ tool: name, args, ok: true });
      return ok(withStaleNote(value, checkBundleStaleness()));
    } catch (error) {
      const result = fail(error, checkBundleStaleness());
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
      "このMCPサーバーの版を返します。拡張機能の版とずれていたら、" +
      "束ね直し（npm run build）が要ります。",
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
    /*
      **走っている束が古くないか**（設計書6.87.15 の柱2の1）。`version` は
      束に焼き込まれた写しなので、それ自体では古さが分からない——
      リポジトリの `package.json` と束の更新時刻を突き合わせて初めて分かる。
    */
    bundle: checkBundleStaleness(),
    /*
      **名前が変わったことを、ここで伝える**（0.66.7、設計書6.87.15 の柱1）。
      旧名と新名を並べて持つ（二重管理）ことはしないので、**古い名前で
      呼んだ相手が「そんな道具は無い」だけを受け取る**ことのないようにする。
    */
    renamed:
      "0.66.7 で道具を束ねました（56本 → 10本）。" +
      "typo.run のような名前は無くなり、novel.prompt / novel.validate / novel.run / " +
      "novel.detect / novel.material に feature（typo・proofread など）を渡す形です。" +
      "作者が置いた古い名前の許可は、そのまま効きます。",
  }))
);

server.registerTool(
  "windows.list",
  {
    title: "開いている VS Code の窓と、その版",
    description:
      "この機械で拡張機能が動いている窓の一覧を返します（拡張機能の版・VS Code の版・" +
      "窓の名前・開発ホストか・開いているフォルダー・最後に打ち直した時刻）。" +
      "**読むだけで、作品の中身は読みません。** mcp.version はこのサーバー（束）の版です。",
  },
  /*
    **引数を渡さない。** `folder` を取らないので許可の対象外（`mcp.version` と
    同じ）で、`now` を外から差し込めるのは試験のためだけである。
  */
  tool("windows.list", () => windowsList())
);

server.registerTool(
  "novel.scan",
  {
    title: "作品フォルダーを走査する",
    description:
      "本文（`本文/` が無ければ直下）の .txt / .md を読み、話数・サブタイトル・字数を返します。" +
      "合本（1ファイルに複数話）は話ごとに分けます。**読むだけ**です。" +
      "ここで返る相対パスを filePath に使います。" +
      /*
        **前提はここで返す**（設計書6.94、0.67.3）。道具を増やすと一覧が
        太り、繋ぐたびの費用になる。走査はどのみち最初に呼ばれる
      */
      "設定資料・各話あらすじ・プロット・単話プロットが揃っているかも返します" +
      "（prerequisites）。",
    inputSchema: WORK_SCAN_INPUT,
  },
  tool("novel.scan", workScan)
);

server.registerTool(
  "novel.prompt",
  {
    title: "機能ごとのプロンプトを組む",
    description:
      "製品と同じ手順でプロンプトを組んで返します（本文が呼び出し元へ渡ります）。" +
      `応答は novel.validate へ、同じ feature で戻してください。${VALIDATE_NOTE}`,
    inputSchema: NOVEL_PROMPT_INPUT,
  },
  tool("novel.prompt", (args: FeatureCallInput) => novelPrompt(args))
);

server.registerTool(
  "novel.validate",
  {
    title: "AIの応答を検算する",
    description:
      "AIの応答を製品の検算（原文が本文に実在するか・字数・指示の言葉がそのまま返っていないか・" +
      "作者が「直さない」と決めた語を巻き込んでいないかなど、機能ごと）に通します。" +
      `落としたものは理由とともに返します。${VALIDATE_NOTE}`,
    inputSchema: NOVEL_VALIDATE_INPUT,
  },
  tool("novel.validate", (args: FeatureCallInput) => novelValidate(args))
);

server.registerTool(
  "novel.run",
  {
    title: "機能を通す（プロンプト → 応答 → 検算）",
    /*
      **行き先の説明は `runner` の欄に1つだけ**（ここへ写すと同じ文が二重に載る）。
      ここには、どの行き先にも共通することだけを書く。
    */
    description:
      "その機能を、指定した行き先（runner）で通します。ollama なら**検算済みの結果だけ**を" +
      "返します（model が要ります）。claude は応答を novel.validate へ戻してください。" +
      "原稿も台帳も書き換えません。" +
      /*
        **前提の一覧はここへ書かない**（novel.scan が返す）。feature ごとに
        書くと同じ表が一覧に載り、繋ぐたびに読まれる
      */
      "前提（設定資料など）の要る feature は、足りなければ実行せずに断ります。",
    inputSchema: NOVEL_RUN_INPUT,
  },
  tool("novel.run", (args: FeatureCallInput) => novelRun(args))
);

server.registerTool(
  "novel.detect",
  {
    title: "AIを使わずに探す",
    description:
      "コードだけで探します（AIは使いません）。notation＝2通り以上で出ている語を探す" +
      "（返した組の1件を options.group に渡すと、揃え先をAIに問えます）。" +
      "name＝名前を読みと表記の規則で突き合わせ、紛らわしい組を返します。",
    inputSchema: NOVEL_DETECT_INPUT,
  },
  tool("novel.detect", (args: FeatureCallInput) => novelDetect(args))
);

server.registerTool(
  "novel.material",
  {
    title: "AIへ渡す材料を組む",
    description:
      "contradiction＝本文に出てくる人物・場所・世界観だけを、" +
      "**その話の時点で分かっていることに巻き戻して**返します" +
      "（先の話で判明した値は、矛盾として挙がってしまうため）。",
    inputSchema: NOVEL_MATERIAL_INPUT,
  },
  tool("novel.material", (args: FeatureCallInput) => novelMaterial(args))
);

server.registerTool(
  "novel.notice",
  {
    title: "実行前に出る断りを、走らせずに読む",
    description:
      "そのモデルで矛盾検知／プロット逸脱検知を押したときに、" +
      "**実行前の確認画面とログへ出る断り**を返します（設計書6.10.8・6.28）。" +
      "断りはモデルの大きさで変わる（20B以上は「確信が持てない箇所も挙げます」、" +
      "20B未満は「指摘しません」）ので、画面を押さずに確かめる口です。" +
      "**AIは呼ばず、本文も設定資料も読みません。**",
    inputSchema: NOVEL_NOTICE_INPUT,
  },
  tool("novel.notice", (args: NoticeInput) => novelNotice(args))
);

server.registerTool(
  "guide.spotlight",
  {
    title: "画面のメニュー項目を光らせる",
    description:
      "作者の VS Code のサイドバーで、その操作の項目を**2回点滅**させます" +
      "（簡単ステップメニュー → 詳細メニューの順に探します）。" +
      "**押すのは作者です——この道具は操作を実行しません。** " +
      "原稿も設定資料も台帳も1文字も触りません。" +
      "command（コマンドID）か label（表示名）のどちらかを渡してください。" +
      "VS Code が閉じていれば、次に開いたときに光ります。",
    inputSchema: GUIDE_SPOTLIGHT_INPUT,
  },
  tool("guide.spotlight", (args: SpotlightRequestInput) => guideSpotlight(args))
);

server.registerTool(
  "novel.propose",
  {
    title: "人物の設定資料の更新案を、承認待ちへ置く",
    description:
      "人物の設定資料の**更新案を承認待ちへ置きます**（`.aiwriter/pending-characters/`）。" +
      "**台帳（設定/characters）は書き換えません。** 作者が VS Code の「更新分を反映」で採ったときに、" +
      "製品のマージ（話数の扱い・食い違いの記録）が走ります。" +
      "name が台帳に居れば更新案、居なければ新規案になります（別名では引き当てません）。" +
      "**同じ人物に作者がまだ判断していない案があれば断ります**（作者が見る前の案が消えるため）。" +
      "**reason は省略できません**——作者が採否を決める材料です。",
    inputSchema: SETTINGS_PROPOSE_INPUT,
  },
  tool("novel.propose", settingsPropose)
);

server.registerTool(
  "ollama.generate",
  {
    title: "手元のOllamaへ投げる",
    description:
      "num_ctx を必ず明示して（省略すると入力が黙って切り捨てられます）、" +
      "スキーマで形式を強制し、思考モードを切って投げます。" +
      "localhost 以外の宛先には allowRemote: true が要ります（本文が機械の外へ出ます）。",
    inputSchema: OLLAMA_GENERATE_INPUT,
  },
  tool("ollama.generate", (args: OllamaGenerateInput) => ollamaGenerate(args))
);

server.registerTool(
  "ollama.models",
  {
    title: "手元の Ollama のモデル一覧",
    description:
      "`runner: \"ollama\"` の `model` を選ぶために使います。" +
      "手元の Ollama に入っているモデルと、読める長さ（contextLength）・" +
      "対応機能（capabilities）・同梱の実測（bundled）を返します。" +
      "**一覧を読むだけで、作者の原稿は1文字も送りません。**",
    inputSchema: OLLAMA_MODELS_INPUT,
  },
  tool("ollama.models", (args: OllamaModelsInput) => ollamaModels(args))
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
