import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  ACTION_TREE,
  allActions,
  shownEntries,
} from "../../../src/views/actionList";
import { STEP_REFERENCED_COMMANDS } from "../../../src/views/stepMenu";

/**
 * **画面に実際に出る詳細メニュー**を、ここに写して固定する。
 *
 * ## なぜ要るか
 *
 * `ACTION_TREE` をそのまま読むと、**画面に出ないものまで並ぶ**。
 * `hiddenFromActionList` が付いた項目（設定管理へ移したもの。設計書6.56.3）と、
 * 外部プロセスを起動できない環境で落ちる項目が、`shownEntries` で除かれるためである。
 *
 * **その違いで2度続けて実機確認の巡を迷わせた**（2026-09-12）。本体が
 * 「コードで確かめた」と言って渡した道順に、出ないはずの「セットアップを開始」
 * 「AI相談の強化」「機能ごとにAIを割り当てる」が入っていた。巡は画面を10分探し、
 * 見つからないまま終わった。**同じ日に、README も同じ古い並びを載せていた**
 * ことが分かっている（8巡目で直した）。
 *
 * ## 何を守るか
 *
 * - **道順を書く人は、まずここを読む。** `ACTION_TREE` を直に読まない
 * - **並びを変えたら、ここが落ちる。** 意図した変更なら写しを直す。
 *   意図していなければ、それは不具合である
 * - **README のメニューの図も、ここと揃える**（食い違ったまま配布された実績がある）
 *
 * 手元の環境（外部プロセスを起動できる）での並びを写す。ブラウザ版で何が落ちるかは
 * `actionList.test.ts` の「外部プロセスを起動できない環境（ブラウザ版）」が見る。
 */
function visibleMenu(): string[] {
  const out: string[] = [];
  for (const group of ACTION_TREE) {
    // 見出しを挟まない分類（相談パネルを開く）は、操作がそのまま最上位に出る
    if (group.standalone) {
      for (const entry of shownEntries(group.entries, true)) {
        out.push(entry.label);
      }
      continue;
    }
    out.push(group.label);
    for (const entry of shownEntries(group.entries, true)) {
      if (entry.kind === "section") {
        out.push("  " + entry.label);
        for (const item of shownEntries(entry.items, true)) {
          out.push("    " + item.label);
        }
      } else {
        out.push("  " + entry.label);
      }
    }
  }
  return out;
}

describe("画面に出る詳細メニュー（道順を書く人はここを読む）", () => {
  /**
   * **2026-09-23 の組み直しの最終形**（作者に見せた組み直し案と14問の答え、
   * 会話での追加の裁定）に、2026-09-24 の整理（B10①②③）を重ねたもの。
   * 名前は作者の確定表どおり。
   *
   * 1行ずつ意味がある並びなので、丸ごと写す。1行でもずれたら落ちる。
   */
  test("組み直した並びを、丸ごと写す（2026-09-24）", () => {
    // 2026-09-24（B10）：①画面の中から入る操作を外した（伏線手動追加・
    // 伏線状態変更・人物名変更・人物名変更の資料反映）②「執筆支援」を
    // 簡単ステップメニューの段の名前で5つの束に割った ③最初に一度だけ
    // 使う設定を「初回設定」へ畳んだ（チューニングの3つ・書庫集約）
    expect(visibleMenu()).toEqual([
      "執筆データ",
      "  全作品執筆統計",
      "  執筆統計",
      "  作品目標設定",
      "  スケジュール",
      "  編集履歴",
      "作品管理",
      "  作品名変更",
      "  シリーズ連結",
      "  メモ追加",
      "  新規執筆開始",
      "    プロット起点",
      "    本文起点",
      "  既存原稿登録",
      "    未登録作品検索",
      "    フォルダー登録",
      "    バックアップ取込",
      "    Word 原稿変換",
      "  クラウド取得",
      "    GitHubから追加",
      "  GitHub作品管理",
      // GitHub初期設定は残す（作者が作品管理の下を探した実績。設計書5.7.9）。
      // 書庫集約は初回設定へ畳んだ（2026-09-24 B10③）
      "    GitHub初期設定",
      "    保存・同期",
      "    全作品同期",
      "    分岐合流",
      "    同期",
      "    競合解決",
      "    復元",
      "  編集部連携",
      "    作者／編集者切替",
      "    編集部共有",
      "    校閲開始／終了",
      "    編集部提案取込",
      "    編集部提案確認",
      "  作品別設定",
      "    形式・ジャンル",
      "    作品の種類",
      "    設定資料項目追加",
      "    SNS告知設定",
      "    外部AI許可／取消",
      "    外部AI指示書設置",
      // Claude Code とつなぐ（設計書6.87.18）。外部AIの2つの隣
      "    Claude Code接続",
      // ── ここから5つは簡単ステップメニューの段と同じ名前（2026-09-24 B10②）──
      "新作構想",
      "  支援機能全工程実行",
      "  プロット自力作成",
      "  プロットモード",
      "  対話式プロット作成",
      "  プロット逆算",
      "  単話プロット作成",
      // 名付けの段階で使う（ステップの「2. 新作構想」と同じ置き場）。
      // 人物名変更・資料反映は名前点検の画面と知らせから入る（B10①）
      "  名前点検",
      "作品執筆",
      "  相談・助言",
      "    相談作品選択",
      "    作家タイプ診断",
      // 相談・助言のいちばん下（作者の指定、2026-09-23）
      "    相談パネルを開く",
      "  原稿整備",
      "    執筆再開用資料生成",
      "    章立て提案",
      "    章見出しから章立て",
      "    バックアップから章立て",
      "    本文 .md 化",
      "    改行コード統一",
      "自己校正",
      "  校正・校閲",
      "    校正一括実行",
      "    誤字脱字検知",
      "    指摘対象外管理",
      "    表記ゆれ検知",
      "    推敲",
      "    プロット逸脱検知",
      "    単話プロット検査",
      "    矛盾検知",
      // 伏線手動追加・伏線状態変更は画面から外した（B10①。ステップと
      // コマンドパレットから呼べる）
      "    伏線検知",
      "    伏線回収確認",
      "    伏線一覧",
      "    期限切れ指摘消去",
      "  読者診断",
      "    冒頭診断",
      "    ターゲット読者",
      // 別の話どうしの似た場面（設計書6.19.10。作者の依頼 2026-09-23 の4）
      "    類似場面検出",
      "投稿脱稿",
      "  広報支援",
      "    キャッチコピー案",
      "    作品紹介文",
      "    更新SNS告知文作成",
      "  投稿・出力",
      "    新話投稿",
      "    投稿サイト設定",
      "    ランキング記録",
      "    読者反応自動取込",
      "    読者反応手動入力",
      "    投稿サイトルビ取込",
      "    設定資料集出力",
      "    提供先別出力",
      "    IME辞書出力",
      "電子出版等",
      "  PDF出力",
      "  EPUBエディター",
      "資料管理",
      "  資料抽出",
      "    一括抽出",
      "    人物抽出",
      "    場所抽出",
      "    スキル抽出",
      "    組織抽出",
      "    世界観抽出",
      "    各話あらすじ",
      "    人物重複統合",
      "    設定資料更新分反映",
      "  資料閲覧",
      "    設定資料集閲覧",
      "    人物相関図",
      // 年表と作中時期・別筋登録は資料閲覧へ（作者の指定、2026-09-23）
      "    年表",
      "    作中時期・別筋登録",
      "    紹介文・あらすじ閲覧",
      // 言葉で本文を探す（設計書6.19.10。作者の依頼 2026-09-23 の1）
      "    場面検索",
      "統合小説執筆環境設定",
      "  設定管理",
      "  AI",
      "    AI設定",
      "    AI接続確認",
      // 最初に一度だけ使う設定（2026-09-24 B10③）
      "  初回設定",
      "    AIチューニング",
      "    AIチューニング実測一覧",
      // 台帳を保管庫のファイルへ移したぶん、設定画面からは消せなくなった
      // （0.66.6）。消す口はここにしかない
      "    AIチューニング記録削除",
      "    書庫集約",
      "ヘルプ",
      "  使い方",
      "  場面別案内",
      "  ログ表示",
      "  相談ログ",
      "  バージョン確認",
    ]);
  });

  test("分類は10で、この順に並ぶ（「執筆支援」を工程の束に割った。2026-09-24）", () => {
    expect(ACTION_TREE.map((group) => group.label)).toEqual([
      "執筆データ",
      "作品管理",
      "新作構想",
      "作品執筆",
      "自己校正",
      "投稿脱稿",
      "電子出版等",
      "資料管理",
      "統合小説執筆環境設定",
      "ヘルプ",
    ]);
    expect(ACTION_TREE.filter((group) => group.standalone).map((g) => g.label)).toEqual([]);
  });

  test("見出しを挟まない分類は、中身がちょうど1つの操作", () => {
    for (const group of ACTION_TREE.filter((g) => g.standalone)) {
      expect(group.entries, group.label).toHaveLength(1);
      expect(group.entries[0].kind, group.label).toBe("action");
    }
  });

  test("「ヘルプ」に「動作診断」は出ない（ブラウザ版からも外した）", () => {
    const group = ACTION_TREE.find((g) => g.label === "ヘルプ");
    for (const runtimeAllowsProcesses of [true, false]) {
      const labels = shownEntries(group!.entries, runtimeAllowsProcesses).map(
        (e) => e.label
      );
      expect(labels).not.toContain("動作診断");
      expect(labels).toContain("使い方");
    }
  });

  test("**隠した項目が、画面のどこにも出ていない**", () => {
    // 1つでも漏れると、作者は「設定管理にもメニューにもある」状態になり、
    // どちらが正なのか分からなくなる
    const shown = new Set(visibleMenu().map((line) => line.trim()));

    for (const label of [
      // 設定管理へしまったもの（設計書6.56.3）
      "セットアップ開始",
      "セットアップ",
      "Ollama導入",
      "LM Studio導入",
      "AI相談強化",
      "機能別AI割当",
      "Ollama実行ファイル位置",
      "ベクトル検索準備",
      "確認省略解除",
      // 2026-09-23 に外したもの（原稿エディター・作家タイプ診断・矛盾検知へ寄せた）
      "シーンメモ一覧",
      "縦書き表示",
      "原稿読み上げ",
      "口述文整形",
      "ルビ付与",
      "傍点付与",
      "投稿用変換・コピー",
      "助言方針",
      "あなた自身の読者タイプ",
      "AI相談",
      "EPUB出力",
      // 2026-09-24 に外したもの（画面の中・知らせ・ステップから入る。B10①）
      "伏線手動追加",
      "伏線状態変更",
      "人物名変更",
      "人物名変更の資料反映",
      // 小分類ごと無くなったもの（中身は新作構想と初回設定へ移した）
      "人物名",
      "執筆支援",
    ]) {
      expect(shown.has(label), label).toBe(false);
    }
  });
});

/**
 * **詳細メニューから外した操作が、ほかの入口から呼べること**（2026-09-24 B10①）。
 *
 * 「消さずに出さない」（`hiddenFromActionList`）は、ほかに入口があって初めて
 * 成り立つ。外したあとで右クリックの登録を消す・ステップから外す・画面の
 * ボタンを消すと、**どこからも押せない操作**が黙ってでき上がる——メニューには
 * 出ないので、無くなったことにも気づけない。
 *
 * 入口として数えるもの：
 * - 簡単ステップメニュー（`STEP_REFERENCED_COMMANDS`）
 * - 右クリック・エディターの見出しのボタン（`package.json` の `menus`）
 * - 設定の説明・道案内の中のリンク（`command:novelai.…`）
 * - 画面の中・知らせのボタン（下の表。目印の文字列がソースに残っているかを見る）
 *
 * **コマンドパレットだけ、は認めない。** パレットは名前を知っている人の
 * 入口で、作者が「どこにあるか」を探す場所ではない。パレットにしか無い
 * ものは下の表（`PALETTE_ONLY`）に理由つきで載せる。
 */
describe("詳細メニューに出さない操作の、ほかの入口", () => {
  const manifestText = readFileSync(
    new URL("../../../package.json", import.meta.url),
    "utf8"
  );
  const manifest = JSON.parse(manifestText) as {
    contributes: {
      menus: Record<string, Array<{ command?: string; when?: string }>>;
    };
  };
  const paletteHidden = new Set(
    manifest.contributes.menus.commandPalette
      .filter((entry) => entry.when === "false")
      .map((entry) => entry.command)
  );
  const menuCommands = new Set(
    Object.entries(manifest.contributes.menus)
      .filter(([key]) => key !== "commandPalette")
      .flatMap(([, entries]) => entries.map((entry) => entry.command))
  );

  /** 画面の中・知らせのボタンから入る道。`marker` がそのファイルに残っていること */
  const INSIDE: Record<string, { where: string; file: string; marker: string }> =
    {
      // 2026-09-24 に外した2つ（B10①）
      "novelai.renameCharacter": {
        where: "名前点検の画面の「付け替える」",
        file: "src/views/nameCheckPanelHtml.ts",
        marker: "付け替える</button>",
      },
      "novelai.applyRenameToRecords": {
        where: "人物名変更を終えたときの知らせのボタン",
        file: "src/features/nameRename.ts",
        marker: 'APPLY_RENAME_COMMAND = "novelai.applyRenameToRecords"',
      },
      // 2026-09-23 に外したもの（作家タイプ診断・原稿エディター・矛盾検知へ寄せた）
      "novelai.setAdvicePolicy": {
        where: "作家タイプ診断の「助言の受け方」",
        file: "src/features/writerDiagnosis.ts",
        marker: "助言の受け方（${ADVICE_QUESTIONS.length}問）",
      },
      "novelai.setAuthorReaderType": {
        where: "作家タイプ診断の「読者としての好み」",
        file: "src/features/writerDiagnosis.ts",
        marker: "読者としての好み（${AUTHOR_READER_QUESTIONS.length}問）",
      },
      "novelai.readManuscriptAloud": {
        where: "原稿エディターの上のバー「読み上げ」",
        file: "src/views/manuscriptEditorHtml.ts",
        marker: '<button id="aloudToggle"',
      },
      "novelai.dictationClean": {
        where: "原稿エディターの下段「口述」→「整える」",
        file: "src/views/manuscriptEditorHtml.ts",
        marker: 'type: "dictationClean"',
      },
      "novelai.checkFactContradictions": {
        where: "矛盾検知（設定資料が無いときの代わりの道）",
        file: "src/core/prerequisites.ts",
        marker: 'command: "novelai.checkFactContradictions"',
      },
      "novelai.exportEpub": {
        where: "EPUBエディターの「EPUBを書き出す」",
        file: "src/features/epubEditorPanel.ts",
        marker: 'parsed.type === "export"',
      },
    };

  /** コマンドパレットにしか無い操作と、その理由 */
  const PALETTE_ONLY: Record<string, string> = {
    // 「ターゲット読者」1つに入口をまとめた旧3つ（設計書6.108.6）。
    // 詳細メニューとステップには「ターゲット読者」が出る
    "novelai.runReaderTargetDiagnosis": "「ターゲット読者」に統合した旧入口",
    "novelai.openTargetSheet": "押すと「ターゲット読者」を開く旧入口",
    "novelai.showThreeCircles": "押すと「ターゲット読者」を開く旧入口",
    // ブラウザ版の確認用（相談へ渡す機能の一覧には出る）
    "novelai.diagnoseWeb": "ブラウザ版の確認用",
  };

  function routesOf(command: string): string[] {
    const routes: string[] = [];
    if (STEP_REFERENCED_COMMANDS.includes(command)) {
      routes.push("簡単ステップメニュー");
    }
    if (menuCommands.has(command)) routes.push("右クリック・見出しのボタン");
    if (manifestText.includes(`command:${command})`)) {
      routes.push("設定の説明・道案内のリンク");
    }
    const inside = INSIDE[command];
    if (
      inside &&
      readFileSync(
        new URL(`../../../${inside.file}`, import.meta.url),
        "utf8"
      ).includes(inside.marker)
    ) {
      routes.push(inside.where);
    }
    return routes;
  }

  const hidden = allActions().filter((action) => action.hiddenFromActionList);

  test("外した操作は、どれもパレットのほかに入口を持つ", () => {
    const stranded = hidden
      .filter((action) => !PALETTE_ONLY[action.command])
      .filter((action) => routesOf(action.command).length === 0)
      .map((action) => `${action.command}（${action.label}）`);

    expect(stranded).toEqual([]);
  });

  test("パレットだけの操作は、本当にパレットに出ている", () => {
    for (const command of Object.keys(PALETTE_ONLY)) {
      expect(paletteHidden.has(command), command).toBe(false);
      // 表は「ほかに入口が無いもの」だけ。入口ができたら表から外す
      expect(routesOf(command), command).toEqual([]);
    }
  });

  /**
   * **2026-09-24 に外した4つ**（B10①）。入口を名指しで確かめる——
   * 数だけ見ていると、ステップから外されてもほかの1本で通ってしまう。
   */
  test("2026-09-24 に外した4つは、決めた入口から呼べる", () => {
    expect(routesOf("novelai.addForeshadow")).toContain("簡単ステップメニュー");
    expect(routesOf("novelai.setForeshadowStatus")).toContain(
      "簡単ステップメニュー"
    );
    expect(routesOf("novelai.renameCharacter")).toContain(
      "名前点検の画面の「付け替える」"
    );
    expect(routesOf("novelai.applyRenameToRecords")).toContain(
      "人物名変更を終えたときの知らせのボタン"
    );
    // どれもコマンドパレットに出ている（名前で呼べる）
    for (const command of [
      "novelai.addForeshadow",
      "novelai.setForeshadowStatus",
      "novelai.renameCharacter",
      "novelai.applyRenameToRecords",
    ]) {
      expect(paletteHidden.has(command), command).toBe(false);
      const action = allActions().find((item) => item.command === command);
      expect(action?.hiddenFromActionList, command).toBe(true);
    }
  });
});
