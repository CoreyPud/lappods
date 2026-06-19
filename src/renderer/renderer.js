'use strict';

const api = window.lappods;

const state = {
  tab: 'podcasts', // 'podcasts' | 'files'
  podcasts: null, // raw shows, or null if not loaded
  files: null, // scan result, or null if not scanned
  activeGroup: { podcasts: null, files: null }, // active group id per tab
  filterExportable: { podcasts: true, files: true },
  selected: new Map(), // itemId -> export payload
  scanning: false,
};

const $ = (id) => document.getElementById(id);

// --- formatting --------------------------------------------------------

function fmtDuration(seconds) {
  if (!seconds) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtBytes(bytes) {
  if (bytes == null) return '';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}
function fmtMtime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function mediaURL(filePath) {
  return 'lappods-media://m/?p=' + encodeURIComponent(filePath);
}
// Absolute path for an episode's downloaded file (from its file:// asset URL).
function pathFromAssetURL(assetURL) {
  try {
    return decodeURIComponent(new URL(assetURL).pathname);
  } catch {
    return null;
  }
}
function prettyDir(dir) {
  const home = dir.replace(/^\/Users\/[^/]+/, '~');
  return home;
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

// --- normalization: both sources -> common group/item shape ------------

function podcastGroups() {
  if (!state.podcasts) return [];
  return state.podcasts.map((s) => ({
    id: 'pod:' + s.pk,
    title: s.title,
    subtitle: s.author || '',
    artwork: s.artwork || null,
    exportableCount: s.downloadedCount,
    items: s.episodes.map((e) => ({
      id: 'pod:' + e.pk,
      title: e.title,
      subtitle: [fmtDate(e.pubDate), fmtDuration(e.durationSeconds)].filter(Boolean).join(' · '),
      exportable: e.downloaded,
      status: e.downloaded ? 'Downloaded' : 'Not downloaded',
      groupTitle: s.title,
      name: e.title,
      assetURL: e.assetURL,
      previewPath: e.downloaded ? pathFromAssetURL(e.assetURL) : null,
    })),
  }));
}

function fileGroups() {
  if (!state.files) return [];
  return state.files.groups.map((g) => ({
    id: 'file:' + g.dir,
    title: g.name,
    subtitle: prettyDir(g.dir),
    artwork: null,
    exportableCount: g.exportableCount,
    items: g.items.map((it) => {
      const sub = [
        it.artist,
        it.album,
        fmtDuration(it.duration),
        fmtBytes(it.size),
        fmtMtime(it.mtime) && 'Saved ' + fmtMtime(it.mtime),
      ].filter(Boolean).join(' · ');
      return {
        id: it.id,
        title: it.title || it.fileName,
        subtitle: sub || it.fileName,
        exportable: it.exportable,
        status: it.exportable ? it.fileName.split('.').pop().toUpperCase() : 'Protected',
        groupTitle: g.name,
        // Export base name: tag title if present, else filename without extension
        // (the exporter re-appends the real extension).
        name: it.title || it.fileName.replace(/\.[^.]+$/, ''),
        srcPath: it.srcPath,
        previewPath: it.exportable ? it.srcPath : null,
      };
    }),
  }));
}

function currentGroups() {
  const groups = state.tab === 'podcasts' ? podcastGroups() : fileGroups();
  if (state.filterExportable[state.tab]) {
    return groups
      .filter((g) => g.exportableCount > 0)
      .map((g) => ({ ...g, items: g.items.filter((i) => i.exportable) }));
  }
  return groups;
}

// --- sidebar -----------------------------------------------------------

function renderGroups() {
  const list = $('group-list');
  const groups = currentGroups();
  list.innerHTML = '';

  if (state.tab === 'files' && !state.files) {
    list.innerHTML = state.scanning
      ? '<li class="empty">Scanning…</li>'
      : '<li class="empty">Pick folders above and click <b>Scan</b> to find audio files on your Mac.</li>';
    return;
  }

  if (groups.length === 0) {
    list.innerHTML =
      state.tab === 'podcasts'
        ? '<li class="empty">No downloaded episodes.<br>Download episodes in the Podcasts app first.</li>'
        : '<li class="empty">No exportable audio found in the scanned folders.</li>';
    return;
  }

  let active = state.activeGroup[state.tab];
  if (!groups.some((g) => g.id === active)) active = groups[0].id;
  state.activeGroup[state.tab] = active;

  for (const group of groups) {
    const li = document.createElement('li');
    li.className = 'show-item' + (group.id === active ? ' active' : '');

    if (group.artwork) {
      const art = document.createElement('img');
      art.className = 'show-art';
      art.referrerPolicy = 'no-referrer';
      art.src = group.artwork;
      art.onerror = () => { art.style.visibility = 'hidden'; };
      li.appendChild(art);
    } else {
      const ph = document.createElement('div');
      ph.className = 'show-art placeholder';
      ph.textContent = state.tab === 'files' ? '🎵' : '🎙️';
      li.appendChild(ph);
    }

    const text = document.createElement('div');
    text.className = 'show-text';
    text.innerHTML = '<div class="show-name"></div><div class="show-sub"></div>';
    text.querySelector('.show-name').textContent = group.title;
    text.querySelector('.show-sub').textContent = group.subtitle;
    li.appendChild(text);

    if (group.exportableCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = group.exportableCount;
      li.appendChild(badge);
    }

    li.addEventListener('click', () => {
      state.activeGroup[state.tab] = group.id;
      renderGroups();
      renderItems();
    });
    list.appendChild(li);
  }
}

function activeGroupData() {
  return currentGroups().find((g) => g.id === state.activeGroup[state.tab]) || null;
}

// --- item list ---------------------------------------------------------

function renderItems() {
  const group = activeGroupData();
  const list = $('item-list');
  list.innerHTML = '';

  if (!group) {
    $('group-title').textContent = state.tab === 'files' ? 'No folder selected' : 'Select a show';
    $('group-meta').textContent = '';
    return;
  }

  $('group-title').textContent = group.title;
  const total = group.items.length;
  $('group-meta').textContent =
    state.tab === 'podcasts'
      ? `${group.exportableCount} downloaded · ${total} shown`
      : `${group.exportableCount} exportable · ${total} file(s)`;

  if (group.items.length === 0) {
    list.innerHTML = '<li class="empty">Nothing to show here.</li>';
    return;
  }

  for (const item of group.items) {
    const li = document.createElement('li');
    li.className = 'episode' + (item.exportable ? '' : ' disabled');

    // Right-click → native "Show in Finder" menu (when a local file exists).
    const revealPath = item.srcPath || item.previewPath;
    if (revealPath) {
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        api.showFileMenu(revealPath);
      });
    }

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.disabled = !item.exportable;
    cb.checked = state.selected.has(item.id);
    cb.addEventListener('change', () => toggleItem(item, cb.checked));

    const main = document.createElement('div');
    main.className = 'ep-main';
    main.innerHTML = '<div class="ep-title"></div><div class="ep-sub"></div>';
    main.querySelector('.ep-title').textContent = item.title;
    main.querySelector('.ep-sub').textContent = item.subtitle;

    // Preview button (only when a playable local file exists).
    const preview = document.createElement('div');
    preview.className = 'ep-preview';
    if (item.previewPath) {
      const btn = document.createElement('button');
      btn.className = 'preview-btn' + (playingId === item.id ? ' playing' : '');
      btn.dataset.id = item.id;
      btn.title = 'Preview';
      btn.textContent = playingId === item.id ? '⏸' : '▶';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePreview(item);
      });
      preview.appendChild(btn);
    }

    const status = document.createElement('div');
    status.className = 'ep-status';
    status.innerHTML = item.exportable
      ? `<span class="dot dl"></span>${item.status}`
      : `<span class="dot no"></span>${item.status}`;

    if (playingId === item.id) li.classList.add('playing');
    li.appendChild(cb);
    li.appendChild(main);
    li.appendChild(preview);
    li.appendChild(status);
    list.appendChild(li);
  }
}

// --- audio preview -----------------------------------------------------

let audioEl = null;
let playingId = null;

function ensureAudio() {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.addEventListener('ended', () => setPlaying(null));
    audioEl.addEventListener('error', () => {
      if (playingId) toast('Could not preview this file.');
      setPlaying(null);
    });
  }
  return audioEl;
}

function togglePreview(item) {
  const a = ensureAudio();
  if (playingId === item.id) {
    a.pause();
    setPlaying(null);
    return;
  }
  a.src = mediaURL(item.previewPath);
  a.play()
    .then(() => setPlaying(item.id))
    .catch(() => {
      toast('Could not preview this file.');
      setPlaying(null);
    });
}

// Reflect playing state in the buttons/rows without rebuilding the list.
function setPlaying(id) {
  playingId = id;
  document.querySelectorAll('#item-list .episode').forEach((li) => {
    const btn = li.querySelector('.preview-btn');
    const on = btn && btn.dataset.id === id;
    li.classList.toggle('playing', !!on);
    if (btn) {
      btn.textContent = on ? '⏸' : '▶';
      btn.classList.toggle('playing', !!on);
    }
  });
}

function toggleItem(item, checked) {
  if (checked) {
    state.selected.set(item.id, {
      showTitle: item.groupTitle,
      episodeTitle: item.name,
      srcPath: item.srcPath || undefined,
      assetURL: item.assetURL || undefined,
    });
  } else {
    state.selected.delete(item.id);
  }
  updateSelectionUI();
}

function updateSelectionUI() {
  const n = state.selected.size;
  $('selection-count').textContent = `${n} selected`;
  $('export').disabled = n === 0;
}

// --- tabs --------------------------------------------------------------

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  $('scan-bar').classList.toggle('hidden', tab !== 'files');
  $('rescan').classList.toggle('hidden', tab !== 'files' || !state.files);
  $('filter-label').textContent = tab === 'podcasts' ? 'Downloaded only' : 'Exportable only';
  $('filter-toggle').checked = state.filterExportable[tab];
  $('select-all').textContent = tab === 'podcasts' ? 'Select all downloaded' : 'Select all exportable';

  if (tab === 'podcasts' && state.podcasts === null) loadLibrary();
  renderGroups();
  renderItems();
}

// --- data loading ------------------------------------------------------

async function loadLibrary() {
  const list = $('group-list');
  if (state.tab === 'podcasts') list.innerHTML = '<li class="empty">Loading library…</li>';
  try {
    state.podcasts = await api.readLibrary();
  } catch (err) {
    state.podcasts = [];
    if (state.tab === 'podcasts') list.innerHTML = `<li class="empty">${err.message}</li>`;
    return;
  }
  if (state.tab === 'podcasts') {
    renderGroups();
    renderItems();
  }
}

function selectedRoots() {
  return Array.from(document.querySelectorAll('.root-chk:checked')).map((c) => c.value);
}

async function runScan() {
  if (state.scanning) return;
  const roots = selectedRoots();
  if (roots.length === 0) {
    toast('Pick at least one folder to scan.');
    return;
  }
  state.scanning = true;
  $('scan-btn').disabled = true;
  $('scan-status').textContent = 'Starting…';
  renderGroups();

  try {
    state.files = await api.scanFiles({ roots });
    $('scan-status').textContent = `${state.files.fileCount} files · ${state.files.groups.length} folders`;
    state.activeGroup.files = null;
    $('rescan').classList.remove('hidden');
  } catch (err) {
    $('scan-status').textContent = 'Scan failed';
    toast(err.message);
  } finally {
    state.scanning = false;
    $('scan-btn').disabled = false;
    renderGroups();
    renderItems();
  }
}

// --- export ------------------------------------------------------------

let lastResultPath = null;

async function runExport() {
  const destDir = $('drive').value;
  if (!destDir) {
    toast('Pick a destination drive or folder first.');
    return;
  }
  const items = Array.from(state.selected.values());
  if (items.length === 0) return;

  const options = {
    destDir,
    organizeByShow: $('opt-organize').checked,
    numberPrefix: $('opt-number').checked,
    writeM3U: $('opt-m3u').checked,
    playlistName: 'LapPods',
  };

  showProgress(items.length);
  try {
    const result = await api.exportEpisodes(items, options);
    finishProgress(result);
  } catch (err) {
    $('progress-title').textContent = 'Export failed';
    $('progress-detail').textContent = err.message;
    $('progress-actions').classList.remove('hidden');
    $('reveal').classList.add('hidden');
  }
}

function showProgress(total) {
  $('progress-title').textContent = 'Exporting…';
  $('progress-detail').textContent = `0 of ${total}`;
  $('bar-fill').style.width = '0%';
  $('progress-actions').classList.add('hidden');
  $('reveal').classList.remove('hidden');
  $('progress').classList.remove('hidden');
}

function finishProgress(result) {
  lastResultPath = result.playlistPath || null;
  $('progress-title').textContent = 'Export complete';
  const parts = [`Copied ${result.copied} of ${result.total} file(s).`];
  if (result.playlistPath) parts.push('Playlist created.');
  if (result.errors.length) parts.push(`${result.errors.length} failed.`);
  $('progress-detail').textContent = parts.join(' ');
  $('bar-fill').style.width = '100%';
  $('progress-actions').classList.remove('hidden');
  $('reveal').classList.toggle('hidden', !lastResultPath);

  state.selected.clear();
  updateSelectionUI();
  renderItems();
}

// --- wiring ------------------------------------------------------------

async function loadDrives() {
  const sel = $('drive');
  const prev = sel.value;
  sel.innerHTML = '';
  let drives = [];
  try {
    drives = await api.listDrives();
  } catch {}

  if (drives.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No drive detected — use Folder…';
    sel.appendChild(opt);
    return;
  }
  for (const d of drives) {
    const opt = document.createElement('option');
    opt.value = d.mountPoint;
    const tag = d.isShokz ? '🎧 ' : '';
    const free = d.freeBytes != null ? ` · ${fmtBytes(d.freeBytes)} free` : '';
    opt.textContent = `${tag}${d.name}${free}`;
    sel.appendChild(opt);
  }
  const shokz = drives.find((d) => d.isShokz);
  sel.value = prev && drives.some((d) => d.mountPoint === prev)
    ? prev
    : (shokz ? shokz.mountPoint : drives[0].mountPoint);
}

function wire() {
  document.querySelectorAll('.tab').forEach((b) =>
    b.addEventListener('click', () => setTab(b.dataset.tab))
  );

  $('filter-toggle').addEventListener('change', (e) => {
    state.filterExportable[state.tab] = e.target.checked;
    state.activeGroup[state.tab] = null;
    renderGroups();
    renderItems();
  });

  $('scan-btn').addEventListener('click', runScan);
  $('rescan').addEventListener('click', runScan);

  $('add-root').addEventListener('click', async () => {
    const dir = await api.chooseFolder();
    if (!dir) return;
    const bar = $('scan-bar');
    const label = document.createElement('label');
    label.className = 'chip';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'root-chk';
    cb.value = dir;
    cb.checked = true;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + (dir.split('/').pop() || dir)));
    bar.insertBefore(label, $('add-root'));
  });

  $('refresh-drives').addEventListener('click', loadDrives);
  $('choose-folder').addEventListener('click', async () => {
    const dir = await api.chooseFolder();
    if (!dir) return;
    const sel = $('drive');
    const opt = document.createElement('option');
    opt.value = dir;
    opt.textContent = `📁 ${dir.split('/').pop() || dir}`;
    sel.appendChild(opt);
    sel.value = dir;
  });

  $('select-all').addEventListener('click', () => {
    const group = activeGroupData();
    if (!group) return;
    for (const item of group.items) if (item.exportable) toggleItem(item, true);
    renderItems();
  });
  $('clear-sel').addEventListener('click', () => {
    state.selected.clear();
    updateSelectionUI();
    renderItems();
  });

  $('export').addEventListener('click', runExport);
  $('progress-close').addEventListener('click', () => $('progress').classList.add('hidden'));
  $('reveal').addEventListener('click', () => {
    if (lastResultPath) api.revealInFinder(lastResultPath);
  });

  api.onExportProgress((p) => {
    if (p.phase === 'copying' || p.phase === 'copied') {
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      $('bar-fill').style.width = pct + '%';
      $('progress-detail').textContent = `${p.done} of ${p.total} — ${p.current || ''}`;
    }
  });

  api.onScanProgress((p) => {
    if (p.phase === 'walking') $('scan-status').textContent = `Found ${p.found || 0} files…`;
    else if (p.phase === 'tagging') $('scan-status').textContent = `Reading tags ${p.tagged || 0}/${p.total || 0}…`;
  });
}

// --- boot --------------------------------------------------------------

wire();
loadDrives();
setTab('podcasts'); // normalize initial tab state + trigger library load
updateSelectionUI();
