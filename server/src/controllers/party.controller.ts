import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { permissionsFor } from '../services/permission.service.js';
import { maskParty, maskParties, hasMaskableValue } from '../lib/pii.js';
import { recordAudit } from '../services/audit.service.js';
import { HttpError } from '../lib/httpError.js';
import { createPartySchema, updatePartySchema } from '../schemas/party.schema.js';
import {
  prepareMasterUpdate,
  recordChanges,
} from '../services/masterChange.service.js';
import { diffFields } from '../lib/masterFields.js';
import { reconcilePartyPins, invalidatePartyPin } from '../services/partyPin.service.js';

/**
 * May this caller see a supplier's full bank account number?
 *
 * `master.party.bank.view` is the specific grant; `pii.view` is the broad one
 * that also covers anything added later. Either is enough. Both already
 * existed in the permission table and were enforced nowhere until now.
 */
async function canSeeBankDetails(req: Request): Promise<boolean> {
  if (!req.user) return false;
  const held = await permissionsFor(req.user.role);
  return held.has('master.party.bank.view') || held.has('pii.view');
}

export async function listParties(req: Request, res: Response) {
  const parties = await prisma.party.findMany({
    orderBy: { createdAt: 'desc' },
    include: { addresses: { orderBy: { createdAt: 'asc' } } },
  });
  // Masked by default. The list goes to every screen that needs a party
  // picker, so it is the widest exposure of the lot.
  const allowed = await canSeeBankDetails(req);
  res.json(allowed ? parties : maskParties(parties as unknown as Record<string, unknown>[]));
}

export async function getParty(req: Request, res: Response) {
  const party = await prisma.party.findUnique({
    where: { id: req.params.id },
    include: { addresses: { orderBy: { createdAt: 'asc' } } },
  });
  if (!party) throw new HttpError(404, 'Party not found');
  const allowed = await canSeeBankDetails(req);
  res.json(allowed ? party : maskParty(party as unknown as Record<string, unknown>));
}

/**
 * Reveal one party's full bank details, and record that it happened
 * (plan item 3: "full value only with permission, and each reveal is audited").
 *
 * A separate endpoint rather than a flag on the list, for two reasons. It
 * keeps the audit row specific - "this person looked at this supplier's
 * account number at this time" - where auditing the list would record only
 * that someone opened a screen. And it means the bulk path has no way to
 * return the real value at all, so a future caller cannot opt itself in.
 */
export async function revealPartyBank(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');

  const party = await prisma.party.findUnique({
    where: { id: req.params.id },
    select: { id: true, name: true, bankAccountNumber: true, bankIfsc: true, bankName: true },
  });
  if (!party) throw new HttpError(404, 'Party not found');

  // Only worth a row when there was something to reveal. "Looked at a party
  // with no bank details on file" is noise, and this trail has already been
  // through one round of being mostly noise.
  if (hasMaskableValue(party as unknown as Record<string, unknown>)) {
    await recordAudit({
      action: 'party.bank.reveal',
      entity: 'Party',
      entityId: party.id,
      entityLabel: party.name,
      // Deliberately not the value itself: an audit trail that records the
      // account number every time someone looks at it becomes the leak.
      newValues: { revealed: 'bankAccountNumber' },
    });
  }

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
  } else if ((rest.address && rest.address.trim()) || rest.city || rest.state || rest.pincode || rest.gstin || rest.destination || rest.locationLink) {
    addressList = [{
      label: 'Registered Office',
      address: (rest.address && rest.address.trim()) || '',
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
  // Resolve the delivery pin behind the response. Following a short Google link
  // is a network round trip with a ten-second ceiling, and a party form must
  // not wait on it - nothing reads the pin until a dispatch is raised.
  void reconcilePartyPins(party.id);
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

  if (!req.user) throw new HttpError(401, 'Not authenticated');
  // The access token carries a name only for the cabin kiosk, so look it up:
  // a change history that cannot say who made the change is not a history.
  const actorUser = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { name: true },
  });
  const actor = {
    userId: req.user.userId,
    name: actorUser?.name ?? req.user.name ?? null,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  };

  // Bank account, IFSC, GSTIN and email cannot be changed in one step: they
  // are held as a request for someone else to approve, and the values already
  // on file stay in force until then. `split.immediate` is what is safe to
  // write - anything protected has been stripped out of it, so even a caller
  // that ignored the rest of this result could not write a bank account.
  const split = await prepareMasterUpdate({
    entity: 'PARTY',
    entityId: existing.id,
    entityName: existing.name,
    existing: existing as unknown as Record<string, unknown>,
    incoming: rest as Record<string, unknown>,
    actor,
  });

  for (const field of Object.keys(rest)) {
    if (!(field in split.immediate)) delete (rest as Record<string, unknown>)[field];
  }

  const party = await prisma.$transaction(async (tx) => {
    if (addressList !== undefined) {
      const incomingIds = addressList.map((a) => a.id).filter(Boolean) as string[];
      // Delete addresses that were removed from the incoming list
      await tx.partyAddress.deleteMany({
        where: {
          partyId: existing.id,
          id: { notIn: incomingIds },
        },
      });

      for (const a of addressList) {
        if (a.id && existing.addresses.some((ea) => ea.id === a.id)) {
          await tx.partyAddress.update({
            where: { id: a.id },
            data: {
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
            },
          });
        } else {
          await tx.partyAddress.create({
            data: {
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
            },
          });
        }
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

  // A changed location link has to drop the old coordinates first, because the
  // reconcile deliberately skips a party that already has a pin - otherwise an
  // edited link would keep pointing at wherever the previous one did.
  if (data.locationLink !== undefined && data.locationLink !== existing.locationLink) {
    await invalidatePartyPin(existing.id);
  }
  void reconcilePartyPins(existing.id);

  // History for the fields that went straight through (plan item 3.5).
  await recordChanges({
    entity: 'PARTY',
    entityId: existing.id,
    entityName: party.name,
    changes: split.immediateChanges,
    actor,
  });

  // Tell the caller plainly that part of their edit is waiting, rather than
  // letting the screen show the old value back and look like a failed save.
  res.json({
    ...party,
    pendingApproval: split.pending
      ? {
          id: split.pending.id,
          summary: split.pending.summary,
          fields: split.pendingChanges.map((c) => c.label),
        }
      : null,
  });
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
