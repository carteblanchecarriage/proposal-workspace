<script>
  // The Schedule tab: every schedule, in the site's own list style (the editor keeps the schedule maker's look).
  import { projectStore } from '../lib/stores/projects.js';
  import { SCHEDULE_TEMPLATES as TEMPLATES } from '../lib/data/templates.js';
  import { goto } from '../lib/nav.js';
  import { confirmDelete, formModal } from '../../modal';
  import { CATEGORIES, BADGES, FONTS, palette, options, cleanPalette, cleanOptions } from '../lib/palette.js';
  import { saveScheduleStyle } from '../../store';

  let projects = $state([]);
  projectStore.subscribe(v => { projects = v; });


  async function newSchedule() {
    const values = await formModal({
      title: 'New schedule',
      fields: [{ label: 'Start from', value: TEMPLATES[2].label, options: TEMPLATES.map((t) => t.label), single: true, required: true }],
      confirm: 'Make schedule',
    });
    const tpl = values && TEMPLATES.find((t) => t.label === values[0]);
    if (!tpl) return;
    const p = tpl.make();
    projectStore.addProject(p);
    goto(`/project/${p.id}`);
  }

  async function deleteSchedule(id) {
    if (await confirmDelete('schedule')) projectStore.deleteProject(id);
  }

  function fmtDate(str) {
    if (!str) return '';
    const [y, m] = str.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[Number(m)-1]} ${y}`;
  }

  const span = (p) => (p.viewStart ? `${fmtDate(p.viewStart)} – ${fmtDate(p.viewEnd)}` : '');

  // Colors and style: the organization's look for every schedule. Global, so it reads as text until Edit; changes are
  // a draft (previewed here) until Save changes, and Cancel throws them away.
  let draft = $state(null); // { colors, font, showToday } while editing, else null
  let styleStatus = $state('');
  let styleError = $state(false);
  let saving = $state(false);
  const startEditing = () => {
    draft = { colors: { ...$palette }, ...$options };
    styleStatus = '';
  };
  const cancelEditing = () => { draft = null; };
  const pick = (key, hex) => { draft.colors = { ...draft.colors, [key]: hex.toUpperCase() }; };
  const standard = (key) => { const { [key]: _, ...rest } = draft.colors; draft.colors = rest; };
  async function saveStyle() {
    const colors = cleanPalette(draft.colors);
    const opts = cleanOptions(draft);
    saving = true;
    styleError = false;
    styleStatus = 'Saving…';
    try {
      await saveScheduleStyle({ colors, ...opts });
      palette.set(colors);
      options.set(opts);
      draft = null;
      styleStatus = 'Saved. Every schedule now uses these.';
    } catch (err) {
      styleError = true;
      styleStatus = err.message;
    } finally {
      saving = false;
    }
  }
  const colorOf = (key, base) => (draft ? draft.colors[key] : $palette[key]) ?? base;
  const isSet = (key) => !!(draft ? draft.colors[key] : $palette[key]);
  const fontLabel = (key) => FONTS.find((f) => f.key === key)?.label ?? FONTS[0].label;
</script>

<section class="schedule-list">
  <div class="saved">
    <h2 class="label">Schedules</h2>
    {#if projects.length}
      <ol>
        {#each projects as p (p.id)}
          <li>
            <a class="link open" href="#schedule/{encodeURIComponent(p.id)}"><b>{p.title || 'Untitled schedule'}</b> <span>{p.client || ''}</span></a>
            <span class="when">{[span(p), `${p.tasks?.length || 0} tasks`].filter(Boolean).join(' · ')}</span>
            <button class="link" onclick={() => deleteSchedule(p.id)}>Delete</button>
          </li>
        {/each}
      </ol>
    {:else}
      <p class="empty">None yet. Make one here, or from a project page.</p>
    {/if}
    <div class="actions"><button class="btn" onclick={newSchedule}>New schedule</button></div>
  </div>

  <div class="colors">
    <h2 class="label">
      Colors and style
      {#if !draft}<button class="link edit-link" onclick={startEditing}>Edit</button>{/if}
    </h2>
    <p class="intro">How your organization's schedules look, including printed and PDF copies. These apply to every schedule, so changes only take effect when you save them.</p>

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

    {#if draft}
      <div class="actions">
        <button class="btn primary" onclick={saveStyle} disabled={saving}>Save changes</button>
        <button class="btn" onclick={cancelEditing} disabled={saving}>Cancel</button>
        <button class="link" onclick={() => { draft = { colors: {}, ...cleanOptions({}) }; }} disabled={saving}>Reset everything to standard</button>
      </div>
    {/if}
    <span class="status" class:error={styleError}>{styleStatus}</span>
  </div>
</section>

<style>
  /* Laid out like the site's other pages (the schedule screens sit outside the site's main area). */
  .schedule-list {
    flex: 1;
    padding: 40px 32px 96px;
    font: 15px/1.5 var(--sans);
    color: var(--ink);
    background: var(--bg);
  }
  .schedule-list .saved { margin-top: 0; max-width: 1100px; }
  .empty { margin: 0; font-size: 14px; }
  .colors { margin-top: 56px; max-width: 760px; }
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
  .colors .opts { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 10px 14px; margin: 20px 0 12px; font-size: 14px; }
  .colors .opts dt { font-weight: 700; }
  .colors .opts dd { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
  .colors select { font: inherit; padding: 5px 8px; border: 1px solid var(--ink); background: var(--bg); }
  .colors .font-sample { font-size: 16px; }
  .colors .check { display: inline-flex; align-items: center; gap: 8px; }
  .colors .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 8px; }
  .colors .status { display: block; margin-top: 8px; font-size: 13px; }
  .colors .status.error { color: var(--bad); }
  @media (max-width: 640px) {
    .schedule-list { padding: 24px 16px 72px; }
    .colors li { grid-template-columns: 36px minmax(0, 1fr) auto; }
    .colors .sample { display: none; }
  }
</style>
