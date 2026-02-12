export type CoreBusHandler<T> = (ev: T) => void;

export type CoreBusQueuePolicy = {
  mode: 'sync' | 'queue';
  maxSize?: number;
  drop?: 'oldest' | 'newest';
};

interface TopicState<T> {
  handlers: Set<CoreBusHandler<T>>;
  queue: T[];
  draining: boolean;
  policy: CoreBusQueuePolicy;
}

export class CoreBus<T> {
  private topics = new Map<string, TopicState<T>>();
  private anyHandlers = new Set<CoreBusHandler<T>>();
  private defaultPolicy: CoreBusQueuePolicy = { mode: 'sync' };

  subscribe(topic: string, handler: CoreBusHandler<T>): () => void {
    const state = this.getOrCreateTopic(topic);
    state.handlers.add(handler);
    return () => {
      state.handlers.delete(handler);
    };
  }

  subscribeAny(handler: CoreBusHandler<T>): () => void {
    this.anyHandlers.add(handler);
    return () => {
      this.anyHandlers.delete(handler);
    };
  }

  setPolicy(topic: string, policy: CoreBusQueuePolicy) {
    const state = this.getOrCreateTopic(topic);
    state.policy = policy;
  }

  publish(topic: string, ev: T) {
    const state = this.getOrCreateTopic(topic);
    if (state.policy.mode === 'queue') {
      this.enqueue(state, ev);
      this.scheduleDrain(state, topic);
      return;
    }
    this.dispatch(state, ev);
  }

  private dispatch(state: TopicState<T>, ev: T) {
    for (const h of state.handlers) {
      h(ev);
    }
    for (const h of this.anyHandlers) {
      h(ev);
    }
  }

  private enqueue(state: TopicState<T>, ev: T) {
    const maxSize = state.policy.maxSize ?? 1024;
    if (state.queue.length >= maxSize) {
      const drop = state.policy.drop ?? 'oldest';
      if (drop === 'oldest') {
        state.queue.shift();
      } else {
        return;
      }
    }
    state.queue.push(ev);
  }

  private scheduleDrain(state: TopicState<T>, topic: string) {
    if (state.draining) return;
    state.draining = true;
    setImmediate(() => this.drain(state, topic));
  }

  private drain(state: TopicState<T>, topic: string) {
    try {
      let next: T | undefined;
      while ((next = state.queue.shift())) {
        this.dispatch(state, next);
      }
    } finally {
      state.draining = false;
      if (state.queue.length > 0) {
        this.scheduleDrain(state, topic);
      }
    }
  }

  private getOrCreateTopic(topic: string): TopicState<T> {
    let state = this.topics.get(topic);
    if (!state) {
      state = {
        handlers: new Set<CoreBusHandler<T>>(),
        queue: [],
        draining: false,
        policy: { ...this.defaultPolicy }
      };
      this.topics.set(topic, state);
    }
    return state;
  }
}
