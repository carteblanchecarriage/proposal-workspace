// What to ask when two people changed the same thing in a schedule.
import { confirmModal, formModal, noticeModal } from '../../modal';
import { CATEGORIES } from '../../../lib/schedule-style';

function describe(v) {
  if (typeof v === 'string') return v;
  // A fee's budget, or its summary lines.
  if (v?.budget) return v.budget.by === 'area' ? `${v.budget.area ?? '?'} SF × $${v.budget.costPerSf ?? '?'}` : v.budget.amount != null ? `$${v.budget.amount.toLocaleString('en-US')}` : 'empty';
  if (v?.draft) v = { lines: v.draft.assumptions ?? [] };
  if (v && 'targetFromCurve' in v) v = { targetPercent: v.targetPercent };
  const color = (c) => CATEGORIES.find((x) => [x.base, x.half].some((h) => h?.toLowerCase() === String(c).toLowerCase()))?.label ?? c;
  const text = Object.entries(v ?? {})
    .map(([k, x]) => (k === 'color' ? color(x) : k === 'type' ? '' : Array.isArray(x) ? x.join(', ') : x && typeof x === 'object' ? x.code ?? '' : typeof x === 'number' ? x.toLocaleString('en-US') : x ?? ''))
    .filter((x) => x !== '')
    .join(' – ')
    .replace(/\s+/g, ' ');
  return text.length > 90 ? `${text.slice(0, 89)}…` : text || 'empty';
}

/** Asks which side to keep for each conflict. Resolves { key: 'mine' | 'theirs' }, or null when closed without choosing. */
export async function askConflicts(title, conflicts) {
  const options = conflicts.map((c) => [`Keep mine: ${describe(c.mine)}`, `Use theirs: ${describe(c.theirs)}`]);
  const picked = await formModal({
    title: `${title || 'This'}: someone else changed the same thing. Everything else has been combined.`,
    fields: conflicts.map((c, i) => ({ label: c.label, value: options[i][0], options: options[i], single: true, required: true })),
    confirm: 'Save',
  });
  return picked && Object.fromEntries(conflicts.map((c, i) => [c.key, picked[i] === options[i][1] ? 'theirs' : 'mine']));
}

/** Someone deleted the schedule being edited: whether to save it again. */
export const askDeleted = (title) =>
  confirmModal({ title: `${title || 'This'} was deleted`, body: 'Someone else deleted this while you were editing it. Save it again with your changes?', confirm: 'Save it again' });

/** The schedule being edited was deleted and another made in its place. */
export const tellReplaced = (title) =>
  noticeModal(`${title || 'This schedule'} was replaced`, 'Someone else deleted this schedule and made a new one for the project. The new one is shown; your last change was to the old one.');
