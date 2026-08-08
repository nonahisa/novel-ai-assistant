const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// countChars と同じ数え方を素朴に再現して差を見る
function stripRuby(t) { return t.replace(/\{([^{}|]+)\|[^{}|]*\}/g, "$1"); }
function cp(s) { let n = 0; for (const _ of s) n++; return n; }

for (const dir of process.argv.slice(2)) {
  let net = 0, msLines = 0, files = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(txt|md)$/i.test(f)) continue;
    files++;
    const raw = stripRuby(fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n?/g, "\n"));
    net += cp(raw.replace(/\n/g, "").replace(/[\s\u3000]/g, ""));
    for (const line of raw.split("\n")) {
      const w = cp(line.replace(/\t/g, "    "));
      msLines += w === 0 ? 1 : Math.ceil(w / 20);
    }
  }
  const divide = Math.ceil(net / 400);
  const actual = Math.ceil(msLines / 20);
  console.log(`${path.basename(dir)}  (${files}ファイル)`);
  console.log(`  純文字数: ${net.toLocaleString()}字`);
  console.log(`  割り算(誤): ${divide.toLocaleString()}枚`);
  console.log(`  行数から(正): ${actual.toLocaleString()}枚  [${msLines.toLocaleString()}行]`);
  console.log(`  差: +${(actual - divide).toLocaleString()}枚 (${((actual / divide - 1) * 100).toFixed(0)}%増)\n`);
}
