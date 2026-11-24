// Svelte actions for the schedule's inline fields.

/**
 * A contenteditable text field. The action owns the text: Svelte's own text node is lost when a field is cleared, after
 * which the field would keep showing whatever was typed. Saves on leaving the field, and only if the text changed.
 * Escape puts the text back and leaves the field.
 */
export function editable(node, params) {
  let { value, onCommit } = params;
  let before = value ?? '';
  let focused = false;
  const show = () => {
    const v = value ?? '';
    // Elements left behind by the browser (a <br> in a cleared field, pasted formatting) go too.
    if (node.textContent !== v || node.firstElementChild) node.textContent = v;
  };
  const focus = () => { focused = true; before = node.textContent.trim(); };
  const blur = () => {
    focused = false;
    const text = node.textContent.trim();
    const changed = text !== before;
    // Not at once: a list re-sorting moves the field, which blurs it while the page is being redrawn.
    setTimeout(() => {
      if (changed) onCommit?.(text);
      // Once the store has answered, a refused or unchanged edit shows the saved text again.
      setTimeout(() => { if (!focused) show(); }, 0);
    }, 0);
  };
  const key = (e) => {
    if (e.key === 'Escape') { show(); before = node.textContent.trim(); node.blur(); }
  };
  node.addEventListener('focus', focus);
  node.addEventListener('blur', blur);
  node.addEventListener('keydown', key);
  show();
  return {
    update(next) {
      const changed = (next.value ?? '') !== (value ?? '');
      ({ value, onCommit } = next);
      // The field now shows something else (undo, the assistant, a re-sorted list): never save the old text over it.
      if (changed) { show(); before = node.textContent.trim(); }
    },
    destroy() {
      node.removeEventListener('focus', focus);
      node.removeEventListener('blur', blur);
      node.removeEventListener('keydown', key);
    },
  };
}

/**
 * A date input. A date picked from the calendar saves at once; a typed one saves on Enter or on leaving the field, so
 * half-typed dates (year 0002, month 1 on the way to 11) are never saved. onCommit returns false to refuse a date, and
 * the saved one is shown again. Escape puts the saved date back.
 */
export function dateField(node, params) {
  let { value, onCommit, defer = false } = params; // defer: in a list that re-sorts (as above)
  let typing = false;
  const show = () => { typing = false; node.value = value ?? ''; };
  const commit = () => {
    typing = false;
    // A half-filled or impossible date reads as empty; it isn't a request to clear the date.
    if (node.validity.badInput || (node.value !== (value ?? '') && onCommit(node.value) === false)) show();
    else if (node.value !== (value ?? '')) setTimeout(() => { if (!typing) show(); }, 0);
  };
  const key = (e) => {
    if (e.key === 'Escape') { show(); node.blur(); }
    else if (e.key === 'Enter') commit();
    else if (e.key !== 'Tab') typing = true;
  };
  const input = () => { if (!typing) commit(); };
  const press = () => { if (typing) commit(); }; // opening the calendar after typing
  const blur = () => {
    if (!typing) return;
    if (!defer) return commit();
    const typed = node.value;
    const bad = node.validity.badInput;
    typing = false;
    setTimeout(() => {
      if (bad || (typed !== (value ?? '') && onCommit(typed) === false)) show();
      else setTimeout(() => { if (!typing) show(); }, 0);
    }, 0);
  };
  node.addEventListener('keydown', key);
  node.addEventListener('input', input);
  node.addEventListener('pointerdown', press);
  node.addEventListener('blur', blur);
  show();
  return {
    update(next) {
      const changed = (next.value ?? '') !== (value ?? '');
      ({ value, onCommit } = next);
      if (changed) show();
    },
    destroy() {
      node.removeEventListener('keydown', key);
      node.removeEventListener('input', input);
      node.removeEventListener('pointerdown', press);
      node.removeEventListener('blur', blur);
    },
  };
}
