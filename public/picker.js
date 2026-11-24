// The session, model and slash-command lists share the same rows and filtering.
export function renderChoices(container, choices, { query = '', empty = 'No matches.', onSelect } = {}) {
  container.onkeydown = event => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const items = [...container.querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  container.replaceChildren();
  const buttons = [];
  for (const choice of choices.filter(choice => words.every(word => `${choice.title} ${choice.description || ''} ${choice.search || ''}`.toLowerCase().includes(word)))) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = choice.title;
    button.disabled = Boolean(choice.disabled);
    button.dataset.value = choice.value;
    if (choice.selected) { button.classList.add('selected'); button.setAttribute('aria-current', 'true'); }
    if (choice.description) {
      const description = document.createElement('small'); description.textContent = choice.description;
      button.append(description);
    }
    button.onclick = () => onSelect?.(choice);
    container.append(button); buttons.push(button);
  }
  if (!buttons.length) {
    const message = document.createElement('p'); message.className = 'muted'; message.textContent = empty;
    container.append(message);
  }
  return buttons;
}
