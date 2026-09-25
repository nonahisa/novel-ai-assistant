import type { ActionItem } from "../views/actionList";
import { STEP_REFERENCED_COMMANDS } from "../views/stepMenu";

/**
 * 詳細メニューに**出さない**操作（`hiddenFromActionList`）の、実際の入口
 * （設計書6.56.3）。
 *
 * **マニュアル（`openManual.ts`）と相談の目次（`featureGuide.ts`）が同じものを
 * 引く。** 以前はマニュアルだけが入口を添え、相談の目次は外す前の分類の下に
 * 名前を並べたままだった。AIはそれを写して「詳細メニューの『原稿整備』→
 * 『ルビ付与』」と案内し、作者が開いても見つからなかった（0.86.10 の担当の報告）。
 * 2か所に書くと片方だけ古くなるので、ここ1か所に置く。
 *
 * **どこにあるかは、手で書かずに導く。** 簡単ステップメニューが参照して
 * いるか（`STEP_REFERENCED_COMMANDS`）で見分けられる——参照されていれば
 * そちらから、いなければ設定管理の説明のリンクから使う操作である。
 * 導き方では当てられない入口だけを `SPECIAL_ENTRANCES` に書く。
 */
export interface ActionEntrance {
  /**
   * 入口のまとまり（相談の目次で、同じ入口の操作を1行にまとめる見出し）。
   * 目次は毎回送るので、操作ごとに長い案内を付けると伸びすぎる
   */
  place: string;
  /** 入口の案内（マニュアルと説明の束に出す。括弧は付けない） */
  text: string;
}

/** 原稿エディターの中にある操作のまとまり（目次の見出し） */
const IN_MANUSCRIPT_EDITOR = "原稿エディター（上のバー・下段・右クリック）";

/**
 * 導き方では当てられない入口（作者の指定、2026-09-03）。
 *
 * 導き方は「簡単ステップメニューが参照しているか」で入口を当てる。ふつうは
 * それで足りるが、**入口がメニューの外にある操作**は当てられない——導きに
 * 任せると「設定管理の説明のリンクから」と、存在しない道を書いてしまう。
 *
 * **例外はここへ集める。** 説明文（`detail`）へ書き足す手もあるが、detail は
 * メニューのホバーにも出るので、入口の一文が3か所に散らばることになる。
 */
const SPECIAL_ENTRANCES: Readonly<Record<string, ActionEntrance>> = {
  // 相談の画面だけは入口がメニューの外にある——横の細いパネル（本文の
  // 右クリックから開く）の「メインに表示」ボタンが、大きく開くいちばん近い道
  "novelai.openChatPanel": {
    place: "「AIに相談」パネルの「メインに表示」",
    text:
      "横の「AIに相談」パネルの「メインに表示」ボタンから。" +
      "簡単ステップメニューにもあります",
  },
  // 入口をエディターの中へ一本化した（作者の指定、2026-09-04）
  "novelai.exportEpub": {
    place: "EPUBエディターの中",
    text: "EPUBエディターの中の「EPUBを書き出す」ボタンから",
  },
  /*
    **2026-09-23 のメニューの組み直しで画面から外したもの**（作者の裁定）。
    どれも入口がメニューの外（原稿エディター・作家タイプ診断・矛盾検知の中）にある。
  */
  "novelai.openSceneMemos": {
    place: IN_MANUSCRIPT_EDITOR,
    text: "原稿エディターの右クリックから。簡単ステップメニューにもあります",
  },
  "novelai.openVertical": {
    place: IN_MANUSCRIPT_EDITOR,
    text: "原稿エディターの上のバー「縦書き」か、本文の右クリックから",
  },
  "novelai.readManuscriptAloud": {
    place: IN_MANUSCRIPT_EDITOR,
    text: "原稿エディターの上のバー「読み上げ」から",
  },
  "novelai.dictationClean": {
    place: IN_MANUSCRIPT_EDITOR,
    text: "原稿エディターの下段「口述」→「整える」から。普通のエディターではコマンドパレットから",
  },
  "novelai.addRuby": {
    place: IN_MANUSCRIPT_EDITOR,
    text: "原稿エディターの上のバー「ルビ」か、右クリックから",
  },
  "novelai.addEmphasis": {
    place: IN_MANUSCRIPT_EDITOR,
    text: "原稿エディターの上のバー「傍点」か、右クリックから",
  },
  "novelai.copyForPosting": {
    place: IN_MANUSCRIPT_EDITOR,
    text:
      "原稿エディターの上のバー「投稿用にコピー」か、右クリックから。" +
      "簡単ステップメニューにもあります",
  },
  "novelai.setAdvicePolicy": {
    place: "「作家タイプ診断」の中",
    text: "「作家タイプ診断」の「助言の受け方」から。コマンドパレットにもあります",
  },
  "novelai.setAuthorReaderType": {
    place: "「作家タイプ診断」の中",
    text: "「作家タイプ診断」の「読者としての好み」から。コマンドパレットにもあります",
  },
  "novelai.checkFactContradictions": {
    place: "「矛盾検知」の中",
    text: "「矛盾検知」を押して「話どうしの照合だけ」を選ぶ。コマンドパレットにもあります",
  },
  /*
    **導き方では「設定管理の説明のリンクから」と、無い道を書いていたもの**
    （0.86.10 の担当の報告を受けて見直した、2026-09-25）。どれも入口は
    別の画面の中のボタンである（`actionList.ts` の各項目の注記のとおり）
  */
  "novelai.renameCharacter": {
    place: "「名前点検」の画面",
    text: "「名前点検」の画面の「付け替える」から。コマンドパレットにもあります",
  },
  "novelai.applyRenameToRecords": {
    place: "人物名変更が済んだときの知らせ",
    text: "人物名変更が済んだときの知らせのボタンから。コマンドパレットにもあります",
  },
  "novelai.openTargetSheet": {
    place: "「ターゲット読者」の中",
    text: "「ターゲット読者」の「いまの材料でシートを作り直す」から",
  },
  "novelai.showThreeCircles": {
    place: "「ターゲット読者」の中",
    text: "「ターゲット読者」で作るシートの「3つの輪」の節に出ます",
  },
  "novelai.diagnoseWeb": {
    place: "コマンドパレット",
    text: "コマンドパレットから。ブラウザ版の確かめ用",
  },
};

/** 簡単ステップメニューから使う操作 */
const FROM_STEP_MENU: ActionEntrance = {
  place: "簡単ステップメニュー",
  text: "簡単ステップメニューから",
};

/** 設定管理の説明のリンクから使う操作 */
const FROM_SETTINGS: ActionEntrance = {
  place: "設定管理の説明のリンク",
  text: "設定管理の説明のリンクから",
};

/**
 * 実際の入口。**詳細メニューに出る操作なら undefined**（入口は詳細メニューそのもの）。
 */
export function entranceOf(action: ActionItem): ActionEntrance | undefined {
  if (!action.hiddenFromActionList) return undefined;
  return (
    SPECIAL_ENTRANCES[action.command] ??
    (STEP_REFERENCED_COMMANDS.includes(action.command) ? FROM_STEP_MENU : FROM_SETTINGS)
  );
}
