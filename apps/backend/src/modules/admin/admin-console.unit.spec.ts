/**
 * Unit tests for the administration console's pure pieces.
 *
 * These cover the rules that can be wrong without a database: the failure
 * classification that keeps provider text out of the API, the URL reduction that
 * makes "a host at most" true, and the metrics aggregation that decides what an
 * operator is told.
 */
import { describe, expect, it } from 'vitest';
import { classifyIngestError, hostOfUrl, toFailureClass } from './admin-console.service.js';
import { MergedMetrics, collectAdminMetrics, emptyMetricsView, playbackCounters } from './admin-metrics.js';
import { Metrics } from '../../server/middleware.js';

describe('toFailureClass', () => {
  it('reports "none" for a source that never failed', () => {
    expect(toFailureClass(null)).toBe('none');
    expect(toFailureClass(undefined)).toBe('none');
    expect(toFailureClass('')).toBe('none');
    expect(toFailureClass('none')).toBe('none');
    /* A degraded check is not a failure of the stream; the stream still plays. */
    expect(toFailureClass('degraded')).toBe('none');
  });

  it('maps the engine vocabulary onto the console vocabulary', () => {
    expect(toFailureClass('timeout')).toBe('timeout');
    expect(toFailureClass('invalid-manifest')).toBe('invalid-manifest');
    expect(toFailureClass('missing-segments')).toBe('missing-segments');
    expect(toFailureClass('unsupported-format')).toBe('unsupported-format');
    expect(toFailureClass('http-404')).toBe('http-error');
    expect(toFailureClass('http-403')).toBe('http-error');
    expect(toFailureClass('http-5xx')).toBe('http-error');
    expect(toFailureClass('dns-failure')).toBe('unreachable');
    expect(toFailureClass('tls-failure')).toBe('unreachable');
    expect(toFailureClass('connection-refused')).toBe('unreachable');
    expect(toFailureClass('unreachable')).toBe('unreachable');
  });

  it('never invents specificity it does not have', () => {
    /* An unknown category becomes "unknown", not a plausible-sounding failure. */
    expect(toFailureClass('something-new')).toBe('unknown');
  });
});

describe('hostOfUrl', () => {
  it('reduces a URL to its host and drops everything that can carry a secret', () => {
    expect(hostOfUrl('https://cdn.example.com/live/index.m3u8?token=SECRET#frag')).toBe('cdn.example.com');
    expect(hostOfUrl('http://EXAMPLE.com:8080/path')).toBe('example.com');
  });

  it('returns null instead of echoing an unparseable value', () => {
    expect(hostOfUrl(null)).toBeNull();
    expect(hostOfUrl('')).toBeNull();
    expect(hostOfUrl('not a url with secret')).toBeNull();
  });
});

describe('classifyIngestError', () => {
  it('classifies without ever returning the message', () => {
    const message = 'fetch failed for https://hidden.example.com/guide.xml?token=abc';
    const classified = classifyIngestError(message);
    expect(classified).toBe('failed');
    expect(classified).not.toContain('hidden.example.com');
    expect(classified).not.toContain('token');
  });

  it('recognises the categories an operator can act on', () => {
    expect(classifyIngestError('Egress guard refused the request')).toBe('egress-refused');
    expect(classifyIngestError('The operation timed out')).toBe('timeout');
    expect(classifyIngestError('upstream returned HTTP 404')).toBe('http-client-error');
    expect(classifyIngestError('upstream returned HTTP 503')).toBe('http-server-error');
    expect(classifyIngestError('malformed XML feed')).toBe('invalid-guide');
  });
});

describe('collectAdminMetrics', () => {
  it('reports zeroes and no percentile when nothing was ever measured', () => {
    const result = collectAdminMetrics({
      metrics: emptyMetricsView(),
      databaseLatencyMs: 2,
      cacheEnabled: false,
      windowSeconds: 10,
    });
    expect(result.http.totalRequests).toBe(0);
    expect(result.http.errorRequests).toBe(0);
    /* Not measured is reported as 0 ms only because the schema is non-negative;
     * the absence itself is what an empty registry proves. */
    expect(result.http.p50Ms).toBe(0);
    expect(result.playback.descriptorsServed).toBe(0);
    expect(result.windowSeconds).toBe(10);
  });

  it('counts requests, their errors and the playback outcomes', () => {
    const metrics = new Metrics();
    metrics.increment('tdt_http_requests_total', { method: 'GET', route: '/channels', status: '2xx' });
    metrics.increment('tdt_http_requests_total', { method: 'GET', route: '/channels', status: '2xx' });
    metrics.increment('tdt_http_requests_total', { method: 'GET', route: '/nope', status: '4xx' });
    metrics.increment('tdt_http_requests_total', { method: 'GET', route: '/boom', status: '5xx' });
    metrics.observe('tdt_http_request_duration_ms', 12, { method: 'GET', route: '/channels' });
    metrics.observe('tdt_http_request_duration_ms', 800, { method: 'GET', route: '/channels' });
    const counters = playbackCounters(metrics);
    counters.descriptorServed('available');
    counters.descriptorServed('external');
    counters.refusedUnauthorised();

    const result = collectAdminMetrics({
      metrics,
      databaseLatencyMs: 3,
      cacheEnabled: true,
      windowSeconds: 60,
    });
    expect(result.http.totalRequests).toBe(4);
    expect(result.http.errorRequests).toBe(2);
    /* p50 falls in the 10 ms bucket, p95 in the 1000 ms bucket: bounded, honest. */
    expect(result.http.p50Ms).toBeGreaterThanOrEqual(10);
    expect(result.http.p50Ms).toBeLessThanOrEqual(25);
    expect(result.http.p95Ms).toBeGreaterThanOrEqual(500);
    expect(result.playback.descriptorsServed).toBe(2);
    expect(result.playback.refusedUnauthorised).toBe(1);
  });

  it('reports a null percentile rather than a fabricated number', () => {
    const metrics = new Metrics();
    metrics.increment('tdt_http_requests_total', { status: '2xx', method: 'GET', route: '/x' });
    expect(metrics.percentile('tdt_http_request_duration_ms', 0.95)).toBeNull();
  });
});

describe('MergedMetrics', () => {
  it('sums counters from both registries without double-counting families', () => {
    const http = new Metrics();
    const playback = new Metrics();
    http.increment('tdt_http_requests_total', { status: '2xx', method: 'GET', route: '/' });
    playbackCounters(playback).descriptorServed('available');

    const merged = new MergedMetrics(http, playback);
    expect(merged.counterTotal('tdt_http_requests_total')).toBe(1);
    expect(merged.counterTotal('tdt_playback_descriptors_total')).toBe(1);
    expect(merged.counterByLabel('tdt_http_requests_total', 'status').get('2xx')).toBe(1);
  });

  it('combines label sets that appear in only one registry', () => {
    const first = new Metrics();
    const second = new Metrics();
    first.increment('tdt_http_requests_total', { status: '2xx', method: 'GET', route: '/a' });
    second.increment('tdt_http_requests_total', { status: '4xx', method: 'GET', route: '/b' });
    const merged = new MergedMetrics(first, second);
    const byStatus = merged.counterByLabel('tdt_http_requests_total', 'status');
    expect(byStatus.get('2xx')).toBe(1);
    expect(byStatus.get('4xx')).toBe(1);
  });
});
