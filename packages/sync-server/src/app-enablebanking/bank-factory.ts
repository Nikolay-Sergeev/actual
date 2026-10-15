import type { IBank } from './banks/bank.interface';
import { IntegrationBank } from './banks/integration-bank';
import { NbgEthngraaxxx } from './banks/nbg_ethngraaxxx';

const banks: IBank[] = [NbgEthngraaxxx];

export function BankFactory(aspspName?: string): IBank {
  return (
    banks.find(bank => bank.aspspNames.includes(aspspName ?? '')) ??
    IntegrationBank
  );
}
