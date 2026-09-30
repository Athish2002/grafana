import { isEmpty } from 'lodash';
import { createElement } from 'react';
import { catchError, map, merge, type Observable, of } from 'rxjs';

import {
  AppEvents,
  type DataFrame,
  type DataQueryError,
  type DataQueryRequest,
  type DataQueryResponse,
  type DataSourceInstanceSettings,
  dateTimeFormat,
  FieldType,
  type QueryResultMetaNotice,
  rangeUtil,
  renderLegendFormat,
  type ScopedVars,
  type TimeRange,
} from '@grafana/data';
import { transformV2, type PromQuery } from '@grafana/prometheus';
import { type TemplateSrv, getAppEvents } from '@grafana/runtime';

import { ThrottlingErrorMessage } from '../components/Errors/ThrottlingErrorMessage';
import { type CloudWatchMetricsQuery, MetricQueryType } from '../dataquery.gen';
import { isCloudWatchMetricsQuery } from '../guards';
import memoizedDebounce from '../memoizedDebounce';
import { migrateMetricQuery } from '../migrations/metricQueryMigrations';
import { type CloudWatchJsonData, type CloudWatchQuery } from '../types';
import { filterMetricsQuery } from '../utils/utils';

import { CloudWatchRequest } from './CloudWatchRequest';

export function applyPromQLTransform(
  response: DataQueryResponse,
  request: DataQueryRequest<CloudWatchQuery>
): DataQueryResponse {
  const promTargets: PromQuery[] = [];

  for (const target of request.targets.filter(isCloudWatchMetricsQuery)) {
    if (target.metricQueryType !== MetricQueryType.PromQL) {
      continue;
    }

    const promTarget: PromQuery = {
      refId: target.refId,
      expr: target.promqlExpression ?? '',
      legendFormat: target.legendFormat,
      format: target.format,
      instant: target.instant,
      range: target.range,
    };

    promTargets.push(promTarget);
  }

  if (promTargets.length === 0) {
    return response;
  }

  const promRefIds = new Set(promTargets.map((target) => target.refId));
  const promFrames: DataFrame[] = [];
  const otherFrames: DataFrame[] = [];
  for (const frame of response.data) {
    if (frame.refId && promRefIds.has(frame.refId)) {
      promFrames.push(frame);
    } else {
      otherFrames.push(frame);
    }
  }

  for (const frame of promFrames) {
    const promTarget = promTargets.find((target) => target.refId === frame.refId);
    if (!promTarget?.legendFormat || promTarget.legendFormat === '__auto') {
      continue;
    }

    for (const field of frame.fields) {
      if (field.type !== FieldType.number || !field.labels) {
        continue;
      }

      field.config = {
        ...field.config,
        displayNameFromDS: renderLegendFormat(promTarget.legendFormat, field.labels),
      };
    }
  }

  const transformed = transformV2({ ...response, data: promFrames }, { ...request, targets: promTargets }, {});
  return { ...response, data: [...otherFrames, ...transformed.data] };
}

const getThrottlingErrorMessage = (region: string, message: string) =>
  `Please visit the AWS Service Quotas console at https://${region}.console.aws.amazon.com/servicequotas/home?region=${region}#!/services/monitoring/quotas/L-5E141212 to request a quota increase or see our documentation at https://grafana.com/docs/grafana/latest/datasources/cloudwatch/#manage-service-quotas to learn more. ${message}`;

const displayAlert = (datasourceName: string, region: string) =>
  getAppEvents().publish({
    type: AppEvents.alertError.name,
    payload: [
      `CloudWatch request limit reached in ${region} for data source ${datasourceName}`,
      '',
      undefined,
      createElement(ThrottlingErrorMessage, { region }, null),
    ],
  });

export interface CloudWatchMetricsDataQueryRequest extends DataQueryRequest<CloudWatchQuery> {
  defaultedRefIds?: Set<string>;
  discardedQueries?: CloudWatchMetricsQuery[];
}

// This class handles execution of CloudWatch metrics query data queries
export class CloudWatchMetricsQueryRunner extends CloudWatchRequest {
  debouncedThrottlingAlert: (datasourceName: string, region: string) => void = memoizedDebounce(displayAlert);

  constructor(instanceSettings: DataSourceInstanceSettings<CloudWatchJsonData>, templateSrv: TemplateSrv) {
    super(instanceSettings, templateSrv);
  }

  handleMetricQueries = (
    metricQueries: CloudWatchMetricsQuery[],
    options: DataQueryRequest<CloudWatchQuery>,
    queryFn: (request: DataQueryRequest<CloudWatchQuery>) => Observable<DataQueryResponse>
  ): Observable<DataQueryResponse> => {
    const timezoneUTCOffset = dateTimeFormat(Date.now(), {
      timeZone: options.timezone,
      format: 'Z',
    }).replace(':', '');

    const defaultedRefIds = new Set<string>();
    for (const q of metricQueries) {
      if (!q.metricQueryType || !q.metricEditorMode || !q.region || q.region === 'default') {
        if (q.refId) {
          defaultedRefIds.add(q.refId);
        }
      }
    }

    const migratedQueries = metricQueries.map((q) => migrateMetricQuery(q));
    const discardedQueries = migratedQueries.filter((q) => !this.filterMetricQuery(q));

    const validMetricsQueries = migratedQueries
      .filter((q) => this.filterMetricQuery(q))
      .map((migratedQuery) => {
        const migratedAndInterpolatedQuery = this.interpolateMetricsQueryVariables(
          migratedQuery,
          options.scopedVars,
          options.range
        );

        return {
          timezoneUTCOffset,
          intervalMs: options.intervalMs,
          maxDataPoints: options.maxDataPoints,
          ...migratedAndInterpolatedQuery,
          type:
            migratedAndInterpolatedQuery.metricQueryType === MetricQueryType.PromQL
              ? 'promqlQuery'
              : 'timeSeriesQuery',
          datasource: this.ref,
        };
      });

    // If all targets were discarded as incomplete, emit refId-scoped errors so the user receives a visible message rather than silent "No data"
    if (isEmpty(validMetricsQueries)) {
      const errors: DataQueryError[] = discardedQueries.map((q) => ({
        refId: q.refId,
        message: `Query "${q.refId}" is incomplete: missing required query fields.`,
      }));
      return of({ data: [], errors: errors.length ? errors : undefined });
    }

    const timeSeriesTargets = validMetricsQueries.filter((q) => q.type === 'timeSeriesQuery');
    const promqlTargets = validMetricsQueries.filter((q) => q.type === 'promqlQuery');
    const responses: Array<Observable<DataQueryResponse>> = [];

    if (timeSeriesTargets.length) {
      responses.push(
        this.performTimeSeriesQuery(
          {
            ...options,
            requestId: options.requestId + '-metrics',
            targets: timeSeriesTargets,
            defaultedRefIds,
            discardedQueries,
          } as CloudWatchMetricsDataQueryRequest,
          queryFn
        )
      );
    }

    if (promqlTargets.length) {
      responses.push(
        this.performTimeSeriesQuery(
          {
            ...options,
            requestId: options.requestId + '-promql',
            targets: promqlTargets,
            defaultedRefIds,
            discardedQueries,
          } as CloudWatchMetricsDataQueryRequest,
          queryFn
        )
      );
    }

    return responses.length === 1 ? responses[0] : merge(...responses);
  };

  interpolateMetricsQueryVariables(
    query: CloudWatchMetricsQuery,
    scopedVars: ScopedVars,
    range?: TimeRange
  ): CloudWatchMetricsQuery {
    const isValidDuration = query.interval && /^-?\d+(?:\.\d+)?(ms|[Mwdhmsy])?$/.test(query.interval);
    const queryIntervalMs = isValidDuration ? rangeUtil.intervalToMs(query.interval!) : 0;
    const intervalMs = Math.max(Number(scopedVars?.__interval_ms?.value) || 60000, queryIntervalMs);
    const intervalSeconds = Math.round(intervalMs / 1000);
    const interval = `${intervalSeconds}s`;
    const rateIntervalMs = Math.max(intervalMs, 60000);
    const rateIntervalSeconds = Math.round(rateIntervalMs / 1000);
    const rateInterval = `${rateIntervalSeconds}s`;
    const promQLScopedVars: ScopedVars = {
      ...scopedVars,
      __interval: { text: interval, value: interval },
      __interval_ms: { text: intervalMs, value: intervalMs },
      __rate_interval: { text: rateInterval, value: rateInterval },
      __rate_interval_ms: { text: rateIntervalMs, value: rateIntervalMs },
    };
    if (range) {
      const rangeMs = range.to.valueOf() - range.from.valueOf();
      const rangeSeconds = Math.round(rangeMs / 1000);
      promQLScopedVars.__range = { text: `${rangeSeconds}s`, value: `${rangeSeconds}s` };
      promQLScopedVars.__range_s = { text: rangeSeconds, value: rangeSeconds };
      promQLScopedVars.__range_ms = { text: rangeMs, value: rangeMs };
    }

    return {
      ...query,
      region: this.templateSrv.replace(this.getActualRegion(query.region), scopedVars),
      alias: this.templateSrv.replace(query.alias, scopedVars),
      metricName: this.replaceVariableAndDisplayWarningIfMulti(query.metricName, scopedVars, true, 'metric name'),
      namespace: this.replaceVariableAndDisplayWarningIfMulti(query.namespace, scopedVars, true, 'namespace'),
      period: String(this.getPeriod(query, scopedVars)),
      expression: this.templateSrv.replace(query.expression, scopedVars),
      sqlExpression: this.templateSrv.replace(query.sqlExpression, scopedVars, 'raw'),
      promqlExpression: query.promqlExpression
        ? this.templateSrv.replace(query.promqlExpression, promQLScopedVars)
        : query.promqlExpression,
      dimensions: this.convertDimensionFormat(query.dimensions ?? {}, scopedVars),
      statistic: this.templateSrv.replace(query.statistic, scopedVars),
      id: this.templateSrv.replace(query.id, scopedVars),
      accountId: query.accountId ? this.templateSrv.replace(query.accountId, scopedVars) : query.accountId,
    };
  }

  performTimeSeriesQuery(
    request: DataQueryRequest<CloudWatchQuery>,
    queryFn: (request: DataQueryRequest<CloudWatchQuery>) => Observable<DataQueryResponse>
  ): Observable<DataQueryResponse> {
    return queryFn(request).pipe(
      map((res) => {
        const dataframes: DataFrame[] = res.data || [];

        dataframes.forEach((frame) => {
          frame.fields.forEach((field) => {
            if (field.type === FieldType.time) {
              // field.config.interval is populated in order for Grafana to fill in null values at frame intervals.
              const period = frame.meta?.custom?.period;
              if (typeof period === 'number') {
                field.config.interval = period * 1000;
              }
            }
          });
        });

        if (res.errors?.length) {
          this.alertOnThrottlingErrors(res.errors, request);
        }

        const transformed = applyPromQLTransform({ ...res, data: dataframes }, request);
        const transformedData = transformed.data;

        // Maintain enrichThrottlingErrorMessages and ensure real AWS errors are never masked
        const enrichedErrors = [...(this.enrichThrottlingErrorMessages(request, res.errors) ?? [])];
        const existingErrorRefIds = new Set(enrichedErrors.map((e) => e.refId).filter(Boolean));

        const metricsReq = request as CloudWatchMetricsDataQueryRequest;
        const defaultedRefIds = new Set(metricsReq.defaultedRefIds ?? []);
        const discardedQueries = [...(metricsReq.discardedQueries ?? [])];

        // Also check request.targets directly in case performTimeSeriesQuery was called standalone
        for (const target of request.targets) {
          if (isCloudWatchMetricsQuery(target)) {
            if (!this.filterMetricQuery(target)) {
              if (!discardedQueries.some((d) => d.refId === target.refId)) {
                discardedQueries.push(target);
              }
            } else if (
              !target.metricQueryType ||
              !target.metricEditorMode ||
              !target.region ||
              target.region === 'default'
            ) {
              if (target.refId) {
                defaultedRefIds.add(target.refId);
              }
            }
          }
        }

        // Emit refId-scoped errors for any queries that were discarded as incomplete
        for (const discarded of discardedQueries) {
          const refId = discarded.refId;
          if (refId && !existingErrorRefIds.has(refId)) {
            existingErrorRefIds.add(refId);
            enrichedErrors.push({
              refId,
              message: `CloudWatch query "${refId}" is incomplete: missing required fields.`,
            });
          }
        }

        // For queries with defaulted or missing fields:
        const returnedFrameRefIds = new Set(transformedData.map((f) => f.refId).filter(Boolean));
        for (const refId of defaultedRefIds) {
          if (returnedFrameRefIds.has(refId)) {
            // Data was returned: emit non-blocking info notice in DataFrame.meta.notices
            for (const frame of transformedData) {
              if (frame.refId === refId) {
                const notice: QueryResultMetaNotice = {
                  severity: 'info',
                  text: `Query "${refId}" is using default query configuration.`,
                };
                frame.meta = {
                  ...frame.meta,
                  notices: [...(frame.meta?.notices ?? []), notice],
                };
              }
            }
          } else {
            // No data was returned: emit refId-scoped non-blocking notice/error so user does not see silent "No data"
            if (!existingErrorRefIds.has(refId)) {
              existingErrorRefIds.add(refId);
              enrichedErrors.push({
                refId,
                message: `Query "${refId}" returned no data with default configuration. Verify metric name, namespace, or region.`,
              });
            }
          }
        }

        return {
          data: transformedData,
          // DataSourceWithBackend will not throw an error, instead it will return "errors" field along with the response
          errors: enrichedErrors.length ? enrichedErrors : undefined,
        };
      }),
      catchError((err: unknown) => {
        if (Array.isArray(err)) {
          return of({ data: [], errors: err });
        } else {
          return of({ data: [], errors: [{ message: err }] });
        }
      })
    );
  }

  enrichThrottlingErrorMessages(request: DataQueryRequest<CloudWatchQuery>, errors?: DataQueryError[]) {
    if (!errors || errors.length === 0) {
      return errors;
    }
    const result: DataQueryError[] = [];
    errors.forEach((error) => {
      if (error.message && (/^Throttling:.*/.test(error.message) || /^Rate exceeded.*/.test(error.message))) {
        const region = this.getActualRegion(request.targets.find((target) => target.refId === error.refId)?.region);
        result.push({ ...error, message: getThrottlingErrorMessage(region, error.message) });
      } else {
        result.push(error);
      }
    });
    return result;
  }

  alertOnThrottlingErrors(errors: DataQueryError[], request: DataQueryRequest<CloudWatchQuery>) {
    const hasThrottlingError = errors.some(
      (err) => err.message && (/^Throttling:.*/.test(err.message) || /^Rate exceeded.*/.test(err.message))
    );
    if (hasThrottlingError) {
      const failedRefIds = errors.map((error) => error.refId).filter((refId) => refId);
      if (failedRefIds.length > 0) {
        const regionsAffected = Object.values(request.targets).reduce(
          (res: string[], { refId, region }) =>
            (refId && !failedRefIds.includes(refId)) || res.includes(region) ? res : [...res, region],
          []
        );
        regionsAffected.forEach((region) => {
          const actualRegion = this.getActualRegion(region);
          if (actualRegion) {
            this.debouncedThrottlingAlert(this.instanceSettings.name, actualRegion);
          }
        });
      }
    }
  }

  filterMetricQuery(query: CloudWatchMetricsQuery): boolean {
    return filterMetricsQuery(query);
  }

  getPeriod(target: CloudWatchMetricsQuery, scopedVars: ScopedVars) {
    let period = this.templateSrv.replace(target.period, scopedVars);
    if (period && period.toLowerCase() !== 'auto') {
      let p: number;
      if (/^\d+$/.test(period)) {
        p = parseInt(period, 10);
      } else {
        p = rangeUtil.intervalToSeconds(period);
      }

      if (p < 1) {
        p = 1;
      }

      return String(p);
    }

    return period;
  }
}
