import { readTextFile } from "./src/core/textFile.ts";
async function main() {
  for (const p of [process.env.TRUNC!, process.env.FULL!]) {
    const r = await readTextFile(p);
    console.log(`${p.split(/[\/]/).pop()}: encoding=${r.encoding} 文字数=${r.text.length}`);
    console.log(`  先頭: ${JSON.stringify(r.text.slice(0, 60))}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
