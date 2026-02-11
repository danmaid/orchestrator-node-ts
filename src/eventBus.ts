
import { Subject, merge, Observable } from 'rxjs';
import { OrchestratorEvent } from './types';

export class EventBus {
  private topics = new Map<string, Subject<OrchestratorEvent>>();
  public readonly input$ = new Subject<OrchestratorEvent>();
  public readonly output$ = new Subject<OrchestratorEvent>();

  topic$(name: string): Subject<OrchestratorEvent> {
    let s = this.topics.get(name);
    if (!s) { s = new Subject<OrchestratorEvent>(); this.topics.set(name, s); }
    return s;
  }

  mergeTopics(names: string[]): Observable<OrchestratorEvent> {
    const streams = names.map(n => this.topic$(n));
    return merge(...streams);
  }

  publishInput(ev: OrchestratorEvent) {
    this.input$.next(ev);
    this.topic$(ev.topic).next(ev);
  }

  publishOutput(ev: OrchestratorEvent) {
    this.output$.next(ev);
    this.topic$(ev.topic).next(ev);
  }
}
