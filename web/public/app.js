/**
 * Shared frontend helper: a fetch that never blindly calls response.json().
 *
 * The old pairing page crashed with `Unexpected token 'T', "The page c"... is not
 * valid JSON` because a static host answered /api/pair with an HTML 404 page and
 * the code parsed it as JSON. Every request now checks the content-type and the
 * status first, and reports a readable error.
 */
(function () {
    var CONFIG = window.LILY_CONFIG || {};
    var STORAGE_KEY = 'lily.backend.url';

    function normalise(url) {
        return String(url || '').trim().replace(/\/+$/, '');
    }

    function backend() {
        return normalise(CONFIG.backendUrl || localStorage.getItem(STORAGE_KEY) || '');
    }

    function setBackend(url) {
        var value = normalise(url);
        if (value) localStorage.setItem(STORAGE_KEY, value);
        else localStorage.removeItem(STORAGE_KEY);
        return value;
    }

    function isCrossOrigin() {
        var base = backend();
        if (!base) return false;
        try {
            return new URL(base, location.href).origin !== location.origin;
        } catch (err) {
            return false;
        }
    }

    async function api(path, options) {
        var opts = Object.assign({ credentials: 'include', headers: {} }, options || {});
        opts.headers = Object.assign({}, opts.headers);
        var controller = new AbortController();
        var timeout = setTimeout(function () { controller.abort(); }, opts.timeoutMs || 20000);
        var res;
        try {
            res = await fetch(backend() + path, Object.assign({}, opts, { signal: controller.signal }));
        } catch (err) {
            clearTimeout(timeout);
            var offline = new Error(
                err.name === 'AbortError'
                    ? 'The server took too long to answer. Check that the bot is running.'
                    : 'Cannot reach the Lily MD server at ' + (backend() || location.origin) + '.'
            );
            offline.code = 'NETWORK';
            throw offline;
        }
        clearTimeout(timeout);

        var type = String(res.headers.get('content-type') || '').toLowerCase();
        var text = await res.text();
        var data = null;
        if (type.indexOf('application/json') !== -1) {
            try {
                data = JSON.parse(text);
            } catch (err) {
                data = null;
            }
        }

        if (!data) {
            var wrong = new Error(
                res.status === 404
                    ? 'This address does not host the Lily MD API (HTTP 404). If the website is on Vercel, point it at your bot with the Backend URL field.'
                    : res.status === 502 || res.status === 503
                      ? 'The server is not ready (HTTP ' + res.status + '). Start the Lily MD bot and try again.'
                      : 'The server answered with HTML/text instead of JSON (HTTP ' + res.status + ').'
            );
            wrong.status = res.status;
            wrong.code = 'NOT_JSON';
            throw wrong;
        }

        if (!res.ok) {
            var failure = new Error(data.error || 'Request failed (HTTP ' + res.status + ')');
            failure.status = res.status;
            failure.code = data.code;
            failure.data = data;
            throw failure;
        }
        return data;
    }

    function escapeHtml(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function when(iso) {
        if (!iso) return '—';
        var date = new Date(iso);
        if (isNaN(date.getTime())) return String(iso);
        var diff = Math.round((Date.now() - date.getTime()) / 1000);
        if (Math.abs(diff) < 60) return diff >= 0 ? diff + 's ago' : 'in ' + -diff + 's';
        if (Math.abs(diff) < 3600) return Math.round(diff / 60) + 'm ago';
        if (Math.abs(diff) < 86400) return Math.round(diff / 3600) + 'h ago';
        return date.toLocaleString();
    }

    window.LilyAPI = {
        api: api,
        backend: backend,
        setBackend: setBackend,
        isCrossOrigin: isCrossOrigin,
        escapeHtml: escapeHtml,
        when: when
    };
})();
