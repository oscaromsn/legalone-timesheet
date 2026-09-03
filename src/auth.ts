/*
 * What to do when a session expires in the middle of an operation.
 *
 * Policy, kept out of `client.ts` so that file stays a request builder. It is also
 * kept out of a blanket rule, because "never retry a write" is wrong here and
 * "always retry" is dangerous, and which one applies is a property of each method:
 *
 *   update, updateMatter, setEntryStatus  read themselves back and raise "did not
 *   closeMatter, reopenMatter            stick" when they didn't. Running one twice
 *                                        converges on the same state, so retrying
 *                                        after a renewal is safe.
 *
 *   create                               proves nothing. It reads an id out of the
 *                                        response, and an expiry can land after the
 *                                        POST was accepted. Retrying writes a second
 *                                        entry, which is the duplicate this codebase
 *                                        exists to avoid.
 *
 *   createMatter                         verifies by search, but matters cannot be
 *                                        deleted. A duplicate is permanent.
 *
 *   delete, deleteMatter                 may have succeeded before the expiry, and
 *                                        their own existence guard then reports the
 *                                        success as "no such entry".
 *
 * So the caller states which class an operation is in. For the unsafe ones it
 * supplies a check that answers "did it land?" — and the answer is read from the
 * server's state, not from an error message, because a message is a description and
 * the state is the fact.
 */
import { SessionExpiredError } from './client.ts';

/** Obtains a fresh credential and installs it. Called at most once per operation. */
export type Renew = () => Promise<void>;

/**
 * Answers whether an interrupted operation actually took effect.
 *
 * Runs after the session has been renewed, so it sees the truth. Returning the value
 * adopts the work that already landed; returning `landed: false` licenses one more
 * attempt, because absence has just been proved rather than assumed.
 */
export type Check<T> = () => Promise<{ landed: true; value: T } | { landed: false }>;

/** `'retry'` for operations that prove their own result; a check for the rest. */
export type Recovery<T> = 'retry' | Check<T>;

/**
 * Runs an operation, renewing once if the session expired underneath it.
 *
 * Exactly one renewal per call. If the second attempt expires again the error
 * propagates: something is wrong that another cookie will not fix, and a loop here
 * would hammer the tenant's login while looking like progress.
 */
export async function withRenewal<T>(
  run: () => Promise<T>,
  recovery: Recovery<T>,
  renew: Renew,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof SessionExpiredError)) throw error;
    await renew();

    if (recovery === 'retry') return await run();

    const outcome = await recovery();
    if (outcome.landed) return outcome.value;
    // Absence is now established, so this attempt cannot duplicate anything.
    return await run();
  }
}

/** Reads retry freely: they change nothing, so a second attempt costs a request. */
export const read = <T>(run: () => Promise<T>, renew: Renew): Promise<T> =>
  withRenewal(run, 'retry', renew);

/**
 * A write that proves its own result — update, updateMatter, setEntryStatus,
 * closeMatter, reopenMatter. Each reads itself back, so convergence is the point.
 */
export const idempotentWrite = <T>(run: () => Promise<T>, renew: Renew): Promise<T> =>
  withRenewal(run, 'retry', renew);

/**
 * A write that cannot be repeated blindly — create, createMatter, delete.
 *
 * `check` decides. For a create it looks for the record; for a delete it asks
 * whether the record is gone, which is the same question with the answer inverted.
 */
export const guardedWrite = <T>(run: () => Promise<T>, check: Check<T>, renew: Renew): Promise<T> =>
  withRenewal(run, check, renew);
