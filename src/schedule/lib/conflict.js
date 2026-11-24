// What to ask when two people changed the same thing in a schedule.
import { confirmModal, formModal } from '../../modal';
import { CATEGORIES } from '../../../lib/schedule-style';

function describe(v) {
  if (typeof v === 'string') return v;
  const color = (c) => CATEGORIES.find((x) => [x.base, x.half].some((h) => h?.toLowerCase() === String(c).toLowerCase()))?.label ?? c;
  const text = Object.entries(v ?? {})
    .map(([k, x]) => (k === 'color' ? color(x) : k === 'type' ? '' : Array.isArray(x) ? x.join(', ') : x && typeof x === 'object' ? x.code ?? '' : x ?? ''))
    .filter((x) => x !== '')
    .join(' – ')
    .replace(/\s+/g, ' ');
  return text.length > 90 ? `${text.slice(0, 89)}…` : text || 'empty';
}

/** Asks which side to keep for each conflict. Resolves { key: 'mine' | 'theirs' }, or null when closed without choosing. */
export async function askConflicts(title, conflicts) {
  const options = conflicts.map((c) => [`Keep mine: ${describe(c.mine)}`, `Use theirs: ${describe(c.theirs)}`]);
  const picked = await formModal({
    title: `${title || 'This schedule'}: someone else changed the same thing. Everything else has been combined.`,
    fields: conflicts.map((c, i) => ({ label: c.label, value: options[i][0], options: options[i], single: true, required: true })),
    confirm: 'Save',
  });
  return picked && Object.fromEntries(conflicts.map((c, i) => [c.key, picked[i] === options[i][1] ? 'theirs' : 'mine']));
}

/** Someone deleted the schedule being edited: whether to save it again. */
export const askDeleted = (title) =>
  confirmModal({ title: `${title || 'This schedule'} was deleted`, body: 'Someone else deleted this schedule while you were editing it. Save it again with your changes?', confirm: 'Save it again' });
