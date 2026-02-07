export type EnableBankingAspsp = {
  name: string;
  country: string;
  logo?: string;
};

export type EnableBankingAuthResult = {
  session_id: string;
  accounts: SyncServerEnableBankingAccount[];
};

export type SyncServerEnableBankingAccount = {
  balance: number;
  account_id: string;
  identification_hash?: string;
  institution?: string;
  orgDomain?: string | null;
  orgId?: string;
  name: string;
  uid?: string | null;
};
