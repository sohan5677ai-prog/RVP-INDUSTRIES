import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { createTransportSchema, updateTransportSchema } from '../schemas/transport.schema.js';

export async function listTransports(req: Request, res: Response) {
  const activeOnly = req.query.active === 'true';
  const transports = await prisma.transport.findMany({
    where: activeOnly ? { active: true } : undefined,
    include: {
      _count: {
        select: { saleDispatches: true },
      },
    },
    orderBy: { name: 'asc' },
  });
  res.json(transports);
}

export async function getTransport(req: Request, res: Response) {
  const transport = await prisma.transport.findUnique({
    where: { id: req.params.id },
    include: {
      _count: {
        select: { saleDispatches: true },
      },
    },
  });
  if (!transport) {
    return res.status(404).json({ error: 'Transport not found' });
  }
  res.json(transport);
}

export async function createTransport(req: Request, res: Response) {
  const data = createTransportSchema.parse(req.body);
  const transport = await prisma.transport.create({
    data: {
      ...data,
      defaultRetention: data.defaultRetention ?? 0,
    },
    include: {
      _count: {
        select: { saleDispatches: true },
      },
    },
  });
  res.status(201).json(transport);
}

export async function updateTransport(req: Request, res: Response) {
  const data = updateTransportSchema.parse(req.body);
  const updated = await prisma.transport.update({
    where: { id: req.params.id },
    data,
    include: {
      _count: {
        select: { saleDispatches: true },
      },
    },
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
