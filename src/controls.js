const BLOCKED = 'input, select, textarea, button, a, summary, [contenteditable], [role="textbox"], [role="slider"], [role="button"], dialog[open]';

// P toggles playback, G opens the go-card. DOM-free: every DOM touch is optional-chained for mocks.
export function shortcutAction(event, enabled) {
  if (!enabled || !event) return null;
  if (event.defaultPrevented || event.repeat || event.isComposing) return null;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  const target = event.target;
  if (target?.closest?.(BLOCKED)) return null;
  if (target?.ownerDocument?.querySelector?.('dialog[open]')) return null;
  const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
  if (key === 'p') return 'toggle';
  if (key === 'g') return 'card';
  return null;
}
