<script>
  // The organization's schedule style (colors, font, Today line), on the Organization page. Global, so it reads as
  // text until Edit; changes are a draft (previewed here) until Save changes, and Cancel throws them away.
  import { onMount } from 'svelte';
  import { CATEGORIES, BADGES, FONTS, STANDARD_COLORS, palette, options, cleanPalette, cleanOptions, loadFont } from '../lib/palette.js';
  import { getScheduleStyle, saveScheduleStyle } from '../../store';
  import { DEFAULT_SCHEDULE_CONVENTIONS, MAX_CONVENTIONS, checkConventions } from '../../../lib/schedule-style';
  import { confirmModal, noticeModal } from '../../modal';
  import { setScheduleNotes } from '../../org';
  import { esc } from '../../table';

  let loaded = $state(false);
  // Couldn't read the saved style: editing stays off, so the standard look can't be saved over the real one.
  let loadFailed = $state(false);
  // The organization's schedule conventions for the AI (unset: the starting ones).
  let conventions = $state(undefined);
  // The notes every new schedule starts with, one per line (unset: none).
  let notes = $state('');
  const MAX_NOTES = 2_000;
  const noteLines = (t) => (t ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const conventionsText = (c) => (c ?? DEFAULT_SCHEDULE_CONVENTIONS);
  onMount(async () => {
    try {
      const s = await getScheduleStyle();
      palette.set(cleanPalette(s.colors));
      options.set(cleanOptions(s));
      conventions = s.conventions;
      notes = s.notes ?? '';
    } catch {
      loadFailed = true;
    }
    loaded = true;
  });
  // Escape leaves editing without saving, like Cancel (a dialog on top handles its own Escape first).
  function onKey(e) {
    if (e.key === 'Escape' && draft && !saving && !document.querySelector('dialog[open]')) cancelEditing();
  }
  // The font sample needs the font itself (Google fonts load on demand; Barlow and Inter are the site's own).
  $effect(() => { if (draft?.font) loadFont(draft.font); });

  let draft = $state(null); // { colors, font, showToday } while editing, else null
  let styleStatus = $state('');
  let styleError = $state(false);
  let saving = $state(false);
  // The whole group (its panel on the Organization page) shows it's being edited.
  let rootEl = $state(null);
  $effect(() => { rootEl?.closest('.settings-group')?.classList.toggle('editing', !!draft); });
  const startEditing = () => {
    draft = { colors: { ...$palette }, ...$options, conventions: conventionsText(conventions), notes };
    styleStatus = '';
  };
  const cancelEditing = () => { draft = null; };
  const pick = (key, hex) => { draft.colors = { ...draft.colors, [key]: hex.toUpperCase() }; };
  const standard = (key) => { const { [key]: _, ...rest } = draft.colors; draft.colors = rest; };
  async function saveStyle() {
    const colors = cleanPalette(draft.colors);
    const opts = cleanOptions(draft);
    // Kept only when it differs from the starting conventions, so an untouched one follows improvements to those.
    const text = (draft.conventions ?? '').trim();
    const own = text === DEFAULT_SCHEDULE_CONVENTIONS.trim() ? undefined : text;
    const ownNotes = noteLines(draft.notes).join('\n');
    if (ownNotes.length > MAX_NOTES) return noticeModal('Default notes are too long', `Keep them under ${MAX_NOTES.toLocaleString('en-US')} characters.`);
    // Guardrails: what can't be saved, and what the assistant would ignore (shown so it can be fixed first).
    const { errors, warnings } = text === conventionsText(conventions).trim() ? { errors: [], warnings: [] } : checkConventions(text);
    if (errors.length) return noticeModal('Schedule conventions need a change', errors.join(' '));
    if (warnings.length) {
      const ok = await confirmModal({
        title: 'Check the schedule conventions',
        body: '',
        html: `<ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul><p>Save anyway, or go back and fix them? The assistant ignores these parts either way.</p>`,
        confirm: 'Save anyway',
      });
      if (!ok) return;
    }
    saving = true;
    styleError = false;
    styleStatus = 'Saving…';
    try {
      await saveScheduleStyle({ colors, ...opts, ...(own === undefined ? {} : { conventions: own }), ...(ownNotes ? { notes: ownNotes } : {}) });
      palette.set(colors);
      options.set(opts);
      conventions = own;
      notes = ownNotes;
      setScheduleNotes(ownNotes);
      draft = null;
      styleStatus = 'Saved. Every schedule now uses these.';
    } catch (err) {
      styleError = true;
      styleStatus = err.message;
    } finally {
      saving = false;
    }
  }
  const colorOf = (key, base) => (draft ? draft.colors[key] : $palette[key]) ?? STANDARD_COLORS[key] ?? base;
  const isSet = (key) => !!(draft ? draft.colors[key] : $palette[key]);
  const fontLabel = (key) => FONTS.find((f) => f.key === key)?.label ?? FONTS[0].label;
</script>

<svelte:window onkeydown={onKey} />

{#if loaded}
  <div class="colors" bind:this={rootEl}>
    <div class="settings-head">
      <div>
        <h3 class="style-head">Schedules</h3>
      </div>
      {#if draft}<span class="settings-editing">Editing: saved together</span>{:else if !loadFailed}<button class="btn" onclick={startEditing}>Edit schedule settings</button>{/if}
    </div>
    {#if loadFailed}<p class="status error">Couldn't load your saved schedule settings. Reload the page to edit them.</p>{/if}
    <p class="intro">How your organization's schedules look. These apply to every schedule, so changes only take effect when you save them.</p>

    <section class="part">
    <h4 class="settings-sub">Colors</h4>
    <p class="part-hint">How each kind of bar and legend marker is drawn.</p>
    <ul>
      {#each [...CATEGORIES, ...BADGES] as c, i (c.key)}
        {@const current = colorOf(c.key, c.base)}
        <li class:badge-first={i === CATEGORIES.length}>
          {#if draft}
            <label class="swatch" title="Choose a color for {c.label}">
              <input type="color" value={current} onchange={(e) => pick(c.key, e.currentTarget.value)} aria-label="{c.label} color" />
            </label>
          {:else}
            <span class="swatch" style:background={current}></span>
          {/if}
          <span class="name"><b>{c.label}</b> <span class="hint">{c.hint}</span></span>
          {#if BADGES.includes(c)}
            {#if c.key === 'approval'}
              <span class="sample diamond" style:background={current}></span>
            {:else}
              <span class="sample badge" class:round={c.key === 'deliverable'} style:background={current}>{c.key === 'milestone' ? 'BK' : c.key === 'deliverable' ? '1' : 'SD'}</span>
            {/if}
          {:else}
            <span class="sample" style:background={current}></span>
          {/if}
          {#if draft && isSet(c.key)}
            <button class="link" onclick={() => standard(c.key)}>Use standard</button>
          {:else}
            <span class="std">{isSet(c.key) ? 'Custom' : c.key === 'estimate' ? 'Each item’s own' : 'Standard'}</span>
          {/if}
        </li>
      {/each}
    </ul>
    </section>

    <section class="part">
    <h4 class="settings-sub">Font and Today line</h4>
    <dl class="opts">
      <dt>Font</dt>
      <dd>
        {#if draft}
          <select bind:value={draft.font} aria-label="Schedule font">
            {#each FONTS as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
          </select>
          <span class="font-sample" style:font-family={FONTS.find((f) => f.key === draft.font)?.stack}>Schematic Design · Mar 2027</span>
        {:else}
          {fontLabel($options.font)}
        {/if}
      </dd>
      <dt>Today line</dt>
      <dd>
        {#if draft}
          <label class="check"><input type="checkbox" bind:checked={draft.showToday} /> Show today's date on schedules by default</label>
        {:else}
          {$options.showToday ? 'Shown by default' : 'Hidden by default'}
        {/if}
      </dd>
    </dl>
    </section>

    <section class="part">
      <h4 class="settings-sub">Default notes</h4>
      <p class="part-hint">Added to every new schedule. Existing schedules keep their own notes.</p>
      {#if draft}
        <textarea rows="4" bind:value={draft.notes} maxlength={MAX_NOTES} placeholder="One note per line" aria-label="Default schedule notes"></textarea>
        <span class="std">One note per line</span>
      {:else if noteLines(notes).length}
        <ol class="notes">{#each noteLines(notes) as n, i (i)}<li><span class="note-num">{i + 1}.</span><span>{n}</span></li>{/each}</ol>
      {:else}
        <p class="empty">None. New schedules start without notes.</p>
      {/if}
    </section>

    <section class="part">
      <h4 class="settings-sub">Conventions for the AI</h4>
      <p class="part-hint">What the AI follows when it drafts or changes a schedule.</p>
      {#if draft}
        <textarea rows="16" bind:value={draft.conventions} maxlength={MAX_CONVENTIONS} aria-label="Schedule conventions"></textarea>
        <span class="std">{(draft.conventions ?? '').length.toLocaleString('en-US')} of {MAX_CONVENTIONS.toLocaleString('en-US')} characters</span>
        <button class="link" onclick={() => { draft.conventions = DEFAULT_SCHEDULE_CONVENTIONS; }} disabled={saving}>Use the starting conventions</button>
      {:else}
        {#if conventionsText(conventions).trim()}<pre>{conventionsText(conventions)}</pre>{:else}<p class="empty">None. The assistant uses general scheduling practice.</p>{/if}
        <span class="std">{conventions === undefined ? 'Starting conventions' : 'Your own'}</span>
      {/if}
    </section>

    {#if draft}
      <div class="actions">
        <button class="btn primary" onclick={saveStyle} disabled={saving}>Save schedule settings</button>
        <button class="btn" onclick={cancelEditing} disabled={saving}>Cancel</button>
        <button class="link" onclick={() => { draft = { colors: {}, ...cleanOptions({}), conventions: DEFAULT_SCHEDULE_CONVENTIONS, notes: '' }; }} disabled={saving}>Reset everything to standard</button>
      </div>
    {/if}
    <span class="status" class:error={styleError}>{styleStatus}</span>
  </div>
{/if}

<style>
  .colors { max-width: 760px; }
  .style-head { font-size: 15px; font-weight: 700; margin: 0 0 4px; }
  .colors .intro { margin: 0 0 12px; font-size: 14px; }
  .colors ul { list-style: none; margin: 0 0 8px; padding: 0; }
  .colors li { display: grid; grid-template-columns: 36px minmax(0, 1fr) 120px 110px; align-items: center; gap: 14px; padding: 8px 0; border-bottom: 1px solid var(--rule); }
  .colors .swatch { width: 32px; height: 32px; border: 1px solid var(--ink); display: block; cursor: pointer; overflow: hidden; }
  .colors .swatch input { width: 48px; height: 48px; margin: -8px; border: 0; padding: 0; cursor: pointer; }
  .colors .name { min-width: 0; }
  .colors .hint { display: block; font-size: 13px; }
  .colors .sample { height: 14px; }
  .colors .std { font-size: 13px; }
  .colors li > .link, .colors li > .std { white-space: nowrap; justify-self: start; }
  .colors .edit-link { margin-left: 8px; font-size: 13px; font-weight: 400; }
  .colors li.badge-first { margin-top: 16px; border-top: 1px solid var(--rule); }
  .colors .sample.round { width: 18px; }
  .colors .sample.diamond { width: 11px; height: 11px; transform: rotate(45deg); margin-left: 4px; justify-self: start; }
  .colors .sample.badge { height: 18px; width: 30px; border-radius: 9px; color: #fff; font-size: 10px; font-weight: 700; line-height: 18px; text-align: center; justify-self: start; }
  .colors .opts { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 10px 14px; margin: 0 0 12px; font-size: 14px; }
  .colors .opts dt { font-weight: 700; }
  .colors .opts dd { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
  .colors select { font: inherit; padding: 5px 8px; border: 1px solid var(--ink); background: var(--bg); }
  .colors .font-sample { font-size: 16px; }
  .colors .check { display: inline-flex; align-items: center; gap: 8px; }
  .colors .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 8px; }
  .colors .status { display: block; margin-top: 8px; font-size: 13px; text-transform: none; letter-spacing: normal; }
  .colors .status.error { color: var(--bad); }
  /* Each part: a divider, its heading and one-line hint, then its content, evenly spaced. */
  .colors .part { border-top: 1px solid var(--rule); padding: 16px 0 12px; }
  .colors .part :global(.settings-sub) { margin: 0 0 2px; }
  .colors .part-hint { margin: 0 0 10px; font-size: 13px; }
  .colors .part ul, .colors .part .opts { margin-bottom: 0; }
  .colors .empty { margin: 0; font-size: 14px; }
  .colors .part pre { white-space: pre-wrap; font: inherit; font-size: 14px; line-height: 1.5; margin: 0 0 6px; padding: 10px 12px; background: var(--soft); }
  /* Numbered rows like the color rows: the number in its own column, a rule between notes. */
  .colors .notes { list-style: none; margin: 0; padding: 0; font-size: 14px; line-height: 1.5; border-top: 1px solid var(--rule); }
  .colors .notes li { grid-template-columns: 24px minmax(0, 1fr); align-items: start; gap: 8px; padding: 7px 0; }
  .colors .note-num { font-weight: 700; text-align: right; }
  .colors .part textarea { width: 100%; font: inherit; font-size: 14px; line-height: 1.5; padding: 8px 10px; border: 1px solid var(--ink); resize: vertical; margin-bottom: 6px; }
  @media (max-width: 640px) {
    .colors li { grid-template-columns: 36px minmax(0, 1fr) auto; }
    .colors .sample { display: none; }
  }
</style>
