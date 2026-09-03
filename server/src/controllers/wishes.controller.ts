import type { Request, Response } from 'express';
import type { WishCategory } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { generateWishMessage, generateWishImage } from '../lib/gemini.js';
import { uploadBufferToStorage } from '../lib/upload.js';
import * as whatsappService from '../services/whatsapp.service.js';
import { parseCompanyVehicles } from '../lib/calc.js';
import {
  createDriverSchema,
  updateDriverSchema,
  bulkTagReligionSchema,
  recipientGroupsSchema,
  generateWishSchema,
  sendWishSchema,
} from '../schemas/wishes.schema.js';

// --- KNM Driver directory ---------------------------------------------------

export async function listDrivers(_req: Request, res: Response) {
  const drivers = await prisma.knmDriver.findMany({ orderBy: { name: 'asc' } });
  res.json(drivers);
}

export async function createDriver(req: Request, res: Response) {
  const data = createDriverSchema.parse(req.body);
  const driver = await prisma.knmDriver.create({ data });
  res.status(201).json(driver);
}

export async function updateDriver(req: Request, res: Response) {
  const data = updateDriverSchema.parse(req.body);
  const existing = await prisma.knmDriver.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new HttpError(404, 'Driver not found');
  const driver = await prisma.knmDriver.update({ where: { id: req.params.id }, data });
  res.json(driver);
}

export async function deleteDriver(req: Request, res: Response) {
  const existing = await prisma.knmDriver.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new HttpError(404, 'Driver not found');
  await prisma.knmDriver.delete({ where: { id: req.params.id } });
  res.status(204).end();
}

// --- Party religion bulk tagging --------------------------------------------

export async function bulkTagPartyReligion(req: Request, res: Response) {
  const { partyIds, religion } = bulkTagReligionSchema.parse(req.body);
  const result = await prisma.party.updateMany({
    where: { id: { in: partyIds } },
    data: { religion },
  });
  res.json({ updated: result.count });
}

export async function updatePartyPhone(req: Request, res: Response) {
  const existing = await prisma.party.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new HttpError(404, 'Party not found');
  const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() || null : null;
  const updated = await prisma.party.update({
    where: { id: req.params.id },
    data: { phone },
  });
  res.json(updated);
}

// --- Recipient resolution ----------------------------------------------------

export interface WishRecipient {
  group: 'PARTY' | 'DRIVER' | 'OWNER';
  id: string;
  name: string;
  phone: string;
  waLanguage: 'EN' | 'TE' | 'TA' | 'KN' | 'HI';
}

/**
 * Resolves who a Wishes send targets. `category` filters Parties and Drivers
 * (untagged records are excluded from a filtered send); Owners has no
 * religion tag and is included whenever `includeOwners` is on regardless of
 * category, since it's a small fixed on/off group (see
 * docs/whatsapp-wishes-template.md).
 */
export async function resolveWishRecipients(opts: {
  category?: WishCategory | null;
  includeParties: boolean;
  includeDrivers: boolean;
  includeOwners: boolean;
}): Promise<WishRecipient[]> {
  const recipients: WishRecipient[] = [];

  if (opts.includeParties) {
    const parties = await prisma.party.findMany({
      where: opts.category ? { religion: opts.category } : {},
      select: { id: true, name: true, phone: true, phone2: true, waLanguage: true },
    });
    for (const p of parties) {
      const phone = p.phone?.trim() || p.phone2?.trim();
      if (phone) recipients.push({ group: 'PARTY', id: p.id, name: p.name, phone, waLanguage: p.waLanguage });
    }
  }

  if (opts.includeDrivers) {
    const company = await prisma.companyProfile.findFirst({
      select: { companyVehicles: true },
    });
    const vehicles = parseCompanyVehicles(company?.companyVehicles);
    const seenPhones = new Set<string>();
    for (const v of vehicles) {
      const phone = v.driverPhone?.trim();
      if (!phone || seenPhones.has(phone)) continue;
      if (opts.category && v.religion !== opts.category) continue;
      seenPhones.add(phone);
      recipients.push({
        group: 'DRIVER',
        id: v.number || phone,
        name: v.driverName || 'Driver',
        phone,
        waLanguage: 'EN',
      });
    }
  }

  if (opts.includeOwners) {
    const owners = await whatsappService.resolveOwnerRecipients();
    for (const o of owners) {
      const phone = o.phone?.trim();
      if (phone) recipients.push({ group: 'OWNER', id: o.phone, name: o.name, phone: o.phone, waLanguage: 'EN' });
    }
  }

  return recipients;
}

export async function previewRecipients(req: Request, res: Response) {
  const parsed = recipientGroupsSchema.parse({
    category: req.query.category || null,
    includeParties: req.query.includeParties !== 'false',
    includeDrivers: req.query.includeDrivers !== 'false',
    includeOwners: req.query.includeOwners !== 'false',
  });
  const recipients = await resolveWishRecipients(parsed);

  const totalParties = parsed.includeParties
    ? await prisma.party.count({
        where: parsed.category ? { religion: parsed.category } : {},
      })
    : 0;
  const partiesWithPhone = recipients.filter((r) => r.group === 'PARTY').length;
  const partiesMissingPhone = Math.max(0, totalParties - partiesWithPhone);

  const driversCount = recipients.filter((r) => r.group === 'DRIVER').length;
  const ownersCount = recipients.filter((r) => r.group === 'OWNER').length;

  res.json({
    count: recipients.length,
    breakdown: {
      partiesTotal: totalParties,
      partiesWithPhone,
      partiesMissingPhone,
      driversCount,
      ownersCount,
    },
    recipients,
  });
}

// --- Generation (Gemini) -----------------------------------------------------

export async function generateWishText(req: Request, res: Response) {
  const { occasion, category } = generateWishSchema.parse(req.body);
  const message = await generateWishMessage(occasion, category);
  res.json({ message });
}

export async function generateWishImageEndpoint(req: Request, res: Response) {
  const { occasion, category } = generateWishSchema.parse(req.body);
  const image = await generateWishImage(occasion, category);
  const ext = image.mimeType === 'image/jpeg' ? '.jpg' : '.png';
  const imageUrl = await uploadBufferToStorage(image.buffer, image.mimeType, ext);
  res.json({ imageUrl });
}

// --- Send ---------------------------------------------------------------------

export async function sendWishBroadcast(req: Request, res: Response) {
  const input = sendWishSchema.parse(req.body);
  const recipients = await resolveWishRecipients(input);
  if (recipients.length === 0) {
    throw new HttpError(400, 'No recipients match this category/group selection');
  }

  let userName: string | null = null;
  if (req.user) {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { name: true } });
    userName = user?.name ?? null;
  }

  const broadcast = await prisma.wishBroadcast.create({
    data: {
      occasion: input.occasion,
      category: input.category ?? null,
      includeParties: input.includeParties,
      includeDrivers: input.includeDrivers,
      includeOwners: input.includeOwners,
      messageText: input.messageText,
      imageUrl: input.imageUrl ?? null,
      recipientCount: recipients.length,
      sentById: req.user?.userId ?? null,
      sentByName: userName,
    },
  });

  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const r of recipients) {
    const result = await whatsappService.sendWhatsAppTemplate({
      templateKey: 'WISHES',
      to: r.phone,
      language: r.waLanguage,
      variables: [r.name, input.messageText],
      mediaUrl: input.imageUrl ?? undefined,
      relatedType: 'WISH',
      relatedId: broadcast.id,
    });
    if (result.ok) sentCount++;
    else if (result.skipped) skippedCount++;
    else failedCount++;
  }

  const updated = await prisma.wishBroadcast.update({
    where: { id: broadcast.id },
    data: { sentCount, failedCount, skippedCount },
  });

  res.status(201).json(updated);
}

export async function listWishHistory(req: Request, res: Response) {
  const take = Math.min(Number(req.query.take) || 25, 100);
  const history = await prisma.wishBroadcast.findMany({ orderBy: { createdAt: 'desc' }, take });
  res.json(history);
}
