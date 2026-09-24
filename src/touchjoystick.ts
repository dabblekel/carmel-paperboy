import type { Walker } from './walker';

/** A small, fixed joystick that controls the same screen-relative walk input as the keys. */
export function bindTouchJoystick(button: HTMLButtonElement, getWalker: () => Walker | undefined): void {
  let activePointer: number | null = null;
  const thumb = button.querySelector<HTMLElement>('.touch-joystick-thumb')!;

  const release = () => {
    activePointer = null;
    thumb.style.transform = '';
    getWalker()?.setTouchDirection(0, 0);
  };
  const move = (event: PointerEvent) => {
    const rect = button.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) / 2 - thumb.offsetWidth / 2 - 5;
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const length = Math.hypot(dx, dy);
    const scale = length > radius ? radius / length : 1;
    const x = dx * scale;
    const y = dy * scale;
    thumb.style.transform = `translate(${x}px, ${y}px)`;
    const strength = length / radius < 0.12 ? 0 : Math.min(1, (length / radius - 0.12) / 0.88);
    getWalker()?.setTouchDirection((x / radius) * strength, (-y / radius) * strength);
  };

  button.addEventListener('pointerdown', (event) => {
    if (activePointer !== null) return;
    activePointer = event.pointerId;
    button.setPointerCapture(event.pointerId);
    move(event);
    event.preventDefault();
  });
  button.addEventListener('pointermove', (event) => {
    if (event.pointerId !== activePointer) return;
    move(event);
    event.preventDefault();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(type, (event) => {
      if ((event as PointerEvent).pointerId === activePointer) release();
    });
  }
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
}
