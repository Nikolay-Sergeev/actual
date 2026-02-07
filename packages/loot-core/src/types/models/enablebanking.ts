export type EnableBankingAspsp = {
  name: string;
  country: string;
  logo?: string;
};

export type EnableBankingAuthResult = {
  session_id: string;
  accounts: SyncServerEnableBankingAccount[];
};

// Raw response from the sync-server `/enablebanking/create-auth` endpoint.
export type EnableBankingCreateAuthResponse = {
  url?: string;
  authorization_id?: string;
  reason?: string;
  error_description?: string;
  error?: string;
  error_code?: string;
};

export type EnableBankingCreateAuthResult =
  | EnableBankingCreateAuthResponse
  | { error: 'unauthorized' | 'failed' };

export type EnableBankingAuthPollResult =
  | { error: 'timeout' }
  | { error: 'unknown'; message?: string }
  | { data: EnableBankingAuthResult };

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
