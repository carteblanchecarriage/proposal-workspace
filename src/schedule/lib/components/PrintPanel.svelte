<script>
  let {
    open             = false,
    projectId        = '',
    monthCount       = 0,
    showTodayDefault = true,
    onDownload,
    onClose,
  } = $props();

  // Making the PDF on the server takes a few seconds (longer the first time); the button says so meanwhile.
  let downloading = $state(false);
  let downloadError = $state('');
  async function handleDownload() {
    if (downloading) return;
    downloading = true;
    downloadError = '';
    try {
      await onDownload?.({ showToday, showLegend, paper });
    } catch (err) {
      downloadError = err?.message || 'Couldn\'t make the PDF.';
    } finally {
      downloading = false;
    }
  }

  const PAPERS = {
    letter:  { w: 816,  h: 1056, usableW: 720,  label: '8.5 × 11 in' },
    tabloid: { w: 1632, h: 1056, usableW: 1536, label: '11 × 17 in'  },
  };

  // Preview pane is up to 880px wide (narrower on small screens); iframe is the
  // full paper size scaled to fit. Below 760px the options stack under the preview.
  let innerW    = $state(window.innerWidth);
  let stacked   = $derived(innerW < 760);
  let PREVIEW_W = $derived(Math.max(240, Math.min(880, stacked ? innerW - 34 : innerW * 0.95 - 192)));

  let paper      = $state('tabloid');
  let showToday  = $state(true);
  let showLegend = $state(true);
  let iframeEl   = $state(null);

  $effect(() => {
    if (open) {
      showToday  = showTodayDefault;
      showLegend = true;
      paper      = 'tabloid';
      scale      = null;
    }
  });

  // Push option changes into the preview iframe via postMessage (no reload).
  $effect(() => {
    iframeEl?.contentWindow?.postMessage({ showToday, showLegend }, location.origin);
  });

  let pg          = $derived(PAPERS[paper]);
  // The whole sheet fits the pane both ways, so a portrait page isn't cut off at the bottom.
  let innerH      = $state(window.innerHeight);
  let maxPreviewH = $derived(Math.max(240, innerH - 220));
  let iframeScale = $derived(Math.min(PREVIEW_W / pg.w, maxPreviewH / pg.h));
  let previewH    = $derived(Math.round(pg.h * iframeScale));
  let sheetW      = $derived(Math.round(pg.w * iframeScale));
  // The scale the preview fitted the sheet at; null until it has.
  let scale       = $state(null);
  let scalePct    = $derived(Math.round((scale ?? 1) * 100));
  let fits        = $derived(scale >= 1);
  let iframeSrc   = $derived(projectId ? `${location.pathname}#schedule-print?paper=${paper}` : '');


  // From the preview (PrintPreview.svelte). It's made again when the paper changes, so it asks for the options again.
  function onMessage(e) {
    if (e.origin !== location.origin || !iframeEl || e.source !== iframeEl.contentWindow) return;
    const m = e.data?.preview;
    if (m?.ready) onIframeLoad();
    if (typeof m?.scale === 'number') scale = m.scale;
    if (m?.escape) onClose?.();
  }

  function onIframeLoad() {
    // Re-send current options once the iframe finishes loading.
    iframeEl?.contentWindow?.postMessage({ showToday, showLegend }, location.origin);
  }
</script>

<svelte:window bind:innerWidth={innerW} bind:innerHeight={innerH} onmessage={onMessage} onkeydown={(e) => { if (open && e.key === 'Escape') onClose?.(); }} />

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="overlay" onmousedown={onClose} role="dialog" aria-modal="true" aria-labelledby="print-panel-title">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="panel" onmousedown={(e) => e.stopPropagation()}>

      <!-- Header -->
      <div class="panel-hdr">
        <h2 class="panel-title" id="print-panel-title">Download PDF</h2>
        <button class="close-btn" onclick={onClose}>Close</button>
      </div>

      <!-- Body: preview (left) + options (right) -->
      <div class="panel-body" class:stacked>

        <!-- Preview -->
        <div class="preview-col">
          <div class="preview-bg" style:width="{PREVIEW_W}px" style:height="{previewH}px">
            <div class="preview-paper"
              style:width="{sheetW}px"
              style:height="{previewH}px"
              style:margin="0 auto">
              {#if iframeSrc}
                <iframe
                  bind:this={iframeEl}
                  title="Print Preview"
                  class="preview-frame"
                  src={iframeSrc}
                  onload={onIframeLoad}
                  style:width="{pg.w}px"
                  style:height="{pg.h}px"
                  style:transform="scale({iframeScale})"
                ></iframe>
              {:else}
                <div class="preview-placeholder">No project selected</div>
              {/if}
            </div>
          </div>
        </div>

        <!-- Options -->
        <div class="opts-col">

          <div class="section">
            <div class="section-label">Paper</div>
            <div class="paper-btns">
              {#each Object.entries(PAPERS) as [key, p]}
                <button
                  class="paper-btn"
                  class:paper-active={paper === key}
                  onclick={() => { if (paper !== key) { paper = key; scale = null; } }}
                >{p.label}</button>
              {/each}
            </div>
          </div>

          <div class="divider"></div>

          <div class="section">
            <div class="section-label">Schedule</div>
            <div class="info-row">
              <!-- 8.5 × 11 prints quarters (Q1–Q4); 11 × 17 prints months -->
              <span class="info-key">{paper === 'letter' ? 'Quarters' : 'Months'}</span>
              <span class="info-val">{paper === 'letter' ? Math.ceil(monthCount / 3) : monthCount}</span>
            </div>
            <div class="info-row">
              <span class="info-key">Scale</span>
              <span class="info-val" class:scale-full={fits} class:scale-down={scale !== null && !fits}>
                {scale === null ? '…' : fits ? 'Full size' : `${scalePct}%`}
              </span>
            </div>
          </div>

          <div class="divider"></div>

          <div class="section">
            <div class="section-label">Include</div>
            <label class="opt-row">
              <input type="checkbox" bind:checked={showToday} />
              <span class="opt-lbl">Today marker</span>
            </label>
            <label class="opt-row">
              <input type="checkbox" bind:checked={showLegend} />
              <span class="opt-lbl">Legend</span>
            </label>
          </div>

        </div>
      </div>

      <!-- Footer -->
      <div class="panel-foot">
        {#if downloadError}<p class="dl-error" role="alert">{downloadError}</p>{/if}
        <button class="btn" onclick={onClose}>Cancel</button>
        <!-- The reliable PDF: made on the server, always this paper size, landscape. -->
        <button class="btn primary" onclick={handleDownload} disabled={downloading}>{downloading ? 'Making PDF…' : 'Download PDF'}</button>
      </div>

    </div>
  </div>
{/if}

<style>
  /* Matches the site's dialogs (src/style.css: dialog.modal, .label, .btn): square, ink border, Inter, no shadow. */
  .overlay {
    position: fixed; inset: 0; z-index: 500;
    background: rgba(17, 17, 17, .35);
    display: flex; align-items: center; justify-content: center;
  }

  .panel {
    background: var(--bg, #fff);
    border: 1px solid var(--ink, #111);
    display: flex; flex-direction: column;
    font: 15px/1.5 var(--sans);
    color: var(--ink, #111);
    max-width: 95vw;
    max-height: 90vh;
    overflow: hidden;
  }

  .panel-hdr {
    display: flex; align-items: baseline; justify-content: space-between; gap: 16px;
    padding: 18px 24px 14px;
    border-bottom: 1px solid var(--rule, #e2e2e2);
    flex-shrink: 0;
  }
  .panel-title { margin: 0; font: 500 18px/1.3 var(--sans); }
  .close-btn {
    background: none; border: 0; padding: 0; cursor: pointer;
    font: 14px var(--sans); color: var(--ink, #111);
    text-decoration: underline; text-underline-offset: 3px;
  }
  .close-btn:hover { text-decoration-thickness: 2px; }

  /* Body row */
  .panel-body {
    display: flex;
    flex-direction: row;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* Preview column */
  .preview-col {
    flex-shrink: 0;
    border-right: 1px solid var(--rule, #e2e2e2);
  }
  .preview-bg {
    background: var(--soft, #f6f6f4);
    display: flex; align-items: flex-start; justify-content: center;
    padding: 0;
    overflow: hidden;
  }
  .preview-paper {
    position: relative;
    overflow: hidden;
    flex-shrink: 0;
    background: #fff;
    outline: 1px solid var(--rule, #e2e2e2);
  }
  .preview-frame {
    border: none; display: block;
    transform-origin: top left;
  }
  .preview-placeholder {
    display: flex; align-items: center; justify-content: center;
    width: 100%; height: 100%;
    font-size: 14px;
  }

  /* Options column */
  .opts-col {
    width: 220px;
    flex-shrink: 0;
    padding: 18px 20px;
    display: flex; flex-direction: column; gap: 16px;
    overflow-y: auto;
  }

  .section { display: flex; flex-direction: column; gap: 6px; }
  .section-label { font: 700 15px/1.3 var(--sans); margin-bottom: 4px; }

  /* Paper size: a choice of two, like the site's buttons (the chosen one filled). */
  .paper-btns { display: flex; flex-direction: column; gap: 6px; }
  .paper-btn {
    font: 14px var(--sans);
    text-align: left;
    background: var(--bg, #fff); border: 1px solid var(--ink, #111);
    border-radius: 0; padding: 7px 12px;
    color: var(--ink, #111); cursor: pointer;
  }
  .paper-btn:hover:not(.paper-active) { background: var(--soft, #f6f6f4); }
  .paper-active { background: var(--ink, #111); color: var(--bg, #fff); }

  .divider { height: 1px; background: var(--rule, #e2e2e2); }

  .info-row {
    display: flex; align-items: baseline; justify-content: space-between;
    font-size: 14px;
  }
  .info-val { font-weight: 600; }
  .scale-down { color: var(--bad, #b3261e); }

  .opt-row {
    display: flex; align-items: center; gap: 8px;
    font-size: 14px;
    cursor: pointer; user-select: none; padding: 2px 0;
  }
  .opt-row input[type="checkbox"] {
    width: 15px; height: 15px; margin: 0; cursor: pointer;
    accent-color: var(--ink, #111); flex-shrink: 0;
  }

  /* Narrow screens: options below the preview, whole body scrolls */
  .panel-body.stacked { flex-direction: column; overflow-y: auto; }
  .stacked .preview-col { border-right: none; border-bottom: 1px solid var(--rule, #e2e2e2); }
  .stacked .opts-col { width: auto; overflow: visible; }
  .stacked .paper-btns { flex-direction: row; }
  .stacked .paper-btn { flex: 1; text-align: center; padding: 9px; }

  @media (pointer: coarse) {
    .opt-row input[type="checkbox"] { width: 20px; height: 20px; }
    .opt-row { padding: 6px 0; }
  }

  /* Footer: the site's buttons (global .btn, .btn.primary). */
  .panel-foot {
    display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: 8px;
    padding: 14px 24px 18px;
    border-top: 1px solid var(--rule, #e2e2e2);
    flex-shrink: 0;
  }
  .panel-foot :global(.btn) { font-family: var(--sans); }
  .panel-foot :global(.btn.primary:disabled) { opacity: .6; cursor: progress; }
  .dl-error { margin: 0 auto 0 0; color: var(--bad, #b3261e); font-size: 14px; }
</style>
