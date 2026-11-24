<script>
  // The Schedule tab: every schedule, in the site's own list style (the editor keeps the schedule maker's look).
  import { projectStore } from '../lib/stores/projects.js';
  import { confirmDelete, noticeModal } from '../../modal';

  let projects = $state([]);
  projectStore.subscribe(v => { projects = v; });


  async function deleteSchedule(id) {
    if (!(await confirmDelete('schedule'))) return;
    try {
      await projectStore.deleteProject(id);
    } catch (err) {
      await noticeModal("Couldn't delete the schedule", err.message);
    }
  }

  function fmtDate(str) {
    if (!str) return '';
    const [y, m] = str.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[Number(m)-1]} ${y}`;
  }

  const span = (p) => (p.viewStart ? `${fmtDate(p.viewStart)} – ${fmtDate(p.viewEnd)}` : '');

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
      <p class="empty">None yet.</p>
    {/if}
    <p class="empty">Each schedule belongs to a project: make one from its project's page. Colors and fonts for every schedule are on the <a class="link" href="#org">Organization</a> page.</p>
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
</style>
