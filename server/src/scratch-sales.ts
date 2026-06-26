import { prisma } from './lib/prisma.js';
import fs from 'fs';

async function main() {
  const parties = await prisma.party.findMany();
  const output = parties.map(p => `${p.name} (${p.type})`).join('\n');
  fs.writeFileSync('scratch-output.txt', output);
  console.log('Done, check scratch-output.txt');
}

main().catch(console.error);
