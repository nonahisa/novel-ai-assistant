import { describe, expect, test } from "vitest";
import {
  OVERVIEW_EPISODE_LIMIT,
  OVERVIEW_FILE_CHARS,
  formatChatOverview,
} from "../../../src/core/chatFileRequest";
import { SYNOPSIS_FILE } from "../../../src/core/synopsisDoc";

/**
 * 相談の全体像に載せる各話あらすじを、**問いに合わせて選ぶ**（P-21、2026-10-01）。
 *
 * 以前は `synopsis.md` を先頭から2,000字で切っていたので、219話の作品では
 * 第16話で途切れ、後半の話を訊く問いに答える材料が1つも無かった
 * （docs/measurements/2026-10-01-sonnet-as-internal-ai.md の不具合12）。
 *
 * **量は増やさない。** M7 の測定で、全体像が大きいと小さいモデルで読者の
 * 宣言が押し出されると分かっている（2026-10-01-reader-glossary-m7.md）。
 * 変えるのは「どの話を入れるか」だけ。
 */

const TOTAL = 219;

/** 1話ぶん約100字のあらすじ。`extra` に話ごとの目印を入れる */
function summaryOf(chapter: number, extra = ""): string {
  const filler = "主人公は村で畑を耕し、隣家の老人と天気の話をして、夕方には妹と夕食を囲んだ。";
  return `${extra}${filler}${filler}`.slice(0, 100) + `（第${chapter}話の出来事）`;
}

function synopsisText(): string {
  const lines = ["# 試しの作品", "", "辺境の村に転生した少年が、知識で村を立て直す話。", "", "## 各話あらすじ", ""];
  lines.push(`全 ${TOTAL} 話 / あらすじ合計 23,299 字`, "");
  for (let chapter = 1; chapter <= TOTAL; chapter++) {
    const extra =
      chapter === 43
        ? "国内の塩不足が深刻になり、"
        : chapter === 116
          ? "電気分解で塩不足がついに解消し、"
          : chapter === 200
            ? "竜の卵が孵り、"
            : "";
    lines.push(`### 第${chapter}話 題${chapter}`, "", summaryOf(chapter, extra), "");
  }
  return lines.join("\n");
}

const episodes = Array.from({ length: TOTAL }, (_, index) => ({
  path: `episode_${String(index + 1).padStart(4, "0")}.txt`,
  label: `第${index + 1}話 題${index + 1}`,
}));

function overview(focus?: string[]): string {
  const text = formatChatOverview({
    episodes,
    documents: [{ label: "作品紹介文・各話あらすじ", file: SYNOPSIS_FILE, text: synopsisText() }],
    ...(focus ? { focus } : {}),
  });
  if (!text) throw new Error("全体像が組めなかった");
  return text;
}

/** 以前の組み方（先頭から2,000字で切る）での字数。量の比べの物差し */
function previousLength(): number {
  const labels = episodes.map((episode) => `${episode.label}（${episode.path}）`);
  const head = labels.slice(0, OVERVIEW_EPISODE_LIMIT / 2).join(" / ");
  const tail = labels.slice(-OVERVIEW_EPISODE_LIMIT / 2).join(" / ");
  const synopsis = synopsisText().trim();
  return [
    "【作品の全体像】",
    `全${TOTAL}話。`,
    `話の一覧（多いため中間を省略）: ${head} …（中略）… ${tail}`,
    `【作品紹介文・各話あらすじ（${SYNOPSIS_FILE}）】\n${synopsis.slice(0, OVERVIEW_FILE_CHARS)}\n（以下省略。全文が要るなら needFiles で求めてください）`,
  ].join("\n").length;
}

describe("各話あらすじを問いに合わせて選ぶ", () => {
  test("後半の話数を訊いたら、その辺りのあらすじが入る", () => {
    const text = overview(["第200話あたりで主人公は何をしていましたか"]);
    expect(text).toContain("竜の卵が孵り");
    expect(text).toContain("第199話");
    expect(text).toContain("第201話");
  });

  test("問いの語を含む話のあらすじが入る（第16話より後でも）", () => {
    const text = overview(["この作品で、塩不足の問題は何話から何話までで解決されますか。"]);
    expect(text).toContain("国内の塩不足が深刻になり");
    expect(text).toContain("電気分解で塩不足がついに解消し");
  });

  test("話の一覧の中略にも、訊かれた話数の辺りの場所を出す", () => {
    const text = overview(["第120話で何が起きましたか"]);
    expect(text).toContain("第120話 題120（episode_0120.txt）");
  });

  test("抜き出したことを書く（全部だと誤解させない）", () => {
    const text = overview(["第200話あたりで主人公は何をしていましたか"]);
    expect(text).toMatch(/全219話のあらすじから/);
  });

  test("作品紹介文は残す", () => {
    expect(overview(["第200話はどんな話？"])).toContain("辺境の村に転生した少年");
  });

  test.each([
    ["話数を訊く問い", ["第200話あたりで主人公は何をしていましたか"]],
    ["語を訊く問い", ["この作品で、塩不足の問題は何話から何話までで解決されますか。"]],
    ["手がかりの無い問い", ["主人公の口調はどんな感じですか"]],
    ["問いを渡さない", undefined],
  ] as const)("材料の総量は今と同程度（%s）", (_, focus) => {
    const text = overview(focus ? [...focus] : undefined);
    // 増やさない。見出しや断りの言い回しのぶんだけ揺れを許す
    expect(text.length).toBeLessThanOrEqual(previousLength() + 150);
    // 減りすぎてもいけない（あらすじが入らなくなっていないか）
    expect(text.length).toBeGreaterThanOrEqual(previousLength() - 400);
  });
});

describe("短いあらすじは今までどおり", () => {
  test("上限に収まる文書は切らずにそのまま載せる", () => {
    const short = "# 短い作品\n\n紹介文。\n\n## 各話あらすじ\n\n### 第1話 出会い\n\n港で出会う。";
    const text = formatChatOverview({
      episodes: [{ path: "本文/001.md", label: "第1話 出会い" }],
      documents: [{ label: "作品紹介文・各話あらすじ", file: SYNOPSIS_FILE, text: short }],
      focus: ["第1話はどんな話？"],
    });
    expect(text).toContain(short);
  });
});
