import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { createTransportSchema, updateTransportSchema } from '../schemas/transport.schema.js';
import { freightDestinationKey } from '../lib/transportFreight.js';

/**
 * What every transport read returns alongside the agency: the trip count the
 * list shows, and the agreed flat rates, which the Transports form edits in
 * place rather than on a page of their own. There are a handful per agency and
 * they are only ever read together with it.
 */
const TRANSPORT_INCLUDE = {
  _count: {
    select: { saleDispatches: true },
  },
  freightRates: {
    orderBy: { destination: 'asc' as const },
  },
};

type RateInput = { destination: string; flatAmount: number; forTonnageKg: number | null };

/**
 * Replace an agency's rate set with what the form sent.
 *
 * A wholesale replace rather than a per-row upsert: the form edits the whole
 * table, so a lane the user deleted has to disappear, and there is no stable id
 * to match a renamed destination on. Rates are stored upper-cased and folded,
 * so "Ahmednagar" and "Ahilyanagar" cannot both be filed as separate lanes for
 * the same town and then disagree about the freight.
 */
async function replaceFreightRates(transportId: string, rates: RateInput[]) {
  const seen = new Set<string>();
  const rows: RateInput[] = [];
  for (const rate of rates) {
    const key = freightDestinationKey(rate.destination);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      destination: rate.destination.trim().toUpperCase(),
      flatAmount: rate.flatAmount,
      forTonnageKg: rate.forTonnageKg,
    });
  }

  await prisma.$transaction([
    prisma.transportFreightRate.deleteMany({ where: { transportId } }),
    ...(rows.length
      ? [
          prisma.transportFreightRate.createMany({
            data: rows.map((r) => ({ ...r, transportId })),
          }),
        ]
      : []),
  ]);
}

export async function listTransports(req: Request, res: Response) {
  const activeOnly = req.query.active === 'true';
  const transports = await prisma.transport.findMany({
    where: activeOnly ? { active: true } : undefined,
    include: TRANSPORT_INCLUDE,
    orderBy: { name: 'asc' },
  });
  res.json(transports);
}

export async function getTransport(req: Request, res: Response) {
  const transport = await prisma.transport.findUnique({
    where: { id: req.params.id },
    include: TRANSPORT_INCLUDE,
  });
  if (!transport) {
    return res.status(404).json({ error: 'Transport not found' });
  }
  res.json(transport);
}

export async function createTransport(req: Request, res: Response) {
  const { freightRates, ...data } = createTransportSchema.parse(req.body);
  const transport = await prisma.transport.create({
    data: {
      ...data,
      defaultRetention: data.defaultRetention ?? 0,
      associationFeePerTrip: data.associationFeePerTrip ?? 0,
    },
    include: TRANSPORT_INCLUDE,
  });
  if (freightRates) {
    await replaceFreightRates(transport.id, freightRates);
    const withRates = await prisma.transport.findUnique({
      where: { id: transport.id },
      include: TRANSPORT_INCLUDE,
    });
    return res.status(201).json(withRates);
  }
  res.status(201).json(transport);
}

export async function updateTransport(req: Request, res: Response) {
  const { freightRates, ...data } = updateTransportSchema.parse(req.body);
  // The rates are written first so a form that saves both cannot leave the
  // agency updated and its lanes stale.
  if (freightRates) await replaceFreightRates(req.params.id, freightRates);
  const updated = await prisma.transport.update({
    where: { id: req.params.id },
    data,
    include: TRANSPORT_INCLUDE,
  });
  res.json(updated);
}

export async function deleteTransport(req: Request, res: Response) {
  const { id } = req.params;
  const count = await prisma.saleDispatch.count({ where: { transportId: id } });
  if (count > 0) {
    return res.status(400).json({
      error: `Cannot delete transport: ${count} dispatch(es) are associated with it. You can mark it inactive instead.`,
    });
  }
  await prisma.transport.delete({
    where: { id },
  });
  res.json({ message: 'Transport deleted' });
}
