<script>
  // The organization's schedule style (colors, font, Today line), on the Organization page. Global, so it reads as
  // text until Edit; changes are a draft (previewed here) until Save changes, and Cancel throws them away.
  import { onMount } from 'svelte';
  import { CATEGORIES, BADGES, FONTS, palette, options, cleanPalette, cleanOptions, loadFont } from '../lib/palette.js';
  import { getScheduleStyle, saveScheduleStyle } from '../../store';

  let loaded = $state(false);
  onMount(async () => {
    try {
      const s = await getScheduleStyle();
      palette.set(cleanPalette(s.colors));
      options.set(cleanOptions(s));
    } catch {}
    loaded = true;
  });
  // The font sample needs the font itself (Google fonts load on demand; Barlow and Inter are the site's own).
  $effect(() => { if (draft?.font) loadFont(draft.font); });

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

{#if loaded}
  <div class="colors">
    <h3 class="style-head">
      Schedules
      {#if !draft}<button class="link edit-link" onclick={startEditing}>Edit</button>{/if}
    </h3>
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
  .colors .opts { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 10px 14px; margin: 20px 0 12px; font-size: 14px; }
  .colors .opts dt { font-weight: 700; }
  .colors .opts dd { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
  .colors select { font: inherit; padding: 5px 8px; border: 1px solid var(--ink); background: var(--bg); }
  .colors .font-sample { font-size: 16px; }
  .colors .check { display: inline-flex; align-items: center; gap: 8px; }
  .colors .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 8px; }
  .colors .status { display: block; margin-top: 8px; font-size: 13px; text-transform: none; letter-spacing: normal; }
  .colors .status.error { color: var(--bad); }
  @media (max-width: 640px) {
    .colors li { grid-template-columns: 36px minmax(0, 1fr) auto; }
    .colors .sample { display: none; }
  }
</style>
