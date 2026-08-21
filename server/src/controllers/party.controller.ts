import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createPartySchema, updatePartySchema } from '../schemas/party.schema.js';

export async function listParties(_req: Request, res: Response) {
  const parties = await prisma.party.findMany({
    orderBy: { createdAt: 'desc' },
    include: { addresses: { orderBy: { createdAt: 'asc' } } },
  });
  res.json(parties);
}

export async function getParty(req: Request, res: Response) {
  const party = await prisma.party.findUnique({
    where: { id: req.params.id },
    include: { addresses: { orderBy: { createdAt: 'asc' } } },
  });
  if (!party) throw new HttpError(404, 'Party not found');
  res.json(party);
}

export async function createParty(req: Request, res: Response) {
  const data = createPartySchema.parse(req.body);
  const duplicate = await prisma.party.findFirst({
    where: { name: { equals: data.name.trim(), mode: 'insensitive' } },
  });
  if (duplicate) throw new HttpError(409, `A party named "${duplicate.name}" already exists`);

  const { commodities, addresses, ...rest } = data;

  let addressList = addresses ?? [];
  if (addressList.length > 0) {
    const hasDefault = addressList.some((a) => a.isDefault);
    if (!hasDefault) addressList[0].isDefault = true;
    const defaultAddr = addressList.find((a) => a.isDefault) || addressList[0];
    if (!rest.address && defaultAddr) {
      rest.address = defaultAddr.address;
      rest.city = defaultAddr.city ?? rest.city;
      rest.state = defaultAddr.state ?? rest.state;
      rest.pincode = defaultAddr.pincode ?? rest.pincode;
      rest.gstin = defaultAddr.gstin ?? rest.gstin;
      rest.destination = defaultAddr.destination ?? rest.destination;
      if (defaultAddr.phone) rest.phone = defaultAddr.phone;
      if (defaultAddr.phone2) rest.phone2 = defaultAddr.phone2;
      if (defaultAddr.locationLink) rest.locationLink = defaultAddr.locationLink;
    }
  } else if (rest.address && rest.address.trim()) {
    addressList = [{
      label: 'Registered Office',
      address: rest.address.trim(),
      city: rest.city ?? null,
      state: rest.state ?? null,
      pincode: rest.pincode ?? null,
      gstin: rest.gstin ?? null,
      destination: rest.destination ?? null,
      phone: rest.phone ?? null,
      phone2: rest.phone2 ?? null,
      locationLink: rest.locationLink ?? null,
      isDefault: true,
    }];
  }

  const party = await prisma.party.create({
    data: {
      ...rest,
      commodities: commodities ?? [],
      addresses: {
        create: addressList.map((a) => ({
          label: a.label,
          address: a.address,
          city: a.city ?? null,
          state: a.state ?? null,
          pincode: a.pincode ?? null,
          gstin: a.gstin ?? null,
          destination: a.destination ?? null,
          phone: a.phone ?? null,
          phone2: a.phone2 ?? null,
          locationLink: a.locationLink ?? null,
          isDefault: a.isDefault ?? false,
        })),
      },
    },
    include: { addresses: { orderBy: { createdAt: 'asc' } } },
  });
  res.status(201).json(party);
}

export async function updateParty(req: Request, res: Response) {
  const data = updatePartySchema.parse(req.body);
  const existing = await prisma.party.findUnique({ where: { id: req.params.id }, include: { addresses: true } });
  if (!existing) throw new HttpError(404, 'Party not found');
  if (data.name !== undefined) {
    const duplicate = await prisma.party.findFirst({
      where: { name: { equals: data.name.trim(), mode: 'insensitive' }, id: { not: existing.id } },
    });
    if (duplicate) throw new HttpError(409, `A party named "${duplicate.name}" already exists`);
  }
  const { commodities, addresses, ...rest } = data;

  const addressList = addresses;
  if (addressList !== undefined && addressList.length > 0) {
    const hasDefault = addressList.some((a) => a.isDefault);
    if (!hasDefault) addressList[0].isDefault = true;
    const defaultAddr = addressList.find((a) => a.isDefault) || addressList[0];
    rest.address = defaultAddr.address;
    rest.city = defaultAddr.city ?? rest.city;
    rest.state = defaultAddr.state ?? rest.state;
    rest.pincode = defaultAddr.pincode ?? rest.pincode;
    if (defaultAddr.gstin) rest.gstin = defaultAddr.gstin;
    if (defaultAddr.destination) rest.destination = defaultAddr.destination;
    if (defaultAddr.phone) rest.phone = defaultAddr.phone;
    if (defaultAddr.phone2) rest.phone2 = defaultAddr.phone2;
    if (defaultAddr.locationLink) rest.locationLink = defaultAddr.locationLink;
  }

  const party = await prisma.$transaction(async (tx) => {
    if (addressList !== undefined) {
      await tx.partyAddress.deleteMany({ where: { partyId: existing.id } });
      if (addressList.length > 0) {
        await tx.partyAddress.createMany({
          data: addressList.map((a) => ({
            partyId: existing.id,
            label: a.label,
            address: a.address,
            city: a.city ?? null,
            state: a.state ?? null,
            pincode: a.pincode ?? null,
            gstin: a.gstin ?? null,
            destination: a.destination ?? null,
            phone: a.phone ?? null,
            phone2: a.phone2 ?? null,
            locationLink: a.locationLink ?? null,
            isDefault: a.isDefault ?? false,
          })),
        });
      }
    }

    return tx.party.update({
      where: { id: req.params.id },
      data: {
        ...rest,
        ...(commodities !== undefined ? { commodities: { set: commodities } } : {}),
      },
      include: { addresses: { orderBy: { createdAt: 'asc' } } },
    });
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
