const fs = require("fs");
const text = fs.readFileSync(process.env.SRC, "utf8");
const part = text.slice(0, 80000);
fs.writeFileSync(process.env.OUT, part, "utf8");
console.log("文字数:", part.length);
