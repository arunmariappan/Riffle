/** Keyboard and mouse state shared by the camera modes. */
export class Input {
  readonly keys = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  private readonly element: HTMLElement;
  private readonly listeners: [EventTarget, string, EventListener][] = [];
  /** True while typing in a UI field, so movement keys don't fire. */
  uiFocused = false;

  constructor(element: HTMLElement) {
    this.element = element;
    this.on(window, 'keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (this.isTyping(ke)) return;
      this.keys.add(ke.code);
    });
    this.on(window, 'keyup', (e) => this.keys.delete((e as KeyboardEvent).code));
    this.on(window, 'blur', () => this.keys.clear());
    this.on(document, 'mousemove', (e) => {
      if (document.pointerLockElement === this.element) {
        this.mouseDX += (e as MouseEvent).movementX;
        this.mouseDY += (e as MouseEvent).movementY;
      }
    });
    this.on(element, 'wheel', (e) => {
      this.wheel += Math.sign((e as WheelEvent).deltaY);
    });
  }

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  private on(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn);
    this.listeners.push([target, type, fn]);
  }

  pressed(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  /** Mouse movement since the last call. */
  takeMouse(): [number, number] {
    const d: [number, number] = [this.mouseDX, this.mouseDY];
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  takeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  lockPointer(): void {
    if (document.pointerLockElement !== this.element) void this.element.requestPointerLock();
  }

  unlockPointer(): void {
    if (document.pointerLockElement === this.element) document.exitPointerLock();
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.element;
  }

  dispose(): void {
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
  }
}
