import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { signToken } from '../lib/jwt.js';
import { HttpError } from '../lib/httpError.js';
import { loginSchema } from '../schemas/auth.schema.js';
import {
  MAX_DEVICES_PER_USER,
  SERVICE_SESSION_ID,
  liveSessionCutoff,
} from '../lib/sessionPolicy.js';
import { forgetSession, touchSession } from '../middleware/auth.js';
import {
  getMaintenanceConfigRecord,
  isMaintenanceActive,
  formatMaintenanceStatus,
} from '../services/maintenance.service.js';

// Dummy hash so bcrypt.compare always runs, even for unknown usernames -
// keeps response timing the same whether or not the account exists.
const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8Q8lPZC.jQBnQXvhO1kZWm.wZ5ymPO';

export async function login(req: Request, res: Response) {
  const { username, password, deviceId } = loginSchema.parse(req.body);

  const user = await prisma.user.findUnique({ where: { username } });

  const ok = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Invalid credentials');

  // Prevent non-developer login when maintenance mode is active
  if (user.role !== 'DEVELOPER') {
    const config = await getMaintenanceConfigRecord();
    if (isMaintenanceActive(config)) {
      const status = formatMaintenanceStatus(config);
      const minsLeft = Math.ceil(status.secondsLeft / 60);
      const timeMsg = minsLeft > 0 ? ` (approx. ${minsLeft} min${minsLeft === 1 ? '' : 's'} remaining)` : '';
      throw new HttpError(
        503,
        `System is currently under maintenance${timeMsg}: ${status.message}`
      );
    }
  }

  // Sessions that have gone quiet past the idle window are dead - drop them so
  // a closed laptop or a lost phone stops holding one of the device slots.
  await prisma.userSession.deleteMany({
    where: { userId: user.id, lastSeenAt: { lt: liveSessionCutoff() } },
  });

  const userAgent = req.headers['user-agent']?.slice(0, 255) ?? null;
  const ip = req.ip?.slice(0, 64) ?? null;

  const existing = await prisma.userSession.findUnique({
    where: { userId_deviceId: { userId: user.id, deviceId } },
  });

  // A developer account is support staff and has to be able to sign in from
  // wherever the problem is; every other role is capped.
  if (!existing && user.role !== 'DEVELOPER') {
    const live = await prisma.userSession.count({ where: { userId: user.id } });
    if (live >= MAX_DEVICES_PER_USER) {
      throw new HttpError(
        403,
        `This account is already signed in on ${MAX_DEVICES_PER_USER} devices. Sign out on one of them, or leave it idle for a few minutes, then try again.`
      );
    }
  }

  const session = existing
    ? await prisma.userSession.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date(), userAgent, ip },
      })
    : await prisma.userSession.create({
        data: { userId: user.id, deviceId, userAgent, ip },
      });

  touchSession(session.id, session.lastSeenAt);

  const token = signToken({ userId: user.id, role: user.role, sid: session.id });
  res.json({
    token,
    user: { id: user.id, name: user.name, username: user.username, role: user.role },
  });
}

export async function me(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');

  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { id: true, name: true, username: true, role: true, createdAt: true },
  });
  if (!user) throw new HttpError(404, 'User not found');

  res.json({ user });
}

/**
 * Called by the browser while someone is actually using the app. requireAuth
 * has already refreshed lastSeenAt, so there is nothing left to do here - the
 * point is to keep the session warm during a long stretch of typing that makes
 * no other API calls.
 */
export async function heartbeat(_req: Request, res: Response) {
  res.json({ ok: true });
}

/** Drop this device's session so it stops counting against the cap. */
export async function logout(req: Request, res: Response) {
  const sid = req.user?.sid;
  if (sid && sid !== SERVICE_SESSION_ID) {
    await prisma.userSession.deleteMany({ where: { id: sid } });
    forgetSession(sid);
  }
  res.json({ ok: true });
}
