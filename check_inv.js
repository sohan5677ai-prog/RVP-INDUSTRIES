const fs = require('fs');
const content = fs.readFileSync('extracted_data2.js', 'utf8').replace('const prisma = new PrismaClient();', '');
eval(content);
const all = [...mustafa, ...jithu, ...rvp];
console.log('Total entries:', all.length);
const uniqueInvs = new Set(all.map(x => x.inv));
console.log('Unique invoices:', uniqueInvs.size);
const duplicates = all.filter((x, i, arr) => arr.findIndex(y => y.inv === x.inv) !== i);
console.log('Duplicates:', duplicates.map(x => x.inv));
