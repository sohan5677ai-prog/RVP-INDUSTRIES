const fs = require('fs');
const content = fs.readFileSync('extracted_data2.js', 'utf8');
const dataStr = content.replace('const prisma = new PrismaClient();', '');
eval(dataStr);
const all = [...mustafa, ...jithu, ...rvp];
const pappu = all.filter(x => x.price > 20);
const husk = all.filter(x => x.price < 20);
console.log('Pappu count:', pappu.length, 'tons:', pappu.reduce((s,x) => s + (x.tonnage || 0), 0));
console.log('Husk count:', husk.length, 'tons:', husk.reduce((s,x) => s + (x.tonnage || 0), 0));
