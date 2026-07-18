import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function computeFY(date: Date): string {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed; April = 3
  const startYear = month >= 3 ? year : year - 1;
  const yy = (n: number) => String(n % 100).padStart(2, '0');
  return `${yy(startYear)}-${yy(startYear + 1)}`;
}

function normalizeSeriesKey(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function derivePartyPrefix(partyName: string): string {
  const words = partyName.trim().split(/\s+/);
  if (words.length > 1) {
    const initials = normalizeSeriesKey(words.map((w) => w[0]).join(''));
    if (initials.length >= 2) return initials;
  }
  return normalizeSeriesKey(partyName.slice(0, 3));
}

function formatPoNumber(seriesKey: string, serial: number, fy: string): string {
  return `${seriesKey}/${String(serial).padStart(2, '0')}/${fy}`;
}

/**
 * One-off migration: assigns a nickname to every party missing one, then
 * renumbers every existing PurchaseOrder (except KNM_BATCH cold-storage
 * imports, which keep their own scheme) into Nickname/NN[-NN]/FY-FY format,
 * with URP_DIRECT spot purchases collapsed into a single continuing "URP"
 * series. Safe to re-run: parties that already have a nickname are left
 * alone, and POs are processed in one shot inside a transaction.
 */
async function main() {
  await prisma.$transaction(async (tx) => {
    // 1. Backfill party nicknames (deduped) from the existing initials scheme.
    const parties = await tx.party.findMany({ orderBy: { createdAt: 'asc' } });
    const usedNicknames = new Set(
      parties.filter((p) => p.nickname).map((p) => normalizeSeriesKey(p.nickname!))
    );

    for (const party of parties) {
      if (party.nickname && party.nickname.trim()) continue;
      let candidate = derivePartyPrefix(party.name) || 'PTY';
      let suffix = 2;
      while (usedNicknames.has(candidate)) {
        candidate = `${derivePartyPrefix(party.name) || 'PTY'}${suffix}`;
        suffix++;
      }
      usedNicknames.add(candidate);
      await tx.party.update({ where: { id: party.id }, data: { nickname: candidate } });
      party.nickname = candidate;
    }
    const nicknameByPartyId = new Map(parties.map((p) => [p.id, normalizeSeriesKey(p.nickname!)]));

    // 2. Renumber all POs except KNM_BATCH (separate location-tag scheme, out of scope).
    const orders = await tx.purchaseOrder.findMany({
      where: { createdBy: { not: 'KNM_BATCH' } },
      orderBy: [{ createdAt: 'asc' }],
    });

    // Group per-lorry POs from the same order back together.
    const groups = new Map<string, typeof orders>();
    for (const po of orders) {
      const key = po.poGroupId ?? po.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(po);
    }

    // Process groups in creation order so numbering continues chronologically.
    const orderedGroups = [...groups.values()].sort(
      (a, b) => a[0].createdAt.getTime() - b[0].createdAt.getTime()
    );

    const serialCounters = new Map<string, number>(); // key = `${seriesKey}::${fy}`

    for (const group of orderedGroups) {
      const isUrp = group[0].createdBy === 'URP_DIRECT';
      const seriesKey = isUrp ? 'URP' : (nicknameByPartyId.get(group[0].partyId) ?? 'PTY');
      const fy = computeFY(group[0].poDate);
      const counterKey = `${seriesKey}::${fy}`;
      const startSerial = (serialCounters.get(counterKey) ?? 0) + 1;
      serialCounters.set(counterKey, startSerial + group.length - 1);

      // Deterministic per-lorry ordering within the batch.
      const members = [...group].sort((a, b) => a.id.localeCompare(b.id));
      for (let i = 0; i < members.length; i++) {
        const serial = startSerial + i;
        await tx.purchaseOrder.update({
          where: { id: members[i].id },
          data: {
            poNumber: formatPoNumber(seriesKey, serial, fy),
            poSeriesKey: seriesKey,
            poSerial: serial,
            poFy: fy,
          },
        });
      }
    }

    // 3. Seed the live counters so future creates continue from here.
    for (const [key, lastSerial] of serialCounters) {
      const [seriesKey, fy] = key.split('::');
      await tx.poSerialCounter.upsert({
        where: { seriesKey_fy: { seriesKey, fy } },
        create: { seriesKey, fy, lastSerial },
        update: { lastSerial },
      });
    }

    console.log(`Renumbered ${orders.length} purchase orders across ${orderedGroups.length} batches.`);
    console.log(`Series/FY counters:`, Object.fromEntries(serialCounters));
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
