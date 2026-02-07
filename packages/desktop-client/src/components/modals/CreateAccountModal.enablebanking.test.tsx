import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { CreateAccountModal } from './CreateAccountModal';

import { mockStore, TestProvider } from '@desktop-client/redux/mock';

vi.mock('@desktop-client/auth/AuthProvider', () => ({
  useAuth: () => ({
    hasPermission: () => true,
  }),
}));

vi.mock('@desktop-client/components/ServerContext', () => ({
  useMultiuserEnabled: () => false,
}));

vi.mock('@desktop-client/hooks/useSyncServerStatus', () => ({
  useSyncServerStatus: () => 'online',
}));

vi.mock('@desktop-client/hooks/useGoCardlessStatus', () => ({
  useGoCardlessStatus: () => ({
    configuredGoCardless: true,
  }),
}));

vi.mock('@desktop-client/hooks/useSimpleFinStatus', () => ({
  useSimpleFinStatus: () => ({
    configuredSimpleFin: true,
  }),
}));

vi.mock('@desktop-client/hooks/usePluggyAiStatus', () => ({
  usePluggyAiStatus: () => ({
    configuredPluggyAi: true,
  }),
}));

vi.mock('@desktop-client/hooks/useEnableBankingStatus', () => ({
  useEnableBankingStatus: () => ({
    configuredEnableBanking: false,
  }),
}));

vi.mock('@desktop-client/gocardless', () => ({
  authorizeBank: vi.fn(),
}));

vi.mock('@desktop-client/enablebanking', () => ({
  authorizeEnableBanking: vi.fn(),
}));

describe('CreateAccountModal (Enable Banking)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens enablebanking-init modal when setup is required', async () => {
    render(<CreateAccountModal />, { wrapper: TestProvider });

    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', {
        name: /Set up Enable Banking for bank sync/i,
      }),
    );

    await waitFor(() => {
      const topModal =
        mockStore.getState().modals.modalStack[
          mockStore.getState().modals.modalStack.length - 1
        ];
      expect(topModal?.name).toBe('enablebanking-init');
    });
  });
});
