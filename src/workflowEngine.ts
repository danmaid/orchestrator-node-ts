
import { Observable, debounceTime, throttleTime, delay as rxDelay, filter, map, merge as rxMerge, race as rxRace, timer, takeUntil, tap, mergeMap } from 'rxjs';
import { EventBus } from './eventBus';
import { EnrichmentService } from './enrichment';
import { OrchestratorEvent, StepDefinition, WorkflowDefinition } from './types';

export class WorkflowEngine {
  private bus: EventBus;
  private workflows = new Map<string, { def: WorkflowDefinition, unsubscribe: () => void }>();
  private onOutput: (ev: OrchestratorEvent) => void;
  private onLoopback: (ev: OrchestratorEvent) => void;
  private onLifecycle?: (ev: any) => void;
  private enrichment: EnrichmentService;

  constructor(bus: EventBus, onOutput: (ev: OrchestratorEvent) => void, onLoopback: (ev: OrchestratorEvent) => void, onLifecycle?: (ev: any) => void, enrichment?: EnrichmentService) {
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
    if (def.sourceTopics && def.sourceTopics.length > 0) {
      source$ = this.bus.mergeTopics(def.sourceTopics);
    } else {
      source$ = this.bus.input$; // all inputs
    }

    // Apply steps
    let stream$ = source$;
    for (const step of def.steps || []) {
      stream$ = this.applyStep(stream$, step, def);
    }

    const sub = stream$.subscribe((ev) => {
      const out: OrchestratorEvent = {
        ...ev,
        type: ev.type || 'workflow_output',
        topic: ev.topic || def.outputTopic || 'outputs/default',
        meta: { ...(ev.meta || {}), workflowId: def.id }
      };
      this.onOutput(out);
      if (def.loopbackToInput) {
        this.onLoopback({ ...out, type: out.type || 'loopback' });
      }
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
      case 'enrich': {
        const targetField = step.targetField || `payload.enrichment.${step.sourceId}`;
        const errorField = step.errorField || `payload.enrichmentErrors.${step.sourceId}`;
        const onError = step.onError || 'setError';
        const concurrency = step.concurrency ?? 4;
        return stream$.pipe(
          mergeMap(async (ev) => {
            const params: Record<string, any> = {};
            for (const [key, path] of Object.entries(step.params || {})) {
              params[key] = this.getByPath(ev, path);
            }
            try {
              const enriched = await this.enrichment.get(step.sourceId, params, { cacheTtlMs: step.cacheTtlMs });
              const next = { ...ev, payload: { ...(ev.payload || {}) } };
              this.setDeep(next, targetField, enriched);
              return next;
            } catch (err: any) {
              if (onError === 'skip') return null;
              if (onError === 'pass') return ev;
              const next = { ...ev, payload: { ...(ev.payload || {}) } };
              this.setDeep(next, errorField, {
                message: err?.message || String(err),
                sourceId: step.sourceId,
                params
              });
              return next;
            }
          }, concurrency),
          filter((ev): ev is OrchestratorEvent => ev !== null)
        );
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
}
