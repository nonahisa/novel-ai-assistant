/**
 * 脚本モードの土台：ふつうに書いたテキストの1行を、柱・ト書き・台詞に読み分ける
 * （設計書6.70.3。読み分けの表は「脚本モードの案」の5章、順1〜14）。
 *
 * **読むだけで、原稿は書き直さない。** 返すのは「この行はこう読める」という
 * 答えと、直すならこう直せるという候補の行だけである。書き直すかどうかは
 * 作者が行ごとに決める（呼び出し側の仕事）。迷った行は決めずに「迷い」で返す。
 *
 * ## `scriptLines.ts` との関係
 *
 * 順3〜5（柱・ト書き・台詞の確かな形）は `classifyScriptLine` に任せる。
 * 画面と紙が使っている判定と**食い違わせない**ため、正規表現を写さない。
 * ここが足すのは、その手前（空行・付箋）と、その先（候補と迷い）だけである。
 *
 * ## 音・転換の扱い
 *
 * ＳＥ・Ｍ・×××などの行は、行の種類を増やさない（作者の答え 2026-11-18）。
 * 組み方はト書きと同じで、色の印（`cue: true`）だけ付ける。すでに全角空白で
 * 字下げした `　ＳＥ　雷` も、ト書き（確か）に印が付く。
 *
 * ## ここは vscode に触らない（純粋関数）
 */

import { classifyScriptLine, SCRIPT_ROLE_MAX } from "./scriptLines";

/** 読み分けた行の種類。`unsure` が「迷い」 */
export type ScriptReadKind =
  | "blank"
  | "memo"
  | "hashira"
  | "togaki"
  | "serifu"
  | "unsure";

/** 確か＝そのまま組める／候補＝書き直せば組める／迷い＝決めない */
export type ScriptReadConfidence = "sure" | "candidate" | "unsure";

export interface ScriptLineReading {
  kind: ScriptReadKind;
  confidence: ScriptReadConfidence;
  /** 読み分けの表の順（1〜14。5' は 5、9' は 9 と数える） */
  rule: number;
  /** 候補のときだけ：書き直した行。確か・迷いには付けない */
  rewritten?: string;
  /** 迷いのときだけ：なぜ決めなかったか（作者に見せる） */
  reason?: string;
  /** 台詞のときだけ：話し手の名前（括弧の指示・「の声」・ルビを除いたもの） */
  role?: string;
  /** 音・転換の印（ト書きと同じ組み方で色だけ変える） */
  cue?: boolean;
  /** 迷い（順10）のときだけ：直前の話し手。作者が選ぶ候補になる */
  candidateRoles?: string[];
}

export interface ScriptReadContext {
  /** 作品の人物の呼び名（設定資料と、本文で確かに台詞になっている役名） */
  roles: ReadonlySet<string>;
  /** 直前の話し手（順10の候補） */
  previousSpeaker?: string;
}

/** 時刻・時間帯の語。柱の `場所（夜）` の形を見分ける */
const TIME_WORDS =
  "朝|昼|夕|夕方|夜|深夜|早朝|明け方|午前|午後|同日|翌日|翌朝|数日後|日中|夜明け|真夜中";

/**
 * 音・転換の頭の語。**後ろが空白・括弧・「・行末のときだけ**当てる
 * （`SEきり` のような語の一部を拾わない）。`×　×　×` は別の形で見る。
 */
const CUE_WORD =
  "(?:ＳＥ|SE|Ｍ|M|ＢＧＭ|BGM|Ｆ・Ｉ|Ｆ・Ｏ|F\\.I|F\\.O|Ｏ・Ｌ|O\\.L|インサート|字幕|テロップ)";
const CUE_HEAD = new RegExp(`^${CUE_WORD}(?=[\\s\\u3000（(「]|$)`);
const CUE_BATSU = /^×[\s　]*×[\s　]*×/;

const RE = {
  memo: /^(\/\/|／／)/,
  // ○ と見分けにくい字（〇 U+3007 は順3で柱の確かな形として拾っている）
  hashiraLookalike: /^[◯◎●⚪⭕]/,
  halfIndent: /^[ \t]+\S/,
  serifuHead: /^([^\s「」]{1,12})「/,
  // 役名の側に地の文らしさがある（読点・句点、または助詞で終わる）
  roleLooksProse: /[、。]|[はがもをにでと]$/,
  colonLine: /^([^\s「」：:、。]{1,12})[：:][ \t　]*(.+)$/,
  timeParen: new RegExp(`^(.{1,30})[（(](?:${TIME_WORDS})[）)]\\s*$`),
  sceneNumber: /^(?:シーン|Ｓ|S|＃|#)\s*[0-9０-９]+/,
  // 「…」のあとに地の文が続く
  tailAfterQuote: /」[^」]+$/,
  longRole: /^[^\s「」]{13,}「/,
};

/** 音・転換の行か（字下げを除いた本文の頭で見る） */
export function isScriptCueText(body: string): boolean {
  return CUE_HEAD.test(body) || CUE_BATSU.test(body);
}

/**
 * 役名から、話し手の名前だけを取り出す。
 *
 * 括弧の指示（`店主（奥から）`）・`の声`・ルビ記法（`{千尋|ちひろ}`
 * `｜太郎《たろう》` `太郎《たろう》`）を外す。人物の一覧と突き合わせるため。
 */
export function normalizeScriptRole(role: string): string {
  return role
    .replace(/[（(][^）)]*[）)]$/, "")
    .replace(/\{([^|}]+)\|[^}]*\}/g, "$1")
    .replace(/｜([^《》｜]+)《[^》]*》/g, "$1")
    .replace(/《[^》]*》/g, "")
    .replace(/の声$/, "");
}

/** 役名の側が地の文に見えるか（順5'）。括弧の指示は見ない */
function roleLooksLikeProse(role: string): boolean {
  return RE.roleLooksProse.test(role.replace(/[（(][^）)]*[）)]$/, ""));
}

/**
 * 1行を読む。**表の順1〜14をこの順に当てる**。
 *
 * 確かな台詞（順5）の話し手は `role` に入れて返す。呼び出し側（`readScriptText`）は
 * それを次の行の `previousSpeaker` と、作品の役名の候補に使う。
 */
export function readScriptLine(
  line: string,
  ctx: ScriptReadContext
): ScriptLineReading {
  // 1. 空行（半角空白だけの行も空行。全角空白だけの行はト書きの形なので4で拾う）
  if (/^[ \t]*$/.test(line)) {
    return { kind: "blank", confidence: "sure", rule: 1 };
  }
  // 2. 付箋
  if (RE.memo.test(line)) {
    return { kind: "memo", confidence: "sure", rule: 2 };
  }

  // 3〜5. 確かな形。今の画面と紙の判定（scriptLines.ts）に任せる
  const sure = classifyScriptLine(line);
  if (sure === "hashira") {
    return { kind: "hashira", confidence: "sure", rule: 3 };
  }
  if (sure === "togaki") {
    const reading: ScriptLineReading = {
      kind: "togaki",
      confidence: "sure",
      rule: 4,
    };
    if (isScriptCueText(line.slice(1))) reading.cue = true;
    return reading;
  }
  if (sure === "serifu") {
    const role = RE.serifuHead.exec(line)![1];
    if (roleLooksLikeProse(role) || RE.tailAfterQuote.test(line)) {
      return {
        kind: "unsure",
        confidence: "unsure",
        rule: 5,
        reason: "台詞の形だが、役名の側が地の文に見える",
      };
    }
    return {
      kind: "serifu",
      confidence: "sure",
      rule: 5,
      role: normalizeScriptRole(role),
    };
  }

  // 6. ○に似た字
  if (RE.hashiraLookalike.test(line)) {
    return {
      kind: "hashira",
      confidence: "candidate",
      rule: 6,
      rewritten: "○" + line.slice(1),
    };
  }
  // 7. 半角空白の字下げ
  if (RE.halfIndent.test(line)) {
    const body = line.replace(/^[ \t]+/, "");
    const reading: ScriptLineReading = {
      kind: "togaki",
      confidence: "candidate",
      rule: 7,
      rewritten: "　" + body,
    };
    if (isScriptCueText(body)) reading.cue = true;
    return reading;
  }
  // 8. 音・転換
  if (isScriptCueText(line)) {
    return {
      kind: "togaki",
      confidence: "candidate",
      rule: 8,
      rewritten: "　" + line,
      cue: true,
    };
  }
  // 9. 名前：本文
  const colon = RE.colonLine.exec(line);
  if (colon) {
    const role = colon[1];
    if (ctx.roles.has(normalizeScriptRole(role))) {
      return {
        kind: "serifu",
        confidence: "candidate",
        rule: 9,
        role: normalizeScriptRole(role),
        rewritten: `${role}「${colon[2]}」`,
      };
    }
    return {
      kind: "unsure",
      confidence: "unsure",
      rule: 9,
      reason: "「名前：」の形だが、作品の人物にいない名前",
    };
  }
  // 10. 役名の無い「
  if (line.startsWith("「")) {
    return {
      kind: "unsure",
      confidence: "unsure",
      rule: 10,
      reason: "役名の無い「」。誰の台詞か決められない",
      candidateRoles: ctx.previousSpeaker ? [ctx.previousSpeaker] : [],
    };
  }
  // 11. 柱らしい形
  if (RE.timeParen.test(line) || RE.sceneNumber.test(line)) {
    return {
      kind: "hashira",
      confidence: "candidate",
      rule: 11,
      rewritten: "○" + line,
    };
  }
  // 12. 役名が13字以上の台詞の形
  if (RE.longRole.test(line)) {
    return {
      kind: "unsure",
      confidence: "unsure",
      rule: 12,
      reason: `役名が${SCRIPT_ROLE_MAX + 1}字以上の台詞の形`,
    };
  }
  // 13. 字下げの無い地の文
  if (!line.includes("「") && line.endsWith("。")) {
    return {
      kind: "togaki",
      confidence: "candidate",
      rule: 13,
      rewritten: "　" + line,
    };
  }
  // 14. どれにも当たらない
  return {
    kind: "unsure",
    confidence: "unsure",
    rule: 14,
    reason: "どの決まりにも当たらない",
  };
}

export interface ScriptTextReading {
  /** 入力の各行（`split("\n")`。`\r` は行の末尾に残さず外して読む）の読み */
  lines: ScriptLineReading[];
  /** 役名の候補：渡された人物＋本文で確かに台詞になっている役名（重複なし） */
  roles: string[];
}

/**
 * 全文を読む。
 *
 * 役名の候補は、渡された設定資料の人物と、本文で確かに台詞になっている役名
 * （順5。設定資料の無い作品でも順9が効くように）。**候補の台詞（順9）の役名は
 * 候補に足さない**——自分で自分を確かにする循環になるため。
 */
export function readScriptText(
  text: string,
  roles: readonly string[] = []
): ScriptTextReading {
  const rawLines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const known = new Set(roles);
  const order: string[] = [...roles];

  // 1周目：確かな台詞の役名を集める（順5は人物の一覧に左右されない）
  const empty: ReadonlySet<string> = new Set();
  for (const line of rawLines) {
    const r = readScriptLine(line, { roles: empty });
    if (r.kind === "serifu" && r.confidence === "sure" && r.role) {
      if (!known.has(r.role)) {
        known.add(r.role);
        order.push(r.role);
      }
    }
  }

  // 2周目：全員の名前を知った状態で読み、直前の話し手を持ち回す
  const lines: ScriptLineReading[] = [];
  let previous: string | undefined;
  for (const line of rawLines) {
    const r = readScriptLine(line, { roles: known, previousSpeaker: previous });
    lines.push(r);
    if (r.kind === "serifu" && r.role) previous = r.role;
  }
  return { lines, roles: order };
}

// ── 行の種類の切り替え ─────────────────────────────────────

/** 切り替えの行き先。音・転換はト書きと同じ組み方の、頭の語つきの行 */
export type ScriptSwitchKind = "hashira" | "togaki" | "serifu" | "cue";

/** Alt+1〜4 と種類の対応（上の列のボタンの並びと同じ） */
export const SCRIPT_ALT_KEY_KINDS: readonly {
  key: 1 | 2 | 3 | 4;
  kind: ScriptSwitchKind;
}[] = [
  { key: 1, kind: "hashira" },
  { key: 2, kind: "togaki" },
  { key: 3, kind: "serifu" },
  { key: 4, kind: "cue" },
];

/** 空の行の頭で Tab を押すたびに替わる順（ト書き→柱→台詞→音・転換→ト書き） */
export const SCRIPT_TAB_ORDER: readonly ScriptSwitchKind[] = [
  "togaki",
  "hashira",
  "serifu",
  "cue",
];

export function nextKindOnTab(current: ScriptSwitchKind): ScriptSwitchKind {
  const at = SCRIPT_TAB_ORDER.indexOf(current);
  return SCRIPT_TAB_ORDER[(at + 1) % SCRIPT_TAB_ORDER.length];
}

/** 読みを、切り替えの種類（いまの行はどれか）へ直す。付箋・迷い・空行は undefined */
export function switchKindOf(
  reading: ScriptLineReading
): ScriptSwitchKind | undefined {
  if (reading.confidence === "unsure") return undefined;
  if (reading.kind === "hashira" || reading.kind === "serifu") {
    return reading.kind;
  }
  if (reading.kind === "togaki") return reading.cue ? "cue" : "togaki";
  return undefined;
}

const ROLE_OK = /^[^\s「」]{1,12}$/;

/** 頭の印（○・字下げ・役名「）を外した残りを返す。残りの字は1字も変えない */
function stripHead(line: string): string {
  if (/^[○〇◯◎●]/.test(line)) return line.slice(1);
  if (line.startsWith("　")) return line.slice(1);
  // 地の文（`彼は「行こう」と言った`）の頭を役名と読んで削らないよう、
  // 読み分けで台詞と確かに決まった行だけ役名を外す
  const role = RE.serifuHead.exec(line);
  if (role && readScriptLine(line, { roles: new Set() }).kind === "serifu") {
    return line.slice(role[1].length);
  }
  if (RE.halfIndent.test(line)) return line.replace(/^[ \t]+/, "");
  return line;
}

/**
 * 行の種類を替える。**頭の字だけを書き換え、本文の中身の字は変えない。**
 *
 * - 柱：頭に `○`
 * - ト書き：頭に全角空白
 * - 音・転換：ト書きと同じ字下げ。本文が音・転換の語で始まらなければ、
 *   頭に `ＳＥ　` を足す（語が無いと、色の印が付かない）
 * - 台詞：頭に `役名`。本文が `「` で始まらなければ `「…」` で包む
 *   （台詞の形に要る。外す側は役名だけを外し、`「」` は残す）
 *
 * ト書きへ戻すとき、頭の `ＳＥ　`・`Ｍ　` のような**単純な語は外す**
 * （残すと色の印が消えない）。`×　×　×` は外せないので残す。
 *
 * 台詞へ替えるのに役名が無い・使えない（空・13字以上・空白か「」を含む）ときは
 * `undefined` を返す（呼び出し側が役名を訊く）。
 */
export function switchScriptLineKind(
  line: string,
  to: ScriptSwitchKind,
  role?: string
): string | undefined {
  let body = stripHead(line);
  if (to === "togaki" || to === "hashira") {
    // 音・転換の頭の語は、ト書き・柱へ替えるときに外す（残すと色の印が消えない）
    const simple = new RegExp(`^${CUE_WORD}[ \t\u3000]*`).exec(body);
    if (simple && CUE_HEAD.test(body)) body = body.slice(simple[0].length);
  }
  switch (to) {
    case "hashira":
      return "○" + body;
    case "togaki":
      return "　" + body;
    case "cue":
      return "　" + (isScriptCueText(body) ? body : "ＳＥ　" + body);
    case "serifu": {
      if (role === undefined || !ROLE_OK.test(role)) return undefined;
      return role + (body.startsWith("「") ? body : `「${body}」`);
    }
  }
}
