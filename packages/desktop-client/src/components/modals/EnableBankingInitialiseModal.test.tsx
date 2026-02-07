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
      expect(send).toHaveBeenCalledTimes(3);
    });

    expect(send).toHaveBeenNthCalledWith(1, 'secret-set', {
      name: 'enablebanking_applicationId',
      value: 'test-application-id',
    });
    expect(send).toHaveBeenNthCalledWith(2, 'secret-set', {
      name: 'enablebanking_privateKey',
      value: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
    });
    expect(send).toHaveBeenNthCalledWith(3, 'secret-set', {
      name: 'enablebanking_environment',
      value: 'PRODUCTION',
    });
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
    expect(send).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
