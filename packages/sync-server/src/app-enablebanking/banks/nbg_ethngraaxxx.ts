import type { IBank } from './bank.interface';
import { IntegrationBank as Fallback } from './integration-bank';

const PURCHASE_PREFIX = 'ΑΓΟΡΑ ';

export const NbgEthngraaxxx = {
  aspspNames: ['National Bank of Greece'],

  /**
   * Corrects NBG purchases without transaction IDs:
   * - Marks purchases as debits when NBG reports them as credits.
   * - Removes the 'ΑΓΟΡΑ ' prefix to align with booked transactions for fuzzy matching.
   *
   * The filter matches missing IDs and the purchase prefix, not booking status.
   */
  normalizeTransaction(transaction) {
    const [description, ...remainingRemittance] =
      transaction.remittance_information ?? [];

    if (
      transaction.entry_reference ||
      transaction.transaction_id ||
      !description?.startsWith(PURCHASE_PREFIX)
    ) {
      return Fallback.normalizeTransaction(transaction);
    }

    // Preserve provider fields for bank sync field mapping and diagnostics.
    return {
      ...Fallback.normalizeTransaction({
        ...transaction,
        credit_debit_indicator: 'DBIT',
        remittance_information: [
          description.slice(PURCHASE_PREFIX.length),
          ...remainingRemittance,
        ],
      }),
      credit_debit_indicator: transaction.credit_debit_indicator,
      remittance_information: transaction.remittance_information,
    };
  },
} satisfies IBank;
