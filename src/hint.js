/**
 * The on-screen prompt (style.css #hint): a two-part chip, the input (TAP on phones, the E key on desktop)
 * and what it does ("Open Door", "Sit"). One for the whole game: set(text) each frame, null hides it.
 */
export function createHint() {
  const hint = document.createElement('div');
  hint.id = 'hint';
  const touch = document.body.classList.contains('touch');
  const key = document.createElement('span');
  key.className = touch ? 'hint-key tap' : 'hint-key';
  key.textContent = touch ? 'TAP' : 'E';
  const label = document.createElement('span');
  label.className = 'hint-label';
  hint.append(key, label);
  document.body.appendChild(hint);
  return (text) => {
    if (text && label.textContent !== text) label.textContent = text;
    hint.classList.toggle('show', !!text);
  };
}
