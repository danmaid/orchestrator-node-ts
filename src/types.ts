
export interface OrchestratorEvent {
  id: string;
  timestamp: string; // ISO string
  source: string;
  topic: string;
  type?: string;
  payload: any;
  meta?: Record<string, any>;
}

export type ChannelName = 'inputs' | 'outputs' | 'workflows';

export type StepDefinition =
  | { type: 'filterEquals'; field: string; value: any }
  | { type: 'mapFields'; mapping: Record<string, string> }
  | { type: 'debounce'; ms: number }
  | { type: 'throttle'; ms: number }
  | { type: 'delay'; ms: number }
  | { type: 'branch'; branches: { when: { field: string; equals: any }, set?: Record<string, any>, outputTopic?: string }[], else?: { set?: Record<string, any>, outputTopic?: string } }
  | { type: 'setTopic'; topic: string }
  | { type: 'mergeWithTopics'; topics: string[] }
  | { type: 'raceTopics'; topics: string[], windowMs?: number }
  | { type: 'tapLog'; label?: string };

export interface WorkflowDefinition {
  id: string;
  name: string;
  enabled: boolean;
  description?: string;
  sourceTopics?: string[]; // if omitted, consume all inputs
  steps: StepDefinition[];
  outputTopic?: string;
  loopbackToInput?: boolean;
}
