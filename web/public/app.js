/**
 * Lily MD — Premium Frontend Application
 * Copyright (c) 2026 Rahul Haldar
 *
 * Implements:
 * - Dual pairing system: Phone code & live Baileys QR code
 * - Country code selector with formatting & validation
 * - Live interactive command browser with search & category filters
 * - Real-time system health & connection status monitor
 * - Safe API transport with resilient error discrimination
 */
(function () {
    'use strict';

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
        var token = null;
        try { token = localStorage.getItem('lily.auth.token'); } catch (e) {}
        if (token && !opts.headers['authorization']) {
            opts.headers['authorization'] = 'Bearer ' + token;
        }
        var controller = new AbortController();
        var timeout = setTimeout(function () { controller.abort(); }, opts.timeoutMs || 25000);
        var res;
        try {
            res = await fetch(backend() + path, Object.assign({}, opts, { signal: controller.signal }));
        } catch (err) {
            clearTimeout(timeout);
            var offline = new Error(
                err.name === 'AbortError'
                    ? 'The server took too long to answer. Check that the bot process is active.'
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
                    ? 'This address does not host the Lily MD API (HTTP 404). Check Server Settings or ensure the website service is running.'
                    : res.status === 502 || res.status === 503
                      ? 'The pairing engine is initializing (HTTP ' + res.status + '). Ensure `npm install` and `npm start` have run on the bot host.'
                      : 'The server answered with non-JSON format (HTTP ' + res.status + ').'
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
        if (data && data.token) {
            try { localStorage.setItem('lily.auth.token', data.token); } catch (e) {}
        }
        if (path === '/api/auth/logout') {
            try { localStorage.removeItem('lily.auth.token'); } catch (e) {}
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

    function formatUptime(seconds) {
        if (!seconds || seconds <= 0) return 'Just started';
        var d = Math.floor(seconds / 86400);
        var h = Math.floor((seconds % 86400) / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        var parts = [];
        if (d > 0) parts.push(d + 'd');
        if (h > 0 || d > 0) parts.push(h + 'h');
        parts.push(m + 'm');
        return parts.join(' ');
    }

    window.LilyAPI = {
        api: api,
        backend: backend,
        setBackend: setBackend,
        isCrossOrigin: isCrossOrigin,
        escapeHtml: escapeHtml,
        formatUptime: formatUptime
    };

    /* ------------------------------------------------------------- DOM UI */

    var $ = function (id) { return document.getElementById(id); };

    // State
    var currentMode = 'phone'; // 'phone' | 'qr'
    var activeJobId = null;
    var phonePollTimer = null;
    var qrPollTimer = null;
    var countdownTimer = null;
    var deadline = 0;
    var rawPairingCode = '';
    var allCommands = [];

    function setMsg(el, text, kind) {
        if (!el) return;
        el.textContent = text || '';
        el.className = 'msg ' + (kind || 'error') + (text ? ' show' : '');
    }

    function stopAllPolling() {
        if (phonePollTimer) { clearTimeout(phonePollTimer); phonePollTimer = null; }
        if (qrPollTimer) { clearTimeout(qrPollTimer); qrPollTimer = null; }
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    }

    /* -------------------------------------------------------- Mode Switching */

    function switchMode(mode) {
        if (mode === currentMode) return;
        stopAllPolling();
        currentMode = mode;

        var isPhone = mode === 'phone';
        $('tab-phone').classList.toggle('active', isPhone);
        $('tab-phone').setAttribute('aria-selected', isPhone ? 'true' : 'false');
        $('tab-qr').classList.toggle('active', !isPhone);
        $('tab-qr').setAttribute('aria-selected', !isPhone ? 'true' : 'false');

        $('pane-phone').style.display = isPhone ? 'block' : 'none';
        $('pane-qr').style.display = !isPhone ? 'block' : 'none';
        $('step-connected').classList.remove('on');

        if (!isPhone) {
            // Auto-start QR session when switching to QR tab
            startQr();
        }
    }

    $('tab-phone').addEventListener('click', function () { switchMode('phone'); });
    $('tab-qr').addEventListener('click', function () { switchMode('qr'); });
    if ($('hero-qr-btn')) {
        $('hero-qr-btn').addEventListener('click', function () {
            switchMode('qr');
            $('pairing').scrollIntoView({ behavior: 'smooth' });
        });
    }

    /* --------------------------------------------------- Phone Pairing Logic */

    function setPhoneStep(step) {
        $('phone-step-1').classList.toggle('on', step === 1);
        $('phone-step-2').classList.toggle('on', step === 2);
        $('step-connected').classList.toggle('on', step === 3);
    }

    function setChips(state) {
        var map = {
            initializing: 'chip-init',
            waiting: 'chip-init',
            requesting: 'chip-init',
            code: 'chip-code',
            connecting: 'chip-connect',
            connected: 'chip-done'
        };
        ['chip-init', 'chip-code', 'chip-connect', 'chip-done'].forEach(function (id) {
            var el = $(id);
            if (el) el.classList.toggle('active', map[state] === id);
        });
    }

    function tickPhoneTimer() {
        var left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        var el = $('phone-timer');
        if (!el) return;
        if (left > 0) {
            var m = Math.floor(left / 60);
            var s = left % 60;
            el.textContent = 'Code expires in ' + m + ':' + (s < 10 ? '0' : '') + s;
        } else {
            el.textContent = 'Code expired — please cancel and retry.';
        }
    }

    async function startPhonePairing() {
        var country = $('country-select').value.replace(/[^0-9]/g, '');
        var num = $('phone-number').value.replace(/[^0-9]/g, '');
        setMsg($('phone-error'), '');

        var fullNumber = country + num;
        if (fullNumber.length < 7 || fullNumber.length > 15) {
            setMsg($('phone-error'), 'Enter your valid WhatsApp number with country code (e.g. 916033352400).');
            return;
        }

        var btn = $('btn-get-code');
        btn.disabled = true;
        btn.textContent = 'Generating Code…';

        try {
            var data = await LilyAPI.api('/api/pair', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ number: fullNumber }),
                timeoutMs: 25000
            });

            activeJobId = data.id;
            setPhoneStep(2);
            $('code-display').textContent = '••••-••••';
            setChips('initializing');
            setMsg($('phone-info'), 'Requesting pairing handshake from WhatsApp…', 'info');
            setMsg($('phone-step-error'), '');

            deadline = Date.now() + 180000;
            tickPhoneTimer();
            countdownTimer = setInterval(tickPhoneTimer, 1000);

            pollPhoneStatus(data.id, 0);
        } catch (err) {
            setMsg($('phone-error'), err.message || 'Could not connect to WhatsApp pairing engine.');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Get Pairing Code';
        }
    }

    async function pollPhoneStatus(id, attempt) {
        if (!id || activeJobId !== id) return;
        try {
            var data = await LilyAPI.api('/api/pair/status?id=' + encodeURIComponent(id), { timeoutMs: 15000 });
            setChips(data.state);

            if (data.code) {
                rawPairingCode = data.code;
                $('code-display').textContent = data.code;
                setMsg($('phone-info'), 'Code ready! Enter this 8-digit code in WhatsApp on your phone.', 'info');
            }

            if (data.state === 'connecting') {
                setMsg($('phone-info'), 'Code accepted! Saving WhatsApp credentials securely…', 'info');
            }

            if (data.state === 'connected') {
                stopAllPolling();
                activeJobId = null;
                setPhoneStep(3);
                refreshHealth();
                return;
            }

            if (data.state === 'failed') {
                stopAllPolling();
                setMsg($('phone-info'), '');
                setMsg($('phone-step-error'), data.error || 'Pairing failed. Please verify your phone number and try again.');
                return;
            }
        } catch (err) {
            if (err.status === 404) {
                stopAllPolling();
                setMsg($('phone-step-error'), 'Pairing session expired. Please start again.');
                return;
            }
        }

        phonePollTimer = setTimeout(function () {
            pollPhoneStatus(id, attempt + 1);
        }, 2000);
    }

    $('btn-get-code').addEventListener('click', startPhonePairing);
    $('phone-number').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') startPhonePairing();
    });

    $('btn-copy-code').addEventListener('click', async function () {
        var textToCopy = rawPairingCode.replace(/[^A-Za-z0-9]/g, '');
        if (!textToCopy) return;
        try {
            await navigator.clipboard.writeText(textToCopy);
            $('copy-btn-text').textContent = 'Copied!';
            setTimeout(function () { $('copy-btn-text').textContent = 'Copy'; }, 2200);
        } catch (err) {
            $('code-display').focus();
        }
    });

    $('btn-cancel-phone').addEventListener('click', async function () {
        if (activeJobId) {
            try {
                await LilyAPI.api('/api/pair/cancel', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ id: activeJobId })
                });
            } catch {}
        }
        stopAllPolling();
        activeJobId = null;
        rawPairingCode = '';
        setPhoneStep(1);
    });

    /* ------------------------------------------------------ QR Pairing Logic */

    async function startQr() {
        stopAllPolling();
        setMsg($('qr-error'), '');
        setMsg($('qr-info'), 'Connecting to WhatsApp Baileys gateway…', 'info');
        $('qr-placeholder').textContent = 'Generating QR code…';

        try {
            var data = await LilyAPI.api('/api/pair/qr', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                timeoutMs: 25000
            });

            activeJobId = data.id;
            pollQrStatus(data.id, 0);
        } catch (err) {
            setMsg($('qr-error'), err.message || 'QR pairing engine is unavailable.');
            setMsg($('qr-info'), '');
            $('qr-placeholder').textContent = 'QR unavailable. Use Phone Code mode instead.';
        }
    }

    async function pollQrStatus(id, attempt) {
        if (!id || activeJobId !== id) return;
        try {
            var data = await LilyAPI.api('/api/pair/status?id=' + encodeURIComponent(id), { timeoutMs: 15000 });

            if (data.qrDataUrl) {
                var target = $('qr-target');
                target.innerHTML = '<img src="' + escapeHtml(data.qrDataUrl) + '" alt="WhatsApp QR Code" />';
                var secondsLeft = data.qrExpiresIn !== null ? data.qrExpiresIn : 20;
                $('qr-timer').textContent = 'QR refreshes in ' + secondsLeft + 's';
                setMsg($('qr-info'), 'Scan with WhatsApp camera on your primary phone.', 'info');
            }

            if (data.state === 'connecting') {
                setMsg($('qr-info'), 'QR scanned! Saving session securely…', 'info');
            }

            if (data.state === 'connected') {
                stopAllPolling();
                activeJobId = null;
                $('pane-qr').style.display = 'none';
                $('step-connected').classList.add('on');
                refreshHealth();
                return;
            }

            if (data.state === 'failed') {
                stopAllPolling();
                setMsg($('qr-info'), '');
                setMsg($('qr-error'), data.error || 'QR scan failed. Click Refresh to generate a new QR.');
                return;
            }
        } catch (err) {
            if (err.status === 404) {
                stopAllPolling();
                setMsg($('qr-error'), 'QR session expired. Click Refresh to get a new code.');
                return;
            }
        }

        qrPollTimer = setTimeout(function () {
            pollQrStatus(id, attempt + 1);
        }, 2000);
    }

    $('btn-refresh-qr').addEventListener('click', startQr);
    $('btn-cancel-qr').addEventListener('click', async function () {
        if (activeJobId) {
            try {
                await LilyAPI.api('/api/pair/cancel', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ id: activeJobId })
                });
            } catch {}
        }
        stopAllPolling();
        activeJobId = null;
        switchMode('phone');
    });

    $('btn-pair-another').addEventListener('click', function () {
        stopAllPolling();
        activeJobId = null;
        rawPairingCode = '';
        $('phone-number').value = '';
        $('step-connected').classList.remove('on');
        switchMode('phone');
        setPhoneStep(1);
    });

    /* ------------------------------------------- Commands Documentation Browser */

    async function loadCommands() {
        var grid = $('cmd-grid');
        if (!grid) return;
        try {
            var res = await LilyAPI.api('/api/commands', { timeoutMs: 15000 });
            allCommands = res.commands || [];
            renderCommands(allCommands);
        } catch (err) {
            grid.innerHTML = '<div class="empty" style="grid-column:1/-1">Failed to load commands: ' + escapeHtml(err.message) + '</div>';
        }
    }

    function renderCommands(commands) {
        var grid = $('cmd-grid');
        if (!grid) return;
        if (!commands || !commands.length) {
            grid.innerHTML = '<div class="empty" style="grid-column:1/-1">No commands match your filter.</div>';
            return;
        }

        var html = '';
        commands.forEach(function (cmd) {
            var cat = cmd.category || 'general';
            var isOwnerOnly = /owner|sudo|setpp|update|clearsession|cleartmp/.test(cmd.name);
            var isGroupAdmin = /promote|demote|kick|mute|unmute|tagall|hidetag|warn/.test(cmd.name);
            var perm = isOwnerOnly ? 'Owner' : (isGroupAdmin ? 'Admin' : 'Public');
            var permClass = isOwnerOnly ? 'off' : (isGroupAdmin ? 'warn' : 'on');

            html += '<div class="cmd-card">' +
                '<div>' +
                    '<div class="cmd-header">' +
                        '<span class="cmd-name">.' + escapeHtml(cmd.name) + '</span>' +
                        '<span class="tag ' + permClass + '">' + perm + '</span>' +
                    '</div>' +
                    '<p class="cmd-desc">WhatsApp ' + escapeHtml(cat) + ' command: <code>.' + escapeHtml(cmd.name) + '</code></p>' +
                '</div>' +
                '<div class="cmd-footer">' +
                    '<span class="tag" style="text-transform:capitalize">' + escapeHtml(cat) + '</span>' +
                    '<button class="btn quiet small btn-copy-cmd" data-cmd=".' + escapeHtml(cmd.name) + '" style="padding:2px 8px; font-size:11px">' +
                        'Copy' +
                    '</button>' +
                '</div>' +
            '</div>';
        });

        grid.innerHTML = html;

        // Attach copy listener to buttons
        var btns = grid.querySelectorAll('.btn-copy-cmd');
        btns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                var text = btn.getAttribute('data-cmd');
                navigator.clipboard.writeText(text).then(function () {
                    var prev = btn.textContent;
                    btn.textContent = 'Copied!';
                    setTimeout(function () { btn.textContent = prev; }, 1800);
                });
            });
        });
    }

    // Filter by Category
    var catButtons = document.querySelectorAll('.cmd-cat-btn');
    catButtons.forEach(function (btn) {
        btn.addEventListener('click', function () {
            catButtons.forEach(function (b) { b.classList.remove('active'); });
            btn.classList.add('active');
            filterCommands();
        });
    });

    // Filter by Search Query
    if ($('cmd-search')) {
        $('cmd-search').addEventListener('input', filterCommands);
    }

    function filterCommands() {
        var activeBtn = document.querySelector('.cmd-cat-btn.active');
        var cat = activeBtn ? activeBtn.getAttribute('data-cat') : 'all';
        var query = ($('cmd-search') ? $('cmd-search').value : '').toLowerCase().trim();

        var filtered = allCommands.filter(function (cmd) {
            var matchesCat = (cat === 'all') || (cmd.category && cmd.category.toLowerCase() === cat);
            var matchesQuery = !query || cmd.name.toLowerCase().indexOf(query) !== -1 || (cmd.category && cmd.category.toLowerCase().indexOf(query) !== -1);
            return matchesCat && matchesQuery;
        });

        renderCommands(filtered);
    }

    /* -------------------------------------------- Live Health & System Status */

    async function refreshHealth() {
        try {
            var res = await LilyAPI.api('/api/status', { timeoutMs: 12000 });
            var isLive = res.connected || res.ok;

            if ($('stat-connected')) $('stat-connected').textContent = isLive ? 'Connected' : 'Standby';
            if ($('health-conn')) $('health-conn').textContent = isLive ? 'Live' : 'Standby';
            if ($('health-uptime')) $('health-uptime').textContent = LilyAPI.formatUptime(res.uptimeSeconds || res.uptime);

            if ($('health-ai') && res.autoReply) {
                $('health-ai').textContent = res.autoReply.provider ? res.autoReply.provider.split(' ')[0] : 'AYHA';
            }
            if ($('health-ai-sub') && res.autoReply && res.autoReply.model) {
                $('health-ai-sub').textContent = res.autoReply.model;
            }
            if ($('health-cmds') && res.commands) {
                $('health-cmds').textContent = res.commands;
            }
        } catch (err) {
            if ($('stat-connected')) $('stat-connected').textContent = 'Standby';
            if ($('health-conn')) $('health-conn').textContent = 'Offline';
        }
    }

    if ($('btn-refresh-status')) {
        $('btn-refresh-status').addEventListener('click', refreshHealth);
    }

    /* -------------------------------------------------------- Server Settings */

    if ($('backend-url')) {
        $('backend-url').value = LilyAPI.backend();
        $('backend-status').textContent = LilyAPI.backend()
            ? 'Configured backend: ' + LilyAPI.backend()
            : 'Using origin: ' + location.origin;

        $('save-backend').addEventListener('click', async function () {
            var url = LilyAPI.setBackend($('backend-url').value);
            $('backend-status').textContent = url ? 'Saved: ' + url : 'Using ' + location.origin;
            try {
                var info = await LilyAPI.api('/api/info', { timeoutMs: 8000 });
                setMsg($('phone-error'), '');
                $('backend-status').textContent = 'Connected to ' + info.bot + ' at ' + (url || location.origin);
                loadCommands();
                refreshHealth();
            } catch (err) {
                setMsg($('phone-error'), err.message);
            }
        });
    }

    // Auto-detect hash routing (e.g. #qr, #commands)
    if (location.hash === '#qr') {
        switchMode('qr');
    }

    // Scroll Reveal Animation Engine
    function initScrollReveal() {
        if (!('IntersectionObserver' in window)) {
            document.querySelectorAll('.block, .feature, .security-card, .status-card, .pair-card, .hero-copy').forEach(function (el) {
                el.classList.add('revealed');
            });
            return;
        }
        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    entry.target.classList.add('revealed');
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.08 });

        document.querySelectorAll('.block, .feature, .security-card, .status-card, .pair-card, .hero-copy').forEach(function (el) {
            el.classList.add('reveal-on-scroll');
            observer.observe(el);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initScrollReveal);
    } else {
        initScrollReveal();
    }

    // Initial load
    loadCommands();
    refreshHealth();
})();
