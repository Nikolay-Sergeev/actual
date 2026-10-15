import type { normalizeTransaction } from '#app-enablebanking/services/enablebanking-service';

export type IBank = {
  aspspNames: string[];

  /**
   * Returns a normalized transaction object.
   */
  normalizeTransaction: typeof normalizeTransaction;
};
