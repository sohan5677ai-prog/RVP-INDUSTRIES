import { logger } from './logger.js';

/**
 * Bank account verification — penny-drop or name match (plan item 3.3).
 *
 * **Interface only.** No provider is wired, and that is the whole scope of
 * this item: the plan asks for the hook so that adding a provider later is a
 * configuration change rather than a redesign of the approval flow.
 *
 * What a provider would do: deposit one rupee into the account and read back
 * the name the bank returns, or call a name-match API. That answers the
 * question an approver cannot answer from a form — "does this account actually
 * belong to the party we think we are paying?" — which is exactly the question
 * in a vendor-impersonation fraud.
 *
 * Deliberately shaped so that `UNAVAILABLE` is a distinct outcome from
 * `MISMATCH`. An approver must be able to tell "we could not check" from "we
 * checked and the name is wrong"; collapsing them would either block every
 * approval during an outage or teach people to ignore the warning.
 */

export type VerificationOutcome =
  /** The account exists and the name matches closely enough. */
  | 'MATCH'
  /** The account exists but is in a different name. */
  | 'MISMATCH'
  /** The account does not exist or was rejected by the bank. */
  | 'INVALID'
  /** No provider configured, or the provider could not be reached. */
  | 'UNAVAILABLE';

export interface VerificationRequest {
  accountNumber: string;
  ifsc: string;
  /** The name we expect the account to be in. */
  expectedName: string;
}

export interface VerificationResult {
  outcome: VerificationOutcome;
  /** The name the bank returned, when it returned one. */
  reportedName?: string | null;
  /** 0–1, where the provider gives a similarity score. */
  score?: number | null;
  /** Provider identifier, for the audit trail. */
  provider?: string | null;
  /** Why it was unavailable or invalid, in words an approver can use. */
  message?: string | null;
}

export interface BankVerificationProvider {
  readonly name: string;
  verify(request: VerificationRequest): Promise<VerificationResult>;
}

let provider: BankVerificationProvider | null = null;

/** Install a provider. Called at boot once one exists. */
export function setBankVerificationProvider(p: BankVerificationProvider | null): void {
  provider = p;
  logger.info(`bank verification provider: ${p?.name ?? 'none'}`);
}

export function isBankVerificationConfigured(): boolean {
  return provider !== null;
}

/**
 * Verify an account, if a provider is configured.
 *
 * Never throws and never blocks: with no provider this returns `UNAVAILABLE`,
 * so the approval flow works exactly as it does today and gains a signal the
 * moment a provider is installed. A verification step that could fail the
 * whole approval would be a new way to stop payments going out.
 */
export async function verifyBankAccount(
  request: VerificationRequest
): Promise<VerificationResult> {
  if (!provider) {
    return {
      outcome: 'UNAVAILABLE',
      provider: null,
      message: 'No bank verification provider is configured.',
    };
  }
  try {
    return await provider.verify(request);
  } catch (err) {
    logger.error('bank verification failed', err);
    return {
      outcome: 'UNAVAILABLE',
      provider: provider.name,
      message: err instanceof Error ? err.message : 'Verification failed',
    };
  }
}
