import { send } from 'loot-core/platform/client/fetch';
import {
  type EnableBankingAuthPollResult,
  type EnableBankingAuthResult,
  type EnableBankingCreateAuthResult,
} from 'loot-core/types/models';

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
            const resp: EnableBankingCreateAuthResult = await send(
              'enablebanking-create-auth',
              {
                aspsp,
                accessValidForDays: 90,
              },
            );

            const url = 'url' in resp ? resp.url : undefined;
            const authorizationId =
              'authorization_id' in resp ? resp.authorization_id : undefined;

            if (
              ('error' in resp && Boolean(resp.error)) ||
              ('error_code' in resp && Boolean(resp.error_code)) ||
              !url ||
              !authorizationId
            ) {
              const message =
                ('reason' in resp && resp.reason) ||
                ('error_description' in resp && resp.error_description) ||
                ('error' in resp ? resp.error : undefined) ||
                ('error_code' in resp ? resp.error_code : undefined) ||
                'authorization_failed';
              return {
                error: 'unknown',
                message,
              };
            }

            window.Actual.openURLInBrowser(url);

            const pollResult: EnableBankingAuthPollResult = await send(
              'enablebanking-poll-auth',
              {
                authorizationId,
              },
            );

            return pollResult;
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
