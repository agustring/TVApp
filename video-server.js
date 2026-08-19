/*
 * Created by Agustin Copita in 2026 for the exclusive use of Agustin Copita.
 * © 2026 Agustin Copita. All rights reserved.
 */
/**
 * Video server for TVApp (TuViejapp) — a drop-in replacement for `python -m http.server`,
 * since Python isn't installed on this machine (and port 8000 is held by an
 * SSL-enabled Apache).
 *
 * Usage:  node video-server.js [folder] [port]
 *
 * Serves a browsable tree:
 *   - every directory returns an HTML listing in the same shape python's
 *     http.server produces, so js/main.js parses it unchanged;
 *   - subdirectories are listed with a trailing slash, and ONLY when they
 *     actually contain a playable video somewhere beneath them — so folders
 *     like "Games" or "Adobe Photoshop 2023" never reach the TV grid;
 *   - files are served with HTTP Range support, which the TV needs in order
 *     to seek (AVPlay issues a fresh ranged GET for every seek).
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || 'd:\\No one\'s gonna pay for it\\');
const PORT = parseInt(process.argv[3] || '8001', 10);

const MIME = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.ts': 'video/mp2t'
};

// Only these show up in the listing, matching MEDIA_EXTENSIONS in js/main.js.
const MEDIA_EXT = Object.keys(MIME);

// Deciding whether a folder is worth showing means walking it, and that answer
// is needed once per folder per listing. Cap the descent and memoise briefly so
// browsing a large library stays responsive.
const MAX_DEPTH = 8;
const CACHE_TTL_MS = 30000;
const mediaCache = new Map();

// A folder only counts as "has video" if something in it is big enough to be
// real content. Without this, app folders qualify on incidental clips — the
// Photoshop installer, for instance, ships a 1.1 MB carousel .mp4 four levels
// down. This gates folder VISIBILITY only: once you are inside a folder, every
// media file in it is listed regardless of size.
const MIN_MEDIA_BYTES = 20 * 1024 * 1024;   // 20 MB

function isMedia(name) {
    return MEDIA_EXT.indexOf(path.extname(name).toLowerCase()) !== -1;
}

// Hidden/system entries (".VJ", ".git", ...) are never interesting on a TV.
function isHidden(name) {
    return name.charAt(0) === '.';
}

function isBigEnough(file) {
    try {
        return fs.statSync(file).size >= MIN_MEDIA_BYTES;
    } catch (e) {
        return false;
    }
}

function readDirSafe(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return [];   // unreadable: permissions, or vanished mid-walk
    }
}

/**
 * True when `dir` holds a playable file at any depth.
 *
 * isDirectory() is false for symlinks when using withFileTypes, so symlinked
 * folders are skipped — which also makes link cycles impossible to walk into.
 */
function dirHasMedia(dir, depth) {
    depth = depth || 0;

    const cached = mediaCache.get(dir);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached.value;
    }

    const entries = readDirSafe(dir);
    let found = entries.some((e) =>
        e.isFile() && !isHidden(e.name) && isMedia(e.name) &&
        isBigEnough(path.join(dir, e.name)));

    // Only descend if this level had nothing — most hits are shallow.
    if (!found && depth < MAX_DEPTH) {
        found = entries.some((e) =>
            e.isDirectory() && !isHidden(e.name) &&
            dirHasMedia(path.join(dir, e.name), depth + 1));
    }

    mediaCache.set(dir, { value: found, at: Date.now() });
    return found;
}

/** Keeps every resolved path inside ROOT — this is the traversal guard. */
function isInsideRoot(target) {
    const rel = path.relative(ROOT, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Distinguishes AVPlay from the grid's HTML5 preview element in the log. */
function clientKind(req) {
    const ua = String(req.headers['user-agent'] || '');
    if (/Tizen|SmartTV|AVPlay/i.test(ua)) return 'TV';
    return ua ? ua.slice(0, 28) : 'unknown';
}

function log(req, extra) {
    const from = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    console.log(`${new Date().toISOString()} ${from} ${req.method} ${req.url}` +
                ` [${clientKind(req)}]` + (extra ? ' ' + extra : ''));
}

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sendListing(req, res, absDir, relDir) {
    const entries = readDirSafe(absDir);

    // Folders first, then files — both alphabetical, like a file manager.
    const dirs = entries
        .filter((e) => e.isDirectory() && !isHidden(e.name) &&
                       dirHasMedia(path.join(absDir, e.name)))
        .map((e) => e.name)
        .sort();

    const files = entries
        .filter((e) => e.isFile() && !isHidden(e.name) && isMedia(e.name))
        .map((e) => e.name)
        .sort();

    // hrefs stay RELATIVE to the current directory, so the client can simply
    // append them to the URL it already used. Directories carry a trailing
    // slash, which is how the client tells the two apart.
    const links = dirs
        .map((n) => `<li><a href="${encodeURIComponent(n)}/">${escapeHtml(n)}/</a></li>`)
        .concat(files
        .map((n) => `<li><a href="${encodeURIComponent(n)}">${escapeHtml(n)}</a></li>`))
        .join('\n');

    const title = escapeHtml('Directory listing for /' + relDir);
    const body = `<!DOCTYPE HTML>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1><hr><ul>
${links}
</ul><hr></body></html>`;

    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        // The app runs on a different origin, so CORS must be open.
        'Access-Control-Allow-Origin': '*'
    });
    res.end(req.method === 'HEAD' ? undefined : body);
}

function sendFile(req, res, filePath) {
    const stat = fs.statSync(filePath);
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;

    // No (or unparseable) Range header: serve the whole file.
    if (!match) {
        log(req);
        res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': stat.size,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*'
        });
        if (req.method === 'HEAD') return res.end();
        return pipeFile(res, filePath, {});
    }

    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;

    // An unsatisfiable range must be refused, not answered with a negative
    // Content-Length — that stalls the player instead of failing cleanly.
    if (start >= stat.size || start > end) {
        log(req, `-> 416 (size ${stat.size})`);
        res.writeHead(416, {
            'Content-Range': `bytes */${stat.size}`,
            'Access-Control-Allow-Origin': '*'
        });
        return res.end();
    }

    const last = Math.min(end, stat.size - 1);
    log(req, `-> 206 ${start}-${last}`);

    res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${last}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': last - start + 1,
        'Access-Control-Allow-Origin': '*'
    });
    if (req.method === 'HEAD') return res.end();
    pipeFile(res, filePath, { start, end: last });
}

/**
 * Seeking makes the TV abandon the previous response mid-flight. Without these
 * handlers the resulting ECONNRESET/EPIPE reaches the process as an unhandled
 * 'error' event and kills the server part-way through a film.
 */
function pipeFile(res, filePath, opts) {
    const stream = fs.createReadStream(filePath, opts);

    stream.on('error', () => { res.destroy(); });
    res.on('close', () => { stream.destroy(); });
    res.on('error', () => { stream.destroy(); });

    stream.pipe(res);
}

const server = http.createServer((req, res) => {
    try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'Allow': 'GET, HEAD' });
            return res.end('405 Method Not Allowed');
        }

        const rawPath = req.url.split('?')[0];
        const relPath = decodeURIComponent(rawPath).replace(/^\/+/, '');
        const abs = path.resolve(ROOT, relPath);

        // Traversal guard: everything must resolve inside ROOT.
        if (!isInsideRoot(abs)) {
            log(req, '-> 403');
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            return res.end('403 Forbidden');
        }

        let stat;
        try {
            stat = fs.statSync(abs);
        } catch (e) {
            log(req, '-> 404');
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('404 Not Found');
        }

        if (stat.isDirectory()) {
            // Relative hrefs only resolve correctly under a trailing slash.
            if (!rawPath.endsWith('/')) {
                log(req, '-> 301');
                res.writeHead(301, { 'Location': rawPath + '/' });
                return res.end();
            }
            log(req);
            return sendListing(req, res, abs, relPath);
        }

        if (!stat.isFile()) {
            log(req, '-> 404');
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('404 Not Found');
        }
        sendFile(req, res, abs);
    } catch (err) {
        console.error('request failed:', err.message);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
        }
        res.end('500 ' + err.message);
    }
});

// A socket-level error must never take the whole server down mid-session.
server.on('clientError', (err, socket) => {
    if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Serving ${ROOT} on http://0.0.0.0:${PORT}/`);
});
