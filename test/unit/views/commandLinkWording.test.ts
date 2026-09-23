import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ACTION_TREE,
  type ActionGroup,
  type ActionItem,
  type ActionSection,
} from "../../../src/views/actionList";

/**
 * 設定の説明の中のコマンドリンクが、メニューの項目名と食い違っていないか。
 *
 * ## なぜ要るか
 *
 * 2026-09-22、作者の「メニューや設定が口語体すぎる」に応えて項目名を41件
 * 短くしたとき、**設定の説明の中のリンクの文字が5本、古い名前のまま残った**
 * （「Ollamaのセットアップ…」対「Ollamaの導入」など）。押せば正しい場所へ
 * 行くので動作は壊れないが、**作者から見ると画面ごとに違う名前を言う。**
 *
 * 名前はこれからも変わる。**変えた日に落ちる網**が無いと、同じずれが積もる。
 *
 * ## 何を見るか
 *
 * リンクの文字と、そのコマンドIDを持つメニュー項目の `label` を突き合わせる。
 * ただし**同じ字であることまでは求めない**——リンクは文の中に置かれるので、
 * 末尾の「…」や、動作を言う形（「ファイルを選択…」）が自然なことがある。
 * 求めるのは「**古い名前が残っていないこと**」で、そのために
 * **例外は理由つきで表に書かせる**。
 */

/** リンクの文字が label と違ってよいもの。**理由を書くこと** */
const EXCEPTIONS: Record<string, string> = {
  // メニューの名前は「Ollamaの実行ファイル」だが、これは
  // `novelai.ollama.executablePath` の説明の中のリンク。名前へ揃えると
  // 「ollama 実行ファイルの場所」の下に同じ字が二度出る。
  // **古い名前ではなく、もともと名前ではない**（動作を言う文字）
  "novelai.selectOllamaExecutable": "説明の中で動作を言うリンク。項目名ではない",
  // 「セットアップ（必要なものを入れる）」は詳細メニューに無いコマンド
  // （`runFullSetup` は案内の中から呼ぶ）。突き合わせる相手がいない
  "novelai.runFullSetup": "詳細メニューに項目が無い",
  "novelai.setupVectorSearch": "詳細メニューに項目が無い",
  "novelai.buildVectorIndex": "詳細メニューに項目が無い",
  "novelai.clearVectorIndex": "詳細メニューに項目が無い",
};

interface Link {
  setting: string;
  text: string;
  command: string;
}

function settingLinks(): Link[] {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    contributes: {
      configuration:
        | { properties?: Record<string, Record<string, unknown>> }
        | { properties?: Record<string, Record<string, unknown>> }[];
    };
  };
  const blocks = ([] as { properties?: Record<string, Record<string, unknown>> }[]).concat(
    pkg.contributes.configuration
  );
  const links: Link[] = [];
  for (const block of blocks) {
    for (const [setting, value] of Object.entries(block.properties ?? {})) {
      const text =
        (typeof value.markdownDescription === "string" ? value.markdownDescription : "") ||
        (typeof value.description === "string" ? value.description : "");
      for (const match of text.matchAll(/\[([^\]]+)\]\(command:([A-Za-z0-9_.]+)\)/g)) {
        links.push({ setting, text: match[1], command: match[2] });
      }
    }
  }
  return links;
}

/** コマンドIDから、詳細メニューの項目名を引く */
function labelsByCommand(): Map<string, string> {
  const map = new Map<string, string>();
  const visit = (nodes: readonly (ActionGroup | ActionSection | ActionItem)[]): void => {
    for (const node of nodes) {
      if (node.kind === "action") map.set(node.command, node.label);
      else if (node.kind === "section") visit(node.items);
      else visit(node.entries);
    }
  };
  visit(ACTION_TREE);
  return map;
}

describe("設定の中のコマンドリンクと、メニューの項目名", () => {
  it("リンクが1本以上ある（見張りが空回りしていない）", () => {
    expect(settingLinks().length).toBeGreaterThan(5);
  });

  it("リンクの文字に、古くなった項目名が残っていない", () => {
    const labels = labelsByCommand();
    const ずれ: string[] = [];
    for (const link of settingLinks()) {
      if (EXCEPTIONS[link.command]) continue;
      const label = labels.get(link.command);
      // メニューに無いコマンドは、突き合わせる相手がいない
      if (label === undefined) {
        ずれ.push(
          `${link.setting}：「${link.text}」→ ${link.command} は詳細メニューに無い。` +
            "EXCEPTIONS へ理由つきで足すか、メニューの項目を確かめること"
        );
        continue;
      }
      // 末尾の「…」は文の中でリンクらしく見せるためのもので、名前の違いではない
      const 文字 = link.text.replace(/[…\.]+$/, "").trim();
      if (文字 !== label) {
        ずれ.push(`${link.setting}：リンクは「${文字}」、メニューは「${label}」`);
      }
    }
    expect(ずれ).toEqual([]);
  });

  it("例外の表に、使われていない行が残っていない", () => {
    const 使っている = new Set(settingLinks().map((link) => link.command));
    const 余り = Object.keys(EXCEPTIONS).filter((command) => !使っている.has(command));
    expect(余り).toEqual([]);
  });
});
