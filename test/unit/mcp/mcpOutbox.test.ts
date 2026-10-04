import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import iconv from "iconv-lite";
import { decodeBytes } from "../../../src/core/textDecode";
import { parseFindingLines, resolveFindings, type Finding } from "../../../src/models/finding";
import {
  AUTHOR_EDIT_NOTE,
  BODY_CHANGED_REASON,
  OUTBOX_CONTEXT_CHARS,
  OVERLAP_REASON,
  findOutboxTemplate,
  outboxImport,
  outboxPack,
  type OutboxRecord,
} from "../../../src/mcp/tools/outbox";
import { exposureOf } from "../../../src/mcp/tools/accessLog";
import { locateAppliedSuggestion } from "../../../src/core/proposalUndo";
import { locateAppliedFinding, recentAppliedFindings } from "../../../src/core/appliedFindings";

/**
 * 出先の原稿箱の段1（設計書6.115）——`outbox.pack` と `outbox.import`。
 *
 * いちばん見張りたいのは3つ。
 *
 * 1. **送る中身に本文が入らない**（段1で claude.ai へ出るのは指摘の一文と題・ハッシュだけ）
 * 2. **原稿を壊さない**——送ったあとに本文が変わっていれば入れない／文字コード・
 *    改行・末尾改行を保つ（実装ルール1）
 * 3. **採否は持ち主の記録だけ**——編集部の採否は入れない
 */

const OWNER = "u_owner";
const EDITOR = "u_editor";
const FILE = "本文/001_はじまり.txt";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "outbox-"));
  fs.mkdirSync(nodePath.join(root, "本文"), { recursive: true });
  fs.mkdirSync(nodePath.join(root, ".aiwriter"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeBody(bytes: Uint8Array | string, file = FILE): void {
  fs.writeFileSync(nodePath.join(root, file), bytes);
}

function readBytes(file = FILE): Buffer {
  return fs.readFileSync(nodePath.join(root, file));
}

function hashOf(file = FILE): string {
  return decodeBytes(readBytes(file)).hash;
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f_typo1",
    time: new Date().toISOString(),
    file: FILE,
    hintLine: 2,
    original: "彼はわらった。",
    target: "わらった",
    suggestion: "笑った",
    before: "",
    after: "",
    message: "漢字にすると読みやすい",
    category: "typo",
    label: "誤字脱字",
    producer: { providerId: "ollama", model: "gemma" },
    ...overrides,
  };
}

function placeFindings(findings: Finding[]): void {
  fs.writeFileSync(
    nodePath.join(root, ".aiwriter", "findings.jsonl"),
    findings.map((item) => JSON.stringify({ kind: "finding", ...item })).join("\n") + "\n",
    "utf8"
  );
}

function memo(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    id: "r1",
    kind: "memo",
    writer: OWNER,
    episode: FILE,
    text: "ここに潮の匂いを足す",
    baseHash: hashOf(),
    ...overrides,
  };
}

function verdict(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    id: "v1",
    kind: "verdict",
    writer: OWNER,
    findingId: "f_typo1",
    verdict: "fix",
    baseHash: hashOf(),
    ...overrides,
  };
}

function findingStatus(id: string): string | undefined {
  const text = fs.readFileSync(nodePath.join(root, ".aiwriter", "findings.jsonl"), "utf8");
  return resolveFindings(parseFindingLines(text)).find((view) => view.id === id)?.status;
}

describe("outbox.pack——送る中身", () => {
  it("本文の全体は返さない（題・ハッシュ・未処理の指摘の一文と、その前後2行だけ）", async () => {
    const secret = "この一文は外へ出てはいけない本文である。";
    // 前後に添えるのは中身のある2行まで。3行目より先は出ない
    writeBody(`一行目\n彼はわらった。\n後ろの一。\n\n後ろの二。\n${secret}\n`);
    placeFindings([finding()]);

    const result = outboxPack({ folder: root });

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.episodes).toEqual([
      { file: FILE, chapter: 1, title: expect.any(String), hash: hashOf() },
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      id: "f_typo1",
      file: FILE,
      line: 2,
      original: "彼はわらった。",
      suggestion: "笑った",
      canFix: true,
    });
  });

  it("判断の済んだ指摘は送らない（提案パネルと同じ状態の決め方）", async () => {
    writeBody("一行目\n彼はわらった。\n");
    placeFindings([finding()]);
    fs.appendFileSync(
      nodePath.join(root, ".aiwriter", "findings.jsonl"),
      JSON.stringify({ kind: "decision", findingId: "f_typo1", time: new Date().toISOString(), status: "dismissed", note: "" }) + "\n"
    );
    expect(outboxPack({ folder: root }).findings).toHaveLength(0);
  });

  it("雛形の道は実在するものだけを返す（束の隣 → リポジトリの media/outbox の順）", async () => {
    // 束の隣に写してある（製品が保管庫へ写した形）
    const storage = fs.mkdtempSync(nodePath.join(os.tmpdir(), "outbox-storage-"));
    try {
      fs.writeFileSync(nodePath.join(storage, "outbox.html"), "<title>x</title>");
      expect(findOutboxTemplate(nodePath.join(storage, "mcp-server.mjs"))).toBe(
        nodePath.join(storage, "outbox.html")
      );
      // 隣に無く、1つ上にも media が無ければ null（推測の道を返さない）
      fs.rmSync(nodePath.join(storage, "outbox.html"));
      expect(findOutboxTemplate(nodePath.join(storage, "mcp-server.mjs"))).toBeNull();
    } finally {
      fs.rmSync(storage, { recursive: true, force: true });
    }
    // リポジトリの dist から走らせた形
    const repo = nodePath.join(__dirname, "..", "..", "..");
    expect(findOutboxTemplate(nodePath.join(repo, "dist", "mcp-server.mjs"))).toBe(
      nodePath.join(repo, "media", "outbox", "outbox.html")
    );
  });

  it("作品に触れない記録の重さ：pack は抜粋、import は出さない", async () => {
    expect(exposureOf("outbox.pack", { folder: root })).toBe("excerpt");
    expect(exposureOf("outbox.import", { folder: root })).toBe("none");
  });
});

describe("ページの雛形——Claude に聞く（決まり6）", () => {
  const repo = nodePath.join(__dirname, "..", "..", "..");
  const page = fs.readFileSync(nodePath.join(repo, "media", "outbox", "outbox.html"), "utf8");

  it("sample が無い見え方では道を出さない・答えは textContent で出す", async () => {
    expect(page).toContain('window.claude.use("sample")');
    expect(page).toContain("if (state.sample) item.appendChild(askBox(");
    // 答えも保管庫の中身も HTML として差し込まない
    expect(page).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("頼み方に、判断材料を示すだけで本文を書き換えないことを書く", async () => {
    expect(page).toContain("作者の文体を尊重し、直すかどうかの判断材料を短く示す");
    expect(page).toContain("書き換えた本文を作らない");
  });

  it("呼ぶたびに止め口を新しく作り、拒否されたら道を隠す", async () => {
    expect(page).toMatch(/var ctl = new AbortController\(\);[\s\S]*signal: ctl\.signal/);
    expect(page).toContain('"not_granted"');
  });

  it("答えは保管庫へ自動では書かない（書くのは［メモを残す］の addRecord だけ）", async () => {
    // Claude に聞く部品の区間（聞く欄を組む askBox まで。そのあとは話の見出しとメモの欄）
    const askPart = page.slice(page.indexOf("var DEFAULT_QUESTION"), page.indexOf("function episodeHeading"));
    expect(askPart.length).toBeGreaterThan(0);
    expect(askPart).toContain("function askBox(");
    expect(askPart).not.toMatch(/addRecord|\.set\(|\.add\(|\.update\(|create_or_update_file/);
  });

  it("書き手の名前を引かない（user.profiles を呼ぶと、スマホで「応答していません」が続いた）", async () => {
    expect(page).not.toMatch(/\.profiles\(/);
  });

  it("保管庫の知らせのたびには組まず、まとめて1回組む（scheduleRender）", async () => {
    const start = page.slice(page.indexOf("async function start()"));
    expect(start).toContain("scheduleRender();");
    // 知らせの受け口（onSnapshot の1つ目の関数）の中で render() を直に呼ばない
    const handlers = [...start.matchAll(/onSnapshot\(function \(snap\) \{([\s\S]*?)\}, function/g)].map((m) => m[1]);
    expect(handlers.length).toBeGreaterThan(0);
    for (const handler of handlers) {
      expect(handler).toContain("scheduleRender();");
      expect(handler).not.toMatch(/\brender\(\);/);
    }
    expect(page).toMatch(/function scheduleRender\(\)[\s\S]*if \(renderQueued\) return;/);
  });

  it("スキルの publish の capabilities に sample と GitHub の3つの道具がある", async () => {
    const skill = fs.readFileSync(nodePath.join(repo, "docs", "skills", "novel-assist.md"), "utf8");
    expect(skill).toContain('"user": {}, "sample": {}');
    expect(skill).toContain(
      '"mcp": {"servers": [{"server": "GitHub", "tools": ["get_file_contents", "list_commits", "create_or_update_file"]}]}'
    );
    // ページが呼ぶ道具は、スキルに並べた3つだけ（manifest に無い道具は呼べない）
    const called = new Set([...page.matchAll(/gh\("([a-z_]+)"/g)].map((m) => m[1]));
    expect([...called].sort()).toEqual(["create_or_update_file", "get_file_contents", "list_commits"]);
  });
});

describe("ページの雛形——決めた状態・自分で直す・取り込み待ちの帯", () => {
  const repo = nodePath.join(__dirname, "..", "..", "..");
  const page = fs.readFileSync(nodePath.join(repo, "media", "outbox", "outbox.html"), "utf8");

  it("判断がある指摘は灰色にして、判断のボタンと［自分で直す］を出さない", async () => {
    expect(page).toContain("var decision = decisionOf(fid);");
    expect(page).toContain('" decided"');
    expect(page).toContain("if (state.myId && !decision) {");
    // ［自分で直す］も同じ枠の中（決めた指摘には出ない）。切って送った原文には出さない
    const ownerBlock = page.slice(page.indexOf("if (state.myId && !decision) {"));
    expect(ownerBlock.slice(0, ownerBlock.indexOf("if (state.sample)"))).toContain(
      "f.originalClipped !== true)) item.appendChild(editBox(f, base));"
    );
  });

  it("押した直後にその指摘のボタンを止め、まだ送っていない自分の記録だけを［取り消す］で消せる", async () => {
    expect(page).toMatch(/if \(state\.sending\[fid\]\) return;\s*state\.sending\[fid\] = true;/);
    // 送ったものは GitHub の受け取り箱にあるので、ページからは消さない
    expect(page).toMatch(/stageOf\(r\) !== "unsent"\) return;[\s\S]*\.delete\(\)/);
  });

  it("［自分で直す］は空・改行入り・元と同じ文を送らず、原文を添えて edit を足す", async () => {
    expect(page).toContain('if (!text.trim()) { say("直した文が空です。"); return; }');
    expect(page).toContain("/[\\r\\n]/.test(text))");
    expect(page).toContain("if (text === original)");
    expect(page).toContain('kind: "edit", original: original, text: text');
  });

  it("送る帯がいつも見え、送っていない分と送った分を数え分け、原稿へ入る道を書く（GitHub 経由）", async () => {
    expect(page).toMatch(/<div class="tray" id="tray"/);
    expect(page).toContain("押したもの・残したメモは、まずこの画面に保存されます。");
    expect(page).toContain("［原稿箱を取り込む］を押すと、原稿に入ります。");
    expect(page).toContain('"まだ送っていない " + unsent + "件"');
    expect(page).toContain('"送った " + sent + "件（パソコンの取り込み待ち）"');
    expect(page).toContain('"取り込み済み " + imported + "件"');
    // 送るのは新しいファイルとして（sha を渡さない＝既存のファイルを書き換えない）
    const send = page.slice(page.indexOf("async function sendToPc()"), page.indexOf("function recordsFor("));
    expect(send).toContain('gh("create_or_update_file"');
    expect(send).not.toMatch(/\bsha\s*:/);
  });

  it("画面に出す文に内部の言葉（保管庫・records）を書かない", async () => {
    // 地の HTML と、setStatus／textContent に渡す文字列だけを見る（コメントは対象外）
    const shown = [
      ...page.matchAll(/setStatus\("([^"]*)"\)/g),
      ...page.matchAll(/textContent = "([^"]*)"/g),
      ...page.matchAll(/var LOST = "([^"]*)"/g),
    ].map((m) => m[1]);
    const markup = page.slice(page.indexOf('<div class="wrap">'), page.indexOf("<script>"));
    for (const text of [...shown, markup]) {
      expect(text).not.toMatch(/保管庫|records/);
    }
  });
});

describe("outbox.import——メモ", () => {
  it("話の末尾へ // の行として入れる", async () => {
    writeBody("一行目\n二行目\n");
    const result = await outboxImport({ folder: root, ownerId: OWNER, records: [memo()] });
    expect(result.results[0].status).toBe("imported");
    expect(readBytes().toString("utf8")).toBe("一行目\n二行目\n// ここに潮の匂いを足す\n");
  });

  it("指摘に付けたメモは、その指摘の行の上へ入れる", async () => {
    writeBody("一行目\n彼はわらった。\n三行目\n");
    placeFindings([finding()]);
    const result = await outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [memo({ findingId: "f_typo1", text: "ここは笑顔の描写を足す" })],
    });
    expect(result.results[0].status).toBe("imported");
    expect(readBytes().toString("utf8")).toBe(
      "一行目\n// ここは笑顔の描写を足す\n彼はわらった。\n三行目\n"
    );
  });

  it("持ち主でない人のメモには「編集部：」を付ける", async () => {
    writeBody("一行目\n");
    await outboxImport({ folder: root, ownerId: OWNER, records: [memo({ writer: EDITOR, text: "ここは早い" })] });
    expect(readBytes().toString("utf8")).toBe("一行目\n// 編集部：ここは早い\n");
  });

  it("送ったあとに本文が変わっていれば入れずに断る（原稿は1バイトも変えない）", async () => {
    writeBody("一行目\n");
    const stale = memo();
    writeBody("一行目\n作者がパソコンで書き足した\n");
    const before = readBytes();

    const result = await outboxImport({ folder: root, ownerId: OWNER, records: [stale] });

    expect(result.results[0]).toMatchObject({ status: "refused", reason: BODY_CHANGED_REASON });
    expect(readBytes().equals(before)).toBe(true);
  });

  it("同じ話へ2件入れても、2件目を「本文が変わった」で断らない", async () => {
    writeBody("一行目\n");
    const base = hashOf();
    const result = await outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [
        memo({ id: "a", text: "一つ目", baseHash: base }),
        memo({ id: "b", text: "二つ目", baseHash: base }),
      ],
    });
    expect(result.results.map((item) => item.status)).toEqual(["imported", "imported"]);
    expect(readBytes().toString("utf8")).toBe("一行目\n// 一つ目\n// 二つ目\n");
  });

  it("2度目は入れ済みとして返し、本文へ2度入れない", async () => {
    writeBody("一行目\n");
    const record = memo();
    await outboxImport({ folder: root, ownerId: OWNER, records: [record] });
    const after = readBytes();

    const second = await outboxImport({ folder: root, ownerId: OWNER, records: [record] });

    expect(second.results[0].status).toBe("already");
    expect(second.alreadyCount).toBe(1);
    expect(readBytes().equals(after)).toBe(true);
  });

  it("Shift_JIS・CRLF・末尾改行なしの本文で、文字コードと改行を保つ", async () => {
    // 「～」は CP932 で別の符号を持つ字。書いていない行の元バイトが残るかを見る
    const original = iconv.encode("一行目～\r\n二行目", "shift_jis");
    writeBody(original);

    const result = await outboxImport({ folder: root, ownerId: OWNER, records: [memo({ text: "足す" })] });

    expect(result.results[0].status).toBe("imported");
    const expected = Buffer.concat([
      original,
      iconv.encode("\r\n// 足す", "shift_jis"),
    ]);
    expect(readBytes().equals(expected)).toBe(true);
    // 書き換える前の本文は回復先に残る（既存ファイルを上書きしない）
    const recovery = fs.readdirSync(nodePath.join(root, "本文", ".novelai-recovery"));
    expect(recovery).toHaveLength(1);
  });

  it("本文でないファイルは指させない", async () => {
    writeBody("一行目\n");
    fs.writeFileSync(nodePath.join(root, "メモ.json"), "{}");
    const result = await outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [memo({ episode: "メモ.json", baseHash: decodeBytes(Buffer.from("{}")).hash })],
    });
    expect(result.results[0].status).toBe("refused");
    expect(fs.readFileSync(nodePath.join(root, "メモ.json"), "utf8")).toBe("{}");
  });
});

describe("outbox.import——採否", () => {
  it("持ち主の［直す］は、提案パネルの［適用］と同じ計算で当てて判断を残す", async () => {
    writeBody("一行目\r\n彼はわらった。\r\n");
    placeFindings([finding()]);

    const result = await outboxImport({ folder: root, ownerId: OWNER, records: [verdict()] });

    expect(result.results[0].status).toBe("imported");
    expect(readBytes().toString("utf8")).toBe("一行目\r\n彼は笑った。\r\n");
    expect(findingStatus("f_typo1")).toBe("accepted");
    const verdicts = fs.readFileSync(
      nodePath.join(root, ".aiwriter", "history", "ai-verdicts.jsonl"),
      "utf8"
    );
    expect(JSON.parse(verdicts.trim())).toMatchObject({
      subject: "f_typo1",
      providerId: "ollama",
      model: "gemma",
      feature: "typo",
      status: "accepted",
    });
  });

  it("持ち主でない人の採否は断る（本文も判断も変えない）", async () => {
    writeBody("一行目\n彼はわらった。\n");
    placeFindings([finding()]);
    const before = readBytes();

    const result = await outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [verdict({ writer: EDITOR })],
    });

    expect(result.results[0].status).toBe("refused");
    expect(readBytes().equals(before)).toBe(true);
    expect(findingStatus("f_typo1")).toBe("pending");
  });

  it("欄に持ち主の id が書いてあっても、パスが別の人のものなら採否は断る", async () => {
    // 編集部が記録の欄 by に持ち主の id を書いて、持ち主の採否に見せかけた形
    writeBody("一行目\n彼はわらった。\n");
    placeFindings([finding()]);
    const before = readBytes();

    const result = await outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [verdict({ writer: EDITOR, by: OWNER })],
    });

    expect(result.results[0]).toMatchObject({ status: "refused", writer: EDITOR });
    expect(readBytes().equals(before)).toBe(true);
    expect(findingStatus("f_typo1")).toBe("pending");
  });

  it("同じ文書の id でも、書き手が違えば別の記録として扱う", async () => {
    writeBody("一行目\n");
    const base = hashOf();
    const result = await outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [
        memo({ id: "same", writer: OWNER, text: "作者", baseHash: base }),
        memo({ id: "same", writer: EDITOR, text: "編集", baseHash: base }),
      ],
    });
    expect(result.results.map((item) => [item.writer, item.status])).toEqual([
      [OWNER, "imported"],
      [EDITOR, "imported"],
    ]);
    expect(readBytes().toString("utf8")).toBe("一行目\n// 作者\n// 編集部：編集\n");
  });

  it("［採らない］は退けた、［済み］は採ったとして記録し、本文には触れない", async () => {
    writeBody("一行目\n彼はわらった。\n彼女はないた。\n");
    placeFindings([
      finding(),
      finding({ id: "f_typo2", hintLine: 3, original: "彼女はないた。", target: "ないた", suggestion: "泣いた" }),
    ]);
    const before = readBytes();

    const result = await outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [
        verdict({ id: "a", verdict: "reject" }),
        verdict({ id: "b", findingId: "f_typo2", verdict: "done" }),
      ],
    });

    expect(result.importedCount).toBe(2);
    expect(readBytes().equals(before)).toBe(true);
    expect(findingStatus("f_typo1")).toBe("dismissed");
    expect(findingStatus("f_typo2")).toBe("accepted");
  });

  it("メモと［直す］が同じ指摘に付いていても、両方入る（メモが先）", async () => {
    writeBody("一行目\n彼はわらった。\n");
    placeFindings([finding()]);
    const base = hashOf();

    const result = await outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [
        verdict({ id: "v", baseHash: base }),
        memo({ id: "m", findingId: "f_typo1", text: "表情も", baseHash: base }),
      ],
    });

    expect(result.results.map((item) => [item.id, item.status])).toEqual([
      ["v", "imported"],
      ["m", "imported"],
    ]);
    expect(readBytes().toString("utf8")).toBe("一行目\n// 表情も\n彼は笑った。\n");
  });

  it("校閲中のファイルへは［直す］を当てない", async () => {
    writeBody("一行目\n彼はわらった。\n");
    placeFindings([finding()]);
    fs.mkdirSync(nodePath.join(root, ".aiwriter", "locks"), { recursive: true });
    fs.writeFileSync(
      nodePath.join(root, ".aiwriter", "locks", "locks.jsonl"),
      JSON.stringify({ kind: "acquire", file: FILE, holder: "編集部の田中", holderKind: "editor", time: new Date().toISOString(), note: "" }) + "\n"
    );
    const before = readBytes();

    const result = await outboxImport({ folder: root, ownerId: OWNER, records: [verdict()] });

    expect(result.results[0].status).toBe("refused");
    expect(readBytes().equals(before)).toBe(true);
  });
});

describe("outbox.pack——自分で直せるか", () => {
  it("長い原文は切って送り、originalClipped で知らせる（切れた文は自分で直せない）", async () => {
    const long = "あ".repeat(130) + "。";
    writeBody(`一行目\n彼はわらった。\n${long}\n`);
    placeFindings([
      finding(),
      finding({ id: "f_long", hintLine: 3, original: long, target: "あ", suggestion: "い", label: "推敲", category: "proofread" }),
    ]);
    const result = outboxPack({ folder: root });
    expect(result.findings.find((item) => item.id === "f_typo1")?.originalClipped).toBe(false);
    expect(result.findings.find((item) => item.id === "f_long")?.originalClipped).toBe(true);
  });
});

/** 修正案の無い推敲の指摘（［直す］が出ず、作者が自分で直す形） */
const PROOF = finding({
  id: "f_proof",
  original: "それを隠すように点々と新聞紙が敷かれていた。",
  target: "それを隠すように点々と新聞紙が敷かれていた。",
  suggestion: "",
  message: "「点々と」の位置が落ち着かない",
  category: "proofread",
  label: "推敲",
});
const MINE = "それを隠すように、新聞紙が点々と敷かれていた。";

function edit(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    id: "e1",
    kind: "edit",
    writer: OWNER,
    findingId: "f_proof",
    original: PROOF.original,
    text: MINE,
    baseHash: hashOf(),
    ...overrides,
  };
}

function findingLines(): ReturnType<typeof parseFindingLines> {
  return parseFindingLines(fs.readFileSync(nodePath.join(root, ".aiwriter", "findings.jsonl"), "utf8"));
}

describe("outbox.import——自分で直す（edit）", () => {
  it("原文が1か所だけなら、作者の文に置き換えて元の指摘を「採った」にする", async () => {
    writeBody(`一行目\n部屋の隅。${PROOF.original}誰もいない。\n三行目\n`);
    placeFindings([PROOF]);

    const result = await outboxImport({ folder: root, ownerId: OWNER, records: [edit()] });

    expect(result.results[0]).toMatchObject({ status: "imported" });
    expect(readBytes().toString("utf8")).toBe(`一行目\n部屋の隅。${MINE}誰もいない。\n三行目\n`);
    expect(findingStatus("f_proof")).toBe("accepted");
    // 作者の文であることが記録で分かる（足した指摘の行の message と、その判断の note）
    const views = resolveFindings(findingLines());
    const mine = views.find((view) => view.suggestion === MINE);
    expect(mine).toMatchObject({
      status: "accepted",
      original: PROOF.original,
      target: PROOF.original,
      file: FILE,
      hintLine: 2,
      label: "推敲",
    });
    expect(mine?.message.startsWith(AUTHOR_EDIT_NOTE)).toBe(true);
    expect(mine?.decision?.note).toBe(AUTHOR_EDIT_NOTE);
    // 作者の文を AI の手柄として数えない
    expect(mine?.producer).toBeUndefined();
  });

  it("足した行から、提案パネルの［戻す］と同じ計算で元の本文へ戻せる", async () => {
    const body = `一行目\n部屋の隅。${PROOF.original}誰もいない。\n三行目\n`;
    writeBody(body);
    placeFindings([PROOF]);
    await outboxImport({ folder: root, ownerId: OWNER, records: [edit()] });

    // 提案パネルの undoIssue と同じ手順：行の中で直したあとの文脈を探し、直す語へ戻す
    const mine = resolveFindings(findingLines()).find((view) => view.suggestion === MINE)!;
    const lines = decodeBytes(readBytes()).text.split("\n");
    const lineText = lines[mine.hintLine - 1];
    const located = locateAppliedSuggestion(lineText, mine);
    expect(located.kind).toBe("found");
    if (located.kind !== "found") return;
    lines[mine.hintLine - 1] =
      lineText.slice(0, located.at) + mine.target + lineText.slice(located.at + mine.suggestion.length);
    expect(lines.join("\n")).toBe(body);
  });

  it("原文がパソコンの本文に無ければ断り、本文も判断も変えない", async () => {
    writeBody("一行目\nパソコンで書き直した一文。\n");
    placeFindings([PROOF]);
    const before = readBytes();

    const result = await outboxImport({ folder: root, ownerId: OWNER, records: [edit()] });

    expect(result.results[0].status).toBe("refused");
    expect(result.results[0].reason).toContain("見つかりません");
    expect(readBytes().equals(before)).toBe(true);
    expect(findingStatus("f_proof")).toBe("pending");
  });

  it("原文が2か所以上あれば、どこか決められないので断る", async () => {
    writeBody(`一行目\n${PROOF.original}\n${PROOF.original}\n`);
    placeFindings([PROOF]);
    const before = readBytes();

    const result = await outboxImport({ folder: root, ownerId: OWNER, records: [edit()] });

    expect(result.results[0].status).toBe("refused");
    expect(result.results[0].reason).toContain("2か所以上");
    expect(readBytes().equals(before)).toBe(true);
  });

  it("持ち主でない人の直しは断る（欄に持ち主の id を書いても、パスで決まる）", async () => {
    writeBody(`一行目\n${PROOF.original}\n`);
    placeFindings([PROOF]);
    const before = readBytes();

    const result = await outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [edit({ writer: EDITOR, by: OWNER })],
    });

    expect(result.results[0]).toMatchObject({ status: "refused", writer: EDITOR });
    expect(readBytes().equals(before)).toBe(true);
    expect(findingStatus("f_proof")).toBe("pending");
  });

  it("2度目は入れ済みとして返し、本文へ2度当てない", async () => {
    writeBody(`一行目\n${PROOF.original}\n`);
    placeFindings([PROOF]);
    await outboxImport({ folder: root, ownerId: OWNER, records: [edit()] });
    const after = readBytes();

    const second = await outboxImport({ folder: root, ownerId: OWNER, records: [edit()] });

    expect(second.results[0].status).toBe("already");
    expect(readBytes().equals(after)).toBe(true);
  });

  it("Shift_JIS・CRLF・末尾改行なしの本文で、文字コードと改行を保つ", async () => {
    const original = iconv.encode(`一行目～\r\n${PROOF.original}\r\n三行目`, "shift_jis");
    writeBody(original);
    placeFindings([PROOF]);

    const result = await outboxImport({ folder: root, ownerId: OWNER, records: [edit()] });

    expect(result.results[0].status).toBe("imported");
    expect(readBytes().equals(iconv.encode(`一行目～\r\n${MINE}\r\n三行目`, "shift_jis"))).toBe(true);
    expect(fs.readdirSync(nodePath.join(root, "本文", ".novelai-recovery"))).toHaveLength(1);
  });

  it("空の文・改行入り・元と同じ文・置き場と違う原文（切れた原文）は、それぞれの理由で断る", async () => {
    writeBody(`一行目\n${PROOF.original}\n`);
    placeFindings([PROOF]);
    const before = readBytes();

    for (const [record, words] of [
      [edit({ id: "a", text: "  " }), "空"],
      [edit({ id: "b", text: "一行目。\n二行目。" }), "改行"],
      [edit({ id: "c", text: PROOF.original }), "同じ"],
      [edit({ id: "d", original: "それを隠すように点々と…" }), "原文と違います"],
    ] as const) {
      const one = await outboxImport({ folder: root, ownerId: OWNER, records: [record] });
      expect(one.results[0].status).toBe("refused");
      expect(one.results[0].reason).toContain(words);
    }
    expect(readBytes().equals(before)).toBe(true);
    expect(findingStatus("f_proof")).toBe("pending");
  });

  it("校閲中のファイルへは当てない", async () => {
    writeBody(`一行目\n${PROOF.original}\n`);
    placeFindings([PROOF]);
    fs.mkdirSync(nodePath.join(root, ".aiwriter", "locks"), { recursive: true });
    fs.writeFileSync(
      nodePath.join(root, ".aiwriter", "locks", "locks.jsonl"),
      JSON.stringify({ kind: "acquire", file: FILE, holder: "編集部の田中", holderKind: "editor", time: new Date().toISOString(), note: "" }) + "\n"
    );
    const before = readBytes();

    const result = await outboxImport({ folder: root, ownerId: OWNER, records: [edit()] });

    expect(result.results[0].status).toBe("refused");
    expect(readBytes().equals(before)).toBe(true);
  });
});

describe("outbox.import——同じ指摘に持ち主の判断が重なったとき", () => {
  it("いちばん新しい1件だけを当て、残りは「重なり」として断る（渡した順ではなく時刻で）", async () => {
    writeBody("一行目\n彼はわらった。\n");
    placeFindings([finding()]);
    const before = readBytes();

    const result = await outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [
        // 新しいほうが［採らない］。古い［直す］は当てない
        verdict({ id: "new", verdict: "reject", at: "2026-10-04T10:05:00.000Z" }),
        verdict({ id: "old", verdict: "fix", at: "2026-10-04T10:00:00.000Z" }),
        verdict({ id: "old2", verdict: "reject", at: "2026-10-04T09:00:00.000Z" }),
      ],
    });

    expect(result.results.map((item) => [item.id, item.status])).toEqual([
      ["new", "imported"],
      ["old", "refused"],
      ["old2", "refused"],
    ]);
    expect(result.results[1].reason).toBe(OVERLAP_REASON);
    expect(readBytes().equals(before)).toBe(true);
    expect(findingStatus("f_typo1")).toBe("dismissed");
  });

  it("自分で直した文と採否が重なれば、新しいほうを当てる", async () => {
    writeBody(`一行目\n${PROOF.original}\n`);
    placeFindings([PROOF]);

    const result = await outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [
        verdict({ id: "v", findingId: "f_proof", verdict: "reject", at: "2026-10-04T10:00:00.000Z" }),
        edit({ id: "e", at: "2026-10-04T10:01:00.000Z" }),
      ],
    });

    expect(result.results.map((item) => [item.id, item.status])).toEqual([
      ["v", "refused"],
      ["e", "imported"],
    ]);
    expect(readBytes().toString("utf8")).toBe(`一行目\n${MINE}\n`);
  });

  it("同じ記録が2度渡されても、重なりとは見なさず1件として入れる", async () => {
    writeBody("一行目\n彼はわらった。\n");
    placeFindings([finding()]);

    const result = await outboxImport({ folder: root, ownerId: OWNER, records: [verdict(), verdict()] });

    expect(result.results.map((item) => [item.id, item.status])).toEqual([["v1", "imported"]]);
    expect(result.refusedCount).toBe(0);
    expect(readBytes().toString("utf8")).toBe("一行目\n彼は笑った。\n");
  });

  it("編集部の採否は重なりに数えない（持ち主の判断を押しのけない）", async () => {
    writeBody("一行目\n彼はわらった。\n");
    placeFindings([finding()]);

    const result = await outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [
        verdict({ id: "mine", verdict: "fix", at: "2026-10-04T10:00:00.000Z" }),
        verdict({ id: "theirs", writer: EDITOR, verdict: "reject", at: "2026-10-04T11:00:00.000Z" }),
      ],
    });

    expect(result.results.map((item) => [item.id, item.status])).toEqual([
      ["mine", "imported"],
      ["theirs", "refused"],
    ]);
    expect(readBytes().toString("utf8")).toBe("一行目\n彼は笑った。\n");
  });
});

/*
  指摘の前後の文と、範囲の指摘（作者の報告 2026-10-04「『た』が4文続いている場合などは、
  前後がわからないと修正できません」）。語尾単調の指摘は、続いている範囲の先頭の文を原文に持ち、
  説明に「（N〜M行目）」を書く（core/proofreadValidation.ts の describeMonotonousRun）
*/
const RANGE_BODY = [
  "前の一。",
  "前の二。",
  "",
  "彼は歩いた。",
  "空は青かった。",
  "",
  "風が吹いた。鳥が鳴いた。",
  "後ろの一。",
  "",
  "後ろの二。",
  "後ろの三。",
  "",
].join("\n");
const RANGE_LINES = ["彼は歩いた。", "空は青かった。", "", "風が吹いた。鳥が鳴いた。"];
const RANGE_TEXT = RANGE_LINES.join("\n");

const MONOTONY = finding({
  id: "f_mono",
  hintLine: 4,
  original: "彼は歩いた。",
  target: "彼は歩いた。",
  suggestion: "",
  message: "「た。」で終わる地の文が4文続いています（4〜7行目）：彼は歩いた。 ／ 空は青かった。 ／ …",
  category: "proofread",
  label: "推敲",
});

describe("outbox.pack——指摘の前後の文と範囲", () => {
  it("前後の中身のある行を2行ずつ（空行は飛ばす）と、範囲の全行を返す", async () => {
    writeBody(RANGE_BODY);
    placeFindings([MONOTONY]);

    const context = outboxPack({ folder: root }).findings[0].context;

    expect(context).toEqual({
      before: ["前の一。", "前の二。"],
      lines: RANGE_LINES,
      startLine: 4,
      after: ["後ろの一。", "後ろの二。"],
      range: true,
      clipped: false,
      rangeClipped: false,
    });
  });

  it("本文が上でずれていても、いまの位置から範囲を取る", async () => {
    writeBody(`足した一行。\n${RANGE_BODY}`);
    placeFindings([MONOTONY]);

    const context = outboxPack({ folder: root }).findings[0].context;

    expect(context?.startLine).toBe(5);
    expect(context?.lines).toEqual(RANGE_LINES);
    expect(context?.before).toEqual(["前の一。", "前の二。"]);
  });

  it("範囲の無い指摘は、指摘の行とその前後", async () => {
    writeBody("前の一。\n彼はわらった。\n後ろの一。\n");
    placeFindings([finding()]);

    const context = outboxPack({ folder: root }).findings[0].context;

    expect(context).toMatchObject({
      before: ["前の一。"],
      lines: ["彼はわらった。"],
      startLine: 2,
      after: ["後ろの一。"],
      range: false,
      clipped: false,
      rangeClipped: false,
    });
  });

  it("1指摘あたりの上限を超えたら切って印を付ける（範囲まで切れたら rangeClipped）", async () => {
    const longBefore = "前".repeat(1990);
    writeBody([longBefore, "彼はわらった。", "後ろの一。", ""].join("\n"));
    placeFindings([finding({ hintLine: 2 })]);
    const context = outboxPack({ folder: root }).findings[0].context!;
    expect(context.lines).toEqual(["彼はわらった。"]);
    expect(context.clipped).toBe(true);
    expect(context.rangeClipped).toBe(false);
    const sent = [...context.before, ...context.lines, ...context.after].join("");
    expect([...sent].length).toBeLessThanOrEqual(OUTBOX_CONTEXT_CHARS + 2);

    const longLine = "長".repeat(2500) + "た。";
    writeBody(["前の一。", "", "彼は歩いた。", longLine, "空は青かった。", "風が吹いた。", ""].join("\n"));
    placeFindings([{ ...MONOTONY, hintLine: 3, message: "「た。」で終わる地の文が4文続いています（3〜6行目）" }]);
    const cut = outboxPack({ folder: root }).findings[0].context!;
    expect(cut.rangeClipped).toBe(true);
    expect(cut.clipped).toBe(true);
    expect([...cut.lines.join("")].length).toBeLessThanOrEqual(OUTBOX_CONTEXT_CHARS + 1);
  });
});

describe("outbox.import——範囲を自分で直す（複数行の edit）", () => {
  function rangeEdit(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
    return edit({
      id: "r_edit",
      findingId: "f_mono",
      original: RANGE_TEXT,
      text: "彼は歩き、空は青かった。\n\n風が吹いて、鳥が鳴いた。",
      ...overrides,
    });
  }

  it("範囲の全行を、行数の違う作者の文に置き換える", async () => {
    writeBody(RANGE_BODY);
    placeFindings([MONOTONY]);

    const result = await outboxImport({ folder: root, ownerId: OWNER, records: [rangeEdit()] });

    expect(result.results[0]).toMatchObject({ status: "imported" });
    expect(readBytes().toString("utf8")).toBe(
      RANGE_BODY.replace(RANGE_TEXT, "彼は歩き、空は青かった。\n\n風が吹いて、鳥が鳴いた。")
    );
    expect(findingStatus("f_mono")).toBe("accepted");
    const mine = resolveFindings(findingLines()).find((view) => view.suggestion.startsWith("彼は歩き"));
    expect(mine).toMatchObject({
      status: "accepted",
      original: RANGE_TEXT,
      target: RANGE_TEXT,
      hintLine: 4,
      before: "前の二。",
      after: "後ろの一。",
    });
    expect(mine?.decision?.note).toBe(AUTHOR_EDIT_NOTE);
  });

  it("行を増やす直しも入れられる", async () => {
    writeBody(RANGE_BODY);
    placeFindings([MONOTONY]);
    const longer = "彼は歩いた。\n足を止める。\n空は青かった。\n\n風が吹く。鳥が鳴いた。";

    const result = await outboxImport({ folder: root, ownerId: OWNER, records: [rangeEdit({ text: longer })] });

    expect(result.results[0].status).toBe("imported");
    expect(readBytes().toString("utf8")).toBe(RANGE_BODY.replace(RANGE_TEXT, longer));
  });

  it("範囲がパソコンの本文に無ければ断り、本文も判断も変えない", async () => {
    writeBody(RANGE_BODY.replace("空は青かった。", "空は灰色だった。"));
    placeFindings([MONOTONY]);
    const before = readBytes();

    const result = await outboxImport({ folder: root, ownerId: OWNER, records: [rangeEdit()] });

    expect(result.results[0].status).toBe("refused");
    expect(result.results[0].reason).toContain("見つかりません");
    expect(readBytes().equals(before)).toBe(true);
    expect(findingStatus("f_mono")).toBe("pending");
  });

  it("範囲が2か所以上あれば断る", async () => {
    writeBody(`${RANGE_BODY}${RANGE_TEXT}\n`);
    placeFindings([MONOTONY]);
    const before = readBytes();

    const result = await outboxImport({ folder: root, ownerId: OWNER, records: [rangeEdit()] });

    expect(result.results[0].status).toBe("refused");
    expect(result.results[0].reason).toContain("2か所以上");
    expect(readBytes().equals(before)).toBe(true);
  });

  it("指摘の原文を含まない範囲・行の途中から始まる範囲は断る", async () => {
    writeBody(RANGE_BODY);
    placeFindings([MONOTONY]);
    const before = readBytes();

    const notMine = await outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [rangeEdit({ id: "x1", original: "後ろの一。\n\n後ろの二。" })],
    });
    expect(notMine.results[0].status).toBe("refused");
    expect(notMine.results[0].reason).toContain("指摘の原文");

    const midLine = await outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [
        rangeEdit({ id: "x2", original: "前の二。\n\n彼は歩いた。\n空は青", text: "前の二。\n彼は歩き、空は青" }),
      ],
    });
    expect(midLine.results[0].status).toBe("refused");
    expect(midLine.results[0].reason).toContain("行の途中");
    expect(readBytes().equals(before)).toBe(true);
    expect(findingStatus("f_mono")).toBe("pending");
  });

  it("Shift_JIS・CRLF の本文で、文字コードと改行を保つ（ページから CRLF で来ても本文の形に揃える）", async () => {
    const crlf = RANGE_BODY.split("\n").join("\r\n");
    writeBody(iconv.encode(crlf, "shift_jis"));
    placeFindings([MONOTONY]);

    const result = await outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [
        rangeEdit({
          original: RANGE_LINES.join("\r\n"),
          text: "彼は歩き、空は青かった。\r\n\r\n風が吹いて、鳥が鳴いた。",
        }),
      ],
    });

    expect(result.results[0].status).toBe("imported");
    const expected = RANGE_BODY.replace(RANGE_TEXT, "彼は歩き、空は青かった。\n\n風が吹いて、鳥が鳴いた。")
      .split("\n")
      .join("\r\n");
    expect(readBytes().equals(iconv.encode(expected, "shift_jis"))).toBe(true);
  });

  it("1行の edit は今までどおり（改行入りは断る）", async () => {
    writeBody(`一行目\n${PROOF.original}\n`);
    placeFindings([PROOF]);
    const refused = await outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [edit({ id: "n1", text: "一行目。\n二行目。" })],
    });
    expect(refused.results[0].reason).toContain("改行");
    const ok = await outboxImport({ folder: root, ownerId: OWNER, records: [edit({ id: "n2" })] });
    expect(ok.results[0].status).toBe("imported");
    expect(readBytes().toString("utf8")).toBe(`一行目\n${MINE}\n`);
  });

  it("「当てたもの」：1行へまとめた直しは［戻す］で戻せ、複数行の直しは並べない（落ちない）", async () => {
    writeBody(RANGE_BODY);
    placeFindings([MONOTONY]);
    await outboxImport({
      folder: root,
      ownerId: OWNER,
      records: [rangeEdit({ id: "one", text: "彼は歩き、空は青く、風が吹いて鳥が鳴いた。" })],
    });

    const views = resolveFindings(findingLines());
    const merged = views.find((view) => view.suggestion.startsWith("彼は歩き"))!;
    const text = decodeBytes(readBytes()).text;
    const line = locateAppliedFinding(merged, text);
    expect(line).toBe(4);
    // 提案パネルの undoIssue と同じ手順で戻す
    const lines = text.split("\n");
    const lineText = lines[line! - 1];
    const located = locateAppliedSuggestion(lineText, merged);
    expect(located.kind).toBe("found");
    if (located.kind !== "found") return;
    lines[line! - 1] =
      lineText.slice(0, located.at) + merged.target + lineText.slice(located.at + merged.suggestion.length);
    expect(lines.join("\n")).toBe(RANGE_BODY);

    // 複数行の直し：戻す口には並ばない（行で探すため見つからない）。落ちもしない
    const multi = { ...merged, suggestion: "彼は歩き、\n空は青かった。" };
    expect(locateAppliedFinding(multi, RANGE_BODY.replace(RANGE_TEXT, multi.suggestion))).toBeUndefined();
    expect(() => recentAppliedFindings([multi], 3)).not.toThrow();
  });
});

describe("ページの雛形——前後の文と範囲の直し", () => {
  const repo = nodePath.join(__dirname, "..", "..", "..");
  const page = fs.readFileSync(nodePath.join(repo, "media", "outbox", "outbox.html"), "utf8");

  it("前後の文を薄い字で出し、長いときは畳んで［前後を見る］で開く。記号は appendMarked で外す", async () => {
    expect(page).toContain("function contextNode(f)");
    expect(page).toContain("前後を見る");
    expect(page).toMatch(/function contextNode\(f\)[\s\S]*appendMarked\(/);
    expect(page).toMatch(/var ctx = contextNode\(f\);\s*if \(ctx\) item\.appendChild\(ctx\);/);
  });

  it("範囲の指摘は、範囲の全行を欄に入れて original に添える（切れた範囲では直させない）", async () => {
    expect(page).toContain("function rangeTextOf(f)");
    expect(page).toContain("c.lines.length < 2 || c.rangeClipped) return null;");
    expect(page).toMatch(/var multi = rangeTextOf\(f\) !== null;/);
    expect(page).toContain("var original = multi ? rangeTextOf(f) : str(f.original);");
    // 範囲の直しは改行を許し、1文の直しは今までどおり改行を入れない
    expect(page).toContain("if (!multi && /[\\r\\n]/.test(text))");
  });
});
