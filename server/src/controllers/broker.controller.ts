import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { createBrokerSchema } from '../schemas/broker.schema.js';

export async function listBrokers(_req: Request, res: Response) {
  const brokers = await prisma.broker.findMany({ orderBy: { name: 'asc' } });
  res.json(brokers);
}

export async function createBroker(req: Request, res: Response) {
  const data = createBrokerSchema.parse(req.body);
  const broker = await prisma.broker.create({ data });
  res.status(201).json(broker);
}

export async function updateBroker(req: Request, res: Response) {
  const data = createBrokerSchema.parse(req.body);
  const updated = await prisma.broker.update({
    where: { id: req.params.id },
    data,
  });
  res.json(updated);
}

export async function deleteBroker(req: Request, res: Response) {
  await prisma.broker.delete({
    where: { id: req.params.id },
  });
  res.json({ message: 'Broker deleted' });
}
