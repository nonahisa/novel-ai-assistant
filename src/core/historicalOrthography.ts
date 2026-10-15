/**
 * 旧字体・歴史的仮名遣いを、今の書き方へ置き換えるだけの直しかを見分ける。
 *
 * **なぜ要るか**：文語体の作品（戦前の自分史など）で、誤字脱字のAIが正しい旧字・旧かなを
 * 「誤字」として今の書き方へ直してくる（「機會→機会」「やうやく→ようやく」「だらう→だろう」）。
 * 作品の作法で「現代表記へ直さないこと」と伝えても、e4b では19件中8件がそれだった
 * （docs/measurements/2026-10-15-ai-measure.md の 2552）。決まった語の一覧
 * （`typoCheckValidation.ts` の `ARCHAIC_FORMS`）では、字と仮名の組み合わせを
 * 網羅できない。そこで**字の種類の規則**で見る（作者の裁定、2026-10-15 の5）。
 *
 * **向きと全体一致で、本物の誤字を巻き込まない。**
 * - 見るのは「元（target）を、規則の置き換えだけで提案（suggestion）にできるか」の一方向。
 *   提案の側を正規化しない——「私わ→私は」のように今の書き方へ直す本物の誤字が、
 *   逆向きの規則で同じ形に揃ってしまうため
 * - 置き換えた字以外は1字残らず同じでなければならない。「機會を得た→機会を得て」の
 *   ように別の直しが混ざっていれば、置き換えだけではないので落とさない
 * - どの規則を当てるかは字ごとに選べる（当てなくてもよい）。「會ふ→会う」の「ふ→う」は
 *   当てて「あう」のまま、「やうやく→ようやく」の「やう→よう」も当てる、と同じ語の中で
 *   選び分けられる
 *
 * **ここは文語体の作品のときだけ使う**（`TypoValidationOptions.archaicWork`。R17）。
 * 現代文の作品に旧字が1つ紛れていたら、それは直すべき字かもしれない。
 */

/**
 * 旧字体 → 新字体（1字ずつ）。
 *
 * **出どころ**：常用漢字表（平成22年内閣告示第2号）の括弧内に添えられた旧字体
 * （いわゆる康熙字典体）と、その新字体。CJK互換漢字の領域にしか無い旧字体
 * （海・都 の旧字など）は、入力でほとんど現れないので載せていない。
 * 「測らないと分からない値」ではなく決まった対応なので、同梱してよい（実装ルール6の外）。
 *
 * **常用漢字どうしの書き換え（附→付・廻→回 など、昭和31年の「同音の漢字による
 * 書きかえ」）は載せない。** 旧字体ではなく別の字への置き換えで、作者の裁定の範囲の外。
 */
const KYUJITAI_PAIRS =
  "亞亜 惡悪 壓圧 圍囲 爲為 醫医 壹壱 稻稲 飮飲 隱隠 營営 榮栄 衞衛 驛駅 圓円 " +
  "鹽塩 緣縁 艷艶 奧奥 應応 歐欧 毆殴 櫻桜 橫横 溫温 穩穏 價価 假仮 會会 壞壊 " +
  "懷懐 繪絵 槪概 擴拡 殼殻 覺覚 學学 嶽岳 樂楽 渴渇 卷巻 陷陥 寬寛 勸勧 歡歓 " +
  "罐缶 觀観 關関 顏顔 歸帰 氣気 龜亀 僞偽 戲戯 犧犠 舊旧 據拠 擧挙 虛虚 峽峡 " +
  "挾挟 狹狭 鄕郷 曉暁 區区 驅駆 勳勲 徑径 惠恵 揭掲 溪渓 經経 螢蛍 輕軽 繼継 " +
  "鷄鶏 藝芸 擊撃 缺欠 硏研 儉倹 劍剣 圈圏 檢検 權権 獻献 縣県 險険 顯顕 驗験 " +
  "嚴厳 效効 廣広 恆恒 黃黄 鑛鉱 號号 國国 黑黒 濟済 碎砕 齋斎 劑剤 雜雑 參参 " +
  "慘惨 棧桟 蠶蚕 贊賛 殘残 絲糸 齒歯 兒児 辭辞 濕湿 實実 寫写 舍舎 釋釈 壽寿 " +
  "收収 從従 澁渋 獸獣 縱縦 肅粛 處処 敍叙 將将 稱称 涉渉 燒焼 證証 獎奨 條条 " +
  "狀状 乘乗 淨浄 剩剰 疊畳 孃嬢 讓譲 釀醸 觸触 囑嘱 寢寝 愼慎 眞真 盡尽 圖図 " +
  "粹粋 醉酔 穗穂 隨随 髓髄 樞枢 數数 瀨瀬 聲声 齊斉 靜静 稅税 竊窃 攝摂 說説 " +
  "專専 淺浅 戰戦 踐践 錢銭 潛潜 纖繊 禪禅 雙双 壯壮 爭争 莊荘 搜捜 插挿 巢巣 " +
  "總総 聰聡 裝装 騷騒 增増 藏蔵 臟臓 卽即 屬属 續続 墮堕 體体 對対 帶帯 滯滞 " +
  "臺台 瀧滝 擇択 澤沢 擔担 單単 膽胆 團団 彈弾 斷断 遲遅 癡痴 晝昼 蟲虫 鑄鋳 " +
  "廳庁 徵徴 聽聴 敕勅 鎭鎮 遞逓 鐵鉄 轉転 點点 傳伝 黨党 盜盗 燈灯 當当 鬭闘 " +
  "德徳 獨独 讀読 屆届 繩縄 貳弐 惱悩 腦脳 霸覇 廢廃 拜拝 賣売 麥麦 發発 髮髪 " +
  "拔抜 晚晩 蠻蛮 祕秘 濱浜 甁瓶 拂払 佛仏 竝並 變変 邊辺 辨弁 瓣弁 辯弁 舖舗 " +
  "步歩 寶宝 豐豊 沒没 飜翻 每毎 萬万 滿満 默黙 譯訳 藥薬 與与 豫予 餘余 譽誉 " +
  "搖揺 樣様 謠謡 來来 賴頼 亂乱 覽覧 龍竜 兩両 獵猟 綠緑 壘塁 淚涙 勵励 禮礼 " +
  "隸隷 靈霊 齡齢 曆暦 歷歴 戀恋 爐炉 勞労 樓楼 郞郎 祿禄 錄録 灣湾 脫脱 銳鋭 " +
  "閱閲 產産 戾戻 旣既 姬姫";

export const KYUJITAI_TO_SHINJITAI: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      KYUJITAI_PAIRS.split(" ").map((pair) => {
        const [old, now] = [...pair];
        return [old, now];
      })
    )
  );

/** い段の仮名（拗音の小書きの前に来る字） */
const I_ROW = new Set([..."きしちにひみりぎじぢびぴ"]);

type KanaRule = {
  /** 元（旧かな）の側の綴り */
  from: string;
  /** 今の書き方の綴り */
  to: string;
  /**
   * 語の頭では当てない。ハ行転呼（かは→かわ）は語中・語尾だけの決まりで、
   * 語頭の「はな」を「わな」へ直すのは置き換えではない
   */
  medialOnly?: boolean;
  /** 直前がい段の仮名のときだけ当てる（しや→しゃ） */
  afterIRow?: boolean;
};

/**
 * 歴史的仮名遣い → 現代仮名遣い の規則。
 *
 * **出どころ**：「現代仮名遣い」（昭和61年内閣告示第1号）の付表（歴史的仮名遣いとの対照）。
 * そのうち、文語体の文章でよく出て、取り違えの起きにくい形だけを載せる。
 * **網羅はしない**——載っていない形が通っても、作者が「無視」を押せば済む。
 * 広げすぎると、本物の誤字が置き換えの形に見えて落ちる（見逃し）。
 */
const KANA_RULES: KanaRule[] = [
  // ア段＋う → オ段＋う（やう→よう・らう→ろう・さう→そう）
  ...pairs("あう:おう かう:こう さう:そう たう:とう なう:のう はう:ほう まう:もう やう:よう らう:ろう わう:おう がう:ごう ざう:ぞう だう:どう ばう:ぼう ぱう:ぽう"),
  // ア段＋ふ → オ段＋う（あふぐ→あおぐ・かふ→こう）
  ...pairs("あふ:おう かふ:こう さふ:そう たふ:とう なふ:のう はふ:ほう まふ:もう らふ:ろう がふ:ごう ざふ:ぞう だふ:どう ばふ:ぼう", true),
  // イ段＋う → イ段＋ゅう（きう→きゅう・しう→しゅう）
  ...pairs("きう:きゅう しう:しゅう ちう:ちゅう にう:にゅう ひう:ひゅう りう:りゅう ぎう:ぎゅう じう:じゅう"),
  // エ段＋う／ふ → イ段＋ょう（けふ→きょう・せう→しょう・てふ→ちょう）
  ...pairs("えう:よう けう:きょう せう:しょう てう:ちょう ねう:にょう へう:ひょう めう:みょう れう:りょう げう:ぎょう ぜう:じょう でう:じょう べう:びょう"),
  ...pairs("けふ:きょう せふ:しょう てふ:ちょう ねふ:にょう へふ:ひょう めふ:みょう れふ:りょう げふ:ぎょう ぜふ:じょう でふ:じょう"),
  // 拗音（しやう→しょう）。直前がい段のときだけ
  { from: "やう", to: "ょう", afterIRow: true },
  { from: "や", to: "ゃ", afterIRow: true },
  { from: "ゆ", to: "ゅ", afterIRow: true },
  { from: "よ", to: "ょ", afterIRow: true },
  // 促音（やつて→やって）。語頭の「つ」は促音にならない
  { from: "つ", to: "っ", medialOnly: true },
  // ゐ・ゑ（カタカナも）
  ...pairs("ゐ:い ゑ:え ヰ:イ ヱ:エ"),
  // 語中・語尾のハ行（かは→かわ・言ふ→言う・思ひ→思い・かへる→かえる・おほきい→おおきい）
  ...pairs("は:わ ひ:い ふ:う へ:え ほ:お", true),
  // 語中・語尾の「を」（かをる→かおる）。語頭は助詞と区別できないので当てない
  ...pairs("を:お", true),
  // 四つ仮名
  ...pairs("ぢ:じ づ:ず"),
  // 合拗音
  ...pairs("くわ:か ぐわ:が"),
];

function pairs(spec: string, medialOnly = false): KanaRule[] {
  return spec.split(" ").map((entry) => {
    const [from, to] = entry.split(":");
    return medialOnly ? { from, to, medialOnly } : { from, to };
  });
}

/**
 * 元（target）を、旧字体→新字体・歴史的仮名遣い→現代仮名遣いの置き換えだけで、
 * 提案（suggestion）にできるか。同じ文字列なら false（直しではない）。
 */
export function onlyModernization(target: string, suggestion: string): boolean {
  const from = [...target.trim()];
  const to = [...suggestion.trim()];
  if (from.join("") === to.join("")) return false;
  if (from.length === 0 || to.length === 0) return false;

  // 字ごとに「そのまま」「旧字→新字」「仮名の規則」のどれかを選ぶ並べ方を探す。
  // 指摘の対象は短い（数字〜数十字）ので、覚えながら全部の並べ方を試してよい
  const memo = new Map<string, boolean>();
  const startsWith = (chars: string[], at: number, text: string): boolean => {
    const parts = [...text];
    if (at + parts.length > chars.length) return false;
    return parts.every((char, offset) => chars[at + offset] === char);
  };
  const walk = (i: number, j: number): boolean => {
    if (i === from.length && j === to.length) return true;
    if (i === from.length || j === to.length) return false;
    const key = `${i}:${j}`;
    const known = memo.get(key);
    if (known !== undefined) return known;

    let ok = false;
    if (from[i] === to[j]) ok = walk(i + 1, j + 1);
    if (!ok && KYUJITAI_TO_SHINJITAI[from[i]] === to[j]) ok = walk(i + 1, j + 1);
    if (!ok) {
      for (const rule of KANA_RULES) {
        if (rule.medialOnly && i === 0) continue;
        if (rule.afterIRow && (i === 0 || !I_ROW.has(from[i - 1]))) continue;
        if (!startsWith(from, i, rule.from) || !startsWith(to, j, rule.to)) continue;
        if (walk(i + [...rule.from].length, j + [...rule.to].length)) {
          ok = true;
          break;
        }
      }
    }
    memo.set(key, ok);
    return ok;
  };
  return walk(0, 0);
}
