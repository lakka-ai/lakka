import { useState } from 'react';
import { Button } from '@heroui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ModelView, RoutingPolicyView } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { api } from '../../lib/api.ts';
import { ModelSelect } from '../model-select.tsx';
import { ErrorNotice } from '../patterns/notices.tsx';
import { CheckboxSetting, SettingsSection } from '../patterns/settings.tsx';

/*
 * Routing settings (RT-1, RT-3, RT-6, RT-11; Routing board, Settings; Routing-States, "Routing
 * off"). Choose models automatically is a checkbox, since nothing applies until Save; each row
 * reads its description. With routing off the rows say what off means, and a line says how many
 * routes are kept. The pinned model stays: it applies with routing off too (ADR 0046).
 */

export function RoutingSettings({
  workspaceId,
  policy,
  models,
  routesShown,
  onShowRoutes,
}: {
  workspaceId: string;
  policy: RoutingPolicyView;
  models: readonly ModelView[];
  /** With routing off, whether the routes card is shown anyway. */
  routesShown: boolean;
  onShowRoutes: (shown: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const saved = policy.settings;
  const [enabled, setEnabled] = useState(saved.routingEnabled);
  const [defaultModel, setDefaultModel] = useState(saved.defaultModel);
  const [pinnedModel, setPinnedModel] = useState(saved.pinnedModel);
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api(`/api/workspaces/${workspaceId}/routing/settings`, {
        method: 'PUT',
        body: { routingEnabled: enabled, defaultModel, pinnedModel },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'routing'] });
      await queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'requestable'] });
      setDone(true);
    },
  });
  const change =
    <T,>(set: (v: T) => void) =>
    (value: T) => {
      setDone(false);
      set(value);
    };
  // The page shows what is saved, so the off state follows Save, not the checkbox.
  const off = !saved.routingEnabled;
  const count = policy.routes.length;
  return (
    <SettingsSection
      title={t('routing.settings.title')}
      onSave={() => save.mutate()}
      isSaving={save.isPending}
      saved={done}
    >
      {save.isError && (
        <ErrorNotice title={t('routing.settings.failed')}>{t('app.error')}</ErrorNotice>
      )}
      <CheckboxSetting
        label={t('routing.settings.auto')}
        description={off ? t('routing.settings.autoOffHelp') : t('routing.settings.autoHelp')}
        isSelected={enabled}
        onChange={change(setEnabled)}
      />
      <ModelSelect
        setting
        label={t('routing.settings.default')}
        description={off ? t('routing.settings.defaultOffHelp') : t('routing.settings.defaultHelp')}
        models={models}
        value={defaultModel}
        onChange={change(setDefaultModel)}
        allowNone
        className="lk-setting-row"
      />
      <ModelSelect
        setting
        label={t('routing.settings.pinned')}
        description={t('routing.settings.pinnedHelp')}
        models={models}
        value={pinnedModel}
        onChange={change(setPinnedModel)}
        allowNone
        className="lk-setting-row"
      />
      {off && count > 0 && (
        <p className="lk-setting-row flex flex-wrap items-center gap-x-2 text-small text-muted">
          {count === 1
            ? t('routing.settings.savedRoute')
            : t('routing.settings.savedRoutes', { n: String(count) })}
          <Button
            variant="ghost"
            className="lk-link"
            aria-expanded={routesShown}
            onPress={() => onShowRoutes(!routesShown)}
          >
            {routesShown ? t('routing.settings.hideRoutes') : t('routing.settings.showRoutes')}
          </Button>
        </p>
      )}
    </SettingsSection>
  );
}
