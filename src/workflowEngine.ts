
import { Observable, debounceTime, throttleTime, delay as rxDelay, filter, map, merge as rxMerge, race as rxRace, timer, takeUntil, tap, mergeMap, bufferTime, groupBy } from 'rxjs';
import { EventBus } from './eventBus';
import { EnrichmentService } from './enrichment';
import { OrchestratorEvent, StepDefinition, WorkflowDefinition, WorkflowOutputDefinition } from './types';

export class WorkflowEngine {
  private bus: EventBus;
  private workflows = new Map<string, { def: WorkflowDefinition, unsubscribe: () => void }>();
  private onOutput: (ev: OrchestratorEvent, outDef?: WorkflowOutputDefinition) => void;
  private onLoopback: (ev: OrchestratorEvent) => void;
  private onLifecycle?: (ev: any) => void;
  private enrichment: EnrichmentService;

  constructor(bus: EventBus, onOutput: (ev: OrchestratorEvent, outDef?: WorkflowOutputDefinition) => void, onLoopback: (ev: OrchestratorEvent) => void, onLifecycle?: (ev: any) => void, enrichment?: EnrichmentService) {
    this.bus = bus;
    this.onOutput = onOutput;
    this.onLoopback = onLoopback;
    this.onLifecycle = onLifecycle;
    this.enrichment = enrichment ?? new EnrichmentService();
  }

  list() { return Array.from(this.workflows.values()).map(w => w.def); }

  get(id: string) { return this.workflows.get(id)?.def; }

  upsert(def: WorkflowDefinition) {
    if (this.workflows.has(def.id)) {
      this.remove(def.id);
    }
    const unsub = this.build(def);
    this.workflows.set(def.id, { def, unsubscribe: unsub });
    this.onLifecycle?.({ kind: 'workflow-upserted', workflow: def });
  }

  remove(id: string) {
    const w = this.workflows.get(id);
    if (w) {
      w.unsubscribe();
      this.workflows.delete(id);
      this.onLifecycle?.({ kind: 'workflow-removed', id });
    }
  }

  enable(id: string, enabled: boolean) {
    const def = this.get(id);
    if (!def) return;
    def.enabled = enabled;
    this.upsert(def); // rebuild subscription
    this.onLifecycle?.({ kind: 'workflow-enabled', id, enabled });
  }

  private build(def: WorkflowDefinition): () => void {
    if (!def.enabled) {
      // dummy unsub
      return () => {};
    }

    let source$: Observable<OrchestratorEvent>;
    const acceptAllInputs = !!def.acceptAllInputs;
    if (def.sourceTopics && def.sourceTopics.length > 0) {
      const topicSet = new Set(def.sourceTopics);
      const byTopics$ = this.bus.mergeTopics(def.sourceTopics).pipe(
        filter(ev => acceptAllInputs || !ev.meta?.workflowId || ev.meta.workflowId === def.id)
      );
      const bound$ = this.bus.input$.pipe(
        filter(ev => (acceptAllInputs || ev.meta?.workflowId === def.id) && !topicSet.has(ev.topic))
      );
      source$ = rxMerge(byTopics$, bound$);
    } else {
      source$ = this.bus.input$.pipe(
        filter(ev => acceptAllInputs || !ev.meta?.workflowId || ev.meta.workflowId === def.id)
      );
    }

    // Prevent re-entry loops
    let stream$ = source$.pipe(
      map(ev => this.markVisited(ev, def.id)),
      filter((ev): ev is OrchestratorEvent => ev !== null)
    );

    // Apply steps
    for (const step of def.steps || []) {
      stream$ = this.applyStep(stream$, step, def);
    }

    const sub = stream$.subscribe((ev) => {
      const baseOut: OrchestratorEvent = {
        ...ev,
        type: ev.type || 'workflow_output',
        topic: ev.topic || def.outputTopic || 'outputs/default',
        meta: { ...(ev.meta || {}), workflowId: def.id }
      };

      const outputs = this.resolveOutputs(def);
      if (outputs.length === 0) {
        this.onOutput(baseOut);
        return;
      }

      outputs.forEach((outDef) => {
        const next: OrchestratorEvent = {
          ...baseOut,
          topic: outDef.topic || baseOut.topic
        };
        this.onOutput(next, outDef);
      });
    });

    return () => sub.unsubscribe();
  }

  private getByPath(obj: any, path: string) {
    return path.split('.').reduce((acc, key) => acc?.[key], obj);
  }

  private setDeep(obj: any, path: string, value: any) {
    const parts = path.split('.');
    let curr = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (typeof curr[k] !== 'object' || curr[k] === null) curr[k] = {};
      curr = curr[k];
    }
    curr[parts[parts.length - 1]] = value;
  }

  private applyStep(stream$: Observable<OrchestratorEvent>, step: StepDefinition, def: WorkflowDefinition): Observable<OrchestratorEvent> {
    switch (step.type) {
      case 'filterEquals': {
        const { field, value } = step;
        return stream$.pipe(filter(ev => this.getByPath(ev, field) === value));
      }
      case 'mapFields': {
        const { mapping } = step;
        return stream$.pipe(map(ev => {
          const newPayload: any = {};
          for (const [to, from] of Object.entries(mapping)) {
            this.setDeep(newPayload, to, this.getByPath(ev, from));
          }
          return { ...ev, payload: newPayload };
        }));
      }
      case 'debounce': {
        return stream$.pipe(debounceTime(step.ms));
      }
      case 'throttle': {
        return stream$.pipe(throttleTime(step.ms));
      }
      case 'delay': {
        return stream$.pipe(rxDelay(step.ms));
      }
      case 'aggregateCount': {
        const windowMs = step.windowMs;
        if (step.keyField) {
          return stream$.pipe(
            groupBy(ev => this.getByPath(ev, step.keyField!)),
            mergeMap(group$ =>
              group$.pipe(
                bufferTime(windowMs),
                filter(batch => batch.length > 0),
                map(batch => {
                  const last = batch[batch.length - 1];
                  return {
                    ...last,
                    type: step.eventType || 'aggregate_count',
                    topic: step.outputTopic || last.topic,
                    payload: {
                      count: batch.length,
                      key: group$.key,
                      windowMs,
                      windowStart: new Date(Date.now() - windowMs).toISOString(),
                      windowEnd: new Date().toISOString()
                    }
                  } as OrchestratorEvent;
                })
              )
            )
          );
        }
        return stream$.pipe(
          bufferTime(windowMs),
          filter(batch => batch.length > 0),
          map(batch => {
            const last = batch[batch.length - 1];
            return {
              ...last,
              type: step.eventType || 'aggregate_count',
              topic: step.outputTopic || last.topic,
              payload: {
                count: batch.length,
                windowMs,
                windowStart: new Date(Date.now() - windowMs).toISOString(),
                windowEnd: new Date().toISOString()
              }
            } as OrchestratorEvent;
          })
        );
      }
      case 'output': {
        const outTopic = step.topic || (step.target ? `output/${step.target}` : 'output');
        return stream$.pipe(tap(ev => {
          const baseOut: OrchestratorEvent = {
            ...ev,
            type: ev.type || 'workflow_output',
            topic: outTopic,
            meta: { ...(ev.meta || {}), workflowId: def.id }
          };
          this.onOutput(baseOut, { type: 'topic', topic: outTopic });
        }));
      }
      case 'enrich': {
        return this.applyLogicStep(stream$, {
          logicId: step.sourceId,
          params: step.params,
          targetField: step.targetField || `payload.enrichment.${step.sourceId}`,
          errorField: step.errorField || `payload.enrichmentErrors.${step.sourceId}`,
          onError: step.onError,
          cacheTtlMs: step.cacheTtlMs,
          concurrency: step.concurrency
        }, def);
      }
      case 'logic': {
        return this.applyLogicStep(stream$, step, def);
      }
      case 'setTopic': {
        return stream$.pipe(map(ev => ({ ...ev, topic: step.topic })));
      }
      case 'mergeWithTopics': {
        const add$ = this.bus.mergeTopics(step.topics);
        return rxMerge(stream$, add$);
      }
      case 'raceTopics': {
        const racers = step.topics.map(t => this.bus.topic$(t));
        let raced = rxRace(stream$, ...racers);
        if (step.windowMs && step.windowMs > 0) {
          raced = raced.pipe(takeUntil(timer(step.windowMs)));
        }
        return raced;
      }
      case 'tapLog': {
        return stream$.pipe(tap(ev => console.log(`[WF ${def.name}]`, step.label || 'tap', ev)));
      }
      case 'branch': {
        return stream$.pipe(tap(ev => {
          let matched = false;
          for (const b of step.branches) {
            const val = this.getByPath(ev, b.when.field);
            if (val === (b.when as any).equals) {
              matched = true;
              const branched = { ...ev, payload: { ...(ev.payload || {}), ...(b.set || {}) }, topic: b.outputTopic || ev.topic };
              this.onOutput({ ...branched, type: 'branch' });
            }
          }
          if (!matched && step.else) {
            const branched = { ...ev, payload: { ...(ev.payload || {}), ...(step.else.set || {}) }, topic: step.else.outputTopic || ev.topic };
            this.onOutput({ ...branched, type: 'branch-else' });
          }
        }));
      }
      default:
        return stream$;
    }
  }

  private applyLogicStep(stream$: Observable<OrchestratorEvent>, step: { logicId: string; params: Record<string, string>; targetField?: string; errorField?: string; onError?: 'skip' | 'pass' | 'setError'; cacheTtlMs?: number; concurrency?: number; }, def: WorkflowDefinition) {
    if (step.logicId === 'loopback') {
      return stream$.pipe(tap(ev => {
        const inEv: OrchestratorEvent = {
          ...ev,
          topic: 'input/loopback',
          meta: {
            ...(ev.meta || {}),
            loopback: true,
            loopbackFromTopic: ev.topic,
            loopbackFromWorkflow: def.id,
            inputId: 'loopback',
            inputType: 'loopback'
          }
        };
        this.onLoopback(inEv);
      }));
    }
    const targetField = step.targetField || `payload.logic.${step.logicId}`;
    const errorField = step.errorField || `payload.logicErrors.${step.logicId}`;
    const onError = step.onError || 'setError';
    const concurrency = step.concurrency ?? 4;
    return stream$.pipe(
      mergeMap(async (ev) => {
        const params: Record<string, any> = {};
        for (const [key, path] of Object.entries(step.params || {})) {
          params[key] = this.getByPath(ev, path);
        }
        try {
          const enriched = await this.enrichment.get(step.logicId, params, { cacheTtlMs: step.cacheTtlMs });
          const next = { ...ev, payload: { ...(ev.payload || {}) } };
          this.setDeep(next, targetField, enriched);
          return next;
        } catch (err: any) {
          if (onError === 'skip') return null;
          if (onError === 'pass') return ev;
          const next = { ...ev, payload: { ...(ev.payload || {}) } };
          this.setDeep(next, errorField, {
            message: err?.message || String(err),
            logicId: step.logicId,
            params
          });
          return next;
        }
      }, concurrency),
      filter((ev): ev is OrchestratorEvent => ev !== null)
    );
  }

  private markVisited(ev: OrchestratorEvent, workflowId: string): OrchestratorEvent | null {
    const visited = Array.isArray(ev.meta?._wfVisited) ? ev.meta!._wfVisited : [];
    if (visited.includes(workflowId)) return null;
    return {
      ...ev,
      meta: {
        ...(ev.meta || {}),
        _wfVisited: [...visited, workflowId]
      }
    };
  }

  private resolveOutputs(def: WorkflowDefinition): WorkflowOutputDefinition[] {
    if (Array.isArray(def.outputs) && def.outputs.length > 0) return def.outputs;
    const outputs: WorkflowOutputDefinition[] = [];
    outputs.push({ type: 'topic', topic: def.outputTopic });
    return outputs;
  }
}
