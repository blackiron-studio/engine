// A bounded stack of snapshots for undo. Push a snapshot before a change; pop to get the
// state to restore. Games keep whatever shape suits them: a serialised save, a command, a
// diff. The stack forgets the oldest entries past its cap.

export class UndoStack<T> {
  private items: T[] = [];

  constructor(readonly cap = 20) {}

  get size(): number {
    return this.items.length;
  }

  get canUndo(): boolean {
    return this.items.length > 0;
  }

  /** Remember a snapshot; the oldest goes once the stack is full. */
  push(snapshot: T): void {
    this.items.push(snapshot);
    if (this.items.length > this.cap) this.items.shift();
  }

  /** The latest snapshot, removed from the stack. */
  pop(): T | undefined {
    return this.items.pop();
  }

  /** The latest snapshot, left in place. */
  peek(): T | undefined {
    return this.items[this.items.length - 1];
  }

  /** Forget everything, for the points of no return. */
  clear(): void {
    this.items.length = 0;
  }
}
