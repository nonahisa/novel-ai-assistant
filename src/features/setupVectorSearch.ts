import * as vscode from "vscode";
import { OllamaEmbeddingProvider, DEFAULT_EMBEDDING_MODEL } from "../ai/ollamaEmbedding";
import { embeddingModelName, isVectorSearchEnabled } from "./vectorSearch";

/**
 * 意味検索（ベクトルDB）のセットアップ案内。
 *
 * ## 何を案内するか
 *
 * 1. これは何で、入れると何が変わるか
 * 2. **入れなくても検索は良くなること**（語句一致だけでも動く）
 * 3. かかるもの（1.2GBの取得・作品ごとの索引づくり・数MBの置き場所）
 * 4. 取得の実行と、設定の切り替え
 *
 * ## 決め打ちしない
 *
 * モデル名は設定から読む。新しい埋め込みモデルは次々出るので、
 * 案内文にも「既定は bge-m3」と書くだけにして、
 * 作者が変えたらそちらを案内する。
 */

interface Step {
  label: string;
  detail: string;
  run: () => Promise<void>;
}

export async function setupVectorSearch(): Promise<void> {
  const model = embeddingModelName();
  const provider = new OllamaEmbeddingProvider();
  const check = await provider.check();
  const enabled = isVectorSearchEnabled();

  const state = check.ok
    ? `いま：使える状態です（モデル ${model}）`
    : `いま：まだ使えません（${check.error.message}）`;
  const switchState = enabled ? "設定：入" : "設定：切";

  const steps: Step[] = [];

  if (!check.ok) {
    steps.push({
      label: `1. 埋め込みモデル「${model}」を取り寄せる`,
      detail:
        model === DEFAULT_EMBEDDING_MODEL
          ? "約1.2GB。日本語を含む多言語向けのモデルです"
          : "設定で指定されているモデルです",
      run: async () => {
        const terminal = vscode.window.createTerminal("Ollama");
        terminal.show();
        terminal.sendText(`ollama pull ${model}`);
        vscode.window.showInformationMessage(
          "取得を始めました。終わったら、もう一度この画面から「設定を入にする」を選んでください。"
        );
      },
    });
  }

  steps.push({
    label: enabled ? "設定を切にする（語句一致だけで動かす）" : "設定を入にする",
    detail: enabled
      ? "非力な機械では切ったほうが軽く動きます"
      : "作品ごとに索引を作れるようになります",
    run: async () => {
      await vscode.workspace
        .getConfiguration("novelai")
        .update(
          "vectorSearch.enabled",
          !enabled,
          vscode.ConfigurationTarget.Global
        );
      vscode.window.showInformationMessage(
        enabled
          ? "意味検索を切りました。相談では語句一致で場面を探します。"
          : "意味検索を入にしました。作品を選んで「検索用の索引を作る」を実行してください。"
      );
    },
  });

  steps.push({
    label: "作品の索引を作る・更新する",
    detail: "変わっていない場面は作り直しません",
    run: async () => {
      await vscode.commands.executeCommand("novelai.buildVectorIndex");
    },
  });

  const picked = await vscode.window.showQuickPick(
    steps.map((step) => ({ label: step.label, detail: step.detail, step })),
    {
      title: "相談で使う「意味検索」の準備",
      placeHolder: `${state} ／ ${switchState}`,
      ignoreFocusOut: true,
    }
  );

  await picked?.step.run();
}

/**
 * 何ができるようになるかの説明文。
 *
 * **入れなくても良くなることを先に書く。** 「入れないと使えない」と
 * 誤解させると、非力な機械の作者が諦めてしまう。
 */
export const VECTOR_SEARCH_OVERVIEW = `相談のときに「質問に近い場面」を本文・設定資料・あらすじから探して渡します。

- **入れなくても、質問を使って探すようになります**（語句一致）。追加のものは要りません
- **入れると**、言い換えで聞いたときにも見つかりやすくなります
  （例：「妬ましさを感じる場面」→「嫉妬」の場面を見つける）

入れる場合にかかるもの
- 埋め込みモデルの取得（既定の bge-m3 で約1.2GB。一度だけ）
- 作品ごとの索引づくり（実測：78.5万字・219話で約39秒）
- 置き場所（同じ作品で約10MB。\`.aiwriter/cache/\` に置くのでGitHubには送りません）

索引づくりは手元のOllamaで行うので**料金はかかりません**。`;
