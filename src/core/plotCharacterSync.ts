import { emptyCharacter, type Character } from "../models/character";
// 再輸出だけでは、このファイルの中で名前を使えない（`buildNewCharacterRecords`
// が使う）。`export { X } from` とは別に import も要る
import { PENDING_CREATION_ID } from "./pendingUpdateFormat";
import { normalizeName } from "./characterMerge";
import { sha256Text } from "./hash";
import { clampSummary } from "./summaryLimit";
import { splitRoleAnnotation } from "./plotRoleNames";

/**
 * plot.md の「主要登場人物」から設定資料への差分反映（設計書6.4.9）。
 *
 * ここは**読むだけの純粋な部品**である。plot.md へは書かず、台帳へも書かない
 * （積むのは承認待ちだけ）。VS Code APIにも依存しない。
 *
 * ## AIを呼ばない
 *
 * プロットの人物欄は短く、構造も緩い箇条書きにすぎない。読める形だけを
 * 機械で拾い、**読めなかった行は黙って飛ばさずに件数を返す**。AIに読ませると
 * 「たぶんこう書きたかったのだろう」という補完が混ざり、作者が書いていない
 * 紹介文が資料へ流れ込む。
 *
 * ## 区切りの優先順（テンプレートの案内に合わせる）
 *
 * 書き出し（`plotTemplate.ts`）が勧めるのは**箇条書き**だけで、中身の形は
 * 決めていない（6.4.3。文書を欄に閉じ込めない）。設計書6.4.9が例に挙げる
 * `- 名前：説明`・`- 名前——説明` を軸に、次の順で読む。
 *
 * 1. **コロン**（`：` `:`）——いちばん明示的。名前に空白やダッシュが
 *    入っていても、コロンの手前を名前として読める
 * 2. **ダッシュ**（`——` `―` `–` `－`、および前後を空白で挟んだ `-`）
 *    ——空白より先に見る。「ギルドマスター グラハム —— 受付の主」で、
 *    名前側の空白を区切りと取り違えないため
 * 3. **空白**（半角・全角）——箇条書きの行だけ
 * 4. **名前だけ**——箇条書きの行だけ。説明は空で拾う
 *
 * **中黒（`・`）と長音符（`ー`）は区切りにしない。** どちらもカタカナの
 * 名前そのものに現れる（「ヴォイド・コンストラクタ」「ギルドマスター」）。
 * 区切りに数えると、名前が途中で割れる。
 *
 * 3と4を箇条書きの行に限るのは、**自由に書かれた地の文を人物にしない**
 * ためである。「この節はあとで書き直す。」のような1行は、空白区切りとして
 * 読めばそれらしく割れてしまう。
 */

/** 節から読み取れた1人分 */
export interface PlotCharacterEntry {
  name: string;
  /** 説明。名前だけの行では空文字 */
  summary: string;
  /**
   * 役名（「主人公（相馬 誠）：〜」の「主人公」）。**「役名（名前）」の形の
   * 行だけが持つ**（設計書6.4.8「名前の候補を出す」）。無い行では欄ごと無い
   */
  role?: string;
}

export interface ParsedPlotCharacters {
  entries: PlotCharacterEntry[];
  /** 読めなかった行（そのまま）。件数を作者へ伝えるために持つ */
  unparsed: string[];
}

/** 行頭の箇条書きの印。`- ` `* ` `+ ` `・` `1. ` */
export const PLOT_CHARACTER_BULLET = /^(?:[-*+]\s+|・\s*|\d+[.)]\s+)/;

/** 名前として認めない長さ。ここを超える行は説明文か地の文である */
const MAX_NAME_LENGTH = 20;

/** 文の終わりを含むものは名前ではない */
const SENTENCE_MARKS = /[。！？!?．]/;

/** 名前に見えるか。記号だけの行（`---` など）も弾く */
function isNameLike(value: string): boolean {
  const name = value.trim();
  if (!name || [...name].length > MAX_NAME_LENGTH) return false;
  if (SENTENCE_MARKS.test(name)) return false;
  return /[\p{L}\p{N}]/u.test(name);
}

/** 強調の印（`**灯**`）を落とす。名前そのものではない */
function stripEmphasis(value: string): string {
  return value.replace(/^\*{1,2}(.+?)\*{1,2}$/, "$1").trim();
}

function tidySummary(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * 1行を人物として読む。読めなければ undefined。
 *
 * `bullet` が false の行（箇条書きでない行）は、区切りが明示されている
 * ものだけを読む——上の「区切りの優先順」を参照。
 */
export function parsePlotCharacterLine(
  content: string,
  bullet: boolean
): PlotCharacterEntry | undefined {
  const patterns: RegExp[] = [
    // コロン。説明が空でもよい（「灯：」）
    /^(.+?)[：:][ 　]*(.*)$/,
    // 全角系のダッシュ。連続していてもまとめて区切りにする
    /^(.+?)[ 　]*[—―–－]+[ 　]*(.*)$/,
    // 半角ハイフンは、前後を空白で挟んだときだけ区切りにする
    // （名前の中のハイフンを割らないため）
    /^(.+?)[ 　]+-{1,3}[ 　]+(.*)$/,
  ];
  if (bullet) patterns.push(/^([^ 　]+)[ 　]+(.+)$/);

  for (const pattern of patterns) {
    const matched = pattern.exec(content);
    if (!matched) continue;
    const name = stripEmphasis(matched[1]);
    if (!isNameLike(name)) continue;
    return withRole(name, tidySummary(matched[2] ?? ""));
  }

  if (!bullet) return undefined;
  const name = stripEmphasis(content);
  return isNameLike(name) ? withRole(name, "") : undefined;
}

/**
 * 「役名（名前）」なら名前と役名に分ける（設計書6.4.8「名前の候補を出す」）。
 *
 * **分けないと、名前を足した行が「主人公（相馬 誠）」という名前の人物として
 * 資料へ積まれる。** 外側が役名のときだけ分ける（「灯（あかり）」は
 * そのまま——括弧の中は読みか注記である。`splitRoleAnnotation`）
 */
function withRole(name: string, summary: string): PlotCharacterEntry {
  const split = splitRoleAnnotation(name);
  if (!split) return { name, summary };
  return { name: split.name, summary, role: split.role };
}

/**
 * 「主要登場人物」の節を読む。
 *
 * 渡すのは `parsePlotMarkdown` が返した節の中身だけ（見出しは含まない）。
 */
export function parsePlotCharacters(
  sectionText: string
): ParsedPlotCharacters {
  const entries: PlotCharacterEntry[] = [];
  const unparsed: string[] = [];

  // 案内のコメントは書かれた中身ではない（`isBlankPlotSection` と同じ扱い）
  const text = sectionText.replace(/<!--[\s\S]*?-->/g, "");

  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 節の中の小見出しと罫線は、人物の行ではない
    if (/^#{1,6}\s/.test(trimmed)) continue;
    if (/^([-*_])\1{2,}$/.test(trimmed)) continue;
    // 印だけの行（`- `）はテンプレートが置く空欄。読めなかった行ではない
    if (/^[-*+・]$/.test(trimmed)) continue;

    const indented = /^[ \t　]/.test(line);
    const bulletMatch = PLOT_CHARACTER_BULLET.exec(trimmed);
    const content = bulletMatch
      ? trimmed.slice(bulletMatch[0].length).trim()
      : trimmed;
    // 「- 」だけの行はテンプレートの空欄。読めなかった行ではない
    if (bulletMatch && !content) continue;

    // 字下げした箇条書きは、直前の人物の細目として書かれることが多い。
    // 別の人物として拾うと「十七歳」という名前の人物が資料に並ぶ
    if (indented && bulletMatch && entries.length > 0) {
      const last = entries[entries.length - 1];
      last.summary = tidySummary(`${last.summary} ${content}`);
      continue;
    }

    const entry = parsePlotCharacterLine(content, Boolean(bulletMatch));
    if (!entry) {
      unparsed.push(trimmed);
      continue;
    }
    entries.push(entry);
  }

  return { entries, unparsed };
}

/**
 * 節の内容ハッシュ。**前回と同じなら積まない**ための鍵である。
 *
 * **並べ替えただけでは変わらない。** 人物の順を入れ替えたり、1人を
 * 上へ動かしたりするたびに同じ提案が積み上がると、提案パネルが
 * 前回と同じ行で埋まる。名前と説明の組が変わったときだけ変わればよい。
 *
 * 1人分を `JSON.stringify` で綴じてから並べ替える。**区切り文字を
 * 自前で決めない**——名前にも説明にも現れない文字を選ぶのは難しく、
 * NULのような制御文字を書けば今度はソースがバイナリ扱いされる。
 */
export function plotCharactersDigest(
  entries: readonly PlotCharacterEntry[]
): string {
  const rows = entries
    // 役名は持つ行だけ綴じる。**持たない行の形を変えない**——変えると、
    // 反映済みの作品がすべて「変わった」と読まれて積み直しになる
    .map((entry) =>
      JSON.stringify(
        entry.role
          ? [entry.name, entry.summary, entry.role]
          : [entry.name, entry.summary]
      )
    )
    .sort();
  return sha256Text(rows.join("\n"));
}

/** 積まなかったものと、その理由 */
export interface PlotCharacterSkip {
  name: string;
  /**
   * authorConfirmed: 作者が確定させた人物（`autoGenerated: false`）。
   *   抽出と同じく、こちらからは書き換えない
   * ambiguous: 同じ呼び名の人物が複数居て、寄せ先を決められない
   * sameRole: 「役名（名前）」の行で、名前の人物は居ないが、**役名の人物が
   *   資料か承認待ちに居る**。同じ人を新規に積むと2人になるので積まない。
   *   名前を直す案も置けなかった（役名の人物が複数・別名で当たっただけ・
   *   別の名前へ直す案が承認待ち・承認待ちの新規案）
   * renameOffered: 役名の人物を直す案を**前に一度置いている**（作者が見送った）。
   *   保存のたびに同じ案を積み直さない
   */
  reason: "authorConfirmed" | "ambiguous" | "sameRole" | "renameOffered";
  /** sameRole・renameOffered のときの役名（作者への案内に使う） */
  role?: string;
}

/**
 * 役名の人物を名前に直す案を置いた、という1件（「主人公 → 相馬 誠」）。
 * **一度置いた組は二度置かない**ための鍵にする（設計書6.4.9）
 */
export interface RoleRenameOffer {
  /** 資料の人物のID */
  id: string;
  /** 直す前の名前（資料の役名） */
  from: string;
  /** 直した名前 */
  to: string;
}

/**
 * 置いた案を比べる鍵。名前の表記ゆれ（空白・全角半角）で別物にしない。
 * 区切り文字を自前で決めず `JSON.stringify` で綴じる（`plotCharactersDigest` と同じ）
 */
export function roleRenameOfferKey(offer: RoleRenameOffer): string {
  return JSON.stringify([offer.id, normalizeName(offer.from), normalizeName(offer.to)]);
}

/** 役名の人物の名前を直す案1件（`buildPlotCharacterUpdates` の答え） */
export interface PlotRoleRename<
  P extends PendingCharacterProposal = PendingCharacterProposal,
> {
  /** 直す案（承認待ちへ積む写し） */
  character: Character;
  /**
   * 同じ人物の更新案（抽出など）が承認待ちにあれば、その案。**その上に
   * 重ねてある**——更新案のファイルは人物のIDで付くので、資料から作り直すと
   * 先の案を上書きで消す。積むときは出どころと理由も引き継ぐ
   */
  base?: P;
  from: string;
  to: string;
}

export interface PlotCharacterUpdateOptions {
  /**
   * その組の直す案を、前に一度置いたか（`roleRenameOfferKey` で引く）。
   * 置いた案が承認待ちにも無く、資料もまだ役名のままなら、作者が見送ったと読む
   */
  renameOffered?: (offer: RoleRenameOffer) => boolean;
}

/**
 * 承認待ちの1件のうち、突き合わせに要る部分（`PendingUpdate` と同じ形）。
 *
 * 型を `pendingReview.ts` から借りないのは、あちらがこのファイルを
 * import しているため（輪にしない）。
 */
export interface PendingCharacterProposal {
  character: Character;
  /** 新規案なら "creation"。無ければ既存レコードの更新案 */
  kind?: string;
}

export interface PlotCharacterPlan<
  P extends PendingCharacterProposal = PendingCharacterProposal,
> {
  /** 既存レコードの写しに、プロットの紹介文を入れたもの（承認待ちへ積む） */
  updates: Character[];
  /** 資料にまだ居ない名前 */
  creations: PlotCharacterEntry[];
  /**
   * **承認待ちの更新案の上に**、プロットの紹介文を重ねたもの。
   * いまは名前を直す案（主人公 → 相馬 誠。設計書6.4.8）だけがここへ来る。
   * 積むときは元の案の出どころと理由を引き継ぐ（`proposal` を返すのはそのため）
   */
  pendingOverlays: Array<{ proposal: P; character: Character }>;
  /**
   * 資料の役名の人物（「主人公」）を、行に書かれた名前に直す案
   * （作者の判断、2026-09-25「直す案を置く」）。「役名（名前）」の行だけが持つ
   */
  renames: PlotRoleRename<P>[];
  skipped: PlotCharacterSkip[];
}

/**
 * 節の内容と既存の人物一覧から、承認待ちへ積むものを決める。
 *
 * **紹介文（summary）だけを扱う。** プロットの人物欄に書かれるのは
 * 「何者か」の一行であり、外見や一人称ではない。ここで欄を増やすと、
 * 書かれていない項目を空で塗り替えることになる。
 *
 * **作中の変化（`changes`）には記録しない。** プロットの記述は
 * 「第何話の値」ではないので、話数の分からない値を変化として積むと、
 * 6.18の前後判定（いちばん後ろの話の値を採る）が狂う。
 *
 * ## 資料に名前が無いときは、承認待ちと役名も見る（設計書6.4.9）
 *
 * 名前の候補（6.4.8）で「主人公（相馬 誠）」と書き足すと、資料の「主人公」を
 * 「相馬 誠」に直す案が承認待ちに置かれる。**承認されるまで資料には
 * 「主人公」しかいない**ので、名前だけで突き合わせると「相馬 誠」を新規に
 * 積み、そちらを先に承認すると同じ人が2人になる（2026-09-25 に作者が「直す」）。
 *
 * 1. 承認待ちの更新案に、その名前の人物がいる（名前を直す案）
 *    → 新規にしない。紹介文が変わっていれば、その案の上に重ねる
 * 2. 「役名（名前）」の行で、**資料に役名だけの人物がちょうど1人**いる
 *    → その人物を名前に直す案を置く（`renames`。作者の判断、2026-09-25
 *    「直す案を置く」）。案の形は名前の候補（`buildRoleRenameProposal`）と同じ
 *    ——ただし前に同じ組の案を置いていれば（作者が見送った）、置き直さない
 *    （`renameOffered`）
 * 3. 2で直せないが、資料か承認待ちの新規案に**役名の人物**がいる
 *    → 新規にしない（`sameRole`）。どちらを残すかは作者が資料で決める
 *
 * 役名の人物が**集団の呼び名（モブ）**なら、その中の1人に名前を付けた
 * ことになるので、今までどおり新規に積む（名前の候補の対象から外す
 * `plotNameTargets.ts` と同じ見方）。
 *
 * **相談からの反映（6.72）も、ここを通る。** 相談の拾い出しは役名を持たない
 * ので、効くのは1だけ。規則を2か所に持たない（片方だけ直すと、経路で
 * 挙動が変わる）。
 */
export function buildPlotCharacterUpdates<
  P extends PendingCharacterProposal = PendingCharacterProposal,
>(
  entries: readonly PlotCharacterEntry[],
  existing: readonly Character[],
  pending: readonly P[] = [],
  options: PlotCharacterUpdateOptions = {}
): PlotCharacterPlan<P> {
  const updates: Character[] = [];
  const creations: PlotCharacterEntry[] = [];
  const pendingOverlays: PlotCharacterPlan<P>["pendingOverlays"] = [];
  const skipped: PlotCharacterSkip[] = [];
  // 直す案の候補。**行を全部見てから**決める（下の「取り合い」を参照）
  const renameCandidates: Array<{
    entry: PlotCharacterEntry;
    rename: PlotRoleRename<P>;
  }> = [];

  const ledgerIds = new Set(existing.map((character) => character.id));
  // 更新案は、資料に本人が居るものだけを見る。本人が消えた案は承認の
  // ときに片付けられるので、それを当てにすると誰も作られなくなる
  const proposals = pending.filter(
    (entry) => entry.kind !== "creation" && ledgerIds.has(entry.character.id)
  );
  const pendingCreations = pending
    .filter((entry) => entry.kind === "creation")
    .map((entry) => entry.character);

  for (const entry of entries) {
    const matches = findCharactersByAppellation(existing, entry.name);

    if (matches.length === 0) {
      const renamed = proposals.filter(
        (proposal) =>
          findCharactersByAppellation([proposal.character], entry.name).length > 0
      );
      if (renamed.length > 1) {
        skipped.push({ name: entry.name, reason: "ambiguous" });
        continue;
      }
      if (renamed.length === 1) {
        const overlay = overlayPendingSummary(entry, renamed[0], existing);
        if (overlay === "authorConfirmed") {
          skipped.push({ name: entry.name, reason: "authorConfirmed" });
        } else if (overlay) {
          pendingOverlays.push({ proposal: renamed[0], character: overlay });
        }
        continue;
      }
      if (entry.role) {
        const rename = planRoleRename(entry, entry.role, existing, proposals, pendingCreations);
        if (
          rename &&
          options.renameOffered?.({
            id: rename.character.id,
            from: rename.from,
            to: rename.to,
          })
        ) {
          skipped.push({ name: entry.name, reason: "renameOffered", role: entry.role });
          continue;
        }
        if (rename) {
          renameCandidates.push({ entry, rename });
          continue;
        }
        if (hasRoleHolder(entry.role, existing, pendingCreations)) {
          skipped.push({ name: entry.name, reason: "sameRole", role: entry.role });
          continue;
        }
      }
      creations.push(entry);
      continue;
    }
    if (matches.length > 1) {
      // どれへ寄せても半分は誤りになる。作者の判断を待つ（characterMergeと同じ）
      skipped.push({ name: entry.name, reason: "ambiguous" });
      continue;
    }

    const match = matches[0];
    const summary = clampSummary(entry.summary);
    // 名前だけの行は、既に居る人物に対して足す情報を持たない
    if (!summary) continue;
    if (summary === match.summary) continue;

    // 作者が確定させたレコードは、抽出と同じくこちらから書き換えない
    // （実装ルール2。登場話数の追記だけが許されるが、プロットには話数が無い）
    if (!match.autoGenerated) {
      skipped.push({ name: entry.name, reason: "authorConfirmed" });
      continue;
    }

    // 呼び出し側のレコードを書き換えない。承認するまで台帳は変わらない
    const proposal = structuredClone(match) as Character;
    proposal.summary = summary;
    updates.push(proposal);
  }

  /*
    **同じ人物へ2つの案が向かうなら、直す案は置かない**（取り合い）。
    更新案のファイルは人物のIDで付くので、後に積んだ方が先の方を上書きで
    消す。「主人公（相馬 誠）」と「主人公（早瀬 陸）」が並んでいる、
    「主人公：〜」の行も残っている、のどちらも作者の書きかけで、
    どれが正しいかはこちらで決められない
  */
  const claimed = new Map<string, number>();
  for (const { rename } of renameCandidates) {
    const id = rename.character.id;
    claimed.set(id, (claimed.get(id) ?? 0) + 1);
  }
  const updatedIds = new Set(updates.map((character) => character.id));
  const renames: PlotRoleRename<P>[] = [];
  for (const { entry, rename } of renameCandidates) {
    const id = rename.character.id;
    if ((claimed.get(id) ?? 0) > 1 || updatedIds.has(id)) {
      skipped.push({ name: entry.name, reason: "sameRole", role: entry.role });
      continue;
    }
    renames.push(rename);
  }

  return { updates, creations, pendingOverlays, renames, skipped };
}

/**
 * 「役名（名前）」の行から、資料の役名の人物を直す案を作る。置けなければ undefined。
 *
 * 置くのは次をすべて満たすときだけ（どれか1つでも崩れると、別の人の名前を
 * 変える案になりうる）：
 *
 * - 資料で役名に当たる人物（モブを除く）が**ちょうど1人**で、その人の
 *   **名前そのものが役名**（「主人公」）。別名に「主人公」を持つだけの
 *   「灯」は、既に名前のある人物なので直さない
 * - 承認待ちの新規案に、同じ役名の人物がいない（どちらが本人か決められない）
 * - その人物の更新案が承認待ちにあるなら、それがまだ役名のまま
 *   （**別の名前へ直す案**なら、上から重ねない。作者が承認の画面で選ぶ）
 *
 * `autoGenerated: false` の人物や `authorLocked` の呼称を持つ人物でも置く
 * （名前の候補と同じ。案に出すだけで、承認するまで資料は変わらない。
 * 実装ルール2）。ただし**紹介文は、作者が確定させた人物には重ねない**
 * ——プロットからの反映は、確定した人物の紹介文を変える案を出さない（上の
 * 名前で当たった行と同じ扱い）。
 */
function planRoleRename<P extends PendingCharacterProposal>(
  entry: PlotCharacterEntry,
  role: string,
  existing: readonly Character[],
  proposals: readonly P[],
  pendingCreations: readonly Character[]
): PlotRoleRename<P> | undefined {
  const holders = findCharactersByAppellation(existing, role).filter(
    (character) => !character.isMob
  );
  if (holders.length !== 1) return undefined;
  const holder = holders[0];
  if (normalizeName(holder.name) !== normalizeName(role)) return undefined;
  const pendingHolders = findCharactersByAppellation(pendingCreations, role).filter(
    (character) => !character.isMob
  );
  if (pendingHolders.length > 0) return undefined;

  const previous = proposals.find((proposal) => proposal.character.id === holder.id);
  if (previous && normalizeName(previous.character.name) !== normalizeName(holder.name)) {
    return undefined;
  }
  const base = previous ? previous.character : holder;
  const character = buildRoleRenameProposal(base, { name: entry.name, reading: "" });
  // plot.md は読みを書かない。**役名の読み（「しゅじんこう」）を新しい名前に
  // 残さない**——名前の候補は選んだ名前の読みを入れるが、ここには入れる読みが無い
  if (normalizeName(base.name) !== normalizeName(entry.name)) character.reading = null;

  const summary = clampSummary(entry.summary);
  if (summary && holder.autoGenerated && base.autoGenerated) {
    character.summary = summary;
  }
  return {
    character,
    ...(previous ? { base: previous } : {}),
    from: holder.name,
    to: entry.name,
  };
}

/**
 * 設定資料の**名前が役名だけの人物**（「主人公」）を、選んだ名前に直す更新案
 * （作者の裁定、2026-09-25 午前）。名前の候補（6.4.8）とプロットからの
 * 反映（6.4.9）の両方が使う——**置く案の形を1か所で決める**。
 *
 * 変えるのは3つだけ：名前を選んだ名前に、読みを選んだ名前の読みに、
 * **元の役名は役割の欄へ**（空ならそのまま入れ、書いてあれば頭に足す。
 * 既に含まれていれば足さない）。新しい名前と同じ別名があれば外す。
 *
 * **ほかの欄は1つも変えない。** 呼称（`authorLocked` のものも）・関係・
 * 作者メモ・`autoGenerated` はそのまま——これは**更新案**で、作者が承認する
 * まで資料は変わらない（実装ルール2。`autoGenerated: false` の人物でも、
 * 名前を自動で書き換えはしない。案として出すだけ）。
 * ほかの人物の呼称・関係に残る元の役名は、ここでは直さない
 * （本文ごとの付け替えは名前の点検 6.37.3 の仕事）。
 *
 * 呼び出し側のレコードは書き換えない（写しを返す）。
 *
 * 以前は `plotNameTargets.ts` にあった（あちらから再輸出している）。
 */
export function buildRoleRenameProposal(
  character: Character,
  pick: { name: string; reading: string }
): Character {
  const proposal = structuredClone(character);
  const oldName = character.name.trim();
  const name = pick.name.trim();
  const reading = pick.reading.trim();
  const role = character.role?.trim() ?? "";

  proposal.name = name;
  if (reading) proposal.reading = reading;
  proposal.role = !role ? oldName : role.includes(oldName) ? role : `${oldName}。${role}`;
  const key = normalizeName(name);
  proposal.aliases = character.aliases.filter((alias) => normalizeName(alias) !== key);
  return proposal;
}

/**
 * 承認待ちの更新案（名前を直す案）へ、プロットの紹介文を重ねた写し。
 * 重ねるものが無ければ undefined、作者が確定させた人物なら "authorConfirmed"。
 *
 * **案の上に重ねる**のは、資料のレコードから作り直すと、直す案が持つ
 * 名前と読み（名前の候補で選んだもの）が消えるため。
 */
function overlayPendingSummary(
  entry: PlotCharacterEntry,
  proposal: PendingCharacterProposal,
  existing: readonly Character[]
): Character | "authorConfirmed" | undefined {
  const summary = clampSummary(entry.summary);
  if (!summary || summary === proposal.character.summary) return undefined;
  // 資料の本人で見る（案の写しの印が古いことがある）。実装ルール2
  const ledger = existing.find((character) => character.id === proposal.character.id);
  if (!ledger?.autoGenerated || !proposal.character.autoGenerated) {
    return "authorConfirmed";
  }
  const overlay = structuredClone(proposal.character) as Character;
  overlay.summary = summary;
  return overlay;
}

/**
 * その役名の人物が、資料か承認待ちの新規案にいるか。**集団（モブ）は数えない**
 * ——「作業員（ガルド）」は作業員の中の1人に名前を付けた行で、群れそのものではない
 */
function hasRoleHolder(
  role: string,
  existing: readonly Character[],
  pendingCreations: readonly Character[]
): boolean {
  return [
    ...findCharactersByAppellation(existing, role),
    ...findCharactersByAppellation(pendingCreations, role),
  ].some((character) => !character.isMob);
}

/**
 * 新規案が持つ仮のID。
 *
 * `parseCharacter` はIDの形（`char_数字`）を確かめるので、空にはできない。
 * **この番号のまま台帳へ入れてはいけない**——承認したときに
 * `applyPendingUpdates` が採り直す。積んだ時点で本番の番号を採ると、
 * 承認までのあいだに別の操作が同じ番号を使う。
 *
 * **実体は `pendingUpdateFormat.ts` へ移した**（0.66.3）。このファイルは
 * `characterMerge` 経由で重い系を引き込むので、外から呼ぶ束（MCPサーバー。
 * 設計書6.87.16）から指すには重すぎる。ここからは再輸出するだけなので、
 * 今までどおりこのファイルから読んでよい。
 */
export { PENDING_CREATION_ID } from "./pendingUpdateFormat";

/**
 * 新規の人物案のレコードを作る。
 *
 * **初期値は抽出の新規と同じ流儀**（`emptyCharacter`。`autoGenerated: true`、
 * 登場話数は空）。違うのは `status` だけで、**本文にまだ出ていないので
 * 「未登場」**にする（設定資料には「未登場（設定のみ）」と出る）。
 * プロットに書いただけの人物を「登場済み」と名乗らせない。
 */
export function buildNewCharacterRecords(
  entries: readonly PlotCharacterEntry[]
): Character[] {
  return entries.map((entry) => ({
    ...emptyCharacter(PENDING_CREATION_ID, entry.name),
    summary: clampSummary(entry.summary),
    // 「主人公（相馬 誠）」の役名は、役割の欄へ（別名にはしない——「魔物」
    // 「班長」を別名にすると、本文のその語がすべてこの人物の呼び名になる）
    ...(entry.role ? { role: entry.role } : {}),
    status: "未登場" as const,
  }));
}

/**
 * 積み直す新規案へ、**既に積んである同じ名前の新規案**から読みと役割を引き継ぐ
 * （設計書6.4.8「名前の候補を出す」）。
 *
 * 名前の候補から選んだ人物は、読み仮名つきで承認待ちへ置かれる。ところが
 * plot.md には読みを書かないので、あとで「プロットの人物を資料へ反映」が
 * 同じ人を積み直すと、**読みの無い案で上書きしてしまう**。プロットが
 * 持たない欄だけを、既にある案から受け継ぐ（プロットに書いてある欄は
 * プロットが正しいので触らない）。
 */
export function inheritPendingCreationFields(
  records: readonly Character[],
  pendingCreations: readonly Character[]
): Character[] {
  return records.map((record) => {
    const key = normalizeName(record.name);
    const previous = pendingCreations.find(
      (entry) => normalizeName(entry.name) === key
    );
    if (!previous) return record;
    return {
      ...record,
      reading: record.reading ?? previous.reading,
      role: record.role ?? previous.role,
    };
  });
}

/**
 * その呼び名で引き当てられる人物。
 *
 * 名前と別名の両方を見る。**作者が「別人だ」と決めた呼び名では
 * 引き当てない**（設計書6.5.8）——ここを塞がないと、分けた判断が
 * プロット経由で戻ってくる。
 *
 * 承認のとき（`applyPendingUpdates`）にも使う。積んだあとに同じ名前の
 * 人物が資料へ増えていたら、新規案は作らずに片付ける——写しを作らない
 * ために、突き合わせの決まりはここ1か所に置く。
 */
export function findCharactersByAppellation(
  existing: readonly Character[],
  name: string
): Character[] {
  const key = normalizeName(name);
  if (!key) return [];

  return existing.filter((character) => {
    const blocked = new Set(
      (character.distinctFrom ?? []).map((entry) => normalizeName(entry.name))
    );
    if (blocked.has(key)) return false;
    return [character.name, ...character.aliases]
      .map(normalizeName)
      .some((candidate) => candidate === key && !blocked.has(candidate));
  });
}
