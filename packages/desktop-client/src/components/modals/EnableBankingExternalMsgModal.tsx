// @ts-strict-ignore
import React, { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { AnimatedLoading } from '@actual-app/components/icons/AnimatedLoading';
import { Paragraph } from '@actual-app/components/paragraph';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { sendCatch } from 'loot-core/platform/client/fetch';
import {
  type EnableBankingAspsp,
  type EnableBankingAuthResult,
} from 'loot-core/types/models';

import { Error } from '@desktop-client/components/alerts';
import { Autocomplete } from '@desktop-client/components/autocomplete/Autocomplete';
import {
  Modal,
  ModalCloseButton,
  ModalHeader,
} from '@desktop-client/components/common/Modal';
import { FormField, FormLabel } from '@desktop-client/components/forms';
import { COUNTRY_OPTIONS } from '@desktop-client/components/util/countries';
import { getCountryFromBrowser } from '@desktop-client/components/util/localeToCountry';
import { useGlobalPref } from '@desktop-client/hooks/useGlobalPref';
import { useEnableBankingStatus } from '@desktop-client/hooks/useEnableBankingStatus';
import { type Modal as ModalType } from '@desktop-client/modals/modalsSlice';

type EnableBankingAspspOption = EnableBankingAspsp & {
  id: string;
};

function useAvailableAspsps(country?: string) {
  const [aspsps, setAspsps] = useState<EnableBankingAspspOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    async function fetch() {
      setIsError(false);

      if (!country) {
        setAspsps([]);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);

      const { data, error } = await sendCatch('enablebanking-get-aspsps', {
        country,
      });

      if (error) {
        setIsError(true);
        setAspsps([]);
      } else {
        const items = Array.isArray(data?.aspsps) ? data.aspsps : [];
        setAspsps(
          items.map(aspsp => ({
            ...aspsp,
            id: `${aspsp.country}:${aspsp.name}`,
          })),
        );
      }

      setIsLoading(false);
    }

    fetch();
  }, [country]);

  return {
    data: aspsps,
    isLoading,
    isError,
  };
}

function renderError(
  error: { code: 'unknown' | 'timeout'; message?: string },
  t: ReturnType<typeof useTranslation>['t'],
) {
  return (
    <Error style={{ alignSelf: 'center', marginBottom: 10 }}>
      {error.code === 'timeout'
        ? t('Timed out. Please try again.')
        : t(
            'An error occurred while linking your account, sorry! The potential issue could be: {{ message }}',
            { message: error.message },
          )}
    </Error>
  );
}

type EnableBankingExternalMsgModalProps = Extract<
  ModalType,
  { name: 'enablebanking-external-msg' }
>['options'];

export function EnableBankingExternalMsgModal({
  onMoveExternal,
  onSuccess,
  onClose,
}: EnableBankingExternalMsgModalProps) {
  const { t } = useTranslation();
  const [language] = useGlobalPref('language');

  const browserTimezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const browserLocale = language || navigator.language || 'en-US';
  const detectedCountry = getCountryFromBrowser(
    browserTimezone,
    browserLocale,
    COUNTRY_OPTIONS,
  );

  const [waiting, setWaiting] = useState<string | null>(null);
  const [success, setSuccess] = useState<boolean>(false);
  const [country, setCountry] = useState<string | undefined>(detectedCountry);
  const [aspspId, setAspspId] = useState<string>();
  const [error, setError] = useState<{
    code: 'unknown' | 'timeout';
    message?: string;
  } | null>(null);

  const data = useRef<EnableBankingAuthResult | null>(null);
  const { data: aspspOptions, isLoading: isAspspsLoading, isError: isAspspError } =
    useAvailableAspsps(country);
  const {
    configuredEnableBanking: isConfigured,
    isLoading: isConfigurationLoading,
  } = useEnableBankingStatus();

  const selectedAspsp = aspspOptions.find(a => a.id === aspspId);

  async function onJump() {
    if (!selectedAspsp) {
      return;
    }

    setError(null);
    setWaiting('browser');

    const res = await onMoveExternal({
      aspsp: {
        name: selectedAspsp.name,
        country: selectedAspsp.country,
      },
    });
    if ('error' in res) {
      setError({
        code: res.error,
        message: 'message' in res ? res.message : undefined,
      });
      setWaiting(null);
      return;
    }

    data.current = res.data;
    setWaiting(null);
    setSuccess(true);
  }

  async function onContinue() {
    setWaiting('accounts');
    await onSuccess(data.current);
    setWaiting(null);
  }

  return (
    <Modal
      name="enablebanking-external-msg"
      onClose={onClose}
      containerProps={{ style: { width: '30vw' } }}
    >
      {({ state: { close } }) => (
        <>
          <ModalHeader
            title={t('Link Your Bank')}
            rightContent={<ModalCloseButton onPress={close} />}
          />
          <View>
            <Paragraph style={{ fontSize: 15 }}>
              <Trans>
                To link your bank account, you will be redirected to a new page
                where Enable Banking will ask to connect to your bank.
              </Trans>
            </Paragraph>

            {error && renderError(error, t)}

            {waiting || isConfigurationLoading ? (
              <View style={{ alignItems: 'center', marginTop: 15 }}>
                <AnimatedLoading
                  color={theme.pageTextDark}
                  style={{ width: 20, height: 20 }}
                />
                <View style={{ marginTop: 10, color: theme.pageText }}>
                  {isConfigurationLoading
                    ? t('Checking Enable Banking configuration...')
                    : waiting === 'browser'
                      ? t('Waiting on Enable Banking...')
                      : waiting === 'accounts'
                        ? t('Loading accounts...')
                        : null}
                </View>
              </View>
            ) : success ? (
              <Button
                variant="primary"
                autoFocus
                style={{
                  padding: '10px 0',
                  fontSize: 15,
                  fontWeight: 600,
                  marginTop: 10,
                }}
                onPress={onContinue}
              >
                <Trans>Success! Click to continue</Trans> &rarr;
              </Button>
            ) : isConfigured ? (
              <View style={{ gap: 10 }}>
                <FormField>
                  <FormLabel
                    title={t('Choose your country:')}
                    htmlFor="enable-banking-country-field"
                  />
                  <Autocomplete
                    strict
                    highlightFirst
                    suggestions={COUNTRY_OPTIONS}
                    onSelect={value => {
                      setCountry(value);
                      setAspspId(undefined);
                    }}
                    value={country}
                    inputProps={{
                      id: 'enable-banking-country-field',
                      placeholder: t('(please select)'),
                    }}
                  />
                </FormField>

                {isAspspError ? (
                  <Error>
                    <Trans>Failed loading available banks.</Trans>
                  </Error>
                ) : (
                  country &&
                  (isAspspsLoading ? (
                    t('Loading banks...')
                  ) : (
                    <FormField>
                      <FormLabel
                        title={t('Choose your bank:')}
                        htmlFor="enable-banking-bank-field"
                      />
                      <Autocomplete
                        strict
                        highlightFirst
                        suggestions={aspspOptions}
                        onSelect={setAspspId}
                        value={aspspId}
                        inputProps={{
                          id: 'enable-banking-bank-field',
                          placeholder: t('(please select)'),
                        }}
                      />
                    </FormField>
                  ))
                )}

                <Button
                  variant="primary"
                  autoFocus
                  style={{
                    padding: '10px 0',
                    fontSize: 15,
                    fontWeight: 600,
                    marginTop: 10,
                  }}
                  onPress={onJump}
                  isDisabled={!selectedAspsp}
                >
                  <Trans>Link bank in browser</Trans> &rarr;
                </Button>
              </View>
            ) : (
              <Paragraph style={{ color: theme.errorText }}>
                <Trans>
                  Enable Banking integration has not yet been configured.
                </Trans>
              </Paragraph>
            )}
          </View>
        </>
      )}
    </Modal>
  );
}
