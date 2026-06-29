import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createPartySchema, updatePartySchema } from '../schemas/party.schema.js';

export async function listParties(_req: Request, res: Response) {
  const parties = await prisma.party.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(parties);
}

export async function getParty(req: Request, res: Response) {
  const party = await prisma.party.findUnique({ where: { id: req.params.id } });
  if (!party) throw new HttpError(404, 'Party not found');
  res.json(party);
}

export async function createParty(req: Request, res: Response) {
  const data = createPartySchema.parse(req.body);
  const party = await prisma.party.create({ data });
  res.status(201).json(party);
}

export async function updateParty(req: Request, res: Response) {
  const data = updatePartySchema.parse(req.body);
  const existing = await prisma.party.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new HttpError(404, 'Party not found');
  const { commodities, ...rest } = data;
  const party = await prisma.party.update({
    where: { id: req.params.id },
    data: {
      ...rest,
      ...(commodities !== undefined ? { commodities: { set: commodities } } : {}),
    },
  });
  res.json(party);
}

export async function deleteParty(req: Request, res: Response) {
  const existing = await prisma.party.findUnique({
    where: { id: req.params.id },
    include: { purchaseOrders: true, saleOrders: true },
  });
  if (!existing) throw new HttpError(404, 'Party not found');
  if (existing.purchaseOrders.length > 0 || existing.saleOrders.length > 0) {
    throw new HttpError(409, 'Cannot delete a party with linked purchase or sale orders');
  }
  await prisma.party.delete({ where: { id: req.params.id } });
  res.status(204).end();
}
