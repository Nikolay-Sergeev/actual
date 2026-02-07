import { send } from 'loot-core/platform/client/fetch';
import { type EnableBankingAuthResult } from 'loot-core/types/models';

import { pushModal } from './modals/modalsSlice';
import { type AppDispatch } from './redux/store';

type EnableBankingAuthPollResult =
  | { error: 'timeout' }
  | { error: 'unknown'; message?: string }
  | { data: EnableBankingAuthResult };

type EnableBankingCreateAuthResponse = {
  url?: string;
  authorization_id?: string;
  reason?: string;
  error_description?: string;
  error?: string;
  error_code?: string;
};

function _authorize(
  dispatch: AppDispatch,
  {
    onSuccess,
    onClose,
  }: {
    onSuccess: (data: EnableBankingAuthResult) => Promise<void>;
    onClose?: () => void;
  },
) {
  dispatch(
    pushModal({
      modal: {
        name: 'enablebanking-external-msg',
        options: {
          onMoveExternal: async ({ aspsp }) => {
            const resp = (await send('enablebanking-create-auth', {
              aspsp,
              accessValidForDays: 90,
            })) as EnableBankingCreateAuthResponse;

            if (
              'error' in resp ||
              'error_code' in resp ||
              !resp.url ||
              !resp.authorization_id
            ) {
              return {
                error: 'unknown' as const,
                message:
                  ('reason' in resp && resp.reason) ||
                  ('error_description' in resp && resp.error_description) ||
                  ('error' in resp ? resp.error : undefined) ||
                  ('error_code' in resp ? resp.error_code : undefined),
              };
            }

            const { url, authorization_id: authorizationId } = resp;
            window.Actual.openURLInBrowser(url);

            const pollResult = (await send('enablebanking-poll-auth', {
              authorizationId,
            })) as EnableBankingAuthPollResult;

            if (
              pollResult &&
              typeof pollResult === 'object' &&
              ('error' in pollResult || 'data' in pollResult)
            ) {
              return pollResult;
            }

            return {
              error: 'unknown' as const,
              message: 'authorization_failed',
            };
          },
          onClose,
          onSuccess,
        },
      },
    }),
  );
}

export async function authorizeEnableBanking(dispatch: AppDispatch) {
  _authorize(dispatch, {
    onSuccess: async data => {
      dispatch(
        pushModal({
          modal: {
            name: 'select-linked-accounts',
            options: {
              externalAccounts: data.accounts,
              sessionId: data.session_id,
              syncSource: 'enableBanking',
            },
          },
        }),
      );
    },
  });
}
