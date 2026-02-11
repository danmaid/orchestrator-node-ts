
export interface OrchestratorEvent {
  id: string;
  timestamp: string; // ISO string
  source: string;
  topic: string;
  type?: string;
  payload: any;
  meta?: Record<string, any>;
}

export type InputType = 'webhook' | 'udp' | 'tail';

export type InputMode = 'raw' | 'aggregate';

export interface WebhookInputConfig {
  path?: string;
  method?: string;
  authToken?: string;
}

export interface UdpInputConfig {
  port: number;
  host?: string;
  codec?: 'utf8' | 'json' | 'raw';
}

export interface TailInputConfig {
  path: string;
  from?: 'start' | 'end';
  codec?: 'utf8' | 'json';
  pollIntervalMs?: number;
}

export type InputConfig = WebhookInputConfig | UdpInputConfig | TailInputConfig;

export interface InputDefinition {
  id: string;
  name: string;
  type: InputType;
  enabled: boolean;
  description?: string;
  workflowId?: string;
  topic?: string;
  source?: string;
  eventType?: string;
  mode?: InputMode;
  config: InputConfig;
}

export type ChannelName = 'inputs' | 'outputs' | 'workflows' | 'events';

export type LogicType = 'builtin' | 'embedded' | 'webhook';

export interface WebhookLogicConfig {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  timeoutMs?: number;
  ttlMs?: number;
}

export type LogicConfig = WebhookLogicConfig | Record<string, any> | undefined;

export interface LogicDefinition {
  id: string;
  name: string;
  type: LogicType;
  enabled: boolean;
  description?: string;
  config?: LogicConfig;
}

export type StepDefinition =
  | { type: 'filterEquals'; field: string; value: any }
  | { type: 'mapFields'; mapping: Record<string, string> }
  | { type: 'debounce'; ms: number }
  | { type: 'throttle'; ms: number }
  | { type: 'delay'; ms: number }
  | { type: 'aggregateCount'; windowMs: number; keyField?: string; outputTopic?: string; eventType?: string }
  | { type: 'branch'; branches: { when: { field: string; equals: any }, set?: Record<string, any>, outputTopic?: string }[], else?: { set?: Record<string, any>, outputTopic?: string } }
  | {
      type: 'enrich';
      sourceId: string;
      params: Record<string, string>;
      targetField?: string;
      errorField?: string;
      onError?: 'skip' | 'pass' | 'setError';
      cacheTtlMs?: number;
      concurrency?: number;
    }
  | {
      type: 'logic';
      logicId: string;
      params: Record<string, string>;
      targetField?: string;
      errorField?: string;
      onError?: 'skip' | 'pass' | 'setError';
      cacheTtlMs?: number;
      concurrency?: number;
    }
  | { type: 'setTopic'; topic: string }
  | { type: 'mergeWithTopics'; topics: string[] }
  | { type: 'raceTopics'; topics: string[], windowMs?: number }
  | { type: 'tapLog'; label?: string };

export type WorkflowOutputDefinition =
  | { type: 'topic'; topic?: string }
  | { type: 'loopback'; topic?: string };

export interface WorkflowDefinition {
  id: string;
  name: string;
  enabled: boolean;
  description?: string;
  sourceTopics?: string[]; // if omitted, consume all inputs
  steps: StepDefinition[];
  outputTopic?: string;
  loopbackToInput?: boolean; // legacy
  outputs?: WorkflowOutputDefinition[];
}
