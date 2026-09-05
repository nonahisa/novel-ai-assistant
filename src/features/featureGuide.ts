import { ACTION_TREE, visibleEntries } from "../views/actionList";
import { canRunProcesses } from "../core/runtime";
import {
  selectGuideBundles,
  type GuideBundle,
  type GuideSelection,
} from "../core/guideSelect";

/**
 * 「この拡張機能の使い方」をAIへ渡すための説明を組み立てる。
 *
 * 作者から「AIに統合執筆環境の拡張機能の使い方を質問したら、
 * わかりやすく説明できるようにしたい」と要望があった（2026-08-15）。
 *
 * **説明書を別に手で書かない。** 操作メニューの定義（`ACTION_TREE`）には、
 * 全操作の名前と「何が起きるか」が既に日本語で書いてある。そこから作れば、
 * 機能を足したときに説明が古びない。手書きの説明書を持つと、**必ず**
 * 実装と食い違い、しかも食い違ったことに誰も気づけない。
 *
 * 操作メニューに出ないもの（パネル類・右クリック・考え方）だけを、
 * ここで補う。
 *
 * ## 毎回送るので、短くする（2026-08-27）
 *
 * この一覧は**相談の1回ごとに毎回**送っている。測ったところ8,111字あり、
 * **1回の問いかけで送る量の半分**を占めていた（本文は19%しかない）。
 * 設計書には「約4,300字」とあるが、機能を足すたびに自動で伸びるので、
 * **誰も気づかないまま倍近くになっていた。**
 *
 * **名前は全部残し、説明は要るところだけにする。** 機能の名前が欠けると
 * 「その機能はありません」と嘘を答える。残すのは**1文目**（何ができるか）と、
 * **「〜ません」で終わる文**（しないことの断り）だけにする。後者を落とすと、
 * 「原稿は書き換えません」「AIは使いません」が消えて、AIが逆を答えかねない。
 *
 * ## 短くするだけでは足りなかった（2026-08-29）
 *
 * 上のやり方で5,097字まで縮めたが、機能を足すたびにまた伸び、
 * **上限のテストを引き上げ続ける**ことになった（6,000→6,300字）。
 * 送る量が機能数に比例する形そのものが行き止まりである。
 *
 * そこで**目次と説明を分けた。**
 *
 * - `buildFeatureIndex()`——**全操作の名前だけ**。毎回送る。名前が全部あれば
 *   「その機能はありません」と嘘を答える心配は残らない
 * - `buildGuideBundles()`——小分類ごとの説明の束。**質問に関係しそうな束だけ**
 *   を選んで送る（選ぶのは `core/guideSelect.ts`）
 *
 * 全文をひとまとめに組み立てる `buildFeatureGuide()` は、この2つへ置き換えた
 * 時点で誰からも呼ばれなくなったので**消した**（0.25.2）。束に漏れが無いか
 * どうかは、全文と突き合わせる代わりに `ACTION_TREE` を直接歩いて確かめる
 * （`featureGuide.test.ts`）——**元になる定義と照らすほうが、写しどうしを
 * 比べるより確かである。**
 * 作者が読むマニュアル（`openManual.ts`）は `EXTRA_GUIDE` だけを使い、
 * 操作の説明は `ACTION_TREE` から独自に（全文で）組み立てている。
 */

/**
 * 操作メニューに出ない事柄。
 *
 * ここに書くのは「メニューの項目では説明できないこと」に限る。
 * 個々の操作の説明を書き足すと、`ACTION_TREE` との二重管理になる。
 *
 * 【メニューに出ないボタンと振る舞い】は、**パネルの中のボタン**（相談・提案・
 * EPUBエディター・執筆統計）と、**作者が押さないのに働くもの**（独り言・
 * 順番待ち）を置く場所である。どれも `ACTION_TREE` に項目が無く、
 * 目次を歩いても名前が出てこない——**名前が無いものを、AIは「ありません」と
 * 答える。** そこで、この節の名前だけは目次にも並べる（`extraGuideNames`）。
 * 名前と場所は「- 名前（場所）: 説明」の形で書くこと。切り出しがこの形に
 * 頼っている。
 *
 * **作者向けのマニュアル（`openManual.ts`）もここを使う。** AIへ渡す説明と
 * 作者が読む説明で、書いてあることが違ってはいけない。文面を2か所に持つと、
 * 片方だけ直したときに「AIの言うことと、マニュアルの記述が違う」ことになる。
 */
export const EXTRA_GUIDE = `
【画面】
- 作品一覧（左）: 登録した作品と話数。話を右クリックすると「この話の誤字脱字を検知」「ファイルを削除」が出る
- 簡単ステップメニュー（左）: 作品づくりの流れ（1.作品登録→2.新作構想→3.作品執筆→4.自己校正→5.投稿脱稿→6.編集部校正・校閲→7.電子出版等）に沿って主な操作を並べたメニュー。最下段に「ヘルプ」がある。最上段で選んだ作品にだけ効く。ほとんどの操作は詳細メニューにもある
- 設定管理（詳細メニュー →「拡張機能の設定」→「設定管理を開く」）: 文字数の数え方や待ち時間などの設定。セットアップ・意味検索の準備・機能ごとのAI割り当て・作者と編集者の切り替えは、該当する設定の説明の下のリンクから実行する
- 詳細メニュー（左）: 下に並ぶ操作の一覧。分類→小分類→操作の3階層
- AIに相談（左）: この画面。開いているファイルについて日本語で相談できる
- 設定資料（エディター領域）: 登場人物・能力・組織・場所・世界観を見て、書き換えたり、AIに相談したりする画面
- 提案（下段）: 誤字脱字・表記ゆれの指摘が並ぶ。1件ずつ「適用」「無視」を選ぶ
- 本文やMarkdownを右クリックすると「設定情報を表示」「AIに相談する」が出る

【メニューに出ないボタンと振る舞い】
- 相談を資料へ反映（相談パネル）: いまの会話から、作者が決めた人物の設定を拾って承認待ちへ積む。AIに相談パネル（横の細いパネル・大きい画面のどちらにもある）の入力欄の下のボタン。承認するまで資料は変わりません。会話を積んだ作品にだけ反映できます
- AIに訊く（提案パネルの表記ゆれ）: どちらの表記に揃えるとよいかを、理由つきで指摘の下に出す。提案パネルの表記ゆれの指摘1件ずつに付くボタン。本文は書き換えません
- EPUBエディターの右の並び: 本に入る面（表紙・目次・話・奥付など）を、ドラッグで並べ替え、右クリックで挿入・削除・保留にする。保留にした面はプレビューでは見られますが、本には入りません。書き出しのボタンもエディターの中にあります
- 貼り込み係へ渡す形でコピー（新話を投稿する）: 変換済みの本文を、相棒のブラウザ拡張「貼り込み係」が投稿画面の欄へ流し込める形でコピーする。「新話を投稿する」の案内の中から選ぶ。カクヨムとアルファポリスにしか出ません。送信は必ず作者が押します
- Xへ貼り付ける（更新告知文）: 告知文と作品一覧のURLを入れた状態で、Xの投稿画面を開く。「更新告知文を作る」の結果の画面にあるボタン。投稿ボタンは作者が押します
- サイトの記録（執筆統計パネル）: 投稿サイトごとの作品情報と、書き留めたランキングの履歴を並べる。小説家になろうには「分析（Narou.fun）を開く」リンクも出る。順位は手入力で、投稿サイトへ自動でアクセスすることはありません
- AIの独り言の感想（相談パネル）: 保存した本文を読んで、AIがたまに一言だけ感想を言う。無料の手元のAIのときだけ、ほかに言うことが無いときだけ出る。設定「novelai.chatter.enabled」を切ると止まります
- AI機能の順番待ち: AIを使う操作を2つ以上動かすと「（先客の名前）の完了を待っています…」と出て、順番に処理される。同時には走らせません。中止ボタンで列から抜けられます

【ファイルの置き場所】
- 本文: 作品フォルダーの直下、または「本文」フォルダー
- 設定/plot.md: プロット
- 設定/synopsis.md: 作品紹介文・キャッチコピー・各話あらすじ（読み物）
- 設定/characters/ 設定/locations/ など: 設定資料の本体（JSON）
- 設定/characters.md など: 設定資料の読み物。JSONから作り直されるので、直すならJSON側か設定資料パネル

【この拡張機能の考え方】
- 本文（原稿）は勝手に書き換えない。AIの指摘は必ず作者が1件ずつ確認して適用する
- 既にいる人物への変更は、その場では書き換えず「更新分を反映」で承認してから入る
- 作者が書き直した内容（作者メモなど）はAIが上書きしない
- 同じ本文を二度AIに読ませない。処理済みは記憶され、本文を変えた分だけ作り直す
- AIを呼ぶ操作には「AI」の印が付く。クラウドのAI（Claude・ChatGPT・Gemini）は実行のたびに課金され、Ollamaは無料
`.trim();

/**
 * 操作の**目次**を作る。名前だけで、説明は入れない。
 *
 * **これは毎回送る。** 名前が1つでも欠けると、AIは「その機能はありません」と
 * 嘘を答える。逆に名前さえ揃っていれば、説明が手元に無い操作でも
 * 「詳細メニューのここにあります」とは答えられる。
 *
 * 末尾に【この拡張機能の考え方】を付ける。「原稿は勝手に書き換えない」
 * 「作者が書いた内容は上書きしない」は、**どんな相談でもAIが逆を答えては
 * いけない**ことなので、質問の中身にかかわらず常に渡す。
 */
export function buildFeatureIndex(): string {
  const lines: string[] = ["【詳細メニューの操作（これで全部）】"];

  // **画面に無い操作を案内させない。** 環境によって出さない操作があるので、
  // 一覧も同じ規則で絞る（`isItemVisibleInRuntime`）。絞り方は
  // `buildGuideBundles()` と揃える——片方だけ規則が違うと、目次に出るのに
  // 説明が無い（またはその逆の）操作ができる
  const allowsProcesses = canRunProcesses();

  for (const group of ACTION_TREE.filter((entry) => !entry.generated)) {
    lines.push(`■ ${group.label}`);
    for (const entry of visibleEntries(group.entries, allowsProcesses)) {
      if (entry.kind === "action") {
        lines.push(nameOnly(entry, ""));
        continue;
      }
      lines.push(`  ▸ ${entry.label}`);
      for (const item of visibleEntries(entry.items, allowsProcesses)) {
        lines.push(nameOnly(item, "  "));
      }
    }
  }

  return [
    lines.join("\n"),
    "",
    // メニューに無いもの（パネルの中のボタン・黙って働く振る舞い）も、
    // 名前だけは毎回渡す。ここが抜けると「そんな機能はありません」になる
    extraGuideNames("メニューに出ないボタンと振る舞い"),
    "",
    extraGuideSection("この拡張機能の考え方"),
  ].join("\n");
}

/**
 * 説明を、小分類ごとの束に切る。
 *
 * **なぜ小分類の単位か。** 作者は「誤字脱字はどこ？」のように、機能を1つ
 * 名指しして聞く。だが答えるときは近くの操作もいっしょに見せたほうがよい
 * （表記ゆれ・推敲は同じ小分類にある）。1操作ずつに切ると関連が切れ、
 * 分類ごとに切ると1束が大きくなりすぎる。
 *
 * 分類の直下にある操作は、その分類の名前だけの束にする。
 */
export function buildGuideBundles(): GuideBundle[] {
  const allowsProcesses = canRunProcesses();
  const bundles: GuideBundle[] = [];

  // 写しの分類（「テスト中」）は案内に入れない。同じ機能を2回案内することになる
  for (const group of ACTION_TREE.filter((entry) => !entry.generated)) {
    const entries = visibleEntries(group.entries, allowsProcesses);

    const direct = entries.filter((entry) => entry.kind === "action");
    if (direct.length > 0) {
      bundles.push({
        key: `group:${group.label}`,
        label: group.label,
        text: [
          `■ ${group.label}`,
          ...direct.map((item) => describeAction(item, "")),
        ].join("\n"),
      });
    }

    for (const entry of entries) {
      if (entry.kind !== "section") continue;
      const items = visibleEntries(entry.items, allowsProcesses);
      if (items.length === 0) continue;
      // 画面の階層をそのまま名前にする。作者が見ている道順と
      // 記録に残る名前が違うと、後から追えない
      const label = `${group.label} → ${entry.label}`;
      bundles.push({
        key: `section:${group.label}/${entry.label}`,
        label,
        text: [
          `■ ${label}`,
          ...items.map((item) => describeAction(item, "")),
        ].join("\n"),
      });
    }
  }

  // 操作メニューに出ないもの（画面・置き場所）も、聞かれることのある話題
  // なので束にする。【この拡張機能の考え方】は目次に常に付くので入れない
  bundles.push({
    key: "screen",
    label: "画面",
    text: extraGuideSection("画面"),
  });
  // 目次には名前しか出せないので、説明はここで受け持つ。
  // 「どこにあるか」を知りたい質問（「保留ってどこ？」）はここに当たる
  bundles.push({
    key: "hidden",
    label: "メニューに出ないボタンと振る舞い",
    text: extraGuideSection("メニューに出ないボタンと振る舞い"),
  });
  bundles.push({
    key: "files",
    label: "ファイルの置き場所",
    text: extraGuideSection("ファイルの置き場所"),
  });

  return bundles;
}

/**
 * 相談1回ぶんの「使い方の説明」を組み立てる。
 *
 * 目次（全操作の名前）は常に、説明は質問に関係しそうな束だけ。
 * `selected` は何を渡したかの記録用（`label` の並び）。
 */
export function buildFeatureGuideForQuestion(input: {
  question: string;
  /** 直前の作者の発言。「それはどこ？」のような追い質問で話題を引き継ぐ */
  recentAuthorTurns?: string[];
}): { text: string; selected: string[]; reason: GuideSelection["reason"] } {
  const selection = selectGuideBundles({
    question: input.question,
    recentAuthorTurns: input.recentAuthorTurns,
    bundles: buildGuideBundles(),
  });

  const blocks = [buildFeatureIndex()];
  if (selection.selected.length > 0) {
    // **目次と説明を見出しで分ける。** どちらも「■ 分類」で始まるので、
    // 見出しが無いと「説明のある操作だけが全部」と読まれかねない
    blocks.push(
      [
        "【関係しそうな操作の説明（ここに無い操作も、目次のものは全部あります）】",
        ...selection.selected.map((bundle) => bundle.text),
      ].join("\n\n")
    );
  }

  return {
    text: blocks.join("\n\n"),
    selected: selection.selected.map((bundle) => bundle.label),
    reason: selection.reason,
  };
}

/**
 * `EXTRA_GUIDE` から【…】の節を1つ取り出す。
 *
 * 目次（考え方）と束（画面・置き場所）で使い分けるが、**文面は1か所に
 * しか持たない。** 写しを作ると、片方だけ直したときに気づけない。
 */
function extraGuideSection(title: string): string {
  const heading = `【${title}】`;
  const lines = EXTRA_GUIDE.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) return "";

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("【"));
  const body = end === -1 ? rest : rest.slice(0, end);
  return [heading, ...body].join("\n").trim();
}

/**
 * `EXTRA_GUIDE` の節から、**名前だけ**を取り出して目次の形にする。
 *
 * 「- 名前（場所）: 説明」の、コロンの前だけを残す。**名前の写しを
 * 目次側に持たない**——2か所に書くと、片方だけ直したときに気づけない
 * （この決まりは `extraGuideSection` と同じ理由）。
 */
function extraGuideNames(title: string): string {
  const section = extraGuideSection(title);
  if (!section) return "";

  const lines = section.split("\n");
  const names = lines
    .filter((line) => line.startsWith("- "))
    // 説明の中にコロンが現れても、名前は最初のコロンまでで決まる
    .map((line) => `・${line.slice(2).split(": ")[0]}`);
  return [lines[0], ...names].join("\n");
}

/**
 * 目次の1行。名前と、AIを使うかの印だけ。
 *
 * 印は「・」1文字にする。説明の側（`describeAction`）は「  - 名前: 説明」
 * なので、**見た目でどちらの一覧かが分かる**。81行あるので、行頭の記号を
 * 1文字削るだけで240字ほど変わる。
 */
function nameOnly(
  action: { label: string; usesAI?: boolean },
  indent: string
): string {
  const mark = action.usesAI ? "（AIを使う）" : "";
  return `${indent}・${action.label}${mark}`;
}

/**
 * 説明の1行。
 *
 * **短い版しか作らない。** 全文を渡す口（`detail: "full"`）は
 * `buildFeatureGuide()` と一緒に消した（0.25.2）——束はどれも
 * 相談へ渡すためのものなので、全文が要る場面が無い。
 */
function describeAction(
  action: { label: string; detail: string; usesAI?: boolean },
  indent: string
): string {
  // 強調の記号は画面用なので落とす。AIへの指示と混ざると読みにくい。
  // 記号そのものを文字列に書かない（画面に出す文字を見張る試験に引っかかる）
  const emphasis = "*".repeat(2);
  const detail = shorten(action.detail.split(emphasis).join(""));
  const mark = action.usesAI ? "（AIを使う）" : "";
  return `${indent}  - ${action.label}${mark}: ${detail}`;
}

/**
 * 説明を短くする。**毎回送るので、要る分だけ残す。**
 *
 * 残すのは2種類だけである。
 *
 * 1. **1文目**——この作品の説明文は「何ができるか」を1文目に書く決まりで
 *    揃えてある
 * 2. **「〜ません」で終わる文**——「原稿は書き換えません」「元のフォルダーは
 *    消しません」「AIは使いません」。**しないことの断りは、作者がいちばん
 *    知りたいこと**であり、落とすとAIが「する」と答えかねない
 *
 * 2文目以降の但し書き（使いどころ・言い換え・例）は落とす。
 */
export function shorten(text: string): string {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return text.trim();

  const kept = [sentences[0]];
  for (const sentence of sentences.slice(1)) {
    // 「〜ません」「〜しません」。**しないことの断りは落とさない**
    if (/ません[。」]?$/.test(sentence.trim())) kept.push(sentence);
  }
  return kept.join("");
}

/** 句点で文に割る。句点そのものは前の文へ付ける */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const char of text.trim()) {
    current += char;
    if (char === "。") {
      out.push(current);
      current = "";
    }
  }
  if (current.trim()) out.push(current);
  return out;
}
