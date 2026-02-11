
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private capacity: number;
  private head = 0; // next write index
  private count = 0;

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error('capacity must be > 0');
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  push(item: T) {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - this.count + i + this.capacity) % this.capacity;
      const val = this.buffer[idx];
      if (val !== undefined) result.push(val);
    }
    return result;
  }

  size() { return this.count; }
  maxSize() { return this.capacity; }
  clear() { this.head = 0; this.count = 0; this.buffer = new Array(this.capacity); }
}
