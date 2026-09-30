import { css } from '@emotion/css';
import { type ChangeEvent, useCallback, useEffect, useId, useState, type JSX } from 'react';
import * as React from 'react';

import { getDefaultTimeRange, type GrafanaTheme2, type QueryEditorProps, type SelectableValue } from '@grafana/data';
import { EditorField, EditorRow, InlineSelect } from '@grafana/plugin-ui';
import { buildVisualQueryFromString } from '@grafana/prometheus';
import { config } from '@grafana/runtime';
import { ConfirmModal, Input, RadioButtonGroup, Space, Stack, Switch, useStyles2 } from '@grafana/ui';

import {
  type CloudWatchMetricsQuery,
  MetricEditorMode,
  MetricQueryType,
  type MetricStat,
} from '../../../dataquery.gen';
import { type CloudWatchDatasource } from '../../../datasource';
import { DEFAULT_METRICS_QUERY } from '../../../defaultQueries';
import useMigratedMetricsQuery from '../../../migrations/useMigratedMetricsQuery';
import { type CloudWatchQuery, type CloudWatchJsonData } from '../../../types';
import { MetricStatEditor } from '../../shared/MetricStatEditor/MetricStatEditor';

import { DynamicLabelsField } from './DynamicLabelsField';
import { MathExpressionQueryField } from './MathExpressionQueryField';
import { PromQLBuilderEditor } from './PromQLBuilderEditor';
import { PromQLCodeEditor } from './PromQLCodeEditor';
import { SQLBuilderEditor } from './SQLBuilderEditor/SQLBuilderEditor';
import { SQLCodeEditor } from './SQLCodeEditor';

export interface Props extends QueryEditorProps<CloudWatchDatasource, CloudWatchQuery, CloudWatchJsonData> {
  query: CloudWatchMetricsQuery;
  extraHeaderElementLeft?: React.Dispatch<JSX.Element | undefined>;
  extraHeaderElementRight?: React.Dispatch<JSX.Element | undefined>;
}

const metricEditorModes: Array<SelectableValue<MetricQueryType>> = [
  { label: 'Metric Search', value: MetricQueryType.Search },
  { label: 'Metric Insights', value: MetricQueryType.Insights },
  { label: 'PromQL', value: MetricQueryType.PromQL },
];
const editorModes = [
  { label: 'Builder', value: MetricEditorMode.Builder },
  { label: 'Code', value: MetricEditorMode.Code },
];

export const MetricsQueryEditor = (props: Props) => {
  const { query, datasource, extraHeaderElementLeft, extraHeaderElementRight, onChange } = props;
  const [showConfirm, setShowConfirm] = useState(false);
  const [promQLParseModalOpen, setPromQLParseModalOpen] = useState(false);
  const [codeEditorIsDirty, setCodeEditorIsDirty] = useState(false);
  const [showPromQLExplain, setShowPromQLExplain] = useState(false);
  const promQLExplainSwitchId = useId();
  const styles = useStyles2(getStyles);
  const currentQuery = useMigratedMetricsQuery(props.query, onChange);

  const onEditorModeChange = useCallback(
    (newMetricEditorMode: MetricEditorMode) => {
      if (
        codeEditorIsDirty &&
        currentQuery.metricQueryType === MetricQueryType.Insights &&
        currentQuery.metricEditorMode === MetricEditorMode.Code
      ) {
        setShowConfirm(true);
        return;
      }
      if (
        currentQuery.metricQueryType === MetricQueryType.PromQL &&
        currentQuery.metricEditorMode === MetricEditorMode.Code &&
        newMetricEditorMode === MetricEditorMode.Builder
      ) {
        const parseResult = buildVisualQueryFromString(currentQuery.promqlExpression ?? '');
        if (parseResult.errors.length > 0) {
          setPromQLParseModalOpen(true);
          return;
        }
      }
      onChange({ ...currentQuery, metricEditorMode: newMetricEditorMode });
    },
    [setShowConfirm, onChange, codeEditorIsDirty, currentQuery]
  );

  const updateAccounIdOnMount = () => {
    if (config.featureToggles.cloudWatchCrossAccountQuerying && query.accountId) {
      datasource.resources.isMonitoringAccount(query.region).then((isMonitoring) => {
        if (!isMonitoring && query.accountId) {
          onChange({ ...query, accountId: undefined });
        }
      });
    }
  };
  useEffect(updateAccounIdOnMount, [datasource, onChange, query]);

  useEffect(() => {
    const selectedMetricQueryType = currentQuery.metricQueryType ?? MetricQueryType.Search;
    const selectedMetricEditorMode =
      currentQuery.metricEditorMode ??
      (currentQuery.expression ? MetricEditorMode.Code : MetricEditorMode.Builder);

    extraHeaderElementLeft?.(
      <>
        <InlineSelect
          aria-label="Metric editor mode"
          value={metricEditorModes.find((m) => m.value === selectedMetricQueryType) ?? metricEditorModes[0]}
          options={metricEditorModes}
          onChange={({ value }) => {
            if (
              codeEditorIsDirty &&
              currentQuery.metricQueryType === MetricQueryType.Search &&
              currentQuery.metricEditorMode === MetricEditorMode.Builder
            ) {
              setShowConfirm(true);
              return;
            }
            onChange({ ...currentQuery, metricQueryType: value });
          }}
        />
        {currentQuery.metricQueryType === MetricQueryType.PromQL && (
          <Stack direction="row" gap={1} alignItems="center">
            <label htmlFor={promQLExplainSwitchId} className={styles.promQLExplainLabel}>
              Explain
            </label>
            <Switch
              id={promQLExplainSwitchId}
              value={showPromQLExplain}
              onChange={(event) => setShowPromQLExplain(event.currentTarget.checked)}
            />
          </Stack>
        )}
      </>
    );

    extraHeaderElementRight?.(
      <>
        <RadioButtonGroup
          options={editorModes}
          size="sm"
          value={selectedMetricEditorMode}
          onChange={onEditorModeChange}
        />
        <ConfirmModal
          isOpen={showConfirm}
          title="Are you sure?"
          body="You will lose changes made to the query if you change to Metric Insights Builder mode."
          confirmText="Yes, I am sure."
          dismissText="No, continue editing the query."
          onConfirm={() => {
            setShowConfirm(false);
            setCodeEditorIsDirty(false);
            onChange({
              ...currentQuery,
              ...DEFAULT_METRICS_QUERY,
              metricQueryType: MetricQueryType.Insights,
              metricEditorMode: MetricEditorMode.Builder,
            });
          }}
          onDismiss={() => setShowConfirm(false)}
        />
        <ConfirmModal
          isOpen={promQLParseModalOpen}
          title="Parsing error: Switch to builder mode?"
          body="There is a syntax error, or the query structure cannot be visualized when switching to builder mode. Parts of the query may be lost."
          confirmText="Continue"
          dismissText="Cancel"
          onConfirm={() => {
            setPromQLParseModalOpen(false);
            onChange({ ...currentQuery, metricEditorMode: MetricEditorMode.Builder });
          }}
          onDismiss={() => setPromQLParseModalOpen(false)}
        />
      </>
    );

    return () => {
      extraHeaderElementLeft?.(undefined);
      extraHeaderElementRight?.(undefined);
    };
  }, [
    currentQuery,
    codeEditorIsDirty,
    datasource,
    onChange,
    extraHeaderElementLeft,
    extraHeaderElementRight,
    showConfirm,
    promQLParseModalOpen,
    showPromQLExplain,
    promQLExplainSwitchId,
    styles.promQLExplainLabel,
    onEditorModeChange,
  ]);

  return (
    <>
      <Space v={0.5} />
      {currentQuery.metricQueryType === MetricQueryType.Search && (
        <>
          {currentQuery.metricEditorMode === MetricEditorMode.Builder && (
            <MetricStatEditor
              {...props}
              refId={currentQuery.refId}
              metricStat={currentQuery}
              onChange={(metricStat: MetricStat) => {
                if (!codeEditorIsDirty) {
                  setCodeEditorIsDirty(true);
                }
                onChange({ ...currentQuery, ...metricStat });
              }}
            ></MetricStatEditor>
          )}
          {currentQuery.metricEditorMode === MetricEditorMode.Code && (
            <MathExpressionQueryField
              expression={currentQuery.expression ?? ''}
              onChange={(expression) => onChange({ ...currentQuery, expression })}
              datasource={datasource}
            ></MathExpressionQueryField>
          )}
        </>
      )}
      {currentQuery.metricQueryType === MetricQueryType.Insights && (
        <>
          {currentQuery.metricEditorMode === MetricEditorMode.Code && (
            <SQLCodeEditor
              region={currentQuery.region}
              sql={currentQuery.sqlExpression ?? ''}
              onChange={(sqlExpression) => {
                if (!codeEditorIsDirty) {
                  setCodeEditorIsDirty(true);
                }
                onChange({ ...currentQuery, sqlExpression });
              }}
              datasource={datasource}
            />
          )}

          {currentQuery.metricEditorMode === MetricEditorMode.Builder && (
            <>
              <SQLBuilderEditor query={currentQuery} onChange={onChange} datasource={datasource}></SQLBuilderEditor>
            </>
          )}
        </>
      )}
      {currentQuery.metricQueryType === MetricQueryType.PromQL && (
        <>
          {currentQuery.metricEditorMode === MetricEditorMode.Code && (
            <PromQLCodeEditor
              query={currentQuery}
              onChange={onChange}
              onRunQuery={props.onRunQuery}
              datasource={datasource}
              timeRange={props.range ?? getDefaultTimeRange()}
              app={props.app}
              showExplain={showPromQLExplain}
              data={props.data}
            />
          )}
          {currentQuery.metricEditorMode === MetricEditorMode.Builder && (
            <PromQLBuilderEditor
              query={currentQuery}
              onChange={onChange}
              onRunQuery={props.onRunQuery}
              datasource={datasource}
              timeRange={props.range ?? getDefaultTimeRange()}
              app={props.app}
              showExplain={showPromQLExplain}
              data={props.data}
            />
          )}
        </>
      )}
      {currentQuery.metricQueryType !== MetricQueryType.PromQL && (
        <>
          <Space v={0.5} />
          <EditorRow>
            <EditorField
              label="ID"
              width={26}
              optional
              tooltip="ID can be used to reference other queries in math expressions. The ID can include numbers, letters, and underscore, and must start with a lowercase letter."
              invalid={!!currentQuery.id && !/^$|^[a-z][a-zA-Z0-9_]*$/.test(currentQuery.id)}
            >
              <Input
                id={`${currentQuery.refId}-cloudwatch-metric-query-editor-id`}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  onChange({ ...currentQuery, id: event.target.value })
                }
                type="text"
                value={currentQuery.id}
              />
            </EditorField>

            <EditorField label="Period" width={26} tooltip="Minimum interval between points in seconds.">
              <Input
                id={`${currentQuery.refId}-cloudwatch-metric-query-editor-period`}
                value={currentQuery.period || ''}
                placeholder="auto"
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  onChange({ ...currentQuery, period: event.target.value })
                }
              />
            </EditorField>

            <EditorField
              label="Label"
              width={26}
              optional
              tooltip="Change time series legend name using Dynamic labels. See documentation for details."
            >
              <DynamicLabelsField
                width={52}
                label={currentQuery.label ?? ''}
                onChange={(label) => onChange({ ...currentQuery, label })}
              ></DynamicLabelsField>
            </EditorField>
          </EditorRow>
        </>
      )}
    </>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  promQLExplainLabel: css({
    color: theme.colors.text.secondary,
    cursor: 'pointer',
    fontSize: theme.typography.bodySmall.fontSize,
    '&:hover': {
      color: theme.colors.text.primary,
    },
  }),
});
