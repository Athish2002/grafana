import { type SelectableValue } from '@grafana/data';

import { type CloudWatchMetricsQuery, MetricQueryType, MetricEditorMode } from '../dataquery.gen';

import { type CloudWatchDatasource } from './../datasource';

export const toOption = (value: string) => ({ label: value, value });

export const appendTemplateVariables = (datasource: CloudWatchDatasource, values: SelectableValue[]) => [
  ...values,
  { label: 'Template Variables', options: datasource.getVariables().map(toOption) },
];

export const filterMetricsQuery = (query: CloudWatchMetricsQuery): boolean => {
  const { expression, metricName, namespace, sqlExpression, statistic } = query;

  const metricQueryType = query.metricQueryType ?? MetricQueryType.Search;
  const metricEditorMode =
    query.metricEditorMode ?? (expression ? MetricEditorMode.Code : MetricEditorMode.Builder);

  if (metricQueryType === MetricQueryType.Search && metricEditorMode === MetricEditorMode.Builder) {
    return !!namespace && !!metricName && !!statistic;
  } else if (metricQueryType === MetricQueryType.Search && metricEditorMode === MetricEditorMode.Code) {
    return !!expression;
  } else if (metricQueryType === MetricQueryType.Insights) {
    // still TBD how to validate the visual query builder for SQL
    return !!sqlExpression;
  } else if (metricQueryType === MetricQueryType.PromQL) {
    return !!query.promqlExpression;
  }

  return false;
};
