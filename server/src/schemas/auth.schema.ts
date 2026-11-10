import { z } from 'zod';
import { MAX_PASSWORD_LENGTH } from '../lib/passwordPolicy.js';

/**
 * Login and account-management payloads.
 *
 * Note what is deliberately NOT validated here: the password on login has no
 * minimum length. The policy applies when a password is *set*, not when one is
 * offered — rejecting a short password at login with a validation error would
 * tell an attacker that the policy had changed, and would lock out any account
 * whose existing password predates the new minimum before they can sign in to
 * change it.
 */

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  /** Stable per-browser id; drives the two-device cap. */
  deviceId: z.string().min(8).max(128),
  /** Suppresses the new-device alert for this device in future. */
  remember: z.boolean().optional(),
});

/** Second step of a login where the account has MFA enabled. */
export const mfaChallengeSchema = z
  .object({
    /** Short-lived challenge token handed back by the first step. */
    challenge: z.string().min(16),
    deviceId: z.string().min(8).max(128),
    code: z.string().min(6).max(10).optional(),
    recoveryCode: z.string().min(8).max(32).optional(),
    remember: z.boolean().optional(),
  })
  .refine((v) => !!v.code || !!v.recoveryCode, {
    message: 'Enter the 6-digit code from your authenticator app, or a recovery code.',
  });

export const refreshSchema = z.object({
  refreshToken: z.string().min(16),
  deviceId: z.string().min(8).max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  newPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email().max(254),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(16).max(256),
  newPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export const mfaConfirmSchema = z.object({
  code: z.string().min(6).max(10),
});

export const mfaDisableSchema = z.object({
  /** Re-authentication: disabling a second factor must not ride on a live session alone. */
  currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  code: z.string().min(6).max(10),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type MfaChallengeInput = z.infer<typeof mfaChallengeSchema>;
