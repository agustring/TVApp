/*
 * Created by Agustin Copita in 2026 for the exclusive use of Agustin Copita.
 * © 2026 Agustin Copita. All rights reserved.
 */
/**
 * TVApp (full name: TuViejapp) - Samsung Smart TV video player (Tizen Web App)
 * ---------------------------------------------------------------------------
 * The app is a small state machine with three views. Only one is ever visible,
 * and each view owns its own rendering and its own key handling:
 *
 *   'grid'   Netflix-style card grid of the files on the local HTTP server.
 *            The focused card scales up and plays a muted inline preview.
 *   'url'    Type or pick an HTTP(S) streaming URL (HLS .m3u8 / DASH .mpd).
 *   'player' Fullscreen playback through Tizen AVPlay with a custom overlay.
 *
 * Playback uses webapis.avplay rather than <video> so that containers and
 * codecs the browser cannot decode (MKV, AVI, TS, HEVC, ...) still play.
 *
 * Two different players are in use on purpose:
 *   - AVPlay          for fullscreen playback (broad codec support, one
 *                     hardware decoder instance, so only ever one at a time).
 *   - HTML5 <video>   for the small muted grid preview. A single shared
 *                     element is moved between cards; spawning one decoder
 *                     per card would exhaust the TV's resources. Previews of
 *                     MKV/AVI simply fail silently and keep the placeholder,
 *                     while fullscreen playback of those files still works.
 */

'use strict';

/* ===========================================================================
 * 1. CONFIGURATION
 * ======================================================================== */

// Local HTTP server listing the video folder. Trailing slash is required.
var SERVER_URL = 'http://192.168.1.252:8001/';

// Files offered in the grid. AVPlay handles far more than <video>, so the
// list is deliberately wider than what the preview can render.
var MEDIA_EXTENSIONS = ['.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.ts'];

var SKIP_MS             = 10000;  // Left/Right seek step
var CONTROLS_TIMEOUT_MS = 4000;   // overlay auto-hide delay
var PREVIEW_DELAY_MS    = 700;    // dwell time before a preview starts

/**
 * Preset streams for the URL view.
 *
 * NOTE ON DRM: these are all clear (unencrypted) streams. Commercial services
 * such as YouTube, Netflix, Disney+ or Prime Video are explicitly OUT OF SCOPE
 * and cannot be played this way. Their catalogues are protected by Widevine /
 * PlayReady DRM and are only reachable through each provider's licensed app,
 * so no URL you can paste here will play them. AVPlay *can* do DRM, but it
 * requires a licence-server handshake plus the drmplay privilege and a
 * commercial agreement with the content owner.
 */
var PRESET_STREAMS = [
    { name: 'Apple HLS (fMP4)',  url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8' },
    { name: 'Mux HLS test',      url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
    { name: 'Big Buck Bunny DASH', url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd' },
    { name: 'Tears of Steel DASH', url: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.mpd' }
];

/* ===========================================================================
 * 2. STATE
 * ======================================================================== */

var state = 'grid';       // 'grid' | 'url' | 'player'

var items = [];           // grid entries: { type:'action'|'folder'|'video', ... }
var gridIndex = 0;        // focused card

// Folder browsing. currentPath is kept URL-ENCODED and always ends in '/'
// (empty string at the root), so a child link is simply
// SERVER_URL + currentPath + href with no re-encoding anywhere.
var currentPath = '';
// Remembers the focused card per folder, so backing out of a folder returns
// the selection to where it was instead of jumping to the top.
var focusMemory = {};

var urlRows = [];         // focusable rows in the URL view
var urlIndex = 0;
var urlInputFocused = false;   // true while the TV on-screen keyboard is open

var previewEl = null;     // the single shared HTML5 <video> preview element
var previewTimer = null;

var player = {            // player-view runtime state
    open: false,          // an AVPlay session is open (needs close())
    playing: false,
    durationMs: 0,
    positionMs: 0,
    title: ''
};
var controlsTimer = null;

// DOM references, resolved in init()
var el = {};

/* ===========================================================================
 * 3. BOOTSTRAP
 * ======================================================================== */

window.onload = function () {
    cacheDom();
    registerRemoteKeys();
    buildUrlView();

    document.addEventListener('keydown', onKeyDown);

    showView('grid');
    loadLibrary();
};

function cacheDom() {
    el.gridView    = document.getElementById('grid-view');
    el.urlView     = document.getElementById('url-view');
    el.playerView  = document.getElementById('player-view');

    el.status      = document.getElementById('status');
    el.breadcrumb  = document.getElementById('breadcrumb');
    el.backHint    = document.getElementById('back-hint');
    el.grid        = document.getElementById('grid');
    el.gridScroll  = document.getElementById('grid-scroll');

    el.urlRows     = document.getElementById('url-rows');
    el.urlInputRow = document.getElementById('url-input-row');
    el.urlPlayRow  = document.getElementById('url-play-row');
    el.urlInput    = document.getElementById('url-input');

    el.controls    = document.getElementById('controls');
    el.nowPlaying  = document.getElementById('now-playing');
    el.timeCurrent = document.getElementById('time-current');
    el.timeTotal   = document.getElementById('time-total');
    el.seekProgress= document.getElementById('seek-progress');
    el.seekBuffered= document.getElementById('seek-buffered');
    el.seekKnob    = document.getElementById('seek-knob');
    el.playPause   = document.getElementById('btn-playpause');
    el.buffering   = document.getElementById('buffering');
    el.bufferText  = document.getElementById('buffering-text');
}

/**
 * Arrow keys, Enter and RETURN(10009) reach a TV web app by default; the media
 * transport buttons do not, and must be claimed explicitly. Wrapped in
 * try/catch so the app still runs in a desktop browser or the simulator.
 */
function registerRemoteKeys() {
    try {
        var keys = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
                    'MediaRewind', 'MediaFastForward'];
        for (var i = 0; i < keys.length; i++) {
            try { tizen.tvinputdevice.registerKey(keys[i]); } catch (inner) {}
        }
    } catch (e) {
        // Not running on a TV - remote keys simply stay unregistered.
    }
}

/* ===========================================================================
 * 4. VIEW MANAGER
 * ======================================================================== */

function showView(next) {
    state = next;

    el.gridView.classList.toggle('hidden',   next !== 'grid');
    el.urlView.classList.toggle('hidden',    next !== 'url');
    el.playerView.classList.toggle('hidden', next !== 'player');

    // AVPlay draws behind the page, so the body must stop painting over it.
    document.body.classList.toggle('player-active', next === 'player');

    if (next === 'grid') {
        focusCard(gridIndex);          // restarts the preview for the card
    } else {
        stopPreview();                 // never leave a decoder running
    }

    if (next === 'url') {
        focusUrlRow(urlIndex);
    }
}

/* ===========================================================================
 * 5. LIBRARY LOADING  (unchanged fetch + directory-listing parsing)
 * ======================================================================== */

/**
 * Loads one folder listing. `path` is the encoded path relative to the server
 * root ('' for the root itself) and always ends in '/'.
 */
function loadLibrary(path) {
    currentPath = path || '';
    updateBreadcrumb();
    el.status.textContent = 'Loading...';

    fetch(SERVER_URL + currentPath)
        .then(function (response) {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            return response.text();
        })
        .then(function (html) {
            var entries = parseDirectoryListing(html);

            // The streaming-URL entry is modelled as the first grid card, so
            // that grid navigation stays uniform and needs no extra focus zone.
            // It belongs to the library root only; inside a folder the grid is
            // purely that folder's contents.
            items = (currentPath === ''
                        ? [{ type: 'action', name: 'Open streaming URL' }]
                        : []).concat(entries);

            var folders = countType(entries, 'folder');
            var videos  = countType(entries, 'video');
            el.status.textContent = describeContents(folders, videos);

            // Restore the previous selection for this folder if we have one,
            // otherwise start on the first real entry rather than the URL card.
            gridIndex = focusMemory[currentPath];
            if (typeof gridIndex !== 'number' || gridIndex >= items.length) {
                gridIndex = (currentPath === '' && entries.length > 0) ? 1 : 0;
            }
            el.gridScroll.scrollTop = 0;
            renderGrid();
        })
        .catch(function (err) {
            // The streaming view stays usable even with no local server.
            items = (currentPath === ''
                        ? [{ type: 'action', name: 'Open streaming URL' }]
                        : []);
            el.status.textContent =
                'Could not reach ' + SERVER_URL + currentPath +
                ' (' + err.message + ').' +
                (currentPath === '' ? ' Streaming URLs are still available.' : '');
            gridIndex = 0;
            renderGrid();
        });
}

function countType(entries, type) {
    var n = 0;
    for (var i = 0; i < entries.length; i++) {
        if (entries[i].type === type) { n++; }
    }
    return n;
}

function describeContents(folders, videos) {
    var parts = [];
    if (folders > 0) { parts.push(folders + ' folder' + (folders === 1 ? '' : 's')); }
    if (videos > 0)  { parts.push(videos + ' video' + (videos === 1 ? '' : 's')); }
    return parts.length ? parts.join(', ') : 'This folder is empty.';
}

/**
 * `python -m http.server` (and the Node equivalent used here) return a plain
 * HTML page with one <a href="...">name</a> per entry. Subdirectories are
 * distinguished by a trailing slash on the href; files are kept when their
 * extension is in MEDIA_EXTENSIONS.
 *
 * The server already hides folders that contain no playable video, so every
 * folder link that arrives here is worth showing.
 */
function parseDirectoryListing(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var links = doc.querySelectorAll('a[href]');
    var result = [];

    for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute('href');

        // Ignore anything that would climb out of the current folder or point
        // at another host: only relative child links are navigable.
        if (!href || href.charAt(0) === '/' || href.indexOf('..') === 0 ||
            href.indexOf('://') !== -1) {
            continue;
        }

        if (href.charAt(href.length - 1) === '/') {
            result.push({
                type: 'folder',
                name: decodeURIComponent(href.slice(0, -1)),
                path: currentPath + href          // stays encoded
            });
        } else if (hasMediaExtension(href)) {
            result.push({
                type: 'video',
                // hrefs are URL-encoded ("my%20movie.mkv"): decode for display,
                // keep the encoded form in the URL actually requested.
                name: decodeURIComponent(href),
                url: SERVER_URL + currentPath + href
            });
        }
    }
    return result;
}

/* ---- folder navigation ------------------------------------------------- */

function enterFolder(item) {
    focusMemory[currentPath] = gridIndex;   // so RETURN comes back here
    stopPreview();
    loadLibrary(item.path);
}

/** Drops the last segment of currentPath. Returns false if already at root. */
function goUpFolder() {
    if (currentPath === '') {
        return false;
    }
    var trimmed = currentPath.slice(0, -1);            // strip trailing '/'
    var cut = trimmed.lastIndexOf('/');
    stopPreview();
    loadLibrary(cut === -1 ? '' : trimmed.slice(0, cut + 1));
    return true;
}

function updateBreadcrumb() {
    el.breadcrumb.textContent = currentPath === ''
        ? '/' : '/' + decodeURIComponent(currentPath);
    // At the root there is nowhere to go back to, so RETURN leaves the app.
    el.backHint.textContent = currentPath === ''
        ? 'RETURN Exit' : 'RETURN Up one folder';
}

function hasMediaExtension(href) {
    var lower = href.toLowerCase().split('?')[0];
    for (var i = 0; i < MEDIA_EXTENSIONS.length; i++) {
        if (lower.slice(-MEDIA_EXTENSIONS[i].length) === MEDIA_EXTENSIONS[i]) {
            return true;
        }
    }
    return false;
}

/* ===========================================================================
 * 6. GRID VIEW
 * ======================================================================== */

function renderGrid() {
    el.grid.innerHTML = '';

    for (var i = 0; i < items.length; i++) {
        el.grid.appendChild(buildCard(items[i]));
    }
    focusCard(gridIndex);
}

// Glyph shown while a card has no live preview.
var CARD_GLYPH = {
    action: '&#43;',        // +
    folder: '&#128193;',    // file folder
    video:  '&#9654;'       // play triangle
};

function buildCard(item) {
    var card = document.createElement('div');
    card.className = 'card card-' + item.type;

    var media = document.createElement('div');
    media.className = 'card-media';

    var glyph = document.createElement('div');
    glyph.className = 'card-fallback';
    glyph.innerHTML = CARD_GLYPH[item.type] || CARD_GLYPH.video;
    media.appendChild(glyph);

    var title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = item.name;

    card.appendChild(media);
    card.appendChild(title);
    return card;
}

/**
 * Column count is read back from the laid-out DOM rather than hard-coded, so
 * the CSS `auto-fill` grid stays the single source of truth for the layout.
 */
function getColumnCount() {
    var cards = el.grid.children;
    if (cards.length === 0) {
        return 1;
    }
    var firstTop = cards[0].offsetTop;
    var cols = 0;
    for (var i = 0; i < cards.length; i++) {
        if (cards[i].offsetTop !== firstTop) {
            break;
        }
        cols++;
    }
    return cols || 1;
}

function focusCard(index) {
    var cards = el.grid.children;
    if (cards.length === 0) {
        return;
    }
    gridIndex = Math.max(0, Math.min(cards.length - 1, index));

    for (var i = 0; i < cards.length; i++) {
        cards[i].classList.toggle('focused', i === gridIndex);
    }
    scrollCardIntoView(cards[gridIndex]);
    schedulePreview();
}

/* Manual scrolling: scrollIntoView() behaves inconsistently on older TV
   Chromium builds, and this keeps a margin around the focused card. */
function scrollCardIntoView(card) {
    var wrap = el.gridScroll;
    var margin = 60;
    var top = card.offsetTop;
    var bottom = top + card.offsetHeight;

    if (top - margin < wrap.scrollTop) {
        wrap.scrollTop = Math.max(0, top - margin);
    } else if (bottom + margin > wrap.scrollTop + wrap.clientHeight) {
        wrap.scrollTop = bottom + margin - wrap.clientHeight;
    }
}

function moveGridFocus(dx, dy) {
    var cols = getColumnCount();
    var index = gridIndex;

    if (dx !== 0) {
        var target = index + dx;
        // Horizontal moves must stay on the same row (no wrap-around).
        if (target < 0 || target >= items.length ||
            Math.floor(target / cols) !== Math.floor(index / cols)) {
            return;
        }
        index = target;
    }

    if (dy !== 0) {
        var vTarget = index + dy * cols;
        if (vTarget < 0) {
            return;
        }
        if (vTarget >= items.length) {
            // Moving down into a partly filled last row: land on the last card.
            var lastRow = Math.floor((items.length - 1) / cols);
            if (dy > 0 && lastRow > Math.floor(index / cols)) {
                vTarget = items.length - 1;
            } else {
                return;
            }
        }
        index = vTarget;
    }

    focusCard(index);
}

/* ---- focused-card preview ---------------------------------------------- */

/**
 * Previews are debounced: holding an arrow key must not open and tear down a
 * decoder for every card that flashes past.
 */
function schedulePreview() {
    clearTimeout(previewTimer);
    stopPreview();

    var item = items[gridIndex];
    if (state !== 'grid' || !item || item.type !== 'video') {
        return;
    }
    previewTimer = setTimeout(function () {
        startPreview(item);
    }, PREVIEW_DELAY_MS);
}

function startPreview(item) {
    var card = el.grid.children[gridIndex];
    if (!card) {
        return;
    }

    if (!previewEl) {
        previewEl = document.createElement('video');
        previewEl.muted = true;          // TV policy: only muted media autoplays
        previewEl.autoplay = true;
        previewEl.loop = true;
        previewEl.setAttribute('muted', 'muted');
        // Reveal the card only once frames are actually being produced, so an
        // unsupported container never leaves a black rectangle behind.
        previewEl.addEventListener('playing', function () {
            if (previewEl.parentNode) {
                previewEl.parentNode.parentNode.classList.add('previewing');
            }
        });
    }

    card.querySelector('.card-media').appendChild(previewEl);
    previewEl.src = item.url;
    var attempt = previewEl.play();
    // Older TV builds return undefined instead of a promise.
    if (attempt && attempt.catch) {
        attempt.catch(function () { /* unsupported container - keep glyph */ });
    }
}

function stopPreview() {
    clearTimeout(previewTimer);
    if (!previewEl) {
        return;
    }
    previewEl.pause();
    previewEl.removeAttribute('src');
    previewEl.load();                    // releases the decoder

    if (previewEl.parentNode) {
        previewEl.parentNode.parentNode.classList.remove('previewing');
        previewEl.parentNode.removeChild(previewEl);
    }
}

function activateCard() {
    var item = items[gridIndex];
    if (!item) {
        return;
    }
    if (item.type === 'action') {
        showView('url');
    } else if (item.type === 'folder') {
        enterFolder(item);
    } else {
        stopPreview();
        startPlayback(item.url, item.name);
    }
}

/* ===========================================================================
 * 7. STREAMING-URL VIEW
 * ======================================================================== */

function buildUrlView() {
    for (var i = 0; i < PRESET_STREAMS.length; i++) {
        el.urlRows.appendChild(buildPresetRow(PRESET_STREAMS[i]));
    }
    // Row order: [0] text field, [1] play-typed-URL, [2..] presets
    urlRows = [el.urlInputRow, el.urlPlayRow].concat(
        Array.prototype.slice.call(
            el.urlRows.querySelectorAll('.url-preset')));

    // The TV keyboard closing must hand control back to the key handler.
    el.urlInput.addEventListener('blur', function () {
        urlInputFocused = false;
    });
}

function buildPresetRow(preset) {
    var row = document.createElement('div');
    row.className = 'url-row url-preset';
    row.setAttribute('data-url', preset.url);

    var name = document.createElement('span');
    name.className = 'url-preset-name';
    name.textContent = preset.name;

    var url = document.createElement('span');
    url.className = 'url-preset-url';
    url.textContent = preset.url;

    row.appendChild(name);
    row.appendChild(url);
    return row;
}

function focusUrlRow(index) {
    urlIndex = Math.max(0, Math.min(urlRows.length - 1, index));
    for (var i = 0; i < urlRows.length; i++) {
        urlRows[i].classList.toggle('focused', i === urlIndex);
    }
}

function activateUrlRow() {
    var row = urlRows[urlIndex];

    if (row === el.urlInputRow) {
        // Giving the field DOM focus is what raises the TV on-screen keyboard.
        urlInputFocused = true;
        el.urlInput.focus();
        return;
    }

    var url = (row === el.urlPlayRow)
        ? el.urlInput.value.trim()
        : row.getAttribute('data-url');

    if (!/^https?:\/\//i.test(url)) {
        el.urlInput.value = '';
        el.urlInput.placeholder = 'Enter a full http:// or https:// URL';
        return;
    }
    startPlayback(url, url.split('/').pop() || url);
}

/* ===========================================================================
 * 8. PLAYER VIEW - Tizen AVPlay
 * ======================================================================== */

/**
 * Full AVPlay open sequence. Order matters:
 *   open() -> setDisplayRect() -> setListener() -> prepareAsync() -> play()
 * setDisplayRect must run while the player object is laid out and before
 * prepare, otherwise the video plane has no geometry to draw into.
 */
function startPlayback(url, title) {
    if (typeof webapis === 'undefined' || !webapis.avplay) {
        el.status.textContent = 'AVPlay is unavailable (run this on a TV).';
        return;
    }

    player.title = title;
    player.durationMs = 0;
    player.positionMs = 0;
    player.playing = false;

    showView('player');
    el.nowPlaying.textContent = title;
    resetSeekUi();
    showBuffering(true, 'Loading...');
    showControls();

    try {
        closePlayer();                       // discard any previous session
        webapis.avplay.open(url);
        player.open = true;

        webapis.avplay.setDisplayRect(0, 0, 1920, 1080);
        try {
            // Letterbox keeps the source aspect ratio instead of stretching.
            webapis.avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
        } catch (ignore) { /* not supported on every firmware */ }

        webapis.avplay.setListener(avplayListener);
        webapis.avplay.prepareAsync(onPrepared, onPrepareError);
    } catch (e) {
        onPrepareError(e);
    }
}

function onPrepared() {
    showBuffering(false);

    try {
        player.durationMs = Number(webapis.avplay.getDuration()) || 0;
    } catch (e) {
        player.durationMs = 0;
    }
    // Live HLS/DASH report a duration of 0; there is nothing to seek within.
    el.timeTotal.textContent = player.durationMs > 0
        ? formatTime(player.durationMs) : 'LIVE';

    try {
        webapis.avplay.play();
        player.playing = true;
        updatePlayPauseGlyph();
    } catch (e) {
        onPrepareError(e);
        return;
    }
    showControls();
}

function onPrepareError(err) {
    var message = (err && err.message) ? err.message : String(err);
    showBuffering(false);
    stopPlaybackAndReturn('Could not play this item (' + message + ')');
}

/* ---- AVPlay listener callbacks ----------------------------------------- */

var avplayListener = {
    onbufferingstart: function () {
        showBuffering(true, 'Buffering...');
    },
    onbufferingprogress: function (percent) {
        showBuffering(true, 'Buffering ' + percent + '%');
        // Reuse the percentage as the "buffered" shading on the seek bar.
        if (player.durationMs > 0) {
            el.seekBuffered.style.width = percent + '%';
        }
    },
    onbufferingcomplete: function () {
        showBuffering(false);
    },
    oncurrentplaytime: function (currentTime) {
        player.positionMs = Number(currentTime) || 0;
        updateSeekUi();
    },
    onstreamcompleted: function () {
        // End of file: tear the session down and go back to the grid.
        stopPlaybackAndReturn();
    },
    onerror: function (eventType) {
        stopPlaybackAndReturn('Playback error: ' + eventType);
    },
    onevent: function (eventType, eventData) {
        // Informational only (bitrate changes, subtitle tracks, ...).
    },
    ondrmevent: function (drmEvent, drmData) {
        // DRM-protected streams are out of scope - see PRESET_STREAMS above.
    },
    onsubtitlechange: function (duration, text) {
        // No subtitle rendering in this version.
    }
};

/* ---- transport controls ------------------------------------------------ */

function togglePlayPause() {
    if (!player.open) {
        return;
    }
    try {
        if (player.playing) {
            webapis.avplay.pause();
            player.playing = false;
        } else {
            webapis.avplay.play();
            player.playing = true;
        }
        updatePlayPauseGlyph();
    } catch (e) { /* ignore transport races */ }
}

function skip(deltaMs) {
    if (!player.open || player.durationMs <= 0) {
        return;   // live streams have nothing to seek within
    }
    try {
        if (deltaMs > 0) {
            webapis.avplay.jumpForward(deltaMs);
        } else {
            webapis.avplay.jumpBackward(-deltaMs);
        }
        // Optimistic UI update; oncurrentplaytime corrects it a moment later.
        player.positionMs = Math.max(
            0, Math.min(player.durationMs, player.positionMs + deltaMs));
        updateSeekUi();
        flashSkipHint(deltaMs);
    } catch (e) { /* seek not possible in the current state */ }
}

function flashSkipHint(deltaMs) {
    var btn = deltaMs > 0
        ? document.getElementById('btn-fwd10')
        : document.getElementById('btn-back10');
    btn.classList.add('ctrl-main');
    setTimeout(function () { btn.classList.remove('ctrl-main'); }, 180);
}

/**
 * stop() then close() is the required teardown pair: stop() releases the
 * decoder, close() releases the AVPlay instance itself. Skipping close()
 * leaks the hardware decoder and the next open() fails.
 */
function closePlayer() {
    if (!player.open) {
        return;
    }
    try {
        var s = webapis.avplay.getState();
        if (s !== 'NONE' && s !== 'IDLE') {
            webapis.avplay.stop();
        }
    } catch (e) { /* already stopped */ }

    try {
        webapis.avplay.close();
    } catch (e) { /* already closed */ }

    player.open = false;
    player.playing = false;
}

function stopPlaybackAndReturn(message) {
    closePlayer();
    clearTimeout(controlsTimer);
    showBuffering(false);
    showView('grid');
    if (message) {
        el.status.textContent = message;
    }
}

/* ---- overlay rendering ------------------------------------------------- */

function updatePlayPauseGlyph() {
    // Pause bars while playing, play triangle while paused.
    el.playPause.innerHTML = player.playing ? '&#10074;&#10074;' : '&#9654;';
}

function resetSeekUi() {
    el.seekProgress.style.width = '0%';
    el.seekBuffered.style.width = '0%';
    el.seekKnob.style.left = '0%';
    el.timeCurrent.textContent = formatTime(0);
    el.timeTotal.textContent = '00:00';
}

function updateSeekUi() {
    el.timeCurrent.textContent = formatTime(player.positionMs);

    if (player.durationMs > 0) {
        var pct = Math.max(0, Math.min(100,
            (player.positionMs / player.durationMs) * 100));
        el.seekProgress.style.width = pct + '%';
        el.seekKnob.style.left = pct + '%';
    }
}

function showBuffering(visible, text) {
    el.buffering.classList.toggle('hidden', !visible);
    if (visible && text) {
        el.bufferText.textContent = text;
    }
}

/** Show the overlay and restart the inactivity countdown. */
function showControls() {
    el.controls.classList.remove('faded');
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(function () {
        // Never hide the overlay while paused - the user is looking at it.
        if (player.playing) {
            el.controls.classList.add('faded');
        }
    }, CONTROLS_TIMEOUT_MS);
}

function formatTime(ms) {
    var total = Math.floor((ms || 0) / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;

    var mm = (m < 10 ? '0' : '') + m;
    var ss = (s < 10 ? '0' : '') + s;
    return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
}

/* ===========================================================================
 * 9. REMOTE KEY DISPATCH
 * ======================================================================== */

var KEY = {
    ENTER: 13,
    LEFT: 37,
    UP: 38,
    RIGHT: 39,
    DOWN: 40,
    RETURN: 10009,     // Samsung "Back"
    MEDIA_PLAY_PAUSE: 10252,
    MEDIA_PLAY: 415,
    MEDIA_PAUSE: 19,
    MEDIA_STOP: 413,
    MEDIA_REWIND: 412,
    MEDIA_FF: 417
};

function onKeyDown(e) {
    // While the on-screen keyboard is up it owns every key except Back.
    if (state === 'url' && urlInputFocused) {
        if (e.keyCode === KEY.RETURN) {
            el.urlInput.blur();
            e.preventDefault();
        }
        return;
    }

    switch (state) {
        case 'grid':   handleGridKey(e);   break;
        case 'url':    handleUrlKey(e);    break;
        case 'player': handlePlayerKey(e); break;
    }
}

function handleGridKey(e) {
    switch (e.keyCode) {
        case KEY.LEFT:   moveGridFocus(-1, 0); break;
        case KEY.RIGHT:  moveGridFocus(1, 0);  break;
        case KEY.UP:     moveGridFocus(0, -1); break;
        case KEY.DOWN:   moveGridFocus(0, 1);  break;
        case KEY.ENTER:  activateCard();       break;
        // Inside a folder RETURN climbs one level; only at the library root
        // does it leave the app.
        case KEY.RETURN: if (!goUpFolder()) { exitApp(); } break;
        default: return;
    }
    e.preventDefault();
}

function handleUrlKey(e) {
    switch (e.keyCode) {
        case KEY.UP:     focusUrlRow(urlIndex - 1); break;
        case KEY.DOWN:   focusUrlRow(urlIndex + 1); break;
        case KEY.ENTER:  activateUrlRow();          break;
        case KEY.RETURN: showView('grid');          break;
        default: return;
    }
    e.preventDefault();
}

function handlePlayerKey(e) {
    // Any key brings the overlay back and restarts the auto-hide timer.
    showControls();

    switch (e.keyCode) {
        case KEY.ENTER:
        case KEY.MEDIA_PLAY_PAUSE:
            togglePlayPause();
            break;

        case KEY.MEDIA_PLAY:
            if (!player.playing) { togglePlayPause(); }
            break;

        case KEY.MEDIA_PAUSE:
            if (player.playing) { togglePlayPause(); }
            break;

        case KEY.LEFT:
        case KEY.MEDIA_REWIND:
            skip(-SKIP_MS);
            break;

        case KEY.RIGHT:
        case KEY.MEDIA_FF:
            skip(SKIP_MS);
            break;

        case KEY.UP:
        case KEY.DOWN:
            break;                       // reserved; overlay already shown

        case KEY.RETURN:
        case KEY.MEDIA_STOP:
            stopPlaybackAndReturn();
            break;

        default:
            return;
    }
    e.preventDefault();
}

function exitApp() {
    stopPreview();
    closePlayer();
    try {
        tizen.application.getCurrentApplication().exit();
    } catch (e) { /* not on a TV */ }
}

/* Releasing AVPlay when the app is backgrounded avoids leaking the decoder. */
window.addEventListener('visibilitychange', function () {
    if (document.hidden && state === 'player') {
        closePlayer();
    }
});
