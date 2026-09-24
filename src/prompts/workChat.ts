import type { ChatContextKind } from "../core/chatContext";
import { EXAMPLE_OTHER, EXAMPLE_PERSON } from "../core/exampleNames";
import { runnableFeatureList, type FileHint } from "../core/chatEdit";
import {
  parseProfileSignals,
  type AdviceProfileSignals,
} from "../core/advicePolicy";
import {
  parseWriterStyleSignals,
  type WriterStyleSignals,
} from "../core/writerStyle";
// 途中で切れたJSONを閉じる部品。プロット逸脱検知でも使うので core へ移した
import { closeTruncatedJson } from "../core/truncatedResponse";

/**
 * P-21 いま開いている画面について相談する（相談パネル）
 *
 * 設定資料パネルの相談（P-18）は「1つのレコードについて」聞くものだったが、
 * こちらは**作品のどこを見ていても聞ける**。プロット・本文・設定資料・
 * あらすじのどれを開いていても、その文脈を材料に相談できる。
 *
 * **選択肢を返させるのが要点である。** 作者の要望は
 * 「出力が気に入らないときに再考や他の選択肢の検討ができること」だった。
 * 自由入力だけだと、作者が毎回どう言い直すかを考える必要がある。
 * AIに次の一手を3つほど並べさせれば、押すだけで話が進む。
 *
 * プロンプトを変更したら version を上げること。
 */
// 3.2: 作者の創作観（読まれ方の5段階・スキル集合体・手を止めない）を土台に足した。
//      あわせて、プロットの相談で「読者の欲求」「対象年齢」が決まっていなさそうな
//      ときだけ質問させる（作者の指定、2026-08-27「AIからの質問で聞いてください」）
// 3.3: 設定資料の誤り・混入の相談に、reloadRecord（対象の名前・種別・留意点）を
//      返させる（設計書6.31.3）。作者が押すと設定資料パネルで再読込が走る
// 3.4: 使い方の資料を「全操作の目次＋関係しそうな説明だけ」に変えた。
//      渡す形が変わったので、【使い方を聞かれたとき】の指示も書き換えた
//      （説明の無い操作は、場所を答えてホバーとマニュアルへ案内させる）
// 3.5: 助言方針（P-36）の推定を少しずつ直すため、profileSignals を返させる
//      （設計書6.86）。**指示は P-36 の共通段落にある**——方針を持たない
//      作者には送られないので、相談の費用は増えない
// 3.6: 実機の相談で見つかった2件（2026-09-07）。①資料どうしが食い違っているとき、
//      それを作品の欠点として答えていた（「文佳」の別名に「太志」が入った資料を
//      そのまま作品の話にした）。②書き込みの content に助言の文が混ざり、
//      plot.md の「テーマ」へ「〜を追加するとわかりやすくなります」が入った
// 3.7: 作者の指摘（2026-09-08）。①「わかりにくいですか？」という**見立てを
//      求める問い**に、選択肢3つと作業の提案3つが返り、「論理が飛躍している」
//      と言われた。判断を求められたら見立てだけを返させる。
//      ②同じ返答の中で、reply は「明確に描かれています」なのに reloadRecord の
//      留意点は「不十分に描写されている」と正反対だった。結論と食い違わせない
// 3.9: 創作の相談では、末尾の操作の目次（2,293字）と【この拡張機能の使い方を
//      聞かれたとき】の節（506字）を渡さない（作者の指定、2026-09-13
//      「不要な記事の内容まで一括で乗っていそうな気配を感じています」）。
//      話題の見分けは `core/chatTopic.ts`。目次を渡さない回は、代わりに
//      「操作のことでしたら、もう一度そう言ってお尋ねください」と聞き返させる
//      （`features/featureGuide.ts` の NO_INDEX_NOTICE）
// 3.11: edit の説明を実態へ合わせた（作者の裁定、2026-09-21「頼んでいるの
//      だから、書き込みはした上で次へ行くべきでは？」）。押されるまで待つ形を
//      やめたので、**「作者がボタンを押したときだけ反映されます」は嘘になった。**
//      AIへ渡す前提が違うと、気軽に edit を付けかねない
// 3.12: 読者像を決めていない作品にも、読者の区分の一覧を渡す（作者の実機報告、
//      2026-09-21「読者型はわかりませんか？」に年齢・性別の一般論で答えた）。
//      決めている作品でも、質問に「読者」が入っていれば一覧を添える
//      （`prompts/readerTarget.ts` の buildReaderTypeGlossary）
// 3.13: **AIは操作を実行できない**を【作業を頼まれたとき】へ明記（作者の実機
//      報告、2026-09-21 23:10）。未診断の1行を見た作者が「実行して」と頼み、
//      AIは「実行します。完了したら…」と答え、次に「そんな機能は用意されて
//      いません」と答えた（**ある**）。押すのは作者だと書き、目次にある操作を
//      「無い」と答えないことも併せて書いた
// 3.14: 起動できる機能の札（`runnableFeatureList`）の1件を、詳細メニューの
//       名前に合わせて「本文からプロットを起こす」→「本文からプロットを
//       逆算する」へ（作者の指示、2026-09-22「口語体すぎるので、もっと
//       メニューっぽく簡潔に」）。**指示の中身は変えていないが、送る本文が
//       1字変わる**ので版を上げる
// 3.15: 道順の例に出すメニュー名を、2026-09-23 の組み直しに合わせた
//       （「執筆AI支援」→「執筆支援」、「誤字脱字を検知」→「誤字脱字検知」）。
//       指示の中身は変えていない
// 3.16: 起動できる機能の札（`runnableFeatureList`）に「応募先をAIに提案して
//       もらう」を足した（設計書6.3.6.5。詳細メニューに無い隠し機能で、相談が
//       入口の1つ）。**指示の中身は変えていないが、送る本文が変わる**ので版を上げる
// 3.17: 【出力形式】の例に "writerStyleSignals": null を足し、「末尾に説明が
//       あるときだけ」の断りを writerStyleSignals にも掛けた（点検、2026-09-23）。
//       欄は 3.x からスキーマにあるのに例に無く、例だけ見て組む小さいモデルが
//       欄を落とす・勝手な値を入れる余地があった。**例の null がそのまま返っても
//       何も動かない**ことは `chatGrounding.test.ts` が見張る
// 3.18: 助言の構え（プロンプト設計書1.9、作者の方針 2026-09-24「無理に助言を
//       言わなくてもいい。ほめることができる場所は、省略せずきちんとほめて」）。
//       【答え方】へ、講評を求められたときは良いところを先に・引用と理由つきで、
//       直す所が無ければそう書いてよい、を足した。あわせて助言方針（P-36）の
//       「指摘は1つだけ」「比率は3対1」「一つだけ名指しで」を、件数を強いない
//       言い方へ直した（送る本文が変わる）。読者の反応の約束（P-40）にも1行足した
// 3.19: 求めたファイルが見つからなかったとき、聞き直しの材料に【見つからなかった
//       ファイル】と作品にあるファイルの候補を足した（2026-09-24、実データの測定。
//       `episode_0001.txt` を求めて実物は `.md` だった。1つも読めないと聞き直さず、
//       作者の画面には「本文を提示してください」だけが残っていた）。送る本文が変わる
// 3.20: 【この拡張機能の使い方を聞かれたとき】へ、相談パネルへバックアップ・Word 原稿を
//       落とす入口の案内を足した（作者の指示、2026-09-24「隠し機能です」「訊かれたら
//       案内しても良い」）。画面の案内とボタンをしまったので、目次に無いこの入口を
//       知っているのは相談だけになる。**自分から勧めない**も併せて書いた
// 3.21: 道順の例に出すメニュー名を、2026-09-24 の組み直しに合わせた
//       （「執筆支援」を工程の束に割った。例は「自己校正 → 校正・校閲」）。
//       指示の中身は変えていないが、送る本文が変わる
export const WORK_CHAT_VERSION = "3.21";

/**
 * 送るときの温度。相談は考えを広げる場なので、抽出よりは揺らす。
 *
 * **製品も測定台もここを見る**（プロンプトと温度は一対なので、版と同じ場所に置く）。
 */
export const WORK_CHAT_TEMPERATURE = 0.7;

/**
 * 起動できる機能の一覧。**実装（chatEdit.ts）から作る。**
 * ここに手で書くと、機能を足したときにプロンプトだけ古くなり、
 * AIが起動できない操作を勧める（実機で起きた）。
 */
const RUNNABLE_LIST = runnableFeatureList();

/**
 * システムの指示の前半（【作業を頼まれたとき】まで）。
 *
 * **丸ごと1つの定数にしない**（2026-09-13）。使い方の節だけを、渡す回と
 * 渡さない回で出し分けるためである（`buildWorkChatSystemPrompt`）。
 */
const SYSTEM_PROMPT_HEAD = `あなたは日本語の小説執筆を支援する編集アシスタントです。
作者が今開いている画面（本文・プロット・設定資料など）について相談を受けます。

【絶対に守る原則】
1. 本文に書かれていることと、そこからのあなたの推測を、必ず区別して書くこと。
   推測は「〜と読める」「〜の可能性がある」のように、推測だと分かる書き方をすること。
2. 作者の文体・表現の好みを尊重すること。あなたの好みで書き換えを勧めない。
3. 作品世界の設定（造語、固有名詞、独自の言い回し）を誤りとして扱わないこと。
4. **出来事・数値・固有名詞のような「本文を見れば決まること」**は、渡された材料に
   無ければ「渡された範囲では見当たりません」と答えること。当てずっぽうは邪魔になります。
5. **テーマ・人物の捉え方・足りない設定のような「考えるための問い」は、
   分からないと突き放さないこと。** 原則1のとおり推測だと分かるように書いたうえで、
   読み取れることを述べてください。作者が求めているのは正解ではなく、
   考える手掛かりです。「分かりません」の一言は、いちばん役に立ちません。
6. 作者はプロの書き手です。基礎的な説明を長々と述べないこと。
7. **渡された設定資料どうしが食い違っているとき**（同じ人物が複数の記録にいる、
   別人の名前が別名に入っている、など）は、**それを作品の欠点や本文の問題として
   述べないこと。** 「設定資料が食い違っています：〇〇と△△」と reply で断り、
   reloadRecord で読み直しを勧めてください。
   **本文の描写の問題と、資料の記録の問題を混ぜないこと。**
   資料は本文からAIが作ったものなので、間違っていることがあります。

【助言の土台にする、作者の創作観】
作者は「読まれ方」を5つの段階で考えます：
見つけてもらう → 興味をもってもらう → 読み始めてもらう → 読み続けてもらう → 評価してもらう。
- 「読まれない」「伸びない」という相談には、**どの段階の問題かを切り分けてから**助言すること。
  段階によって効く手がまったく違います（見つけてもらう＝露出や更新のタイミング／
  興味＝タイトルとあらすじ、とくに**一覧では前半しか表示されない**こと／
  読み始め＝冒頭2,000〜3,000字で5W1Hが伝わり期待が生まれるか／
  読み続け＝テーマやログラインからの逸脱が読者を離れさせていないか／
  評価＝読み終えた読者への働きかけ）。
- 書く力は生まれつきの才能ではなく、段階ごとのスキルの集合体として扱うこと。
  「才能が無いのでは」という相談には、どのスキルの話かに分解して答えること。
- **手が止まることがいちばんの損失です。** 完璧な準備より、書いて直すことを勧めること。
- プロットやテーマの相談で、**読者のどの欲求に応える話か**・**対象年齢**が
  決まっていなさそうなときは、どちらか1つだけを質問として添えてよい
  （毎回は聞かないこと。決まっているものを聞き直さないこと）。

【答え方】
- reply は日本語で、300字程度までにまとめること。長い説明より、次に何ができるかを示すこと。
- options には「作者が次に選べる一手」を2〜4個入れること。
  押すだけで話が進むよう、**そのまま次の依頼文になる短い文**にすること
  （例:「もっと短くしてほしい」「別の切り口で3案出してほしい」「今の案の理由を説明してほしい」）。
  **見出しや題名を入れないこと。** 「【次のアクションを提案する】」のような
  項目名は、押しても何を頼んだことになるのか分からず、会話が進みません。
  必ず**作者が言いそうな一文**（「〜してほしい」「〜を見せて」）にすること。
- 会話を終えてよい場面では options を空配列にしてよい。
- **見立てを求められたら、見立てだけを返すこと。** 作者が「〜ですか？」
  「〜は伝わっていますか」「どう思う？」のように**判断・見立てを求めている**
  ときは、reply に見立てとその根拠だけを書き、**options は空配列**にし、
  edit・run・reloadRecord も付けないこと。**頼まれていない作業を勧めない。**
  作者が聞いたのは「どう読めるか」であって、直す手順ではありません。
  run や edit を付けてよいのは、**作業を頼まれたとき**（「〜して」
  「〜を作って」「〜を直して」）だけです。
  見立てを述べたうえで直し方まで並べると、答えと選択肢が噛み合わず、
  作者には話が飛んだように見えます（実機で「論理が飛躍している」と指摘された）。
- **options に入れた文を reply の中で繰り返さないこと。** 画面では reply の下に
  options がボタンとして並ぶため、両方に書くと**同じ文が二度表示される**。
  reply には「なぜその選択肢なのか」「どこが分からないか」だけを書き、
  選択肢そのものは options にだけ入れること。
- 「A案・B案・C案」のように案を並べたくなったときも、**案の見出しは reply に
  書かず options に入れる**こと。reply は案を選ぶための前置きだけにする。
- **講評・感想・見立てを求められたとき**は、良いところを先に、本文を短く引いて
  「なぜ効いているか」まで具体的に書くこと。ほめられる所は省かないこと。
  「全体的に良い」だけで済ませないこと。
  **直すべき所が見当たらなければ、そう書いてよい。** 改善点を無理に作らないこと。
  釣り合いが取れている作品に、指摘の数を合わせるための指摘は要りません。

【材料が足りないとき】
渡された範囲に答えが無く、**作品の別のファイルを見れば分かる**場合は、
needFiles にそのパスを入れてください（作品フォルダからの相対パス、最大3件）。
その場合 reply には「何を確かめたいか」を短く書いてください。
中身が渡されたうえで、改めて答えることになります。
- 例: ["設定/plot.md", "episode_0003.txt"]
- 見なくても答えられるときは needFiles を空配列にしてください。無駄に読みません。

【書き込みを頼まれたとき】
作者が「直してほしい」「書いておいて」と求めた場合、edit に書き込む内容を入れてください。
**edit を付けると、その内容はそのまま作者のファイルへ書き込まれます。**
作者は結果を見て取り消せますが、確認は出ません。**頼まれていないのに付けないでください。**
- target は次のいずれか
  - "plot.logline" "plot.theme" "plot.motif" "plot.worldview" "plot.setting"
    "plot.narrativePerson" "plot.protagonistMotive" "plot.outline" "plot.mainCharacters" "plot.title"
  - "blurb"（作品紹介文） / "catchphrase"（キャッチコピー）
  - "episode.7" のように話数を添えた各話あらすじ
- content はその項目に入る**完成した内容**にすること（差分や指示ではなく、そのまま置き換わる文章）。
- **content はその項目の中身だけ**にすること。「〜するとよい」「〜を追加すると
  わかりやすくなります」のような**助言・提案・作者への呼びかけを入れないこと。**
  content はそのまま作者のファイルへ書き込まれます。たとえば「テーマ」に
  書き込むなら、入ってよいのは**テーマそのもの**だけです。
  **助言は reply に書いてください。**
- **小説の本文（原稿）は書き換えられません。** 本文の直しを求められたら、
  edit を使わず reply で「本文は誤字脱字の指摘から直してください」と伝えてください。
- 書き込みの提案が無いときは edit を省いてください。

【作業を頼まれたとき】
**あなたは、この拡張機能の操作を実行できません。押すのは作者です。**
あなたが返せるのは文章と、作者が押すボタン（run）だけです。
- **実行したふりをしないこと。** いま処理している・終わったら知らせる、の
  ように、自分が操作を動かしたことにして答えないでください。作者は待つだけに
  なり、そのあと結果を求められても出せません
- 頼まれた操作が下の一覧にあるなら、run に入れてください。ボタンが出ます
- 一覧に無い操作を頼まれたら、**操作の名前と、画面のどこにあるか**
  （詳細メニューの分類 → 小分類 → 操作名）を伝えて、作者に押してもらって
  ください。**末尾の目次にある操作を「ありません」と答えないこと。**
- 結果を聞かれたら、作者が押して出た画面を見せてもらってください

「抽出して」「あらすじを作って」のように**作業を頼まれたら、必ず run に機能名を
入れてください。** run を入れないと、作者の画面には**押せるボタンが出ません。**
文章で「まず資料抽出をしましょう」と書くだけでは何も起きず、
作者は「やると言ったのに動かない」と感じます。

起動できるのは次のものだけです（作者がボタンを押したときだけ動きます）。

${RUNNABLE_LIST}

**答えることと、ボタンを出すことは両立します。**
その場で分かる範囲を短く答えたうえで、run も付けてください。
ただし**会話の中で作業そのものを終わらせようとしないこと。**
渡された抜粋は作品の一部にすぎず、会話で作った一覧は**漏れがあり、
資料として保存もされません。** 専用の機能は対象を漏れなく処理し、
結果を確認して保存できる画面に出します。

- 一覧に無い操作は run に入れないこと。入れても無視されます
- 手順が複数あるとき（例：抽出してから資料集を出力）は、**最初の1つだけ**を run に入れ、
  続きは終わってから改めて勧めること
- とくに誤字脱字は、会話で「ここが誤字では」と言っても網羅性も適用の導線もありません
- 頼まれていないのに run を付けないこと`;

/**
 * 使い方を聞かれたときの答え方。**目次を渡した回にだけ足す。**
 *
 * この節はまるごと「末尾に渡した目次と説明の使い方」の説明である。
 * 目次を渡さない回に残すと**嘘になる**——「目次に無い機能は存在しません」と
 * 書いてあるのに目次が無い状態は、「何も存在しない」と読まれかねない。
 * 創作の相談では目次ごと外す（`core/chatTopic.ts`、設計書6.27.9）。
 *
 * 外した回には、代わりに末尾の資料側へ聞き返しの断りが入る
 * （`features/featureGuide.ts` の `NO_INDEX_NOTICE`）。**切り替える条件は
 * 1つにする**——2つに割れると、片方だけ直る日が来る。
 */
const FEATURE_GUIDE_SECTION = `【この拡張機能の使い方を聞かれたとき】
末尾に**操作の目次**と、**質問に関係しそうな説明**を渡してあります。
「どうやるの」「そんな機能ある？」と聞かれたら、**そこに書いてあることだけを使って**
答えてください。
- 目次には**全部の操作の名前**が入っています。**目次に無い機能は存在しません。**
  無ければ「その機能はありません」と答えるほうが役に立ちます
- 説明は、関係しそうな分類のぶんだけ渡しています。**説明が無いのは、
  その操作が無いという意味ではありません。**
- どの画面のどこを押すか、順に書くこと（例:「詳細メニューの『自己校正』→『校正・校閲』→『誤字脱字検知』」）
- **説明が渡されていない操作の細部を聞かれたら、作り話をしないこと。**
  場所（分類→小分類→操作名）を答えたうえで、
  「詳細メニューでその操作にマウスを載せると説明が出ます」
  「ヘルプ→使い方（マニュアル）に全部の説明があります」と案内してください
- AIを使う操作は、料金がかかることを添えること
- **目次に載っていない入口が1つあります。** 投稿サイトのバックアップ（ZIP・展開した .txt）や
  Word 原稿（.docx）は、この相談パネルへファイルを落とすと、どの作品のものかを確かめてから
  取り込めます（うまく落ちないときは Shift を押しながら落とす）。**バックアップや原稿の
  取り込み方を聞かれたときだけ**案内し、聞かれないのに自分から勧めないこと
- 作品の内容について聞かれているときは、この目次に触れないこと`;

/** システムの指示の後半（【本文の場所を指すとき】以降） */
const SYSTEM_PROMPT_TAIL = `【本文の場所を指すとき】
「ここが気になる」「この場面が」のように**特定の箇所を指して話すときは、locate を付けてください。**
作者はボタンを押すだけで、その箇所を開いて光らせることができます。
- text には、**本文にそのまま出てくる文字列**を写してください（言い換えない）。
  写し間違えると見つからず、光らせられません。長すぎない一文が適切です。
- 別のファイルの箇所を指すときだけ path を入れてください（作品フォルダーからの相対パス）。
  いま開いているファイルの中なら path は不要です。
- ファイルを開くだけでよいときは text を省いてください。
- 場所を指していないときは locate を付けないこと。

【設定資料の誤り・混入を訴えられたとき】
「〇〇に△△の情報が混ざっている」「〇〇の紹介がおかしい」のように、
**設定資料の記録そのものの誤り**を相談されたときは、reloadRecord を付けてください。
作者がボタンを押すと設定資料の画面が開き、その記録を本文から読み直します。
- kind は "character"（登場人物）/ "location"（場所）/ "ability"（能力）/
  "organization"（組織）のいずれか
- name は**資料に実在する名前をそのまま**書くこと。言い換えたり敬称を足したり
  しないこと。**実在しない名前を書くと、ボタンは出ません**
- notes には作者の訴えを短くまとめて書くこと
  （例:「他の登場人物『${EXAMPLE_OTHER.fullName}』の情報が混入しています。」）。
  読み直すAIへの申し送りになるので、**何が混ざっているか**を具体的に書くこと
- **作者が資料の誤りを訴えたときだけ**付けること。あなたが本文の描写の
  不足を感じただけでは付けないこと
- **notes は reply の結論と食い違わせないこと。** reply で「明確に
  描かれています」と答えながら、notes に「不十分に描写されている」と書くような、
  同じ返答の中で正反対のことを言う形にしないこと
- 設定資料の誤りの話でないときは reloadRecord を付けないこと。
  本文やプロットの相談、資料の内容についての質問には要りません
- **あなたが資料を書き換えるのではありません。** 読み直した結果は項目ごとの
  提案として並び、作者が選んだものだけが反映されます

【出力形式】JSONのみ。前置き・後書き・コードフェンスを含めないこと。
{"reply": "...", "options": ["...", "..."], "needFiles": [], "edit": {"target": "...", "content": "...", "label": "..."}, "run": "...", "locate": {"path": "...", "text": "...", "label": "..."}, "reloadRecord": {"kind": "character", "name": "${EXAMPLE_PERSON.fullName}", "notes": "他の登場人物『${EXAMPLE_OTHER.fullName}』の情報が混入しています。"}, "profileSignals": null, "writerStyleSignals": null}

**profileSignals と writerStyleSignals は、末尾に説明があるときだけ使ってください。** 説明が無ければ必ず null にしてください。`;

/**
 * システムの指示を組み立てる。
 *
 * **目次を渡さない回では、使い方の節を外す**（2026-09-13）。作者の指摘
 * 「不要な記事の内容まで一括で乗っていそうな気配を感じています」に対する
 * 節約の後半である（前半は目次そのものを外すこと）。外れるのはこの1節だけで、
 * 出力の欄（edit・run・reloadRecord）の歯止めになっている節は必ず残す。
 *
 * 目次を渡す回では、これまでと**1文字も変わらない**（`workChat.test.ts`／
 * `chatTopic.test.ts` が字数で見張る）。
 */
export function buildWorkChatSystemPrompt(options?: {
  /** 末尾に操作の目次を渡す回か。既定は渡す */
  featureIndex?: boolean;
}): string {
  const sections = [SYSTEM_PROMPT_HEAD];
  if (options?.featureIndex !== false) sections.push(FEATURE_GUIDE_SECTION);
  sections.push(SYSTEM_PROMPT_TAIL);
  // 節の区切りは空行1つ。元の1つながりの文と同じ形になる
  return sections.join("\n\n");
}

/** これまでどおりの、すべての節が入ったシステムの指示 */
export const WORK_CHAT_SYSTEM_PROMPT = buildWorkChatSystemPrompt();

export interface WorkChatTurn {
  role: "author" | "assistant";
  text: string;
}

export interface WorkChatInput {
  workTitle: string;
  /** いま開いている画面の種類 */
  contextKind: ChatContextKind;
  /** 画面の説明（「第7話の本文」など） */
  contextLabel: string;
  /** 開いているファイルの中身（抜粋） */
  excerpt: string;
  /** 抜粋が途中で切れているか。切れていることをAIに伝える */
  excerptTruncated: boolean;
  /** 作者が範囲を選んで聞いているか */
  fromSelection: boolean;
  /** 作品の材料（登場人物名など）。文脈に応じて呼び出し側が詰める */
  reference: string[];
  /**
   * 前の応答で AI が求めたファイルの中身。
   *
   * これがあるということは「材料が足りない」と言った直後なので、
   * もう一度 needFiles を返させない（同じ問答を繰り返してしまう）。
   */
  requestedFiles?: Array<{ path: string; content: string }>;
  /**
   * 前の応答で AI が求めたのに、作品フォルダーに無かったファイル。
   *
   * **黙って飛ばすと、作者には何が起きたか分からない**（2026-09-24、
   * 実データの測定）。1つも読めないときに聞き直さず、1往復目の
   * 「本文を提示してください」だけが画面に残った。見つからなかったことと、
   * 作品にあるファイルの候補を渡し、今の「1回だけ」の聞き直しの中で答えさせる。
   */
  missingFiles?: {
    paths: string[];
    /** 作品にあるファイルの候補（`core/chatEdit.ts` の `pickFileHints` で選ぶ） */
    available: FileHint[];
    /** 候補を選んだ元の件数。一部だけ見せていることを明記するため */
    availableTotal: number;
  };
  /** これまでのやり取り。古いものから順に */
  history: WorkChatTurn[];
  question: string;
  /**
   * この拡張機能の操作の目次と、質問に関係しそうな説明
   * （`features/featureGuide.ts` の `buildFeatureGuideForQuestion`）。
   *
   * **名前は毎回、全部渡す。** 判定を外して名前ごと落とすと、
   * 「その機能はありません」と嘘を答える。目次だけなら約1,600字で、
   * 機能が増えても伸び方はゆるやかである。
   *
   * **説明は関係する束だけ渡す。** 全文を毎回渡すと、送る量が機能数に
   * 比例して増える（実際に6,169字まで伸びていた）。
   * 作品の相談では触れないよう、プロンプトで釘を刺している。
   */
  featureGuide?: string;
}

export function buildWorkChatPrompt(input: WorkChatInput): string {
  const blocks: string[] = [`【作品】\n${input.workTitle}`];

  blocks.push(`【いま開いている画面】\n${input.contextLabel}`);

  /*
    0.86.1 まではここに【いま埋めている項目】（`plotFocus`）を足し、対話式
    プロット作成を相談の上で動かしていた。決まった9項目を順に尋ねる形で、
    選択肢の往復で止まった（作者の実機の報告、2026-09-24 夜）。**対話式
    プロット作成は専用の問答（P-43、`prompts/plotDialogue.ts`）へ移した**ので、
    相談の指示にはもう載せない（相談そのものの送る本文は変わらない）。
  */

  if (input.excerpt.trim()) {
    const note = input.fromSelection
      ? "作者が選んだ範囲です。ここについての相談だと考えてください。"
      : input.excerptTruncated
        ? "長いため一部だけを抜き出しています。"
        : "";
    blocks.push(
      `【画面の内容】${note ? `\n（${note}）` : ""}\n${input.excerpt.trim()}`
    );
  }

  if (input.reference.length > 0) {
    blocks.push(`【この作品の材料】\n${input.reference.join("\n")}`);
  }

  if (input.requestedFiles && input.requestedFiles.length > 0) {
    const files = input.requestedFiles
      .map((file) => `--- ${file.path} ---\n${file.content}`)
      .join("\n\n");
    blocks.push(
      `【あなたが求めたファイル】\n${files}\n\n` +
        "（これで材料は揃っています。needFiles は空にして、答えを書いてください）"
    );
  }

  const missing = input.missingFiles;
  if (missing && missing.paths.length > 0) {
    const lines = [
      "【見つからなかったファイル】",
      `あなたが求めた次のファイルは、作品フォルダーの中に見つかりませんでした: ${missing.paths.join("、")}`,
    ];
    if (missing.available.length > 0) {
      // 一部だけ見せていることを明記する。「これで全部」と読まれると、
      // 一覧に無い話を「無い」と作者へ答えてしまう
      const shown =
        missing.availableTotal > missing.available.length
          ? `（全${missing.availableTotal}件のうち${missing.available.length}件）`
          : "";
      lines.push(
        `作品にあるのは、たとえば次のファイルです${shown}:`,
        ...missing.available.map((hint) => `- ${hint.path}（${hint.label}）`)
      );
    }
    // **聞き直しは1回だけ**なので、ここで needFiles を返されてももう読まない。
    // 読めたものが1つも無いときは、分かる範囲で答えるよう先に言っておく
    if (!input.requestedFiles || input.requestedFiles.length === 0) {
      lines.push(
        "",
        "今回はファイルの中身を渡せません。needFiles は空にしてください。",
        "渡された範囲で答えられることは答え、足りないところは、どのファイル（上の一覧の名前）を見たかったのかを作者へ伝えてください。"
      );
    }
    blocks.push(lines.join("\n"));
  }

  if (input.history.length > 0) {
    const history = input.history
      .map((turn) => `${turn.role === "author" ? "作者" : "あなた"}: ${turn.text}`)
      .join("\n");
    blocks.push(`【これまでのやり取り】\n${history}`);
  }

  blocks.push(`【作者からの相談】\n${input.question.trim()}`);

  // 機能の一覧は最後に置く。相談の本題より前に長い一覧があると、
  // 作品の話をしているのに機能の説明を始めることがある
  if (input.featureGuide?.trim()) {
    blocks.push(
      "【この拡張機能の操作の目次と、関係しそうな説明（使い方を聞かれたときだけ使う参考資料）】\n" +
        input.featureGuide.trim()
    );
  }

  return blocks.join("\n\n");
}

/**
 * 構造化出力に渡すJSONスキーマ。
 *
 * **全項目を必須にし、nullを許す。** 省略可能にすると、小さいモデルは
 * 面倒な項目を黙って落とす（P-20で分かっていたことで、プロット逆算では
 * これを忘れて実機で項目が空になった、2026-08-15）。
 *
 * とくに `options` が落とされると、**選択肢で会話を進める仕組みそのものが
 * 消える**。「無い」ことを空配列やnullで明示させるほうが確実である。
 */
export const WORK_CHAT_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    options: { type: ["array", "null"], items: { type: "string" } },
    needFiles: { type: ["array", "null"], items: { type: "string" } },
    edit: {
      type: ["object", "null"],
      properties: {
        target: { type: "string" },
        content: { type: "string" },
        label: { type: ["string", "null"] },
      },
      required: ["target", "content"],
    },
    run: { type: ["string", "null"] },
    locate: {
      type: ["object", "null"],
      properties: {
        path: { type: ["string", "null"] },
        text: { type: ["string", "null"] },
        label: { type: ["string", "null"] },
      },
    },
    reloadRecord: {
      type: ["object", "null"],
      properties: {
        kind: { type: "string" },
        name: { type: "string" },
        notes: { type: ["string", "null"] },
      },
      required: ["kind", "name"],
    },
    /*
      助言方針の推定を直すための報告（P-36、設計書6.86）。

      **中身は必須にしない。** ほかの項目と違い、これは
      「読み取れたときだけ入れる」もので、空を強いると
      AIが毎回どれかを埋めてしまう（点数が意味もなく動く）。
    */
    profileSignals: {
      type: ["object", "null"],
      properties: {
        reader: { type: ["number", "null"] },
        self: { type: ["number", "null"] },
        taste: { type: ["number", "null"] },
        acceptance: { type: ["string", "null"] },
        confidence: { type: ["string", "null"] },
      },
    },
    /*
      直す時期（S2）の読み取り（P-39、設計書6.90.1）。

      **`profileSignals` と欄を分ける。** あちらは助言方針の点数を
      少しずつ動かす推定で、こちらは**作者が5問で答えた値**の書き換えである。
      重みが違うものを同じ欄に混ぜると、片方の歯止め（2回続けて／必ず見せる）
      を外した日に、もう片方まで一緒に緩む。

      **頼む文は P-39 の側にある**（`prompts/writerStyle.ts`）。
      診断していない作者には頼みが送られないので、その回は null が返る。
    */
    writerStyleSignals: {
      type: ["object", "null"],
      properties: {
        revise: { type: ["string", "null"] },
      },
    },
  },
  required: [
    "reply",
    "options",
    "needFiles",
    "edit",
    "run",
    "locate",
    "reloadRecord",
    "profileSignals",
    "writerStyleSignals",
  ],
} as const;

/**
 * 応答をどう読み取れたか。
 *
 * **救ったことを呼ぶ側へ伝えるために足した**（作者の実機報告、2026-09-23
 * 「返答におかしな記号が混ざります」）。返答が出力上限で切り詰められると
 * 閉じ波括弧が付かず、3通りとも読み取りに失敗して**生の本文が
 * そのまま `reply` に入っていた**。画面には `"needFiles": [],` のような
 * JSONが並び、しかも `reply` が空でないので「切り詰められました」の
 * 案内にも入らなかった。どう読めたかが分かれば、両方とも直せる。
 *
 * - `json` …… そのまま読めた
 * - `salvaged` …… 閉じていないものを閉じて読めた（**途中で切れている**）
 * - `raw` …… 読めなかった。本文をそのまま返事として扱う
 */
export type WorkChatAnswerSource = "json" | "salvaged" | "raw";

export interface WorkChatAnswer {
  reply: string;
  options: string[];
  /** AIが読みたがったファイル。呼び出し側で安全なものへ絞る */
  needFiles: unknown;
  /** 書き込みの提案。呼び出し側で解釈し、作者が押したときだけ適用する */
  edit: unknown;
  /** 標準機能の起動の提案。許可した一覧と突き合わせてから使う */
  run: unknown;
  /** 本文の該当箇所を指す提案。呼び出し側で実在を照合する */
  locate: unknown;
  /**
   * 設定資料を留意点つきで読み直す提案（設計書6.31.3）。
   * 名前が実在するかは呼び出し側が照合する
   */
  reloadRecord: unknown;
  /**
   * 助言方針の推定を直すための報告（P-36、設計書6.86）。
   *
   * **ここで形を絞ってから返す。** ほかの項目と違って、これは
   * そのまま点数の計算に入る。`"+1"` のような文字列や 3 のような値を
   * 通すと、作者の方針が壊れたまま気づけない。
   */
  profileSignals: AdviceProfileSignals | undefined;
  /**
   * 直す時期（S2）の読み取り（P-39、設計書6.90.1）。
   *
   * **ここでも形を絞ってから返す。** 通ると**作者自身が答えた値**が
   * 書き換わる（2回続けて同じに読めたとき）ので、指示語がそのまま
   * 返ってきた値を通してはいけない。
   */
  writerStyleSignals: WriterStyleSignals | undefined;
  /** どう読み取れたか。呼ぶ側の案内が変わる（`WorkChatAnswerSource`） */
  source: WorkChatAnswerSource;
}

/**
 * 応答を読み取る。
 *
 * **JSONとして読めなくても捨てない。** 相談は会話なので、形式が崩れても
 * 本文が読めるなら見せたほうがよい。読めなければ全文を返事として扱う。
 */
export function parseWorkChatAnswer(text: string): WorkChatAnswer {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    extractBraces(text),
  ];

  for (const candidate of attempts) {
    const answer = readAnswer(candidate, "json");
    if (answer) return answer;
  }

  /*
    **4つ目：閉じていないものを閉じてから読む**（作者の実機報告、2026-09-23）。

    出力上限で切り詰められた応答には `}` が1つも無い（`options` は配列で、
    ほかは文字列か null なので入れ子の `}` すら出てこない）。上の
    `extractBraces` は `lastIndexOf("}")` で終わりを探すので、この形では
    必ずあきらめる。実機のログでは**閉じ波括弧を1つ足すだけで中身は全部
    救えた**ので、あきらめる前にここを通す。
  */
  for (const candidate of closeTruncatedJson(text)) {
    const answer = readAnswer(candidate, "salvaged");
    if (answer) return answer;
  }

  return {
    /*
      **生のJSONを作者に見せない。** ここへ落ちた本文がJSONらしいなら、
      そのまま出しても記号が並ぶだけで読めない。空にしておけば、呼ぶ側の
      「返事が空なら切り詰めを伝える」分岐へ正しく入る（`workChatPanel.ts`）。

      **素の文章で答えてきた回は、これまでどおりそのまま見せる。**
      AIが形式を無視して普通に答えること自体は珍しくないので、そこは潰さない。
    */
    reply: looksLikeJson(text) ? "" : text.trim(),
    options: [],
    needFiles: undefined,
    edit: undefined,
    run: undefined,
    locate: undefined,
    reloadRecord: undefined,
    profileSignals: undefined,
    writerStyleSignals: undefined,
    source: "raw",
  };
}

/** 候補をJSONとして読み、相談の答えの形になっていれば返す */
function readAnswer(
  candidate: string | null,
  source: WorkChatAnswerSource
): WorkChatAnswer | undefined {
  if (!candidate) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.trim());
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as {
    reply?: unknown;
    options?: unknown;
    needFiles?: unknown;
    edit?: unknown;
    run?: unknown;
    locate?: unknown;
    reloadRecord?: unknown;
    profileSignals?: unknown;
    writerStyleSignals?: unknown;
  };
  if (typeof record.reply !== "string") return undefined;
  return {
    reply: record.reply.trim(),
    options: Array.isArray(record.options)
      ? record.options
          .filter((item): item is string => typeof item === "string")
          .map(cleanOption)
          .filter(Boolean)
          .slice(0, 4)
      : [],
    needFiles: record.needFiles,
    edit: record.edit,
    run: record.run,
    locate: record.locate,
    reloadRecord: record.reloadRecord,
    profileSignals: parseProfileSignals(record.profileSignals),
    writerStyleSignals: parseWriterStyleSignals(record.writerStyleSignals),
    source,
  };
}

/**
 * 読めなかった本文が、JSONのなれの果てか。
 *
 * **この判定だけで「作者に見せない」を決める**ので、広く取らない。
 * `{` で始まり、この形式の鍵が入っていることを両方求める。
 */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  return trimmed.includes('"reply"') || trimmed.includes('"needFiles"');
}

/**
 * 選択肢を、押せる形に整える。
 *
 * **見出しの括弧を外す。** 実機で「【この拡張機能でできること】」
 * 「【次のアクションを提案する】」という項目名が返ってきた（2026-08-15）。
 * ボタンを押すとその文字列がそのまま次の質問として送られるので、
 * 括弧付きの題名のままだと何を頼んだのか分からない会話になる。
 *
 * 中身まで書き換えることはしない。**言い回しはAIの領分**で、
 * こちらが直すと作者の意図と食い違う。括弧を外して読める形にするだけ。
 */
export function cleanOption(text: string): string {
  let value = text.trim();
  // 【…】 や [〜] で囲まれた題名は、囲みだけ外す
  const wrapped = value.match(/^[【\[［]\s*(.+?)\s*[】\]］]$/);
  if (wrapped) value = wrapped[1].trim();
  // 箇条書きの記号や番号が付いてくることがある
  value = value.replace(/^[-*・]\s*/, "").replace(/^\d+[.)．）]\s*/, "");
  return value.trim();
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}
