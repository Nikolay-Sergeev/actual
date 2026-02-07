import { useEffect, useRef, useState } from 'react';
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
import { Link } from '@desktop-client/components/common/Link';
import {
  Modal,
  ModalCloseButton,
  ModalHeader,
} from '@desktop-client/components/common/Modal';
import { FormField, FormLabel } from '@desktop-client/components/forms';
import { COUNTRY_OPTIONS } from '@desktop-client/components/util/countries';
import { getCountryFromBrowser } from '@desktop-client/components/util/localeToCountry';
import { useEnableBankingStatus } from '@desktop-client/hooks/useEnableBankingStatus';
import { useGlobalPref } from '@desktop-client/hooks/useGlobalPref';
import { type Modal as ModalType } from '@desktop-client/modals/modalsSlice';

type EnableBankingAspspOption = EnableBankingAspsp & {
  id: string;
};

function isEnableBankingAspsp(value: unknown): value is EnableBankingAspsp {
  if (!value || typeof value !== 'object') {
    return false;
  }

  // Minimal shape check; server is the source of truth.
  const obj = value as Record<string, unknown>;
  return typeof obj.name === 'string' && typeof obj.country === 'string';
}

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

      const primaryResponse = await sendCatch('enablebanking-get-aspsps', {
        country,
      });

      if (primaryResponse.error) {
        setIsError(true);
        setAspsps([]);
        setIsLoading(false);
        return;
      }

      const data: unknown = primaryResponse.data;
      const itemsRaw =
        data && typeof data === 'object' && 'aspsps' in data
          ? (data as { aspsps?: unknown }).aspsps
          : undefined;
      const items = Array.isArray(itemsRaw)
        ? itemsRaw.filter(isEnableBankingAspsp)
        : [];
      setAspsps(
        items.map(aspsp => ({
          ...aspsp,
          id: `${aspsp.country}:${aspsp.name}`,
        })),
      );

      setIsLoading(false);
    }

    void fetch();
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
            { message: error.message || t('Unknown error') },
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
  const jumpInFlightRef = useRef(false);
  const continueInFlightRef = useRef(false);

  const browserTimezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const browserLocale = language || navigator.language || 'en-US';
  const detectedCountry = getCountryFromBrowser(
    browserTimezone,
    browserLocale,
    COUNTRY_OPTIONS,
  );

  const [waiting, setWaiting] = useState<null | 'browser' | 'accounts'>(null);
  const [success, setSuccess] = useState<boolean>(false);
  const [country, setCountry] = useState<string | undefined>(detectedCountry);
  const [aspspId, setAspspId] = useState<string>();
  const [error, setError] = useState<{
    code: 'unknown' | 'timeout';
    message?: string;
  } | null>(null);

  const data = useRef<EnableBankingAuthResult | null>(null);
  const {
    data: aspspOptions,
    isLoading: isAspspsLoading,
    isError: isAspspError,
  } = useAvailableAspsps(country);
  const {
    configuredEnableBanking: isConfigured,
    isLoading: isConfigurationLoading,
  } = useEnableBankingStatus();

  const selectedAspsp = aspspOptions.find(a => a.id === aspspId);

  async function onJump() {
    if (jumpInFlightRef.current) {
      return;
    }
    if (!selectedAspsp) {
      return;
    }

    jumpInFlightRef.current = true;
    setError(null);
    setWaiting('browser');

    try {
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
    } finally {
      jumpInFlightRef.current = false;
    }
  }

  async function onContinue() {
    if (continueInFlightRef.current) {
      return;
    }
    if (!data.current) {
      setError({ code: 'unknown', message: t('Missing authorization data.') });
      return;
    }

    continueInFlightRef.current = true;
    setWaiting('accounts');
    try {
      await onSuccess(data.current);
      setWaiting(null);
    } finally {
      continueInFlightRef.current = false;
    }
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
            title={t('Link your bank')}
            rightContent={<ModalCloseButton onPress={close} />}
          />
          <View>
            <Paragraph style={{ fontSize: 15 }}>
              <Trans>
                You'll be redirected to Enable Banking to choose your bank and
                approve access. Then you'll return to Actual Budget.
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

                {waiting === 'browser' && (
                  <Link
                    variant="text"
                    onClick={onJump}
                    style={{ marginTop: 10 }}
                  >
                    (
                    <Trans>
                      Account linking not opening in a new tab? Click here
                    </Trans>
                    )
                  </Link>
                )}
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
                    title={t('Country:')}
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
                  ) : aspspOptions.length === 0 ? (
                    <Error>
                      <Trans>
                        No banks were found for this selection. Try another
                        country.
                      </Trans>
                    </Error>
                  ) : (
                    <FormField>
                      <FormLabel
                        title={t('Bank:')}
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
                  <Trans>Connect bank</Trans> &rarr;
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
