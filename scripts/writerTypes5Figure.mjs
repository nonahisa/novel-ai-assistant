/*
  作者タイプの5分類（旧記事）の図を、note に載せられる形で組み直す。

  **中身は1文字も変えない。** タイプ名も番号も位置も、作者の元の図のまま。
  変えたのは見せ方だけ——象限の塗り分け、軸の向きの示し方、札の作り。

  既存の分類図（writer-types-3d.svg / reader-types-3d.svg）と同じ流儀にする
  ——白地、左上に見出し、Yu Gothic、1240×1000。並べて貼っても浮かない。
*/
import fs from "node:fs";

const W = 1240;
const H = 1000;

/** 軸の交点 */
const CX = 600;
const CY = 585;
/** 軸の長さ（片側） */
const AX = 405; // 横
const AY = 320; // 縦

const FONT = "'Yu Gothic UI','Yu Gothic','Meiryo',sans-serif";
const INK = "#1a1a1a";
const SUB = "#8a8a8a";
const AXIS = "#3a3a3a";

/**
 * 5つのタイプ。**位置は作者の元の図のまま**
 * （作者志向＝縦、読者志向＝横。高いほう＝上／右）。
 */
const TYPES = [
  { no: "①", name: "絶対書籍化タイプ", q: "br", color: "#a8761f" },
  { no: "②", name: "自己実現追求タイプ", q: "tr", color: "#2f6f4f" },
  { no: "③", name: "自己陶酔自爆タイプ", q: "tl", color: "#a33a3a" },
  { no: "④", name: "精神世界潜航タイプ", q: "bl", color: "#4a5a8f" },
  { no: "⑤", name: "性癖趣味人タイプ", q: "c", color: "#7a4a8f" },
];

/** 札の置き場（象限の真ん中あたり） */
const SPOT = {
  tl: { x: CX - 218, y: CY - 205 },
  tr: { x: CX + 218, y: CY - 205 },
  bl: { x: CX - 218, y: CY + 205 },
  br: { x: CX + 218, y: CY + 205 },
  c: { x: CX, y: CY },
};

/** 象限の隅に添える、位置の読み方 */
const CORNER = {
  tl: { text: "作者志向 高 ／ 読者志向 低", x: CX - AX + 16, y: CY - AY + 30, anchor: "start" },
  tr: { text: "作者志向 高 ／ 読者志向 高", x: CX + AX - 16, y: CY - AY + 30, anchor: "end" },
  bl: { text: "作者志向 低 ／ 読者志向 低", x: CX - AX + 16, y: CY + AY - 16, anchor: "start" },
  br: { text: "作者志向 低 ／ 読者志向 高", x: CX + AX - 16, y: CY + AY - 16, anchor: "end" },
};

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const out = [];
const push = (s) => out.push(s);

push(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`
);
push(`<rect width="${W}" height="${H}" fill="#fff"/>`);

// 影と矢印
push(`<defs>
<filter id="sh" x="-30%" y="-60%" width="160%" height="220%">
  <feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#000" flood-opacity="0.13"/>
</filter>
<marker id="ar" markerWidth="11" markerHeight="11" refX="9" refY="5.5" orient="auto">
  <path d="M0,0 L11,5.5 L0,11 z" fill="${AXIS}"/>
</marker>
</defs>`);

// 見出し
push(
  `<text x="62" y="80" font-size="42" font-weight="bold" fill="${INK}">作者タイプ——2つの軸で5つ</text>`
);
push(
  `<text x="62" y="124" font-size="21" fill="#666">作者志向（なぜ書くか）と読者志向（誰のために書くか）。位置が、その人の重心です。</text>`
);

// 象限の塗り（薄く）
const quads = [
  { q: "tl", x: CX - AX, y: CY - AY, color: "#a33a3a" },
  { q: "tr", x: CX, y: CY - AY, color: "#2f6f4f" },
  { q: "bl", x: CX - AX, y: CY, color: "#4a5a8f" },
  { q: "br", x: CX, y: CY, color: "#a8761f" },
];
for (const q of quads) {
  push(
    `<rect x="${q.x}" y="${q.y}" width="${AX}" height="${AY}" fill="${q.color}" opacity="0.045"/>`
  );
}
// 象限の外枠（細く）
push(
  `<rect x="${CX - AX}" y="${CY - AY}" width="${AX * 2}" height="${AY * 2}" fill="none" stroke="#dcdcdc" stroke-width="1"/>`
);

// 象限の隅の読み方
for (const key of Object.keys(CORNER)) {
  const c = CORNER[key];
  push(
    `<text x="${c.x}" y="${c.y}" font-size="15" fill="#a5a5a5" text-anchor="${c.anchor}">${esc(c.text)}</text>`
  );
}

// 軸（両端に矢印）
push(
  `<line x1="${CX}" y1="${CY + AY}" x2="${CX}" y2="${CY - AY - 34}" stroke="${AXIS}" stroke-width="2.5" marker-end="url(#ar)"/>`
);
push(
  `<line x1="${CX}" y1="${CY - AY}" x2="${CX}" y2="${CY + AY + 34}" stroke="${AXIS}" stroke-width="2.5" marker-end="url(#ar)"/>`
);
push(
  `<line x1="${CX - AX}" y1="${CY}" x2="${CX + AX + 34}" y2="${CY}" stroke="${AXIS}" stroke-width="2.5" marker-end="url(#ar)"/>`
);
push(
  `<line x1="${CX + AX}" y1="${CY}" x2="${CX - AX - 34}" y2="${CY}" stroke="${AXIS}" stroke-width="2.5" marker-end="url(#ar)"/>`
);

/*
  **軸の名前は、高いほうの端に置く。**
  元の図は「読者志向」が低いほうの端にあり、「作者志向」は高いほうの端に
  あった。同じ図の中で向きが揃っていないと、どちらへ伸びる軸なのかを
  読む人が一度考えることになる。名前も番号も変えていないが、ここだけ揃えた。
*/
push(
  `<text x="${CX}" y="${CY - AY - 62}" font-size="27" font-weight="bold" fill="${INK}" text-anchor="middle">作者志向</text>`
);
push(
  `<text x="${CX + 22}" y="${CY - AY - 42}" font-size="17" fill="${SUB}" text-anchor="start">高</text>`
);
push(
  `<text x="${CX + 22}" y="${CY + AY + 52}" font-size="17" fill="${SUB}" text-anchor="start">低</text>`
);
push(
  `<text x="${CX + AX + 52}" y="${CY - 10}" font-size="27" font-weight="bold" fill="${INK}" text-anchor="start">読者志向</text>`
);
push(
  `<text x="${CX + AX + 52}" y="${CY + 22}" font-size="17" fill="${SUB}" text-anchor="start">高</text>`
);
push(
  `<text x="${CX - AX - 52}" y="${CY + 22}" font-size="17" fill="${SUB}" text-anchor="end">低</text>`
);

/** タイプの札 */
function card(type) {
  const spot = SPOT[type.q];
  const center = type.q === "c";
  const w = center ? 372 : 356;
  const h = center ? 84 : 76;
  const x = spot.x - w / 2;
  const y = spot.y - h / 2;
  const r = h / 2;
  const badgeX = x + 40;
  const rows = [];

  rows.push(`<g filter="url(#sh)">`);
  rows.push(
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="#fff" stroke="${type.color}" stroke-width="${center ? 3 : 2.5}"${center ? ' stroke-dasharray="9 6"' : ""}/>`
  );
  rows.push(`</g>`);
  // 番号の丸
  rows.push(
    `<circle cx="${badgeX}" cy="${spot.y}" r="${center ? 23 : 21}" fill="${type.color}"/>`
  );
  rows.push(
    `<text x="${badgeX}" y="${spot.y + (center ? 9 : 8)}" font-size="${center ? 25 : 23}" font-weight="bold" fill="#fff" text-anchor="middle">${esc(type.no)}</text>`
  );
  // 名前
  rows.push(
    `<text x="${badgeX + 32}" y="${spot.y + 10}" font-size="${center ? 28 : 27}" font-weight="bold" fill="${INK}" text-anchor="start">${esc(type.name)}</text>`
  );
  return rows.join("");
}

// 中央の札は最後（軸の交点を隠す）
for (const type of TYPES.filter((t) => t.q !== "c")) push(card(type));
push(card(TYPES.find((t) => t.q === "c")));

push("</svg>");

fs.writeFileSync("docs/images/writer-types-5.svg", out.join(""), "utf8");
console.log("○ docs/images/writer-types-5.svg を書きました");
