'use strict';

const api = window.lappods;

const state = {
  tab: 'podcasts', // 'podcasts' | 'files' | 'device'
  podcasts: null, // raw shows, or null if not loaded
  files: null, // scan result, or null if not scanned
  device: null, // scan result for the selected drive, or null if not loaded
  activeGroup: { podcasts: null, files: null, device: null }, // active group id per tab
  filterExportable: { podcasts: true, files: true },
  selected: new Map(), // itemId -> export payload (Podcasts/Files tabs)
  deviceSelected: new Map(), // itemId -> { srcPath } (On Device tab)
  deviceKeys: new Set(), // match keys for what's currently on the device
  scanning: false,
  deviceLoading: false,
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
      trackKey: e.trackKey,
      previewPath: e.downloaded ? pathFromAssetURL(e.assetURL) : null,
    })),
  }));
}

// Maps a scanner `reason` code to the badge label + hover tip shown for a
// file the device can't play.
function blockReason(reason) {
  if (reason === 'alac') {
    return {
      label: 'ALAC',
      tip: 'Apple Lossless — not supported by the device. Convert to AAC or MP3 first.',
    };
  }
  return { label: 'Protected', tip: 'DRM-protected — cannot be exported.' };
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
      const reason = blockReason(it.reason);
      return {
        id: it.id,
        title: it.title || it.fileName,
        subtitle: sub || it.fileName,
        exportable: it.exportable,
        status: it.exportable
          ? it.fileName.split('.').pop().toUpperCase()
          : reason.label,
        statusTitle: it.exportable ? null : reason.tip,
        groupTitle: g.name,
        // Export base name: tag title if present, else filename without extension
        // (the exporter re-appends the real extension).
        name: it.title || it.fileName.replace(/\.[^.]+$/, ''),
        srcPath: it.srcPath,
        trackKey: it.trackKey,
        previewPath: it.exportable ? it.srcPath : null,
      };
    }),
  }));
}

// On Device tab: device contents grouped by folder, every item selectable for
// removal. No in-app preview of device files in this pass.
function deviceGroups() {
  if (!state.device) return [];
  return state.device.groups.map((g) => ({
    id: 'dev:' + g.dir,
    title: g.name,
    subtitle: prettyDir(g.dir),
    artwork: null,
    exportableCount: g.items.length,
    items: g.items.map((it) => {
      const sub = [it.artist, it.album, fmtDuration(it.duration), fmtBytes(it.size)]
        .filter(Boolean)
        .join(' · ');
      return {
        id: it.id,
        title: it.title || it.fileName,
        subtitle: sub || it.fileName,
        exportable: true, // selectable for removal
        status: (it.fileName.split('.').pop() || '').toUpperCase(),
        groupTitle: g.name,
        name: it.title || it.fileName.replace(/\.[^.]+$/, ''),
        srcPath: it.srcPath,
        previewPath: null,
      };
    }),
  }));
}

function currentGroups() {
  if (state.tab === 'device') return deviceGroups();
  const groups = state.tab === 'podcasts' ? podcastGroups() : fileGroups();
  if (state.filterExportable[state.tab]) {
    return groups
      .filter((g) => g.exportableCount > 0)
      .map((g) => ({ ...g, items: g.items.filter((i) => i.exportable) }));
  }
  return groups;
}

// The selection map for the active tab — device removal is tracked separately
// from add/export selection.
function currentSelection() {
  return state.tab === 'device' ? state.deviceSelected : state.selected;
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

  if (state.tab === 'device' && !state.device) {
    list.innerHTML = driveSelected() || state.deviceLoading
      ? '<li class="empty">Reading device…</li>'
      : "<li class=\"empty\">Select a drive above to see what's on it.</li>";
    return;
  }

  if (groups.length === 0) {
    if (state.tab === 'device') {
      list.innerHTML = driveSelected()
        ? '<li class="empty">No audio on this device.</li>'
        : '<li class="empty">No drive selected — pick one above.</li>';
      return;
    }
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
    const empty = { podcasts: 'Select a show', files: 'No folder selected', device: 'Nothing on device' };
    $('group-title').textContent = empty[state.tab] || 'Select a show';
    $('group-meta').textContent = '';
    return;
  }

  $('group-title').textContent = group.title;
  const total = group.items.length;
  $('group-meta').textContent =
    state.tab === 'podcasts'
      ? `${group.exportableCount} downloaded · ${total} shown`
      : state.tab === 'device'
        ? `${total} file(s) on device`
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
    cb.checked = currentSelection().has(item.id);
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
    if (item.statusTitle) status.title = item.statusTitle;

    if (playingId === item.id) li.classList.add('playing');
    li.appendChild(cb);
    li.appendChild(main);
    li.appendChild(preview);

    // Flag candidates already present on the device (add tabs only).
    if (state.tab !== 'device' && item.trackKey && state.deviceKeys.has(item.trackKey)) {
      const flag = document.createElement('div');
      flag.className = 'on-device';
      flag.textContent = '✓ On device';
      li.appendChild(flag);
    }

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
  if (state.tab === 'device') {
    if (checked) state.deviceSelected.set(item.id, { srcPath: item.srcPath });
    else state.deviceSelected.delete(item.id);
    updateSelectionUI();
    return;
  }
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
  const n = currentSelection().size;
  $('selection-count').textContent = `${n} selected`;
  if (state.tab === 'device') $('remove').disabled = n === 0;
  else $('export').disabled = n === 0;
}

// --- tabs --------------------------------------------------------------

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );

  const isDevice = tab === 'device';
  $('scan-bar').classList.toggle('hidden', tab !== 'files');
  $('rescan').classList.toggle('hidden', tab !== 'files' || !state.files);
  $('filter-toggle').closest('.toggle').classList.toggle('hidden', isDevice);
  $('filter-label').textContent = tab === 'podcasts' ? 'Downloaded only' : 'Exportable only';
  $('filter-toggle').checked = !!state.filterExportable[tab];
  $('select-all').textContent = isDevice
    ? 'Select all'
    : tab === 'podcasts'
      ? 'Select all downloaded'
      : 'Select all exportable';

  // Footer action: Export on the add tabs, Remove on the device tab.
  $('options-row').classList.toggle('hidden', isDevice);
  $('export').classList.toggle('hidden', isDevice);
  $('remove').classList.toggle('hidden', !isDevice);

  if (tab === 'podcasts' && state.podcasts === null) loadLibrary();
  if (isDevice && state.device === null && driveSelected()) loadDevice();

  renderGroups();
  renderItems();
  updateSelectionUI();
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

function driveSelected() {
  return !!$('drive').value;
}

// Reads the selected drive's contents for the On Device tab.
async function loadDevice() {
  const mount = $('drive').value;
  if (!mount) {
    state.device = null;
    if (state.tab === 'device') {
      renderGroups();
      renderItems();
    }
    return;
  }
  state.deviceLoading = true;
  if (state.tab === 'device') renderGroups();
  try {
    state.device = await api.listDevice(mount);
    state.activeGroup.device = null;
  } catch (err) {
    state.device = { groups: [] };
    toast(err.message);
  } finally {
    state.deviceLoading = false;
    if (state.tab === 'device') {
      renderGroups();
      renderItems();
    }
  }
}

// Fetches the set of match keys for what's on the device, so the Podcasts/Files
// tabs can flag items already there. Refreshed whenever the device or drive
// could have changed.
async function refreshDeviceKeys() {
  const mount = $('drive').value;
  try {
    state.deviceKeys = mount ? new Set(await api.deviceIndex(mount)) : new Set();
  } catch {
    state.deviceKeys = new Set();
  }
  if (state.tab !== 'device') renderItems();
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

  // What's on the device just changed — re-read it and refresh dedup flags.
  state.device = null;
  refreshDeviceKeys();
  if (state.tab === 'device') loadDevice();
}

// --- remove from device ------------------------------------------------

async function runRemove() {
  const mount = $('drive').value;
  if (!mount) {
    toast('Select the device drive first.');
    return;
  }
  const paths = Array.from(state.deviceSelected.values()).map((v) => v.srcPath);
  if (paths.length === 0) return;

  const ok = window.confirm(
    `Permanently remove ${paths.length} file(s) from the device?\n\nThis cannot be undone.`
  );
  if (!ok) return;

  try {
    const res = await api.removeFromDevice(mount, paths);
    state.deviceSelected.clear();
    toast(
      res.errors.length
        ? `Removed ${res.removed.length}, ${res.errors.length} failed.`
        : `Removed ${res.removed.length} file(s).`
    );
  } catch (err) {
    toast(err.message);
  }
  await loadDevice();
  await refreshDeviceKeys();
  updateSelectionUI();
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
    state.device = null;
    refreshDeviceKeys();
    if (state.tab === 'device') loadDevice();
  });

  $('select-all').addEventListener('click', () => {
    const group = activeGroupData();
    if (!group) return;
    for (const item of group.items) if (item.exportable) toggleItem(item, true);
    renderItems();
  });
  $('clear-sel').addEventListener('click', () => {
    currentSelection().clear();
    updateSelectionUI();
    renderItems();
  });

  $('export').addEventListener('click', runExport);
  $('remove').addEventListener('click', runRemove);
  $('drive').addEventListener('change', () => {
    state.device = null;
    refreshDeviceKeys();
    if (state.tab === 'device') loadDevice();
  });
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
loadDrives().then(refreshDeviceKeys); // populate dedup flags once a drive is known
setTab('podcasts'); // normalize initial tab state + trigger library load
updateSelectionUI();
