// Native popovers handle outside clicks, Escape, and the top layer.
export function closeVersionPickers() {
  for (const menu of document.querySelectorAll('.version-menu:popover-open')) menu.hidePopover();
}

export function createVersionPicker(choices, value, disabled, onSelect) {
  let selected = choices.find(choice => choice.value === value) || choices[0];
  const root = document.createElement('div'); root.className = 'version-picker';
  const trigger = document.createElement('button'); trigger.className = 'version-trigger';
  trigger.type = 'button'; trigger.disabled = disabled;
  trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-label', '下载版本');
  trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span'); label.className = 'version-label';
  const arrow = document.createElement('span'); arrow.textContent = '⌄'; arrow.setAttribute('aria-hidden', 'true');
  trigger.append(label, arrow);
  const menu = document.createElement('div'); menu.className = 'version-menu';
  menu.id = `versions-${crypto.randomUUID()}`;
  menu.setAttribute('popover', 'auto'); menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', '视频下载版本');
  trigger.setAttribute('aria-controls', menu.id);
  // Keep the native focus-return relationship while positioning explicitly.
  trigger.setAttribute('popovertarget', menu.id);
  const buttons = choices.map(choice => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'version-option';
    button.setAttribute('role', 'option'); button.setAttribute('aria-label', choice.label); button.tabIndex = -1;
    button.disabled = choice.item.kind === 'dash';
    const text = document.createElement('span'); text.textContent = choice.label;
    const mark = document.createElement('span'); mark.className = 'version-check'; mark.textContent = '✓'; mark.setAttribute('aria-hidden', 'true');
    button.append(text, mark);
    button.addEventListener('click', () => {
      selected = choice; update(); menu.hidePopover(); trigger.focus(); onSelect(choice);
    });
    menu.append(button); return button;
  });
  function update() {
    label.textContent = selected.label; trigger.title = selected.label;
    buttons.forEach((button, index) => button.setAttribute('aria-selected', String(choices[index] === selected)));
  }
  function open() {
    menu.showPopover();
    const rect = trigger.getBoundingClientRect();
    menu.style.width = `${Math.min(Math.max(220, rect.width), innerWidth - 24)}px`;
    const height = menu.getBoundingClientRect().height;
    const below = innerHeight - rect.bottom - 12;
    const top = below >= height ? rect.bottom + 6 : Math.max(12, rect.top - height - 6);
    menu.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - menu.offsetWidth - 12))}px`;
    menu.style.top = `${Math.min(top, innerHeight - height - 12)}px`;
    const active = buttons[choices.indexOf(selected)];
    (active?.disabled ? buttons.find(button => !button.disabled) : active)?.focus();
  }
  trigger.addEventListener('click', event => {
    event.preventDefault();
    if (menu.matches(':popover-open')) menu.hidePopover(); else open();
  });
  menu.addEventListener('beforetoggle', event => trigger.setAttribute('aria-expanded', String(event.newState === 'open')));
  root.addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!menu.matches(':popover-open')) { open(); return; }
      const enabled = buttons.filter(button => !button.disabled);
      const current = enabled.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 :
        (current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
      enabled[next]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault(); menu.hidePopover(); trigger.focus();
    } else if (event.key === 'Tab' && menu.matches(':popover-open')) menu.hidePopover();
  });
  update(); root.append(trigger, menu);
  return { root, get value() { return selected.value; } };
}

window.addEventListener('resize', closeVersionPickers);
document.addEventListener('scroll', event => {
  if (!event.target.closest?.('.version-menu')) closeVersionPickers();
}, true);
