const DB_NAME = 'vibeai-library';
const DB_VERSION = 1;
const STORE_NAME = 'app';
const STATE_KEY = 'library-state';
const DEFAULT_STATE = { tracks: [], playlists: [], liked: [], currentTrackId: null, currentTime: 0, volume: 0.8, shuffle: false, repeat: false, recent: [] };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const audio = $('#audio-player');
let db;
let state = { ...DEFAULT_STATE };
let activeView = 'home';
let activePlaylistId = null;
let menuTrackId = null;
let toastTimer;
let saveTimer;
let objectUrls = new Map();

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function readState() {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(STATE_KEY);
    request.onsuccess = () => resolve(request.result || { ...DEFAULT_STATE });
    request.onerror = () => reject(request.error);
  });
}
function persist() {
  if (!db) return;
  try {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(state, STATE_KEY);
  } catch (error) { console.warn('Could not save your library.', error); }
}
function makeId() { return globalThis.crypto?.randomUUID?.() || `track-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  return `${mins}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function titleFromFile(name) { return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled track'; }
function getTrack(id) { return state.tracks.find(track => track.id === id); }
function getTrackUrl(track) {
  if (!track?.file) return '';
  if (!objectUrls.has(track.id)) objectUrls.set(track.id, URL.createObjectURL(track.file));
  return objectUrls.get(track.id);
}
function notify(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
}
function persistDebounced() { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 300); }
function init() {
  bindEvents();
  openDatabase().then(async database => {
    db = database;
    state = { ...DEFAULT_STATE, ...(await readState()) };
    state.tracks = Array.isArray(state.tracks) ? state.tracks : [];
    state.playlists = Array.isArray(state.playlists) ? state.playlists : [];
    state.liked = Array.isArray(state.liked) ? state.liked : [];
    state.recent = Array.isArray(state.recent) ? state.recent : [];
    audio.volume = Number.isFinite(state.volume) ? state.volume : 0.8;
    $('#volume-slider').value = audio.volume;
    $('#shuffle-button').classList.toggle('selected', !!state.shuffle);
    $('#repeat-button').classList.toggle('selected', !!state.repeat);
    renderAll();
    if (state.currentTrackId && getTrack(state.currentTrackId)) {
      loadTrack(state.currentTrackId, false);
      audio.addEventListener('loadedmetadata', () => { audio.currentTime = Math.min(state.currentTime || 0, audio.duration || 0); }, { once: true });
    }
  }).catch(error => {
    console.error('VibeAI storage is unavailable:', error);
    $('#library-status').textContent = 'Local storage unavailable';
    renderAll();
    notify('Your browser could not open local music storage.');
  });
}
function bindEvents() {
  ['#upload-trigger', '#hero-upload', '#empty-upload'].forEach(selector => $(selector).addEventListener('click', () => $('#music-input').click()));
  $('#music-input').addEventListener('change', event => { addFiles([...event.target.files]); event.target.value = ''; });
  $('#create-playlist').addEventListener('click', createPlaylist);
  $('#playlist-form').addEventListener('submit', event => { event.preventDefault(); savePlaylist(); });
  $('#playlist-form').addEventListener('click', event => { if (event.target.value === 'cancel') $('#playlist-dialog').close(); });
  $('#search-input').addEventListener('input', renderTracks);
  $$('.nav-link').forEach(link => link.addEventListener('click', event => { event.preventDefault(); setView(link.dataset.view); }));
  $('#track-list').addEventListener('click', onTrackListClick);
  $('#recommendation-list').addEventListener('click', event => {
    const card = event.target.closest('[data-track-id]');
    if (card) playTrack(card.dataset.trackId);
  });
  $('#playlist-nav').addEventListener('click', event => {
    const button = event.target.closest('[data-playlist-id]');
    if (button) { activePlaylistId = button.dataset.playlistId; activeView = 'playlist'; renderAll(); }
  });
  $('#play-button').addEventListener('click', togglePlayback);
  $('#previous-button').addEventListener('click', previousTrack);
  $('#next-button').addEventListener('click', () => advanceTrack());
  $('#shuffle-button').addEventListener('click', () => { state.shuffle = !state.shuffle; $('#shuffle-button').classList.toggle('selected', state.shuffle); persist(); });
  $('#repeat-button').addEventListener('click', () => { state.repeat = !state.repeat; $('#repeat-button').classList.toggle('selected', state.repeat); persist(); });
  $('#player-like').addEventListener('click', () => toggleLike(state.currentTrackId));
  $('#seek-bar').addEventListener('input', event => { if (audio.duration) audio.currentTime = audio.duration * Number(event.target.value) / 100; });
  $('#volume-slider').addEventListener('input', event => { audio.volume = Number(event.target.value); state.volume = audio.volume; persistDebounced(); });
  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('loadedmetadata', updateProgress);
  audio.addEventListener('play', () => { $('#play-button').textContent = 'Ⅱ'; $('#play-button').setAttribute('aria-label', 'Pause'); });
  audio.addEventListener('pause', () => { $('#play-button').textContent = '▶'; $('#play-button').setAttribute('aria-label', 'Play'); persistDebounced(); });
  audio.addEventListener('ended', () => state.repeat ? (audio.currentTime = 0, audio.play()) : advanceTrack());
  audio.addEventListener('error', () => notify('This audio file could not be played.'));
  $('#track-dialog').addEventListener('click', event => { if (event.target.value === 'cancel') $('#track-dialog').close(); });
  $('#menu-play-next').addEventListener('click', event => { event.preventDefault(); playTrack(menuTrackId); $('#track-dialog').close(); });
  $('#menu-toggle-like').addEventListener('click', event => { event.preventEvent(); toggleLike(menuTrackId); $('#track-dialog').close(); });
  $('#menu-add-playlist').addEventListener('click', event => { event.preventDefault(); $('#track-dialog').close(); openPlaylistPicker(); });
  $('#menu-remove-track').addEventListener('click', event => { event.preventDefault(); removeTrack(menuTrackId); $('#track-dialog').close(); });
  $('#playlist-picker-list').addEventListener('click', event => {
    const button = event.target.closest('[data-playlist-id]');
    if (button) { addToPlaylist(menuTrackId, button.dataset.playlistId); $('#playlist-picker-dialog').close(); }
  });
  window.addEventListener('beforeunload', persist);
}
async function addFiles(files) {
  const accepted = files.filter(file => file.type.startsWith('audio/') || /\.(mp3|m4a|aac|ogg|oga|wav|flac|opus|webm)$/i.test(file.name));
  if (!accepted.length) return notify('Choose an audio file to add to your library.');
  const added = accepted.map(file => {
    const title = titleFromFile(file.name);
    const artistGuess = title.includes(' - ') ? title.split(' - ').slice(0, -1).join(' - ').trim() : 'Your library';
    const trackTitle = title.includes(' - ') ? title.split(' - ').slice(-1)[0].trim() : title;
    const track = { id: makeId(), title: trackTitle, artist: artistGuess, name: file.name, size: file.size, type: file.type, addedAt: Date.now(), plays: 0, file };
    state.tracks.push(track);
    return track;
  });
  if (activePlaylistId) added.forEach(track => addToPlaylist(track.id, activePlaylistId, false));
  persist(); renderAll(); notify(`${added.length} ${added.length === 1 ? 'track' : 'tracks'} added to your library.`);
  if (!state.currentTrackId) playTrack(added[0].id);
}
function createPlaylist() { $('#playlist-name').value = ''; $('#playlist-dialog').showModal(); $('#playlist-name').focus(); }
function savePlaylist() {
  const name = $('#playlist-name').value.trim();
  if (!name) return;
  const playlist = { id: makeId(), name, trackIds: [], createdAt: Date.now() };
  state.playlists.unshift(playlist);
  activePlaylistId = playlist.id;
  activeView = 'playlist';
  persist(); $('#playlist-dialog').close(); renderAll(); notify(`“${name}” playlist created.`);
}
function addToPlaylist(trackId, playlistId, shouldPersist = true) {
  const playlist = state.playlists.find(item => item.id === playlistId);
  if (!playlist || !trackId) return;
  if (!playlist.trackIds.includes(trackId)) playlist.trackIds.push(trackId);
  if (shouldPersist) { persist(); renderAll(); notify(`Added to ${playlist.name}.`); }
}
function openPlaylistPicker() {
  const list = $('#playlist-picker-list');
  if (!state.playlists.length) {
    list.innerHTML = '<p class="picker-empty">You have no playlists yet.</p><button class="button button-primary" id="picker-create-playlist" type="button">＋ Create playlist</button>';
    $('#picker-create-playlist').addEventListener('click', () => { $('#playlist-picker-dialog').close(); createPlaylist(); });
  } else {
    list.innerHTML = state.playlists.map(playlist => `<button class="picker-option" type="button" data-playlist-id="${escapeHTML(playlist.id)}"><span class="playlist-cover">♫</span><span>${escapeHTML(playlist.name)}</span><span class="picker-count">${playlist.trackIds.length}</span></button>`).join('');
  }
  $('#playlist-picker-dialog').showModal();
}
function removeTrack(trackId) {
  if (!trackId) return;
  const track = getTrack(trackId);
  state.tracks = state.tracks.filter(item => item.id !== trackId);
  state.liked = state.liked.filter(id => id !== trackId);
  state.playlists.forEach(playlist => playlist.trackIds = playlist.trackIds.filter(id => id !== trackId));
  state.recent = state.recent.filter(id => id !== trackId);
  if (state.currentTrackId === trackId) { audio.pause(); audio.removeAttribute('src'); state.currentTrackId = null; state.currentTime = 0; updatePlayer(null); }
  if (objectUrls.has(trackId)) { URL.revokeObjectURL(objectUrls.get(trackId)); objectUrls.delete(trackId); }
  persist(); renderAll(); notify(`Removed “${track?.title || 'track'}” from your library.`);
}
function toggleLike(trackId) {
  if (!trackId || !getTrack(trackId)) return;
  state.liked = state.liked.includes(trackId) ? state.liked.filter(id => id !== trackId) : [...state.liked, trackId];
  persist(); renderAll();
}
function loadTrack(trackId, autoplay = true) {
  const track = getTrack(trackId);
  if (!track) return;
  state.currentTrackId = trackId;
  audio.src = getTrackUrl(track);
  audio.load();
  updatePlayer(track);
  if (autoplay) audio.play().catch(() => notify('Press play to start listening.'));
  state.recent = [trackId, ...state.recent.filter(id => id !== trackId)].slice(0, 30);
  if (autoplay) track.plays = (track.plays || 0) + 1;
  persist(); renderRecommendations(); renderTracks();
}
function playTrack(trackId) { if (trackId === state.currentTrackId && audio.src) return togglePlayback(); loadTrack(trackId, true); }
function togglePlayback() {
  if (!state.currentTrackId) { const first = visibleTracks()[0] || state.tracks[0]; if (first) playTrack(first.id); return; }
  if (audio.paused) audio.play().catch(() => notify('This track could not be played.')); else audio.pause();
}
function getQueue() {
  if (activeView === 'playlist') return getPlaylistTracks(activePlaylistId);
  if (activeView === 'liked') return state.tracks.filter(track => state.liked.includes(track.id));
  return visibleTracks();
}
function advanceTrack() {
  const queue = getQueue().length ? getQueue() : state.tracks;
  if (!queue.length) return;
  if (state.shuffle) {
    const choices = queue.filter(track => track.id !== state.currentTrackId);
    if (choices.length) return playTrack(choices[Math.floor(Math.random() * choices.length)].id);
  }
  const index = queue.findIndex(track => track.id === state.currentTrackId);
  playTrack(queue[(index + 1 + queue.length) % queue.length].id);
}
function previousTrack() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  const queue = getQueue().length ? getQueue() : state.tracks;
  const index = queue.findIndex(track => track.id === state.currentTrackId);
  if (queue.length) playTrack(queue[(index - 1 + queue.length) % queue.length].id);
}
function updateProgress() {
  const percent = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  $('#seek-bar').value = percent;
  $('#current-time').textContent = formatTime(audio.currentTime);
  $('#duration').textContent = formatTime(audio.duration);
  if (state.currentTrackId) { state.currentTime = audio.currentTime || 0; persistDebounced(); }
}
function updatePlayer(track) {
  $('#player-title').textContent = track?.title || 'Choose a track';
  $('#player-artist').textContent = track?.artist || 'Your music will appear here';
  $('#player-like').textContent = track && state.liked.includes(track.id) ? '♥' : '♡';
  $('#player-like').classList.toggle('liked', !!track && state.liked.includes(track.id));
  $('#player-art').textContent = track ? track.title.charAt(0).toUpperCase() : '♫';
  $('#current-time').textContent = '0:00'; $('#duration').textContent = '0:00'; $('#seek-bar').value = 0;
}
function visibleTracks() {
  let tracks = [...state.tracks];
  if (activeView === 'playlist') tracks = getPlaylistTracks(activePlaylistId);
  if (activeView === 'liked') tracks = tracks.filter(track => state.liked.includes(track.id));
  if (activeView === 'recommendations') tracks = getRecommendations();
  const query = $('#search-input').value.trim().toLowerCase();
  if (query) tracks = tracks.filter(track => `${track.title} ${track.artist} ${track.name}`.toLowerCase().includes(query));
  return tracks;
}
function getPlaylistTracks(playlistId) {
  const playlist = state.playlists.find(item => item.id === playlistId);
  return playlist ? playlist.trackIds.map(getTrack).filter(Boolean) : [];
}
function getRecommendations() {
  const current = getTrack(state.currentTrackId);
  return state.tracks.filter(track => track.id !== current?.id).map(track => {
    let score = (track.plays || 0) * 1.5;
    if (state.liked.includes(track.id)) score += 5;
    if (state.recent.includes(track.id)) score += 2;
    if (current && current.artist !== 'Your library' && track.artist === current.artist) score += 4;
    const currentWords = (current?.title || '').toLowerCase().split(/\W+/).filter(word => word.length > 3);
    const sharedWords = currentWords.filter(word => track.title.toLowerCase().includes(word)).length;
    score += sharedWords * 1.25;
    score += Math.max(0, 1 - (Date.now() - track.addedAt) / (1000 * 60 * 60 * 24 * 30));
    return { track, score };
  }).sort((a, b) => b.score - a.score || b.track.addedAt - a.track.addedAt).slice(0, 4).map(item => item.track);
}
function renderAll() { renderPlaylistNav(); renderTracks(); renderRecommendations(); updatePlayer(getTrack(state.currentTrackId)); }
function renderPlaylistNav() {
  $('#playlist-nav').innerHTML = state.playlists.map(playlist => `<li><button class="playlist-link ${activeView === 'playlist' && activePlaylistId === playlist.id ? 'active' : ''}" data-playlist-id="${escapeHTML(playlist.id)}"><span class="playlist-cover">♫</span><span class="playlist-name">${escapeHTML(playlist.name)}</span><span class="playlist-size">${playlist.trackIds.length}</span></button></li>`).join('');
}
function renderTracks() {
  const tracks = visibleTracks();
  const list = $('#track-list');
  $('#empty-state').hidden = state.tracks.length > 0;
  $('#track-count').textContent = activeView === 'playlist' ? `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}` : `${state.tracks.length} ${state.tracks.length === 1 ? 'track' : 'tracks'}`;
  $('#library-title').textContent = activeView === 'playlist' ? (state.playlists.find(item => item.id === activePlaylistId)?.name || 'Playlist') : activeView === 'liked' ? 'Liked songs' : activeView === 'recommendations' ? 'For you' : 'Your library';
  $('#library-eyebrow').textContent = activeView === 'playlist' ? 'YOUR PLAYLIST' : activeView === 'liked' ? 'YOUR FAVORITES' : activeView === 'recommendations' ? 'MADE FOR YOUR TASTE' : 'YOUR COLLECTION';
  if (activeView === 'playlist' && tracks.length === 0) {
    $('#empty-state').hidden = false;
    $('#empty-state h3').textContent = 'This playlist is ready for a soundtrack';
    $('#empty-state p').textContent = 'Use a track’s options menu to add music, or upload tracks while this playlist is selected.';
  } else {
    $('#empty-state h3').textContent = 'Your next favorite is waiting';
    $('#empty-state p').textContent = 'Upload audio files from your device to start building your personal library.';
  }
  list.innerHTML = tracks.map((track, index) => `<div class="track-row ${track.id === state.currentTrackId ? 'playing' : ''}" data-track-id="${escapeHTML(track.id)}"><button class="track-number" data-action="play" aria-label="Play ${escapeHTML(track.title)}">${track.id === state.currentTrackId && !audio.paused ? '♫' : String(index + 1).padStart(2, '0')}</button><button class="track-title-cell" data-action="play"><span class="track-thumb">${escapeHTML(track.title.charAt(0).toUpperCase())}</span><span class="track-text"><strong>${escapeHTML(track.title)}</strong><small>${escapeHTML(track.artist)}</small></span></button><span class="track-added">${new Date(track.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span><span class="track-duration">${track.id === state.currentTrackId ? formatTime(audio.duration) : '—:—'}</span><div class="track-actions"><button class="icon-button row-like ${state.liked.includes(track.id) ? 'liked' : ''}" data-action="like" aria-label="${state.liked.includes(track.id) ? 'Unlike' : 'Like'} ${escapeHTML(track.title)}">${state.liked.includes(track.id) ? '♥' : '♡'}</button><button class="icon-button more-button" data-action="more" aria-label="More options for ${escapeHTML(track.title)}" title="More options">⋯</button></div></div>`).join('');
}
function renderRecommendations() {
  const recommendations = getRecommendations();
  const list = $('#recommendation-list');
  $('#recommendation-note').textContent = state.tracks.length < 2 ? 'Upload more music to get started' : 'A mix of your favorites and recent plays';
  list.innerHTML = recommendations.length ? recommendations.map((track, index) => `<button class="recommendation-card card-tone-${index + 1}" data-track-id="${escapeHTML(track.id)}"><span class="recommendation-art">${escapeHTML(track.title.charAt(0).toUpperCase())}<i>♫</i></span><span class="recommendation-meta"><strong>${escapeHTML(track.title)}</strong><small>${escapeHTML(track.artist)}</small></span><span class="recommendation-play">▶</span></button>`).join('') : `<div class="recommendation-placeholder"><span>✦</span><div><strong>Your next discovery starts here</strong><small>Add at least two tracks and we’ll make a personal mix from your library.</small></div></div>`;
}
function onTrackListClick(event) {
  const action = event.target.closest('[data-action]');
  if (!action) return;
  const row = action.closest('[data-track-id]');
  const id = row?.dataset.trackId;
  if (action.dataset.action === 'play') playTrack(id);
  if (action.dataset.action === 'like') toggleLike(id);
  if (action.dataset.action === 'more') {
    menuTrackId = id;
    const track = getTrack(id);
    $('#track-menu-title').textContent = track?.title || 'Track options';
    $('#menu-toggle-like').querySelector('span').textContent = state.liked.includes(id) ? 'Remove from liked songs' : 'Like song';
    $('#track-dialog').showModal();
  }
}
function setView(view) {
  activeView = view;
  activePlaylistId = null;
  $$('.nav-link').forEach(link => link.classList.toggle('active', link.dataset.view === view));
  renderAll();
  $('.library-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.addEventListener('DOMContentLoaded', init);
