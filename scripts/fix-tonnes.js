const fs = require('fs');
const files = [
  'client/src/pages/StockByPrice.tsx'
];
files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/toTonnes\((.*?)\)\.toFixed\(2\)/g, 'formatTonnes($1)');
  fs.writeFileSync(file, content);
});
console.log("Done");
