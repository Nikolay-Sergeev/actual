import { send } from 'loot-core/platform/client/fetch';
import { type EnableBankingAuthResult } from 'loot-core/types/models';

import { pushModal } from './modals/modalsSlice';
import { type AppDispatch } from './redux/store';

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
            const resp = await send('enablebanking-create-auth', {
              aspsp,
              accessValidForDays: 90,
            });

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

            return send('enablebanking-poll-auth', {
              authorizationId,
            });
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
