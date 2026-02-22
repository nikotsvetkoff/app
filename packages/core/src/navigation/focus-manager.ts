export type RemoteAction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'ENTER' | 'BACK' | 'MENU' | 'NONE';

export interface FocusItem {
  id: string;
  disabled?: boolean;
}

export class FocusManager {
  private index = 0;

  constructor(private items: FocusItem[] = []) {
    this.index = this.findNextEnabled(0, 1);
  }

  setItems(items: FocusItem[]): void {
    this.items = items;
    if (!this.items.length) {
      this.index = 0;
      return;
    }

    if (this.index >= this.items.length || this.items[this.index]?.disabled) {
      this.index = this.findNextEnabled(0, 1);
    }
  }

  getCurrent(): FocusItem | undefined {
    return this.items[this.index];
  }

  move(delta: 1 | -1): FocusItem | undefined {
    if (!this.items.length) {
      return undefined;
    }

    const candidate = this.findNextEnabled(this.index + delta, delta);
    this.index = candidate;
    return this.getCurrent();
  }

  private findNextEnabled(start: number, delta: 1 | -1): number {
    if (!this.items.length) {
      return 0;
    }

    let cursor = ((start % this.items.length) + this.items.length) % this.items.length;
    let visited = 0;

    while (visited < this.items.length) {
      if (!this.items[cursor]?.disabled) {
        return cursor;
      }
      cursor = (cursor + delta + this.items.length) % this.items.length;
      visited += 1;
    }

    return 0;
  }
}
