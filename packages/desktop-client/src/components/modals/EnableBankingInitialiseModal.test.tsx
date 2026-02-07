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
    await user.type(
      screen.getByLabelText(/Application ID:/i),
      'test-application-id',
    );
    await user.type(
      screen.getByLabelText(/Private Key \(PEM\):/i),
      '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
    );
    await user.clear(screen.getByLabelText(/Environment:/i));
    await user.type(screen.getByLabelText(/Environment:/i), 'PRODUCTION');
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

  it('shows validation error and does not submit for invalid environment', async () => {
    vi.mocked(send).mockResolvedValue({});
    const onSuccess = vi.fn();

    render(<EnableBankingInitialiseModal onSuccess={onSuccess} />, {
      wrapper: TestProvider,
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Application ID:/i), 'app-id');
    await user.type(screen.getByLabelText(/Private Key \(PEM\):/i), 'secret');
    await user.clear(screen.getByLabelText(/Environment:/i));
    await user.type(screen.getByLabelText(/Environment:/i), 'INVALID');
    await user.click(
      screen.getByRole('button', { name: /Save and continue/i }),
    );

    expect(
      screen.getByText(/Environment must be either SANDBOX or PRODUCTION\./i),
    ).toBeInTheDocument();
    // Status call happens on mount, but invalid input should prevent secret writes.
    const secretSetCalls = vi
      .mocked(send)
      .mock.calls.filter(([method]) => method === 'secret-set');
    expect(secretSetCalls).toHaveLength(0);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
