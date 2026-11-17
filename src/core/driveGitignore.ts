import { DRIVE_GLOB_RULE_PREFIX, foldSyncPath } from "./driveSyncPlan";

/** 区切り全体の「*」2つ（記号を続けて書くと、画面の文字列の網が強調と読む） */
const GLOBSTAR = "*".repeat(2);

/**
 * 作者が自分で .gitignore に書いた行を、Google ドライブへ送らないものに足す（設計書5.10.9）。
 * 読むのは作品の根の `.gitignore` だけ（呼び手が中身を渡す）。`vscode`・`node:` を読まない。
 *
 * **読める形だけを読み、読めない行は解釈しない**（読めない行として番号と中身を返し、
 * 呼び手が知らせる）。読み違えると、作者が送りたいファイルが黙って届かない・送りたくない
 * ファイルが黙って届く。どちらも作者は気づけないので、推して読まない。
 *
 * 読める形：
 * - 空の行・`#` で始まる行（読み飛ばす）。行末の空白は落とす
 * - 区切りごとの `*`（0字以上）・`?`（1字）。区切り全体の `**`（頭・途中は0個以上の区切り、
 *   終わりは中の全部）
 * - 末尾の `/`（フォルダーだけ）・先頭の `/`（根に留める）
 * - 途中に `/` のある行は根から、`/` の無い名前はどの深さでも当てる（Git と同じ）
 *
 * 読めない形：否定の `!`・文字の組 `[...]`・円記号（逃がし）・区切りの一部に混ざった `**`・
 * `.` と `..` の区切り・空の区切り（`a//b`）
 */

export interface GitignoreForDrive {
  /** `isIgnoredSyncPath` へそのまま足せる項目（`glob:` で始まる） */
  rules: string[];
  /** 読めなかった行（1から数えた番号と、行末の空白を落とした中身） */
  unreadable: { line: number; text: string }[];
}

export function gitignoreForDrive(text: string): GitignoreForDrive {
  const out: GitignoreForDrive = { rules: [], unreadable: [] };
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.replace(/[ \t]+$/, "");
    if (line === "" || line.startsWith("#")) return;
    const rule = ruleOf(line);
    if (rule === undefined) out.unreadable.push({ line: index + 1, text: line });
    else out.rules.push(rule);
  });
  return out;
}

function ruleOf(line: string): string | undefined {
  if (line.startsWith("!") || /[[\]\\]/.test(line)) return undefined;
  const dirOnly = line.endsWith("/");
  let body = dirOnly ? line.slice(0, -1) : line;
  const rooted = body.startsWith("/");
  if (rooted) body = body.slice(1);
  if (body === "") return undefined;
  const segments = body.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  if (segments.some((segment) => segment.includes(GLOBSTAR) && segment !== GLOBSTAR)) return undefined;
  // 途中に「/」があれば根から。無ければどの深さでも（頭に「**」を足す）
  const anchored = rooted || segments.length > 1;
  const folded = segments.map((segment) => (segment === GLOBSTAR ? GLOBSTAR : foldSyncPath(segment)));
  if (folded.some((segment) => segment === "")) return undefined;
  const pattern = anchored || folded[0] === GLOBSTAR ? folded : [GLOBSTAR, ...folded];
  return `${DRIVE_GLOB_RULE_PREFIX}${pattern.join("/")}${dirOnly ? "/" : ""}`;
}
