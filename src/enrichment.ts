
export type EnrichmentParams = Record<string, any>;

export interface EnrichmentProvider {
  id: string;
  ttlMs?: number;
  refreshIntervalMs?: number;
  init?: () => Promise<void> | void;
  refresh?: () => Promise<void> | void;
  resolve: (params: EnrichmentParams) => Promise<any>;
  cacheKey?: (params: EnrichmentParams) => string;
}

export interface EnrichmentGetOptions {
  cacheTtlMs?: number;
}

interface CacheEntry {
  value: any;
  expiresAt: number;
}

export class EnrichmentService {
  private providers = new Map<string, EnrichmentProvider>();
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<any>>();
  private refreshTimers: NodeJS.Timeout[] = [];

  constructor(providers: EnrichmentProvider[] = [], private defaultTtlMs = 60_000) {
    for (const p of providers) this.register(p);
  }

  register(provider: EnrichmentProvider) {
    this.providers.set(provider.id, provider);
  }

  unregister(id: string) {
    this.providers.delete(id);
    this.clearCache(id);
  }

  listProviders() {
    return Array.from(this.providers.values()).map((p) => ({
      id: p.id,
      ttlMs: p.ttlMs,
      refreshIntervalMs: p.refreshIntervalMs,
      hasRefresh: typeof p.refresh === 'function',
      hasInit: typeof p.init === 'function'
    }));
  }

  getProvider(id: string) {
    return this.providers.get(id);
  }

  cacheSize() {
    return this.cache.size;
  }

  clearCache(sourceId?: string) {
    if (!sourceId) {
      this.cache.clear();
      return;
    }
    const prefix = `${sourceId}:`;
    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  start() {
    for (const provider of this.providers.values()) {
      provider.init?.();
      if (provider.refreshIntervalMs && provider.refresh) {
        const timer = setInterval(() => provider.refresh?.(), provider.refreshIntervalMs);
        this.refreshTimers.push(timer);
      }
    }
  }

  stop() {
    for (const t of this.refreshTimers) clearInterval(t);
    this.refreshTimers = [];
  }

  async get(sourceId: string, params: EnrichmentParams, options: EnrichmentGetOptions = {}) {
    const provider = this.providers.get(sourceId);
    if (!provider) throw new Error(`unknown_enrichment_source:${sourceId}`);
    const key = this.buildCacheKey(provider, params);
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;

    const inflight = this.inflight.get(key);
    if (inflight) return inflight;

    const ttlMs = options.cacheTtlMs ?? provider.ttlMs ?? this.defaultTtlMs;
    const promise = provider.resolve(params)
      .then((value) => {
        if (ttlMs > 0) {
          this.cache.set(key, { value, expiresAt: now + ttlMs });
        }
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  private buildCacheKey(provider: EnrichmentProvider, params: EnrichmentParams) {
    if (provider.cacheKey) return `${provider.id}:${provider.cacheKey(params)}`;
    return `${provider.id}:${JSON.stringify(params)}`;
  }
}

export interface HttpGetProviderConfig {
  id: string;
  urlTemplate: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  ttlMs?: number;
  cacheKeyTemplate?: string;
}

export class HttpGetProvider implements EnrichmentProvider {
  id: string;
  ttlMs?: number;
  private urlTemplate: string;
  private headers?: Record<string, string>;
  private timeoutMs: number;
  private cacheKeyTemplate?: string;

  constructor(cfg: HttpGetProviderConfig) {
    this.id = cfg.id;
    this.urlTemplate = cfg.urlTemplate;
    this.headers = cfg.headers;
    this.timeoutMs = cfg.timeoutMs ?? 5000;
    this.ttlMs = cfg.ttlMs;
    this.cacheKeyTemplate = cfg.cacheKeyTemplate;
  }

  cacheKey(params: EnrichmentParams) {
    if (!this.cacheKeyTemplate) return this.buildUrl(params).url;
    return applyTemplate(this.cacheKeyTemplate, params);
  }

  async resolve(params: EnrichmentParams) {
    const { url } = this.buildUrl(params);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method: 'GET', headers: this.headers, signal: controller.signal });
      if (!res.ok) throw new Error(`http_${res.status}`);
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) return await res.json();
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  private buildUrl(params: EnrichmentParams) {
    const used = new Set<string>();
    const url = this.urlTemplate.replace(/\{([^}]+)\}/g, (_m, key) => {
      used.add(key);
      const val = params[key];
      return encodeURIComponent(val ?? '');
    });
    const queryPairs: string[] = [];
    for (const [k, v] of Object.entries(params)) {
      if (used.has(k)) continue;
      if (v === undefined || v === null) continue;
      queryPairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    const fullUrl = queryPairs.length ? `${url}${url.includes('?') ? '&' : '?'}${queryPairs.join('&')}` : url;
    return { url: fullUrl };
  }
}

export interface ListProviderConfig {
  id: string;
  list?: Record<string, any> | any[];
  listUrl?: string;
  listPath?: string;
  keyField?: string;
  valueField?: string;
  keyParam?: string;
  ttlMs?: number;
  refreshIntervalMs?: number;
}

export class ListProvider implements EnrichmentProvider {
  id: string;
  ttlMs?: number;
  refreshIntervalMs?: number;
  private listUrl?: string;
  private listPath?: string;
  private keyField?: string;
  private valueField?: string;
  private keyParam: string;
  private map = new Map<string, any>();

  constructor(cfg: ListProviderConfig) {
    this.id = cfg.id;
    this.listUrl = cfg.listUrl;
    this.listPath = cfg.listPath;
    this.keyField = cfg.keyField;
    this.valueField = cfg.valueField;
    this.keyParam = cfg.keyParam ?? 'key';
    this.ttlMs = cfg.ttlMs;
    this.refreshIntervalMs = cfg.refreshIntervalMs;
    if (cfg.list) this.setList(cfg.list);
  }

  async init() {
    if (this.listUrl) await this.refresh();
  }

  async refresh() {
    if (!this.listUrl) return;
    const res = await fetch(this.listUrl, { method: 'GET' });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const data = await res.json();
    const list = this.listPath ? getByPath(data, this.listPath) : data;
    this.setList(list);
  }

  async resolve(params: EnrichmentParams) {
    const key = params[this.keyParam] ?? firstParamValue(params);
    if (key === undefined || key === null) return null;
    return this.map.get(String(key)) ?? null;
  }

  private setList(list: Record<string, any> | any[]) {
    this.map.clear();
    if (Array.isArray(list)) {
      const keyField = this.keyField ?? 'id';
      for (const item of list) {
        const key = item?.[keyField];
        if (key === undefined || key === null) continue;
        const val = this.valueField ? item?.[this.valueField] : item;
        this.map.set(String(key), val);
      }
      return;
    }
    if (list && typeof list === 'object') {
      for (const [k, v] of Object.entries(list)) this.map.set(String(k), v);
    }
  }
}

export interface WebhookProviderConfig {
  id: string;
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  timeoutMs?: number;
  ttlMs?: number;
}

export class WebhookProvider implements EnrichmentProvider {
  id: string;
  ttlMs?: number;
  private url: string;
  private method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  private headers?: Record<string, string>;
  private timeoutMs: number;

  constructor(cfg: WebhookProviderConfig) {
    this.id = cfg.id;
    this.url = cfg.url;
    this.method = cfg.method ?? 'POST';
    this.headers = cfg.headers;
    this.timeoutMs = cfg.timeoutMs ?? 5000;
    this.ttlMs = cfg.ttlMs;
  }

  cacheKey(params: EnrichmentParams) {
    const { url, bodyKey } = this.buildRequest(params);
    return `${this.method}:${url}:${bodyKey}`;
  }

  async resolve(params: EnrichmentParams) {
    const { url, body, headers } = this.buildRequest(params);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: this.method,
        headers,
        body,
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`http_${res.status}`);
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) return await res.json();
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  private buildRequest(params: EnrichmentParams) {
    const { url, usedKeys } = buildUrlWithParams(this.url, params);
    const remaining: Record<string, any> = {};
    for (const [k, v] of Object.entries(params)) {
      if (usedKeys.has(k)) continue;
      if (v === undefined || v === null) continue;
      remaining[k] = v;
    }
    const isGet = this.method === 'GET' || this.method === 'DELETE';
    const finalUrl = isGet ? appendQuery(url, remaining) : url;
    const body = isGet ? undefined : JSON.stringify(remaining);
    const headers: Record<string, string> = {
      ...(this.headers || {})
    };
    if (!isGet) {
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }
    return {
      url: finalUrl,
      body,
      headers,
      bodyKey: body ?? ''
    };
  }
}

function getByPath(obj: any, path: string) {
  return path.split('.').reduce((acc, key) => acc?.[key], obj);
}

function firstParamValue(params: EnrichmentParams) {
  const keys = Object.keys(params);
  if (keys.length === 0) return undefined;
  return params[keys[0]];
}

function applyTemplate(template: string, params: EnrichmentParams) {
  return template.replace(/\{([^}]+)\}/g, (_m, key) => String(params[key] ?? ''));
}

function buildUrlWithParams(urlTemplate: string, params: EnrichmentParams) {
  const usedKeys = new Set<string>();
  const url = urlTemplate.replace(/\{([^}]+)\}/g, (_m, key) => {
    usedKeys.add(key);
    const val = params[key];
    return encodeURIComponent(val ?? '');
  });
  return { url, usedKeys };
}

function appendQuery(url: string, params: Record<string, any>) {
  const queryPairs: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    queryPairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  if (queryPairs.length === 0) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${queryPairs.join('&')}`;
}

export function createDefaultEnrichmentService() {
  const providers: EnrichmentProvider[] = [
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

  const service = new EnrichmentService(providers, 60_000);
  service.start();
  return service;
}
