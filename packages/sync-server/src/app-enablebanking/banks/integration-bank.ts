import { normalizeTransaction } from '#app-enablebanking/services/enablebanking-service';

import type { IBank } from './bank.interface';

export const IntegrationBank = {
  aspspNames: [],
  normalizeTransaction,
} satisfies IBank;
