import { describe, expect, it } from 'vitest';

import { BankFactory } from '#app-enablebanking/bank-factory';

describe('BankFactory', () => {
  it.each([
    {
      name: 'uses the NBG adapter for National Bank of Greece',
      aspspName: 'National Bank of Greece',
      expectedAmount: '-5.00',
      expectedPayeeName: 'Example Store',
    },
    {
      name: 'uses IntegrationBank when the ASPSP name is not found',
      aspspName: 'Another Bank',
      expectedAmount: '5.00',
      expectedPayeeName: 'ΑΓΟΡΑ Example Store',
    },
    {
      name: 'uses IntegrationBank when the ASPSP name is missing',
      aspspName: undefined,
      expectedAmount: '5.00',
      expectedPayeeName: 'ΑΓΟΡΑ Example Store',
    },
  ])('$name', ({ aspspName, expectedAmount, expectedPayeeName }) => {
    const normalizedTransaction = BankFactory(aspspName).normalizeTransaction({
      transaction_amount: { currency: 'EUR', amount: '5.00' },
      credit_debit_indicator: 'CRDT',
      remittance_information: ['ΑΓΟΡΑ Example Store'],
    });

    expect(normalizedTransaction.transactionAmount.amount).toBe(expectedAmount);
    expect(normalizedTransaction.payeeName).toBe(expectedPayeeName);
  });
});
