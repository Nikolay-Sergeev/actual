import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { send } from 'loot-core/platform/client/fetch';

import { EnableBankingInitialiseModal } from './EnableBankingInitialiseModal';

import { TestProvider } from '@desktop-client/redux/mock';

vi.mock('loot-core/platform/client/fetch', () => ({
  send: vi.fn(),
}));

describe('EnableBankingInitialiseModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores all required secrets and calls onSuccess', async () => {
    vi.mocked(send).mockResolvedValue({});
    const onSuccess = vi.fn();

    render(<EnableBankingInitialiseModal onSuccess={onSuccess} />, {
      wrapper: TestProvider,
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/App ID/i), 'test-application-id');
    await user.type(
      screen.getByLabelText(/Private key \(PEM\)/i),
      '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
    );
    await user.click(screen.getByLabelText(/Environment/i));
    await user.click(screen.getByRole('button', { name: /PRODUCTION/i }));
    await user.click(
      screen.getByRole('button', { name: /Save and continue/i }),
    );

    await waitFor(() => {
      const secretSetCalls = vi
        .mocked(send)
        .mock.calls.filter(([method]) => method === 'secret-set');
      expect(secretSetCalls).toHaveLength(4);
    });

    // A status call happens on mount to suggest a callback URL (if configured).
    expect(send).toHaveBeenCalledWith('enablebanking-status');

    const secretSetCalls = vi
      .mocked(send)
      .mock.calls.filter(([method]) => method === 'secret-set');
    expect(secretSetCalls).toEqual([
      [
        'secret-set',
        { name: 'enablebanking_applicationId', value: 'test-application-id' },
      ],
      [
        'secret-set',
        {
          name: 'enablebanking_privateKey',
          value:
            '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
        },
      ],
      [
        'secret-set',
        { name: 'enablebanking_environment', value: 'PRODUCTION' },
      ],
      ['secret-set', { name: 'enablebanking_redirectUrl', value: '' }],
    ]);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('shows PRODUCTION and SANDBOX environment options', async () => {
    vi.mocked(send).mockResolvedValue({});
    const onSuccess = vi.fn();

    render(<EnableBankingInitialiseModal onSuccess={onSuccess} />, {
      wrapper: TestProvider,
    });

    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/Environment/i));

    expect(
      screen.getByRole('button', { name: /PRODUCTION/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /SANDBOX/i }),
    ).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
