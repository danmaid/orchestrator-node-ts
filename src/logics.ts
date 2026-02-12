import { EnrichmentService, EnrichmentProvider, HttpGetProvider, ListProvider } from './enrichment';
import { LogicDefinition } from './types';

export interface BuiltinProviderInfo {
  id: string;
  ttlMs?: number;
  refreshIntervalMs?: number;
  hasRefresh?: boolean;
}

export function buildBuiltinLogicDefinition(p: BuiltinProviderInfo): LogicDefinition {
  return {
    id: p.id,
    name: p.id,
    type: 'builtin',
    enabled: true,
    description: 'built-in provider',
    config: {
      ttlMs: p.ttlMs,
      refreshIntervalMs: p.refreshIntervalMs,
      refreshable: !!p.hasRefresh
    }
  } as LogicDefinition;
}

export function getBuiltinLogicDefinitions(providers: BuiltinProviderInfo[]): LogicDefinition[] {
  const defs = providers.map((p) => buildBuiltinLogicDefinition(p));
  const loopbackLogic: LogicDefinition = {
    id: 'loopback',
    name: 'loopback',
    type: 'builtin',
    enabled: true,
    description: 'built-in loopback logic',
    config: { target: 'input/loopback' }
  };
  defs.push(loopbackLogic);
  return defs;
}

export function getRxjsLogicDefinitions(): LogicDefinition[] {
  const rxjsSteps: Array<{ id: string; name: string; description: string; config: Record<string, any> }> = [
    {
      id: 'step/filterEquals',
      name: 'filterEquals',
      description: 'RxJS: filter events where field equals value',
      config: { stepType: 'filterEquals', example: { field: 'payload.status', value: 'ok' } }
    },
    {
      id: 'step/mapFields',
      name: 'mapFields',
      description: 'RxJS: map fields into a new payload',
      config: { stepType: 'mapFields', example: { mapping: { 'payload.userId': 'payload.user.id' } } }
    },
    {
      id: 'step/debounce',
      name: 'debounce',
      description: 'RxJS: debounce events by time',
      config: { stepType: 'debounce', example: { ms: 300 } }
    },
    {
      id: 'step/throttle',
      name: 'throttle',
      description: 'RxJS: throttle events by time',
      config: { stepType: 'throttle', example: { ms: 300 } }
    },
    {
      id: 'step/delay',
      name: 'delay',
      description: 'RxJS: delay events by time',
      config: { stepType: 'delay', example: { ms: 500 } }
    },
    {
      id: 'step/aggregateCount',
      name: 'aggregateCount',
      description: 'RxJS: windowed count aggregation',
      config: { stepType: 'aggregateCount', example: { windowMs: 1000, keyField: 'payload.deviceId' } }
    },
    {
      id: 'step/output',
      name: 'output',
      description: 'RxJS: emit to output topics',
      config: { stepType: 'output', example: { target: 'metrics' } }
    },
    {
      id: 'step/branch',
      name: 'branch',
      description: 'RxJS: conditional branching with optional else',
      config: { stepType: 'branch', example: { branches: [{ when: { field: 'payload.level', equals: 'warn' }, outputTopic: 'alerts/warn' }] } }
    },
    {
      id: 'step/setTopic',
      name: 'setTopic',
      description: 'RxJS: rewrite topic',
      config: { stepType: 'setTopic', example: { topic: 'events/normalized' } }
    },
    {
      id: 'step/mergeWithTopics',
      name: 'mergeWithTopics',
      description: 'RxJS: merge with other topics',
      config: { stepType: 'mergeWithTopics', example: { topics: ['topic/a', 'topic/b'] } }
    },
    {
      id: 'step/raceTopics',
      name: 'raceTopics',
      description: 'RxJS: race with other topics with optional window',
      config: { stepType: 'raceTopics', example: { topics: ['topic/a', 'topic/b'], windowMs: 1000 } }
    },
    {
      id: 'step/tapLog',
      name: 'tapLog',
      description: 'RxJS: log events for debugging',
      config: { stepType: 'tapLog', example: { label: 'debug' } }
    }
  ];

  return rxjsSteps.map((s) => ({
    id: s.id,
    name: s.name,
    type: 'embedded',
    enabled: true,
    description: s.description,
    config: s.config
  } as LogicDefinition));
}

export function createDefaultEnrichmentProviders(): EnrichmentProvider[] {
  return [
    new ListProvider({
      id: 'prefectures',
      list: {
        1: { code: 1, name: '北海道' },
        13: { code: 13, name: '東京都' },
        27: { code: 27, name: '大阪府' }
      },
      keyParam: 'code',
      ttlMs: 10 * 60 * 1000
    }),
    new HttpGetProvider({
      id: 'jsonplaceholder-user',
      urlTemplate: 'https://jsonplaceholder.typicode.com/users/{id}',
      ttlMs: 5 * 60 * 1000,
      timeoutMs: 4000
    })
  ];
}

export function createDefaultEnrichmentService() {
  const providers = createDefaultEnrichmentProviders();
  const service = new EnrichmentService(providers, 60_000);
  service.start();
  return service;
}
