const fs = require('fs');
const path = require('path');
const dir = './src/slack/flows';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));

for (const file of files) {
  const filePath = path.join(dir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace(/(?<!await\s+)getDraft(<[^>]+>)?\(/g, 'await getDraft$1(');
  content = content.replace(/(?<!await\s+)findDraft(<[^>]+>)?\(/g, 'await findDraft$1(');
  content = content.replace(/(?<!await\s+)setDraft(<[^>]+>)?\(/g, 'await setDraft$1(');
  content = content.replace(/(?<!await\s+)clearDraft(<[^>]+>)?\(/g, 'await clearDraft$1(');
  fs.writeFileSync(filePath, content);
}
