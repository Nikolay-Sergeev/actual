import type { EnableBankingTransaction } from '#app-enablebanking/services/enablebanking-service';

import type { IBank } from './bank.interface';
import { IntegrationBank as Fallback } from './integration-bank';

const PURCHASE_PREFIX = 'ΑΓΟΡΑ ';

export const NbgEthngraaxxx = {
  ...Fallback,

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

    const editedTransaction = {
      ...transaction,
      credit_debit_indicator: 'DBIT',
      remittance_information: [
        description.slice(PURCHASE_PREFIX.length),
        ...remainingRemittance,
      ],
    } satisfies EnableBankingTransaction;
    const normalizedTransaction =
      Fallback.normalizeTransaction(editedTransaction);

    // Preserve provider fields for bank sync field mapping and diagnostics.
    return {
      ...normalizedTransaction,
      credit_debit_indicator: transaction.credit_debit_indicator,
      remittance_information: transaction.remittance_information,
    };
  },
} satisfies IBank;
