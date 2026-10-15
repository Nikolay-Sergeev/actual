import { describe, expect, it } from 'vitest';

import { NbgEthngraaxxx } from '#app-enablebanking/banks/nbg_ethngraaxxx';
import type { EnableBankingTransaction } from '#app-enablebanking/services/enablebanking-service';

const purchase = {
  entry_reference: null,
  transaction_id: null,
  transaction_amount: { currency: 'EUR', amount: '5.00' },
  credit_debit_indicator: 'CRDT',
  status: 'PDNG',
  booking_date: '2026-03-01',
  remittance_information: ['ΑΓΟΡΑ Example Store'],
} satisfies EnableBankingTransaction;

describe('NbgEthngraaxxx', () => {
  describe('#normalizeTransaction', () => {
    it.each([
      {
        name: 'provides the correct amount in a pending transaction and removes the purchase prefix',
        transaction: purchase,
        expectedAmount: '-5.00',
        expectedDescription: 'Example Store',
      },
      {
        name: 'does not add a second minus sign to a debit',
        transaction: {
          ...purchase,
          credit_debit_indicator: 'DBIT',
          transaction_amount: { currency: 'EUR', amount: '-5.00' },
        },
        expectedAmount: '-5.00',
        expectedDescription: 'Example Store',
      },
      {
        name: 'matches missing IDs and purchase prefix rather than pending status',
        transaction: { ...purchase, status: 'BOOK' },
        expectedAmount: '-5.00',
        expectedDescription: 'Example Store',
      },
      {
        name: 'preserves a credit with an entry reference',
        transaction: {
          ...purchase,
          status: 'BOOK',
          entry_reference: 'booked-reference',
        },
        expectedAmount: '5.00',
        expectedDescription: 'ΑΓΟΡΑ Example Store',
      },
      {
        name: 'preserves a credit with a transaction ID',
        transaction: { ...purchase, transaction_id: 'transaction-reference' },
        expectedAmount: '5.00',
        expectedDescription: 'ΑΓΟΡΑ Example Store',
      },
      {
        name: 'provides the correct amount and payee in a booked transaction',
        transaction: {
          ...purchase,
          status: 'BOOK',
          entry_reference: 'booked-debit',
          credit_debit_indicator: 'DBIT',
          transaction_amount: { currency: 'EUR', amount: '-5.00' },
          remittance_information: ['Example Store'],
        },
        expectedAmount: '-5.00',
        expectedDescription: 'Example Store',
      },
      {
        name: 'preserves a genuine deposit without the purchase prefix',
        transaction: {
          ...purchase,
          status: 'BOOK',
          remittance_information: ['Transfer from savings'],
        },
        expectedAmount: '5.00',
        expectedDescription: 'Transfer from savings',
      },
      {
        name: 'preserves a deposit without remittance information',
        transaction: { ...purchase, remittance_information: undefined },
        expectedAmount: '5.00',
        expectedDescription: undefined,
      },
    ] satisfies Array<{
      name: string;
      transaction: EnableBankingTransaction;
      expectedAmount: string;
      expectedDescription: string | undefined;
    }>)('$name', ({ transaction, expectedAmount, expectedDescription }) => {
      const originalTransaction = structuredClone(transaction);
      const normalizedTransaction =
        NbgEthngraaxxx.normalizeTransaction(transaction);

      expect(normalizedTransaction.transactionAmount).toEqual({
        amount: expectedAmount,
        currency: 'EUR',
      });
      expect(normalizedTransaction.payeeName).toBe(expectedDescription ?? '');
      expect(normalizedTransaction.notes).toBe(expectedDescription);
      expect(normalizedTransaction.remittanceInformationUnstructured).toBe(
        expectedDescription,
      );
      expect(normalizedTransaction.booked).toBe(
        originalTransaction.status !== 'PDNG',
      );
      // Bank sync field mapping must still see the original provider fields.
      expect(normalizedTransaction.transaction_amount).toEqual(
        originalTransaction.transaction_amount,
      );
      expect(normalizedTransaction.credit_debit_indicator).toBe(
        originalTransaction.credit_debit_indicator,
      );
      expect(normalizedTransaction.remittance_information).toEqual(
        originalTransaction.remittance_information,
      );
      expect(transaction).toEqual(originalTransaction);
    });

    it('uses the merchant rather than the account holder and retains additional remittance lines', () => {
      const normalizedTransaction = NbgEthngraaxxx.normalizeTransaction({
        ...purchase,
        creditor: { name: 'Card Merchant' },
        debtor: { name: 'Account Holder' },
        remittance_information: ['ΑΓΟΡΑ Example Store', 'Card purchase'],
      });

      expect(normalizedTransaction.payeeName).toBe('Card Merchant');
      expect(normalizedTransaction.notes).toBe('Example Store Card purchase');
    });
  });
});
