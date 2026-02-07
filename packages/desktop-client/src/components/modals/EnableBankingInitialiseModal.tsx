import { useEffect, useState } from 'react';
import { TextArea } from 'react-aria-components';
import { Trans, useTranslation } from 'react-i18next';

import { ButtonWithLoading } from '@actual-app/components/button';
import { InitialFocus } from '@actual-app/components/initial-focus';
import { baseInputStyle, Input } from '@actual-app/components/input';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';

import { send } from 'loot-core/platform/client/fetch';
import { getSecretsError } from 'loot-core/shared/errors';

import { Error } from '@desktop-client/components/alerts';
import { Link } from '@desktop-client/components/common/Link';
import {
  Modal,
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
} from '@desktop-client/components/common/Modal';
import { FormField, FormLabel } from '@desktop-client/components/forms';
import { type Modal as ModalType } from '@desktop-client/modals/modalsSlice';

type EnableBankingInitialiseModalProps = Extract<
  ModalType,
  { name: 'enablebanking-init' }
>['options'];

const VALID_ENVIRONMENTS = new Set(['SANDBOX', 'PRODUCTION']);

export function EnableBankingInitialiseModal({
  onSuccess,
}: EnableBankingInitialiseModalProps) {
  const { t } = useTranslation();
  const [applicationId, setApplicationId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [environment, setEnvironment] = useState('SANDBOX');
  const [redirectUrl, setRedirectUrl] = useState('');
  const [suggestedRedirectUrl, setSuggestedRedirectUrl] = useState('');
  const [isValid, setIsValid] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(
    t(
      'It is required to provide the application ID, private key and environment.',
    ),
  );

  const onSubmit = async (close: () => void) => {
    const normalizedEnvironment = environment.trim().toUpperCase();
    const normalizedRedirectUrl = redirectUrl.trim();

    if (!applicationId || !privateKey || !normalizedEnvironment) {
      setIsValid(false);
      setError(
        t(
          'It is required to provide the application ID, private key and environment.',
        ),
      );
      return;
    }

    if (!VALID_ENVIRONMENTS.has(normalizedEnvironment)) {
      setIsValid(false);
      setError(t('Environment must be either SANDBOX or PRODUCTION.'));
      return;
    }

    if (normalizedRedirectUrl) {
      try {
        new URL(normalizedRedirectUrl);
      } catch {
        setIsValid(false);
        setError(t('Redirect URL must be a valid absolute URL.'));
        return;
      }
    }

    setIsLoading(true);

    let { error, reason } =
      (await send('secret-set', {
        name: 'enablebanking_applicationId',
        value: applicationId.trim(),
      })) || {};

    if (error) {
      setIsLoading(false);
      setIsValid(false);
      setError(getSecretsError(error, reason));
      return;
    }

    ({ error, reason } =
      (await send('secret-set', {
        name: 'enablebanking_privateKey',
        value: privateKey.trim(),
      })) || {});

    if (error) {
      setIsLoading(false);
      setIsValid(false);
      setError(getSecretsError(error, reason));
      return;
    }

    ({ error, reason } =
      (await send('secret-set', {
        name: 'enablebanking_environment',
        value: normalizedEnvironment,
      })) || {});

    if (error) {
      setIsLoading(false);
      setIsValid(false);
      setError(getSecretsError(error, reason));
      return;
    }

    ({ error, reason } =
      (await send('secret-set', {
        name: 'enablebanking_redirectUrl',
        value: normalizedRedirectUrl,
      })) || {});

    if (error) {
      setIsLoading(false);
      setIsValid(false);
      setError(getSecretsError(error, reason));
      return;
    }

    setIsValid(true);
    onSuccess();
    setIsLoading(false);
    close();
  };

  useEffect(() => {
    async function loadSuggestedRedirectUrl() {
      const status = await send('enablebanking-status');
      if (!status?.callback_url) {
        return;
      }

      setSuggestedRedirectUrl(status.callback_url);
      setRedirectUrl(current =>
        current.trim() === '' ? status.callback_url : current,
      );
    }

    void loadSuggestedRedirectUrl();
  }, []);

  return (
    <Modal
      name="enablebanking-init"
      containerProps={{ style: { width: '40vw' } }}
    >
      {({ state: { close } }) => (
        <>
          <ModalHeader
            title={t('Set up Enable Banking')}
            rightContent={<ModalCloseButton onPress={close} />}
          />
          <View style={{ display: 'flex', gap: 10 }}>
            <Text>
              <Trans>Enter your credentials to enable bank sync.</Trans>
            </Text>
            <Text>
              <Trans>
                Create an application in the{' '}
                <Link
                  variant="external"
                  to="https://enablebanking.com/cp/applications"
                  linkColor="purple"
                >
                  Enable Banking control panel
                </Link>
                , then paste the details here.
              </Trans>
            </Text>

            <FormField>
              <FormLabel
                title={t('App ID')}
                htmlFor="enablebanking-application-id-field"
              />
              <InitialFocus>
                <Input
                  id="enablebanking-application-id-field"
                  type="text"
                  value={applicationId}
                  onChangeValue={value => {
                    setApplicationId(value);
                    setIsValid(true);
                  }}
                />
              </InitialFocus>
            </FormField>

            <FormField>
              <FormLabel
                title={t('Private key (PEM)')}
                htmlFor="enablebanking-private-key-field"
              />
              <TextArea
                id="enablebanking-private-key-field"
                value={privateKey}
                aria-label={t('Private key (PEM)')}
                onChange={event => {
                  setPrivateKey(event.currentTarget.value);
                  setIsValid(true);
                }}
                style={{
                  ...baseInputStyle,
                  minHeight: 120,
                  resize: 'vertical',
                  fontFamily: 'monospace',
                  whiteSpace: 'pre',
                }}
              />
            </FormField>

            <FormField>
              <FormLabel
                title={t('Environment')}
                htmlFor="enablebanking-environment-field"
              />
              <Select
                id="enablebanking-environment-field"
                value={environment}
                options={[
                  ['PRODUCTION', t('PRODUCTION')],
                  ['SANDBOX', t('SANDBOX')],
                ]}
                onChange={value => {
                  setEnvironment(value);
                  setIsValid(true);
                }}
              />
            </FormField>

            <FormField>
              <FormLabel
                title={t('Redirect URL')}
                htmlFor="enablebanking-redirect-url-field"
              />
              <Input
                id="enablebanking-redirect-url-field"
                type="text"
                value={redirectUrl}
                placeholder={suggestedRedirectUrl || 'https://.../callback'}
                onChangeValue={value => {
                  setRedirectUrl(value);
                  setIsValid(true);
                }}
              />
              <Text style={{ fontSize: 12 }}>
                <Trans>
                  This URL must be added to your Enable Banking app redirect
                  URLs.
                </Trans>
              </Text>
            </FormField>

            {!isValid && <Error>{error}</Error>}
          </View>

          <ModalButtons>
            <ButtonWithLoading
              variant="primary"
              isLoading={isLoading}
              onPress={() => {
                onSubmit(close);
              }}
            >
              <Trans>Save and continue</Trans>
            </ButtonWithLoading>
          </ModalButtons>
        </>
      )}
    </Modal>
  );
}
