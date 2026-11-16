<script>
  import { onMount } from 'svelte';
  import { route } from './route.js';
  import { projectStore } from './lib/stores/projects.js';
  import { SCHEDULE_PROMPT } from '../../lib/schedule-prompt';
  import List from './pages/List.svelte';
  import Editor from './pages/Editor.svelte';
  import Share from './pages/Share.svelte';
  import PrintPreview from './pages/PrintPreview.svelte';
  import SystemPrompt from './pages/SystemPrompt.svelte';
  import { palette, options, cleanPalette, cleanOptions } from './lib/palette.js';
  import { getScheduleStyle } from '../store';

  // The list and editor need every schedule loaded first (as the old app's layout did on start).
  let ready = $state(false);
  // Reloaded on each visit, so a schedule just made from a project page is there.
  onMount(() => {
    // The organization's schedule style, loaded before a schedule opens (the editor starts with its Today default).
    // The print page instead uses the style handed over with the schedule (it may be the server's PDF browser, which
    // isn't signed in).
    const style = location.hash.startsWith('#schedule-print')
      ? Promise.resolve()
      : getScheduleStyle()
          .then((s) => {
            palette.set(cleanPalette(s.colors));
            options.set(cleanOptions(s));
          })
          .catch(() => {});
    Promise.all([projectStore.init(true), style]).then(() => { ready = true; });
  });
</script>

{#if $route.view === 'print'}
  <!-- Re-created when the paper size or options change (the print panel's preview changes only the address). -->
  {#key JSON.stringify($route.params)}<PrintPreview data={$route.params} />{/key}
{:else if $route.view === 'share'}
  {#key $route.id}<Share data={{ id: $route.id }} />{/key}
{:else if $route.view === 'prompt'}
  <SystemPrompt data={{ markdown: SCHEDULE_PROMPT }} />
{:else if ready}
  {#if $route.view === 'editor'}
    {#key $route.id}<Editor data={{ id: $route.id }} />{/key}
  {:else}
    <List />
  {/if}
{/if}
