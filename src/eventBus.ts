
import { merge, Observable } from 'rxjs';
import { CoreBus, CoreBusQueuePolicy } from './coreBus';
import { OrchestratorEvent } from './types';

export class EventBus {
  private topicsBus = new CoreBus<OrchestratorEvent>();
  private inputBus = new CoreBus<OrchestratorEvent>();
  private outputBus = new CoreBus<OrchestratorEvent>();
  private metricsBus = new CoreBus<OrchestratorEvent>();

  public readonly input$ = new Observable<OrchestratorEvent>((subscriber) => {
    return this.inputBus.subscribeAny((ev) => subscriber.next(ev));
  });

  public readonly output$ = new Observable<OrchestratorEvent>((subscriber) => {
    return this.outputBus.subscribeAny((ev) => subscriber.next(ev));
  });

  public readonly metrics$ = new Observable<OrchestratorEvent>((subscriber) => {
    return this.metricsBus.subscribeAny((ev) => subscriber.next(ev));
  });

  topic$(name: string): Observable<OrchestratorEvent> {
    return new Observable<OrchestratorEvent>((subscriber) => {
      const bus = this.isMetricsTopic(name) ? this.metricsBus : this.topicsBus;
      return bus.subscribe(name, (ev) => subscriber.next(ev));
    });
  }

  mergeTopics(names: string[]): Observable<OrchestratorEvent> {
    const streams = names.map((n) => this.topic$(n));
    return merge(...streams);
  }

  publishInput(ev: OrchestratorEvent) {
    this.inputBus.publish(ev.topic, ev);
    if (this.isMetricsTopic(ev.topic)) {
      this.metricsBus.publish(ev.topic, ev);
    } else {
      this.topicsBus.publish(ev.topic, ev);
    }
  }

  publishOutput(ev: OrchestratorEvent) {
    if (this.isMetricsTopic(ev.topic)) {
      this.metricsBus.publish(ev.topic, ev);
      return;
    }
    this.outputBus.publish(ev.topic, ev);
    this.topicsBus.publish(ev.topic, ev);
  }

  publishInternalTopic(ev: OrchestratorEvent) {
    if (this.isMetricsTopic(ev.topic)) {
      this.metricsBus.publish(ev.topic, ev);
      return;
    }
    this.topicsBus.publish(ev.topic, ev);
  }

  setTopicPolicy(topic: string, policy: CoreBusQueuePolicy) {
    this.topicsBus.setPolicy(topic, policy);
  }

  setInputPolicy(topic: string, policy: CoreBusQueuePolicy) {
    this.inputBus.setPolicy(topic, policy);
  }

  setOutputPolicy(topic: string, policy: CoreBusQueuePolicy) {
    this.outputBus.setPolicy(topic, policy);
  }

  setMetricsPolicy(topic: string, policy: CoreBusQueuePolicy) {
    this.metricsBus.setPolicy(topic, policy);
  }

  private isMetricsTopic(topic: string) {
    return String(topic || '').startsWith('metrics/');
  }
}
