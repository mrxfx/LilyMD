/**
 * Lily MD owner dashboard — every view talks to the real bot API.
 * No simulated numbers: /api/dash/* reads the same JSON files the commands use,
 * and status comes from the running process over Server-Sent Events.
 */
(function () {
    var api = LilyAPI.api;
    var esc = LilyAPI.escapeHtml;
    var when = LilyAPI.when;

    var csrf = null;
    var me = null;
    var current = 'overview';
    var stream = null;
    var live = { status: null };

    var VIEWS = [
        { id: 'overview', label: 'Overview', icon: 'grid', group: 'Bot' },
        { id: 'connection', label: 'WhatsApp connection', icon: 'link', group: 'Bot' },
        { id: 'ai', label: 'AI Brain — AYHA', icon: 'cpu', group: 'Intelligence' },
        { id: 'autoreply', label: 'Auto reply', icon: 'chat', group: 'Intelligence' },
        { id: 'commands', label: 'Commands', icon: 'terminal', group: 'Intelligence' },
        { id: 'plugins', label: 'Plugins', icon: 'plug', group: 'Intelligence' },
        { id: 'groups', label: 'Group management', icon: 'users', group: 'Control' },
        { id: 'protection', label: 'Protection', icon: 'shield', group: 'Control' },
        { id: 'autostatus', label: 'Auto status', icon: 'eye', group: 'Control' },
        { id: 'media', label: 'Media & downloads', icon: 'film', group: 'Control' },
        { id: 'themes', label: 'Themes & mode', icon: 'palette', group: 'Control' },
        { id: 'owners', label: 'Owner management', icon: 'user-check', group: 'Access' },
        { id: 'memory', label: 'Database & memory', icon: 'database', group: 'Access' },
        { id: 'logs', label: 'Logs & analytics', icon: 'trend', group: 'Access' },
        { id: 'security', label: 'Security', icon: 'lock', group: 'Access' },
        { id: 'settings', label: 'General settings', icon: 'sliders', group: 'Access' }
    ];

    /* ------------------------------------------------------------- helpers */

    function el(id) { return document.getElementById(id); }
    function view() { return el('view'); }

    // Icons come from the inline SVG sprite in dashboard.html.
    function icon(name, extra) {
        return '<svg class="icon ' + (extra || '') + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
    }

    function toast(text, kind) {
        var node = document.createElement('div');
        node.className = 'toast ' + (kind || '');
        node.textContent = text;
        el('toasts').appendChild(node);
        setTimeout(function () { node.remove(); }, kind === 'error' ? 6500 : 4000);
    }

    function mutate(path, body) {
        return api(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-lily-csrf': csrf || '' },
            body: JSON.stringify(body || {})
        });
    }

    function busy(button, on, label) {
        if (!button) return;
        if (on) {
            button.dataset.label = button.textContent;
            button.disabled = true;
            button.textContent = label || 'Working…';
        } else {
            button.disabled = false;
            if (button.dataset.label) button.textContent = button.dataset.label;
        }
    }

    function fail(err) {
        if (err && err.status === 401) { location.href = '/login'; return; }
        toast(err.message || 'Something went wrong.', 'error');
    }

    function fmtUptime(seconds) {
        var s = Number(seconds || 0);
        var d = Math.floor(s / 86400);
        var h = Math.floor((s % 86400) / 3600);
        var m = Math.floor((s % 3600) / 60);
        if (d) return d + 'd ' + h + 'h';
        if (h) return h + 'h ' + m + 'm';
        return m + 'm ' + (s % 60) + 's';
    }

    function switchRow(key, on, title, sub, action) {
        return '<div class="toggle-row"><div class="meta"><strong>' + esc(title) + '</strong><span>' + esc(sub || '') +
            '</span></div><label class="switch"><input type="checkbox" data-toggle="' + esc(action || key) + '" data-key="' + esc(key) + '"' +
            (on ? ' checked' : '') + ' /><span class="track"></span></label></div>';
    }

    /* ---------------------------------------------------------------- nav */

    function renderNav() {
        var groups = {};
        VIEWS.forEach(function (item) {
            (groups[item.group] = groups[item.group] || []).push(item);
        });
        var html = '';
        Object.keys(groups).forEach(function (group) {
            html += '<div class="nav-group">' + esc(group) + '</div>';
            groups[group].forEach(function (item) {
                html += '<button class="nav-item" data-view="' + item.id + '">' + icon(item.icon) +
                    '<span>' + esc(item.label) + '</span></button>';
            });
        });
        el('nav').innerHTML = html;
        el('nav').addEventListener('click', function (event) {
            var button = event.target.closest('[data-view]');
            if (!button) return;
            location.hash = button.dataset.view;
            el('sidebar').classList.remove('open');
            el('backdrop').classList.remove('show');
        });
    }

    function highlight() {
        Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (node) {
            node.classList.toggle('active', node.dataset.view === current);
        });
        var item = VIEWS.find(function (v) { return v.id === current; }) || VIEWS[0];
        el('title').textContent = item.label;
        el('crumb').textContent = item.group + ' / ' + item.label;
    }

    /* -------------------------------------------------------------- status */

    function paintStatus(status) {
        if (!status) return;
        live.status = status;
        var pill = el('status-pill');
        pill.classList.toggle('online', Boolean(status.connected));
        el('status-text').textContent = status.connected
            ? 'Online' + (status.whatsappNumber ? ' · ' + status.whatsappNumber : '')
            : 'Offline';
        var overview = document.querySelector('[data-live-status]');
        if (overview && current === 'overview') {
            overview.innerHTML = overviewCards(status);
        }
    }

    function connectEvents() {
        if (stream) stream.close();
        try {
            stream = new EventSource(LilyAPI.backend() + '/api/events', { withCredentials: true });
            stream.addEventListener('status', function (event) {
                try { paintStatus(JSON.parse(event.data)); } catch (err) {}
            });
            stream.onerror = function () {
                el('status-pill').classList.remove('online');
                el('status-text').textContent = 'reconnecting…';
            };
        } catch (err) {
            // SSE unsupported — the Refresh button still works.
        }
    }

    /* ------------------------------------------------------------- overview */

    function overviewCards(status) {
        var cards = [
            { label: 'Bot', value: status.connected ? 'Online' : 'Offline', sub: 'uptime ' + fmtUptime(status.uptimeSeconds), cls: status.connected ? '' : 'off' },
            { label: 'WhatsApp', value: status.whatsappNumber || (status.connected ? 'linked' : 'not linked'), sub: status.state },
            { label: 'Commands', value: String(status.enabledCommands) + ' / ' + status.commands, sub: 'enabled / total' },
            { label: 'Messages', value: String(status.messages), sub: 'counted by the bot' },
            { label: 'AI requests', value: String(status.aiRequests), sub: status.aiToday + ' today' },
            { label: 'Auto-reply', value: status.autoReply.enabled ? 'ON' : 'OFF', sub: status.autoReply.mode + ' · ' + status.autoReply.model },
            { label: 'Memory', value: String(status.memory.styleSamples), sub: 'style samples · ' + status.memory.facts + ' facts' },
            { label: 'Mode', value: status.publicMode ? 'public' : 'private', sub: 'run ' + status.node }
        ];
        return cards.map(function (card) {
            return '<div class="stat"><div class="label">' + esc(card.label) + '</div><div class="value' +
                (String(card.value).length > 14 ? ' small' : '') + '">' + esc(card.value) + '</div><div class="sub">' + esc(card.sub) + '</div></div>';
        }).join('');
    }

    var render = {};

    render.overview = async function () {
        var status = await api('/api/dash/status');
        paintStatus(status);
        view().innerHTML =
            '<div class="stack">' +
            (me && me.mustChangePassword ? '<div class="banner warn">You are using a temporary password. Change it in <a href="#security">Security</a>.</div>' : '') +
            '<div class="grid cols-4" data-live-status>' + overviewCards(status) + '</div>' +
            '<div class="grid cols-2">' +
              '<section class="card"><h2>Quick actions</h2><p class="hint">Real operations against the running bot.</p>' +
                '<div class="row">' +
                  '<button class="btn ghost small" data-action="refresh">Refresh status</button>' +
                  '<button class="btn ghost small" data-action="conn-reconnect">Reconnect WhatsApp</button>' +
                  '<a class="btn ghost small" href="#connection">Connection details</a>' +
                '</div></section>' +
              '<section class="card"><h2>Session</h2><p class="hint">Started ' + esc(when(status.startedAt)) + ' · ' + esc(status.platform) + '</p>' +
                '<div class="list">' +
                  '<div class="list-item"><span>Bot version</span><span class="mono">' + esc(status.version) + '</span></div>' +
                  '<div class="list-item"><span>AI engine</span><span>' + esc(status.aiName) + '</span></div>' +
                  '<div class="list-item"><span>Owners</span><span>' + esc(status.owners) + '</span></div>' +
                '</div></section>' +
            '</div>' +
            '<section class="card"><h2>Recent activity</h2><p class="hint">Authentication and configuration events from this server.</p><div id="activity" class="empty">Loading…</div></section>' +
            '</div>';
        api('/api/dash/logs').then(function (data) {
            var target = el('activity');
            if (!target) return;
            var events = (data.events || []).slice(0, 8);
            target.className = events.length ? 'list' : 'empty';
            target.innerHTML = events.length
                ? events.map(function (event) {
                    return '<div class="list-item"><span>' + esc(event.message) + '</span><small>' + esc(when(event.at)) + '</small></div>';
                }).join('')
                : 'No activity recorded yet.';
        }).catch(function () {});
    };

    render.connection = async function () {
        var data = await api('/api/dash/connection');
        view().innerHTML =
            '<div class="stack">' +
            '<div class="grid cols-3">' +
              '<div class="stat"><div class="label">State</div><div class="value small">' + (data.connected ? 'Connected' : 'Disconnected') + '</div><div class="sub">live from the bot process</div></div>' +
              '<div class="stat"><div class="label">Linked number</div><div class="value small">' + esc(data.number || '—') + '</div><div class="sub">never the raw session</div></div>' +
              '<div class="stat"><div class="label">Controls</div><div class="value small">' + (data.canReconnect ? 'available' : 'read-only') + '</div><div class="sub">' + (data.canDisconnect ? 'disconnect enabled' : '') + '</div></div>' +
            '</div>' +
            '<section class="card"><h2>Connection actions</h2><p class="hint">Disconnecting signs the bot out of WhatsApp and removes the local session — you must pair again. Reconnecting reuses the saved session.</p>' +
              '<div class="row">' +
                '<button class="btn ghost small" data-action="conn-reconnect">Reconnect</button>' +
                '<button class="btn danger small" data-action="conn-disconnect">Disconnect &amp; sign out</button>' +
              '</div>' +
              '<p class="hint" style="margin-top:14px">Session credentials are never exposed to this page.</p>' +
            '</section>' +
            '<section class="card"><h2>Link another device</h2><p class="hint">Open the pairing page to link a different number; the current session stays until you disconnect it.</p>' +
              '<a class="btn ghost small" href="/" target="_blank" rel="noopener">Open pairing page' + icon('arrow', 'sm') + '</a></section>' +
            '</div>';
    };

    /* ------------------------------------------------------------------- AI */

    render.ai = async function () {
        var data = await api('/api/dash/settings');
        var ai = data.ai;
        view().innerHTML =
            '<div class="stack">' +
            '<div class="grid cols-2">' +
              '<section class="card"><h2>AYHA configuration</h2><p class="hint">Applies to .ai, the group chatbot and private auto-reply instantly.</p>' +
                '<div class="field-group"><label class="field" for="ai-provider">AI provider</label>' +
                  '<select id="ai-provider">' + (ai.providers || []).map(function (provider) {
                      var hasKey = ai.keysConfigured && ai.keysConfigured[provider.id];
                      return '<option value="' + provider.id + '"' + (ai.provider === provider.id ? ' selected' : '') + '>' +
                          esc(provider.label) + (hasKey ? ' — key saved' : ' — no key yet') + '</option>';
                  }).join('') + '</select></div>' +
                '<div class="field-group"><label class="field" for="ai-model">Model</label><input id="ai-model" type="text" value="' + esc(ai.model) + '" placeholder="openrouter/free · gemini-2.0-flash · gpt-4o-mini · llama-3.3-70b-versatile" /></div>' +
                '<div class="field-group"><label class="field" for="ai-key">' + esc(ai.providerLabel || 'API') + ' key ' + (ai.keyConfigured ? '(configured · ' + esc(ai.maskedKey) + ')' : '(missing)') + '</label>' +
                  '<input id="ai-key" type="password" placeholder="sk-or-... / AIza... / hf_... / gsk_... (blank keeps it)" autocomplete="off" />' +
                  '<p class="hint">Each provider keeps its own key and model — switching back does not wipe them.</p></div>' +
                '<div class="field-group"><label class="field" for="ai-personality">AI agent</label>' +
                  '<select id="ai-personality">' + [
                      { id: 'companion', label: 'Companion — warm, playful friend' },
                      { id: 'professional', label: 'Professional — calm and precise' },
                      { id: 'venom', label: 'Savage — light roasts, no abuse' },
                      { id: 'tutor', label: 'Tutor — explains step by step' },
                      { id: 'coder', label: 'Developer — code-first answers' }
                  ].map(function (agent) {
                      return '<option value="' + agent.id + '"' + (ai.personality === agent.id ? ' selected' : '') + '>' + esc(agent.label) + '</option>';
                  }).join('') + '</select></div>' +
                '<div class="field-group"><label class="field" for="ai-language">Language preference</label>' +
                  '<select id="ai-language">' + ['auto', 'english', 'hindi', 'hinglish', 'bengali', 'benlish'].map(function (lang) {
                      return '<option value="' + lang + '"' + (ai.language === lang ? ' selected' : '') + '>' + lang + '</option>';
                  }).join('') + '</select></div>' +
                '<div class="field-group"><label class="field" for="ai-style">Talking style notes</label>' +
                  '<textarea id="ai-style" placeholder="short Hinglish, dry humour, quick comebacks">' + esc(ai.style) + '</textarea></div>' +
                '<div class="field-group"><label class="field" for="ai-instructions">Custom instructions</label>' +
                  '<textarea id="ai-instructions" rows="4" placeholder="Always call me Rahul. Keep answers under 3 lines. Never use emoji in code.">' + esc(ai.instructions || '') + '</textarea>' +
                  '<p class="hint">Sent with every request — .ai, the group chatbot and private auto-reply.</p></div>' +
                '<div class="row"><button class="btn" data-action="save-ai">Save AYHA settings</button>' +
                  (ai.keyConfigured ? '<button class="btn ghost small" data-action="clear-key">Remove saved key</button>' : '') + '</div>' +
                '<p class="hint" style="margin-top:10px">Base URL: <span class="mono">' + esc(ai.baseUrl) + '</span> · daily limit ' + esc(data.aiDailyLimit) + '</p>' +
              '</section>' +
              '<section class="card"><h2>Test AYHA live</h2><p class="hint">Sends one real request with the configured key and model.</p>' +
                '<div class="field-group"><label class="field" for="ai-prompt">Message</label>' +
                  '<textarea id="ai-prompt" placeholder="bro tu free hai?">bro tu free hai?</textarea></div>' +
                '<button class="btn" data-action="test-ai">Send test</button>' +
                '<div id="ai-result" style="margin-top:14px"></div></section>' +
            '</div>' +
            '<section class="card"><h2>How AYHA learns you</h2><p class="hint">' +
              'The bot reads the plain messages you send from your own phone (never commands, never bots) and mirrors that tone. ' +
              'Style notes above are layered on top, and every chat has its own separate memory.</p>' +
              '<div class="row"><a class="btn ghost small" href="#memory">Inspect style &amp; contacts</a><a class="btn ghost small" href="#autoreply">Auto-reply settings</a></div>' +
            '</section>' +
            '<section class="card"><h2>Provider slots &amp; failover</h2>' +
              '<p class="hint">Primary &rarr; Fallback 1 &rarr; Fallback 2. A slot is skipped when it is off, has no key, or has no vision support for an image. ' +
              'Order: <span class="mono">' + esc((ai.providerOrder || []).join(' → ')) + '</span>' +
              ((ai.providerSummary && ai.providerSummary.active) ? ' · active: <strong>' + esc(ai.providerSummary.active) + '</strong>' : ' · nothing active yet') + '</p>' +
              '<div class="grid cols-3">' + (ai.providerSlots || []).slice().sort(function (a, b) {
                  return (ai.providerOrder || []).indexOf(a.id) - (ai.providerOrder || []).indexOf(b.id);
              }).map(function (slot) {
                  return '<div class="card" style="box-shadow:none"><h3>' + esc(slot.label) + '</h3>' +
                    '<p class="hint">' + esc(slot.providerLabel) + ' · ' + (slot.enabled ? (slot.keyConfigured ? 'ready' : 'no key') : 'off') + (slot.vision ? ' · vision' : '') + '</p>' +
                    '<div class="field-group"><label class="field">Provider</label><select data-pv-provider="' + slot.id + '">' +
                      (ai.providers || []).map(function (provider) {
                          return '<option value="' + provider.id + '"' + (slot.provider === provider.id ? ' selected' : '') + '>' + esc(provider.label) + '</option>';
                      }).join('') + '</select></div>' +
                    '<div class="field-group"><label class="field">Base URL</label><input data-pv-base="' + slot.id + '" type="text" value="' + esc(slot.baseUrl) + '" placeholder="https://api.example.com/v1" /></div>' +
                    '<div class="field-group"><label class="field">Model</label><div class="row"><input data-pv-model="' + slot.id + '" type="text" value="' + esc(slot.model) + '" placeholder="model id" />' +
                      '<button class="btn ghost small" data-action="pv-models" data-slot="' + slot.id + '">List</button></div>' +
                      '<div id="pv-models-' + slot.id + '"></div></div>' +
                    '<div class="field-group"><label class="field">API key ' + (slot.keyConfigured ? '(' + esc(slot.maskedKey) + ')' : '(missing)') + '</label>' +
                      '<input data-pv-key="' + slot.id + '" type="password" autocomplete="off" placeholder="blank keeps the saved key" /></div>' +
                    '<div class="row"><label class="switch"><input type="checkbox" data-pv-enabled="' + slot.id + '"' + (slot.enabled ? ' checked' : '') + ' /><span class="track"></span></label><span class="hint">enabled</span>' +
                      '<label class="switch"><input type="checkbox" data-pv-vision="' + slot.id + '"' + (slot.vision ? ' checked' : '') + ' /><span class="track"></span></label><span class="hint">vision</span></div>' +
                    '<div class="row" style="margin-top:12px"><button class="btn small" data-action="pv-save" data-slot="' + slot.id + '">Save</button>' +
                      '<button class="btn ghost small" data-action="pv-test" data-slot="' + slot.id + '">Test</button>' +
                      '<button class="btn ghost icon-only small" data-action="pv-up" data-slot="' + slot.id + '" aria-label="Move up">' + icon('up', 'sm') + '</button>' +
                      '<button class="btn ghost icon-only small" data-action="pv-down" data-slot="' + slot.id + '" aria-label="Move down">' + icon('down', 'sm') + '</button></div>' +
                    '<div id="pv-result-' + slot.id + '" style="margin-top:10px"></div></div>';
              }).join('') + '</div>' +
              '<p class="hint" style="margin-top:12px">Keys are stored server-side only (never in the page, never in logs). A custom OpenAI-compatible endpoint needs only Base URL + Model + Key.</p>' +
            '</section></div>';
    };

    /* ------------------------------------------------------------ autoreply */

    render.autoreply = async function () {
        var data = await api('/api/dash/settings');
        var ai = data.ai;
        var modes = [
            { id: 'off', label: 'OFF' },
            { id: 'private', label: 'PRIVATE ONLY' },
            { id: 'group', label: 'GROUP ONLY' },
            { id: 'all', label: 'ALL CHATS' }
        ];
        var controls = data.controls || { pause: {}, quiet: {}, neverReply: [] };
        view().innerHTML =
            '<div class="stack">' +
            '<section class="card"><h2>Smart controls</h2>' +
              '<p class="hint">Persisted across restarts. Quiet hours and a manual pause are silent: AYHA sends nothing and no notice.</p>' +
              '<div class="grid cols-3">' +
                '<div class="stat"><div class="label">Auto-reply</div><div class="value small">' + (controls.pause && controls.pause.paused ? 'Paused' : 'Running') + '</div><div class="sub">' +
                  (controls.pause && controls.pause.paused ? esc(controls.pause.left + ' left') : 'no manual pause') + '</div></div>' +
                '<div class="stat"><div class="label">Quiet hours</div><div class="value small">' + (controls.quiet && controls.quiet.enabled ? 'On' : 'Off') + '</div><div class="sub">' +
                  (controls.quiet && controls.quiet.enabled ? esc(controls.quiet.label + (controls.quiet.active ? ' · active now' : '')) : 'always available') + '</div></div>' +
                '<div class="stat"><div class="label">Sensitive guard</div><div class="value small">' + (controls.sensitiveMode === 'hold' ? 'Hold' : 'Off') + '</div><div class="sub">' +
                  (controls.notifyOwner ? 'owner notice on' : 'owner notice off') + '</div></div>' +
              '</div>' +
              '<div class="row" style="margin-top:14px"><button class="btn ghost small" data-action="ai-pause" data-duration="30m">Pause 30m</button>' +
                '<button class="btn ghost small" data-action="ai-pause" data-duration="1h">Pause 1h</button>' +
                '<button class="btn ghost small" data-action="ai-pause" data-duration="4h">Pause 4h</button>' +
                '<button class="btn small" data-action="ai-resume">Resume now</button></div>' +
              '<div class="grid cols-2" style="margin-top:18px">' +
                '<div><div class="field-group"><label class="field">Quiet hours (HH:MM – HH:MM)</label><div class="row">' +
                  '<input id="quiet-start" type="text" value="' + esc(controls.quiet.start || '23:00') + '" placeholder="23:00" style="max-width:110px" />' +
                  '<input id="quiet-end" type="text" value="' + esc(controls.quiet.end || '07:00') + '" placeholder="07:00" style="max-width:110px" />' +
                  '<label class="switch"><input id="quiet-enabled" type="checkbox"' + (controls.quiet.enabled ? ' checked' : '') + ' /><span class="track"></span></label></div>' +
                  '<p class="hint">Timezone: ' + esc(controls.quiet.timezone || 'Asia/Kolkata') + '</p></div>' +
                  '<div class="field-group"><label class="field" for="handoff-minutes">Handoff after your manual reply (minutes, 0 = off)</label>' +
                    '<input id="handoff-minutes" type="number" min="0" max="1440" value="' + esc(controls.handoffMinutes) + '" /></div></div>' +
                '<div><div class="field-group"><label class="field" for="sensitive-mode">Sensitive messages (OTP, password, payment, private info, conflict)</label>' +
                  '<select id="sensitive-mode"><option value="hold"' + (controls.sensitiveMode === 'hold' ? ' selected' : '') + '>Hold — never auto-reply</option>' +
                  '<option value="off"' + (controls.sensitiveMode === 'off' ? ' selected' : '') + '>Off — reply normally</option></select></div>' +
                  '<div class="row" style="margin:10px 0 14px"><label class="switch"><input id="notify-owner" type="checkbox"' + (controls.notifyOwner ? ' checked' : '') + ' /><span class="track"></span></label><span class="hint">Send me a notice (category only, never the content)</span></div>' +
                  '<button class="btn" data-action="save-controls">Save controls</button></div>' +
              '</div>' +
              '<div class="field-group" style="margin-top:18px"><label class="field">Never-reply numbers</label>' +
                '<div class="row"><input id="never-input" type="text" placeholder="916033271400" /><button class="btn ghost small" data-action="never-add">Add</button></div>' +
                '<div class="list" style="margin-top:10px">' + ((controls.neverReply || []).length ? controls.neverReply.map(function (n) {
                    return '<div class="list-item"><span class="mono">' + esc(n) + '</span><button class="btn ghost small" data-action="never-remove" data-value="' + esc(n) + '">Remove</button></div>';
                }).join('') : '<div class="empty">Nobody is on the never-reply list.</div>') + '</div></div>' +
            '</section>' +
            '<section class="card"><h2>Master switch</h2><p class="hint">Only the owner can change this. Changes persist across restarts.</p>' +
              switchRow('autoreply', ai.enabled, 'Auto-reply enabled', 'AYHA answers according to the mode below', 'autoreply-enabled') +
              '<div class="field-group" style="margin-top:16px"><label class="field">Mode</label><div class="pill-row">' +
                modes.map(function (mode) {
                    return '<button class="chip' + (ai.mode === mode.id ? ' active' : '') + '" data-action="ar-mode" data-mode="' + mode.id + '">' + mode.label + '</button>';
                }).join('') +
              '</div></div>' +
              '<div class="field-group"><label class="field" for="ar-cooldown">Cooldown between replies (seconds)</label>' +
                '<input id="ar-cooldown" type="number" min="0" max="120" value="' + esc(ai.cooldownSec) + '" /></div>' +
              '<button class="btn" data-action="save-autoreply">Save auto-reply settings</button>' +
              '<p class="hint" style="margin-top:12px">Bot-loop prevention, duplicate protection and command filtering are always on.</p>' +
            '</section>' +
            '<div class="grid cols-2">' +
              '<section class="card"><h2>Allowlist</h2><p class="hint">When set, only these numbers get automatic replies.</p>' +
                '<div class="row"><input id="allow-input" type="text" placeholder="916033352400" /><button class="btn ghost small" data-action="add-allow">Add</button></div>' +
                '<div class="list" style="margin-top:12px">' + (ai.allowlist.length ? ai.allowlist.map(function (n) {
                    return '<div class="list-item"><span class="mono">' + esc(n) + '</span><button class="btn ghost small" data-action="del-allow" data-value="' + esc(n) + '">Remove</button></div>';
                }).join('') : '<div class="empty">Everyone can get a reply.</div>') + '</div></section>' +
              '<section class="card"><h2>Blocked users</h2><p class="hint">AYHA never replies to these numbers.</p>' +
                '<div class="row"><input id="block-input" type="text" placeholder="916033271400" /><button class="btn ghost small" data-action="add-block">Block</button></div>' +
                '<div class="list" style="margin-top:12px">' + (ai.blocked.length ? ai.blocked.map(function (n) {
                    return '<div class="list-item"><span class="mono">' + esc(n) + '</span><button class="btn ghost small" data-action="del-block" data-value="' + esc(n) + '">Unblock</button></div>';
                }).join('') : '<div class="empty">Nobody is blocked.</div>') + '</div></section>' +
            '</div></div>';
    };

    /* ------------------------------------------------------------- commands */

    function commandList(items) {
        if (!items.length) return '<div class="empty">No commands matched.</div>';
        return items.map(function (item) {
            return '<div class="list-item"><div><strong>' + esc(item.name) + '</strong> <small>· ' + esc(item.category) + '</small></div>' +
                '<div class="row"><span class="tag ' + (item.enabled ? 'on' : 'off') + '">' + (item.enabled ? 'enabled' : 'disabled') + '</span>' +
                '<label class="switch"><input type="checkbox" data-command="' + esc(item.name) + '"' + (item.enabled ? ' checked' : '') + ' /><span class="track"></span></label></div></div>';
        }).join('');
    }

    render.commands = async function () {
        var data = await api('/api/dash/commands');
        var categories = ['all'].concat([...new Set(data.commands.map(function (c) { return c.category; }))]);
        view().innerHTML =
            '<div class="stack">' +
            '<section class="card"><h2>Command library</h2><p class="hint">' + data.commands.length + ' commands loaded from the bot. Disabling one stops it from running for everyone until re-enabled.</p>' +
              '<div class="row"><input id="cmd-search" type="text" placeholder="Search commands…" style="flex:1 1 220px" /><select id="cmd-category" style="flex:0 1 180px">' +
                categories.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('') +
              '</select></div>' +
              '<div id="cmd-list" class="list" style="margin-top:14px">' + commandList(data.commands) + '</div>' +
            '</section></div>';
        window.__commands = data.commands;
        var search = el('cmd-search');
        var category = el('cmd-category');
        function apply() {
            var term = search.value.toLowerCase();
            var cat = category.value;
            var list = (window.__commands || []).filter(function (item) {
                return (cat === 'all' || item.category === cat) && item.name.toLowerCase().indexOf(term) !== -1;
            });
            el('cmd-list').innerHTML = commandList(list);
        }
        search.addEventListener('input', apply);
        category.addEventListener('change', apply);
    };

    render.plugins = async function () {
        var data = await api('/api/dash/commands');
        var groups = {};
        data.commands.forEach(function (item) { (groups[item.category] = groups[item.category] || []).push(item); });
        view().innerHTML =
            '<div class="stack">' +
            '<div class="banner">Plugins are the command files inside <span class="mono">commands/</span>. ' +
              'Every file Lily MD ships is listed — nothing is hidden because it is unused.</div>' +
            Object.keys(groups).sort().map(function (group) {
                var enabled = groups[group].filter(function (i) { return i.enabled; }).length;
                return '<section class="card"><h2>' + esc(group) + ' <span class="tag">' + enabled + '/' + groups[group].length + ' enabled</span></h2>' +
                    '<div class="list" style="margin-top:12px">' + groups[group].map(function (item) {
                        return '<div class="list-item"><span class="mono">' + esc(item.file) + '</span><span class="tag ' + (item.enabled ? 'on' : 'off') + '">' +
                            (item.enabled ? 'active' : 'disabled') + '</span></div>';
                    }).join('') + '</div></section>';
            }).join('') +
            '</div>';
    };

    render.groups = async function () {
        var data = await api('/api/dash/groups');
        view().innerHTML =
            '<div class="stack"><section class="card"><h2>Groups</h2><p class="hint">Fetched live from WhatsApp. ' +
            'Group-level settings (antilink, welcome, warnings) stay in the chat with .antilink, .welcome and .warn.</p>' +
            (data.groups && data.groups.length
                ? '<table><thead><tr><th>Group</th><th>Members</th><th>ID</th></tr></thead><tbody>' +
                  data.groups.map(function (group) {
                      return '<tr><td>' + esc(group.subject) + '</td><td>' + esc(group.size) + '</td><td class="mono wrap">' + esc(group.id) + '</td></tr>';
                  }).join('') + '</tbody></table>'
                : '<div class="empty">' + esc((data.reason || 'No groups available while the bot is offline.')) + '</div>') +
            '</section></div>';
    };

    /* ----------------------------------------------------------- toggles */

    function toggleCards(data, group) {
        return Object.keys(data.toggles).filter(function (key) {
            return data.toggles[key].group === group;
        }).map(function (key) {
            var item = data.toggles[key];
            return switchRow(key, item.value, item.label, key + '.json', 'setting');
        }).join('');
    }

    render.protection = async function () {
        var data = await api('/api/dash/settings');
        view().innerHTML =
            '<div class="stack"><section class="card"><h2>Protection</h2><p class="hint">Global switches. They persist in data/*.json and the in-chat commands show the same values.</p>' +
            toggleCards(data, 'protection') +
            '<div class="field-group" style="margin-top:16px"><label class="field" for="pm-message">PM blocker message</label>' +
              '<textarea id="pm-message" placeholder="Direct messages are blocked.">' + esc(data.pmMessage) + '</textarea></div>' +
              '<button class="btn ghost small" data-action="save-pm">Save message</button>' +
            '</section>' +
            '<div class="banner">Anti-link and anti-badword are per group. Use <span class="mono">.antilink on</span> inside the group.</div>' +
            '</div>';
    };

    render.autostatus = async function () {
        var data = await api('/api/dash/settings');
        view().innerHTML =
            '<div class="stack"><section class="card"><h2>Auto status</h2><p class="hint">Read and react to status updates as they arrive.</p>' +
              switchRow('autostatus-view', data.autoStatus.enabled, 'Auto-view statuses', 'marks every status as seen', 'autostatus') +
              switchRow('autostatus-react', data.autoStatus.reactOn, 'Auto-react to statuses', 'adds a reaction to new statuses', 'autostatus') +
            '</section></div>';
    };

    render.media = async function () {
        var data = await api('/api/dash/commands');
        var media = data.commands.filter(function (c) { return c.category === 'downloads' || c.category === 'media'; });
        view().innerHTML =
            '<div class="stack"><section class="card"><h2>Media &amp; downloads</h2><p class="hint">These commands are active in chat. Providers are configured in lib/atlasApi.js.</p>' +
            '<div class="list" style="margin-top:12px">' + (media.length ? media.map(function (item) {
                return '<div class="list-item"><span class="mono">.' + esc(item.name) + '</span><span class="tag ' + (item.enabled ? 'on' : 'off') + '">' +
                    (item.enabled ? 'ready' : 'disabled') + '</span></div>';
            }).join('') : '<div class="empty">No media commands found.</div>') + '</div>' +
            '<div class="row" style="margin-top:14px"><a class="btn ghost small" href="#commands">Manage commands</a></div></section></div>';
    };

    render.themes = async function () {
        var data = await api('/api/dash/settings');
        view().innerHTML =
            '<div class="stack">' +
            '<section class="card"><h2>Bot mode</h2><p class="hint">Public lets everyone use commands; private limits the bot to owners and sudo users.</p>' +
              '<div class="pill-row">' +
                ['public', 'private'].map(function (mode) {
                    return '<button class="chip' + (data.mode === mode ? ' active' : '') + '" data-action="set-mode" data-mode="' + mode + '">' + mode + '</button>';
                }).join('') +
              '</div></section>' +
            '<section class="card"><h2>Branding</h2><p class="hint">The bot keeps the official Lily MD theme; these are the live values.</p>' +
              '<table><tbody>' +
                '<tr><th>Prefix</th><td class="mono">. and - (both accepted)</td></tr>' +
                '<tr><th>Website</th><td class="wrap">' + esc(data.websiteUrl) + '</td></tr>' +
                '<tr><th>Repository</th><td class="wrap mono">' + esc(data.githubRepo || 'not set') + '</td></tr>' +
                '<tr><th>Owners</th><td class="mono">' + esc(data.ownerNumbers.join(', ')) + '</td></tr>' +
              '</tbody></table></section></div>';
    };

    /* --------------------------------------------------------------- owners */

    render.owners = async function () {
        var data = await api('/api/dash/owners');
        view().innerHTML =
            '<div class="stack">' +
            '<section class="card"><h2>Owner accounts</h2><p class="hint">Only configured owner numbers can have an account. Resetting sends a new temporary password to that WhatsApp.</p>' +
              '<table><thead><tr><th>Number</th><th>Role</th><th>Last login</th><th>Password</th><th></th></tr></thead><tbody>' +
              (data.accounts.length ? data.accounts.map(function (account) {
                  return '<tr><td class="mono">' + esc(account.number) + '</td><td>' + esc(account.role) + '</td><td>' + esc(when(account.lastLoginAt)) +
                      '</td><td>' + (account.mustChangePassword ? '<span class="tag off">temporary</span>' : '<span class="tag on">set</span>') +
                      '</td><td><button class="btn ghost small" data-action="reset-owner" data-number="' + esc(account.number) + '">Reset password</button></td></tr>';
              }).join('') : '<tr><td colspan="5"><div class="empty">No dashboard account yet. Pair an owner number to provision one.</div></td></tr>') +
              '</tbody></table>' +
              '<p class="hint" style="margin-top:12px">Authorized owner numbers: <span class="mono">' + esc(data.configured.join(', ')) + '</span></p>' +
            '</section>' +
            '<section class="card"><h2>Active sessions</h2><p class="hint">Revoking ends that login immediately.</p>' +
              '<table><thead><tr><th>Account</th><th>Created</th><th>Expires</th><th>IP</th><th></th></tr></thead><tbody>' +
              (data.sessions.length ? data.sessions.map(function (session) {
                  return '<tr><td class="mono">' + esc(session.number) + '</td><td>' + esc(when(session.createdAt)) + '</td><td>' + esc(when(session.expiresAt)) +
                      '</td><td class="mono">' + esc(session.ip) + '</td><td><button class="btn ghost small" data-action="revoke-session" data-id="' + esc(session.id) + '">Revoke</button></td></tr>';
              }).join('') : '<tr><td colspan="5"><div class="empty">No active sessions.</div></td></tr>') +
              '</tbody></table></section></div>';
    };

    /* --------------------------------------------------------------- memory */

    render.memory = async function () {
        var data = await api('/api/dash/database');
        var memory = await api('/api/dash/memory');
        var facts = Object.keys(memory.facts || {});
        view().innerHTML =
            '<div class="stack">' +
            '<div class="grid cols-3">' +
              '<div class="stat"><div class="label">Storage files</div><div class="value">' + data.files.length + '</div><div class="sub">' + (data.totalBytes / 1024).toFixed(1) + ' KB total</div></div>' +
              '<div class="stat"><div class="label">Style samples</div><div class="value">' + memory.styleSamples.length + '</div><div class="sub">learned from your messages</div></div>' +
              '<div class="stat"><div class="label">AI requests</div><div class="value">' + memory.usage.total + '</div><div class="sub">' + memory.usage.today + ' today</div></div>' +
            '</div>' +
            '<div class="grid cols-2">' +
              '<section class="card"><h2>AYHA memory</h2><p class="hint">Everything the assistant remembers about your writing style.</p>' +
                (memory.styleSamples.length ? '<div class="list">' + memory.styleSamples.slice(-10).reverse().map(function (sample) {
                    return '<div class="list-item"><span>' + esc(sample) + '</span></div>';
                }).join('') + '</div>' : '<div class="empty">No style samples learned yet.</div>') +
                (facts.length ? '<p class="hint" style="margin-top:12px">Facts: ' + esc(facts.map(function (k) { return k + '=' + memory.facts[k]; }).join(', ')) + '</p>' : '') +
                '<div class="row" style="margin-top:14px"><button class="btn danger small" data-action="memory-clear">Clear style memory</button></div>' +
              '</section>' +
              '<section class="card"><h2>Contact memories</h2><p class="hint">One separate memory per chat. Each row is only ever used in that conversation.</p>' +
                ((memory.contacts || []).length ? '<div class="list">' + memory.contacts.slice(0, 25).map(function (contact) {
                    return '<div class="list-item"><div><strong class="mono">' + esc(contact.number || contact.chatId) + '</strong>' + (contact.name ? ' · ' + esc(contact.name) : '') +
                      '<br /><small>' + esc(contact.turns) + ' messages · ' + esc(contact.language || 'unknown') + (contact.facts && Object.keys(contact.facts).length ? ' · ' + esc(Object.keys(contact.facts).map(function (k) { return k + '=' + contact.facts[k]; }).join(', ')) : '') +
                      (contact.lastMessage ? '<br />“' + esc(contact.lastMessage.slice(0, 80)) + '”' : '') + '</small></div>' +
                      '<div class="row"><button class="btn ghost small" data-action="contact-mode" data-id="' + esc(contact.chatId) + '" data-mode="on">On</button>' +
                      '<button class="btn ghost small" data-action="contact-mode" data-id="' + esc(contact.chatId) + '" data-mode="off">Off</button>' +
                      '<button class="btn ghost small" data-action="contact-mode" data-id="' + esc(contact.chatId) + '" data-mode="never">Never</button>' +
                      '<button class="btn ghost small" data-action="contact-clear-handoff" data-id="' + esc(contact.chatId) + '">Resume</button>' +
                      '<button class="btn ghost small" data-action="contact-delete" data-id="' + esc(contact.chatId) + '">Delete</button></div></div>';
                }).join('') + '</div>' : '<div class="empty">No contact memory stored yet.</div>') +
                ((memory.contacts || []).length ? '<div class="row" style="margin-top:12px"><button class="btn danger small" data-action="contact-clear">Clear all contact memories</button></div>' : '') +
              '</section>' +
              '<section class="card"><h2>Storage health</h2><p class="hint">Data files on this server.</p>' +
                '<div class="list">' + data.files.slice(0, 12).map(function (file) {
                    return '<div class="list-item"><span class="mono">' + esc(file.name) + '</span><small>' + (file.bytes / 1024).toFixed(1) + ' KB</small></div>';
                }).join('') + '</div>' +
                '<p class="hint" style="margin-top:12px">Session backup: ' + esc(data.sessionBackupAt ? when(data.sessionBackupAt) : 'none') + ' · session folder: ' +
                (data.sessionPresent ? 'present' : 'missing') + '</p>' +
              '</section>' +
            '</div></div>';
    };

    render.logs = async function () {
        var data = await api('/api/dash/logs');
        view().innerHTML =
            '<div class="stack"><div class="grid cols-2">' +
            '<section class="card"><h2>Server events</h2><p class="hint">Pairing, configuration and connection changes.</p>' +
              (data.events.length ? '<div class="list">' + data.events.map(function (event) {
                  return '<div class="list-item"><span><span class="tag ' + (event.level === 'error' ? 'off' : '') + '">' + esc(event.type) + '</span> ' +
                      esc(event.message) + '</span><small>' + esc(when(event.at)) + '</small></div>';
              }).join('') + '</div>' : '<div class="empty">No events yet.</div>') +
            '</section>' +
            '<section class="card"><h2>Authentication audit</h2><p class="hint">Logins, failures, lockouts and password changes.</p>' +
              (data.audit.length ? '<div class="list">' + data.audit.map(function (entry) {
                  return '<div class="list-item"><span><span class="tag">' + esc(entry.action) + '</span> ' + esc(entry.number || entry.prefix || '') +
                      '</span><small>' + esc(when(entry.at)) + '</small></div>';
              }).join('') + '</div>' : '<div class="empty">No audit entries yet.</div>') +
            '</section></div></div>';
    };

    render.security = async function () {
        var data = await api('/api/dash/owners');
        view().innerHTML =
            '<div class="stack">' +
            '<section class="card"><h2>Change password</h2><p class="hint">Changing it signs out every session, including this one.</p>' +
              '<div class="field-group"><label class="field" for="cur-pass">Current password</label><input id="cur-pass" type="password" autocomplete="current-password" /></div>' +
              '<div class="field-group"><label class="field" for="new-pass">New password (10+ chars, letters and numbers)</label><input id="new-pass" type="password" autocomplete="new-password" /></div>' +
              '<div class="field-group"><label class="field" for="new-pass2">Repeat new password</label><input id="new-pass2" type="password" autocomplete="new-password" /></div>' +
              '<button class="btn" data-action="change-password">Update password</button>' +
            '</section>' +
            '<section class="card"><h2>Sessions</h2><p class="hint">Each row is a browser login. Revoke anything you do not recognise.</p>' +
              '<table><thead><tr><th>Account</th><th>IP</th><th>Started</th><th>Expires</th><th></th></tr></thead><tbody>' +
              (data.sessions.length ? data.sessions.map(function (session) {
                  return '<tr><td class="mono">' + esc(session.number) + '</td><td class="mono">' + esc(session.ip) + '</td><td>' + esc(when(session.createdAt)) +
                      '</td><td>' + esc(when(session.expiresAt)) + '</td><td><button class="btn ghost small" data-action="revoke-session" data-id="' +
                      esc(session.id) + '">Revoke</button></td></tr>';
              }).join('') : '<tr><td colspan="5"><div class="empty">No sessions.</div></td></tr>') +
              '</tbody></table></section>' +
            '<section class="card"><h2>Security model</h2><table><tbody>' +
              '<tr><th>Password storage</th><td>scrypt (N=16384) with a per-account salt, constant-time compare</td></tr>' +
              '<tr><th>Session</th><td>HttpOnly cookie, SHA-256 hash stored server-side, ' + 12 + 'h expiry</td></tr>' +
              '<tr><th>CSRF</th><td>Per-session token required on every mutation</td></tr>' +
              '<tr><th>Lockout</th><td>5 failed attempts → 15 minutes</td></tr>' +
            '</tbody></table></section></div>';
    };

    render.settings = async function () {
        var status = await api('/api/dash/status');
        var data = await api('/api/dash/settings');
        view().innerHTML =
            '<div class="stack"><section class="card"><h2>General</h2><p class="hint">Read from the running process and settings.</p>' +
              '<table><tbody>' +
                '<tr><th>Bot</th><td>' + esc(status.botName) + ' v' + esc(status.version) + '</td></tr>' +
                '<tr><th>AI engine</th><td>' + esc(status.aiName) + '</td></tr>' +
                '<tr><th>Node</th><td class="mono">' + esc(status.node) + '</td></tr>' +
                '<tr><th>Uptime</th><td>' + esc(fmtUptime(status.uptimeSeconds)) + '</td></tr>' +
                '<tr><th>Daily AI limit</th><td>' + esc(data.aiDailyLimit) + ' per user (0 = unlimited)</td></tr>' +
                '<tr><th>Website</th><td class="wrap">' + esc(data.websiteUrl) + '</td></tr>' +
                '<tr><th>Backend URL</th><td class="wrap mono">' + esc(LilyAPI.backend() || location.origin) + '</td></tr>' +
              '</tbody></table></section>' +
              '<section class="card"><h2>Dashboard access</h2><p class="hint">Sign out of this browser, or change your password.</p>' +
              '<div class="row"><a class="btn ghost small" href="#security">Security</a><button class="btn danger small" data-action="logout">Sign out</button></div></section>' +
            '</div>';
    };

    /* -------------------------------------------------------------- routing */

    async function route() {
        var id = (location.hash || '#overview').slice(1);
        if (!render[id]) id = 'overview';
        current = id;
        highlight();
        view().innerHTML = '<div class="grid cols-4"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
        try {
            await render[id]();
        } catch (err) {
            fail(err);
            view().innerHTML = '<div class="banner error">' + esc(err.message || 'Could not load this section.') +
                '</div><div class="row" style="margin-top:14px"><button class="btn ghost small" data-action="refresh">Try again</button></div>';
        }
    }

    /* --------------------------------------------------------------- events */

    document.addEventListener('change', async function (event) {
        var target = event.target;

        if (target.matches('[data-command]')) {
            var name = target.dataset.command;
            var enabled = target.checked;
            try {
                await mutate('/api/dash/commands/toggle', { name: name, enabled: enabled });
                toast((enabled ? 'Enabled ' : 'Disabled ') + name, 'success');
                var tag = target.closest('.list-item').querySelector('.tag');
                if (tag) {
                    tag.className = 'tag ' + (enabled ? 'on' : 'off');
                    tag.textContent = enabled ? 'enabled' : 'disabled';
                }
            } catch (err) {
                target.checked = !enabled;
                fail(err);
            }
            return;
        }

        if (target.dataset.toggle === 'setting') {
            var key = target.dataset.key;
            var value = target.checked;
            try {
                await mutate('/api/dash/settings/toggle', { key: key, value: value });
                toast(key + ' ' + (value ? 'enabled' : 'disabled'), 'success');
            } catch (err) {
                target.checked = !value;
                fail(err);
            }
            return;
        }

        if (target.dataset.toggle === 'autostatus') {
            var field = target.dataset.key === 'autostatus-view' ? 'enabled' : 'reactOn';
            var on = target.checked;
            try {
                var payload = {};
                payload[field] = on;
                await mutate('/api/dash/settings/autostatus', payload);
                toast('Auto status updated', 'success');
            } catch (err) {
                target.checked = !on;
                fail(err);
            }
            return;
        }

        if (target.dataset.toggle === 'autoreply-enabled') {
            var enabledState = target.checked;
            try {
                await mutate('/api/dash/autoreply', { enabled: enabledState });
                toast('Auto-reply ' + (enabledState ? 'enabled' : 'disabled'), 'success');
            } catch (err) {
                target.checked = !enabledState;
                fail(err);
            }
        }
    });

    document.addEventListener('click', async function (event) {
        var button = event.target.closest('[data-action]');
        if (!button) return;
        var action = button.dataset.action;
        var ctx = button.closest('.card') || document;

        try {
            if (action === 'refresh') {
                await route();
                toast('Refreshed', 'success');
            } else if (action === 'logout') {
                await mutate('/api/auth/logout', {});
                location.href = '/login';
            } else if (action === 'conn-disconnect') {
                if (!confirm('Disconnect Lily MD from WhatsApp and delete the local session? You will have to pair again.')) return;
                busy(button, true, 'Disconnecting…');
                await mutate('/api/dash/connection/action', { action: 'disconnect', confirm: true });
                toast('Disconnect requested', 'success');
                setTimeout(route, 1500);
            } else if (action === 'conn-reconnect') {
                if (!confirm('Ask the bot to reconnect using the saved session?')) return;
                busy(button, true, 'Reconnecting…');
                await mutate('/api/dash/connection/action', { action: 'reconnect', confirm: true });
                toast('Reconnect requested', 'success');
                setTimeout(route, 1500);
            } else if (action === 'save-ai') {
                busy(button, true, 'Saving…');
                var payload = {
                    provider: el('ai-provider').value,
                    model: el('ai-model').value.trim(),
                    style: el('ai-style').value,
                    instructions: el('ai-instructions').value,
                    personality: el('ai-personality').value,
                    language: el('ai-language').value
                };
                var keyValue = el('ai-key').value.trim();
                if (keyValue) payload.apiKey = keyValue;
                await mutate('/api/dash/ai', payload);
                toast('AYHA settings saved', 'success');
                el('ai-key').value = '';
                await route();
            } else if (action === 'clear-key') {
                if (!confirm('Remove the key saved from the dashboard and fall back to the .env key?')) return;
                await mutate('/api/dash/ai', { clearKey: true });
                toast('Saved key removed', 'success');
                await route();
            } else if (action === 'test-ai') {
                busy(button, true, 'Testing…');
                var out = el('ai-result');
                out.innerHTML = '<div class="banner">Calling OpenRouter…</div>';
                try {
                    var result = await api('/api/dash/ai/test', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json', 'x-lily-csrf': csrf || '' },
                        body: JSON.stringify({ prompt: el('ai-prompt').value }),
                        timeoutMs: 45000
                    });
                    out.innerHTML = '<div class="banner success">' + esc(result.reply) + '</div><p class="hint">' +
                        esc(result.provider || '') + ' · ' + esc(result.model) + ' · ' + esc(result.ms) + 'ms</p>';
                } catch (err) {
                    out.innerHTML = '<div class="banner error">' + esc(err.message) + '</div>';
                } finally {
                    busy(button, false);
                }
            } else if (action === 'ar-mode') {
                var mode = button.dataset.mode;
                await mutate('/api/dash/autoreply', { mode: mode, enabled: mode !== 'off' });
                toast('Mode set to ' + mode, 'success');
                await route();
            } else if (action === 'save-autoreply') {
                busy(button, true, 'Saving…');
                await mutate('/api/dash/autoreply', { cooldownSec: Number(el('ar-cooldown').value) });
                toast('Auto-reply settings saved', 'success');
                await route();
            } else if (action === 'add-allow' || action === 'add-block') {
                var input = el(action === 'add-allow' ? 'allow-input' : 'block-input');
                var number = input.value.replace(/[^0-9]/g, '');
                if (number.length < 7) { toast('Enter a number with country code.', 'error'); return; }
                var body = {};
                var currentSettings = await api('/api/dash/settings');
                if (action === 'add-allow') {
                    body.allowlist = currentSettings.ai.allowlist.concat([number]);
                    body.blocked = currentSettings.ai.blocked.filter(function (n) { return n !== number; });
                } else {
                    body.blocked = currentSettings.ai.blocked.concat([number]);
                }
                await mutate('/api/dash/autoreply', body);
                toast('Saved', 'success');
                await route();
            } else if (action === 'del-allow' || action === 'del-block') {
                var settingsNow = await api('/api/dash/settings');
                var value = button.dataset.value;
                if (action === 'del-allow') {
                    await mutate('/api/dash/autoreply', { allowlist: settingsNow.ai.allowlist.filter(function (n) { return n !== value; }) });
                } else {
                    await mutate('/api/dash/autoreply', { blocked: settingsNow.ai.blocked.filter(function (n) { return n !== value; }) });
                }
                await route();
            } else if (action === 'save-pm') {
                await mutate('/api/dash/settings/toggle', { key: 'pmblocker', value: true, message: el('pm-message').value });
                toast('PM message saved', 'success');
            } else if (action === 'set-mode') {
                await mutate('/api/dash/settings/mode', { mode: button.dataset.mode });
                toast('Bot mode updated', 'success');
                await route();
            } else if (action === 'reset-owner') {
                if (!confirm('Send a new temporary password to ' + button.dataset.number + ' on WhatsApp?')) return;
                busy(button, true, 'Sending…');
                await mutate('/api/dash/owners/reset-password', { number: button.dataset.number });
                toast('Temporary password sent on WhatsApp', 'success');
            } else if (action === 'revoke-session') {
                if (!confirm('Revoke this session? That browser will be signed out.')) return;
                await mutate('/api/dash/sessions/revoke', { id: button.dataset.id });
                toast('Session revoked', 'success');
                await route();
            } else if (action === 'memory-clear') {
                if (!confirm('Clear AYHA’s learned style samples and facts? This cannot be undone.')) return;
                await mutate('/api/dash/memory/clear', {});
                toast('Memory cleared', 'success');
                await route();
            } else if (action === 'ai-pause') {
                var duration = button.dataset.duration || '1h';
                busy(button, true, 'Pausing…');
                await mutate('/api/dash/ai/controls', { action: 'pause', duration: duration });
                toast('AYHA paused for ' + duration, 'success');
                await route();
            } else if (action === 'ai-resume') {
                await mutate('/api/dash/ai/controls', { action: 'resume' });
                toast('AYHA resumed', 'success');
                await route();
            } else if (action === 'save-controls') {
                busy(button, true, 'Saving…');
                await mutate('/api/dash/ai/controls', {
                    quietHours: {
                        enabled: el('quiet-enabled').checked,
                        start: el('quiet-start').value.trim(),
                        end: el('quiet-end').value.trim()
                    },
                    handoffMinutes: Number(el('handoff-minutes').value),
                    sensitiveMode: el('sensitive-mode').value,
                    notifyOwner: el('notify-owner').checked
                });
                toast('Controls saved', 'success');
                await route();
            } else if (action === 'never-add') {
                var neverNumber = el('never-input').value.replace(/[^0-9]/g, '');
                if (neverNumber.length < 7) { toast('Enter a number with country code.', 'error'); return; }
                await mutate('/api/dash/ai/controls', { neverAdd: neverNumber });
                toast('Number added to never-reply', 'success');
                await route();
            } else if (action === 'never-remove') {
                await mutate('/api/dash/ai/controls', { neverRemove: button.dataset.value });
                toast('Number removed', 'success');
                await route();
            } else if (action === 'contact-mode') {
                var mode = button.dataset.mode;
                var body = mode === 'never' ? { never: true } : { autoReply: mode, never: false };
                body.id = button.dataset.id;
                await mutate('/api/dash/ai/contacts/settings', body);
                toast('Contact rule saved', 'success');
                await route();
            } else if (action === 'contact-clear-handoff') {
                await mutate('/api/dash/ai/controls', { action: 'resume', id: button.dataset.id });
                toast('AYHA is active for that contact again', 'success');
                await route();
            } else if (action === 'contact-delete') {
                if (!confirm('Delete the stored memory for this contact?')) return;
                await mutate('/api/dash/ai/contacts/delete', { id: button.dataset.id });
                toast('Contact memory deleted', 'success');
                await route();
            } else if (action === 'contact-clear') {
                if (!confirm('Delete every contact memory? Style learning is kept.')) return;
                await mutate('/api/dash/ai/contacts/delete', { all: true });
                toast('Contact memories cleared', 'success');
                await route();
            } else if (action === 'pv-save' || action === 'pv-test' || action === 'pv-models' || action === 'pv-pick' || action === 'pv-up' || action === 'pv-down') {
                var slotId = button.dataset.slot;
                var q = function (sel) { return document.querySelector(sel); };
                if (action === 'pv-save') {
                    busy(button, true, 'Saving…');
                    var slotBody = {
                        slot: slotId,
                        provider: q('[data-pv-provider="' + slotId + '"]').value,
                        baseUrl: q('[data-pv-base="' + slotId + '"]').value.trim(),
                        model: q('[data-pv-model="' + slotId + '"]').value.trim(),
                        vision: q('[data-pv-vision="' + slotId + '"]').checked,
                        enabled: q('[data-pv-enabled="' + slotId + '"]').checked
                    };
                    var slotKey = q('[data-pv-key="' + slotId + '"]').value.trim();
                    if (slotKey) slotBody.apiKey = slotKey;
                    await mutate('/api/dash/ai/providers', slotBody);
                    toast('Provider slot saved', 'success');
                    await route();
                } else if (action === 'pv-test') {
                    busy(button, true, 'Testing…');
                    var slotOut = el('pv-result-' + slotId);
                    if (slotOut) slotOut.innerHTML = '<div class="banner">Sending one real request…</div>';
                    try {
                        var slotResult = await api('/api/dash/ai/providers/test', {
                            method: 'POST',
                            headers: { 'content-type': 'application/json', 'x-lily-csrf': csrf || '' },
                            body: JSON.stringify({
                                slot: slotId,
                                prompt: 'Say hello in one short line.',
                                provider: q('[data-pv-provider="' + slotId + '"]').value,
                                baseUrl: q('[data-pv-base="' + slotId + '"]').value.trim(),
                                model: q('[data-pv-model="' + slotId + '"]').value.trim(),
                                apiKey: q('[data-pv-key="' + slotId + '"]').value.trim() || undefined
                            }),
                            timeoutMs: 60000
                        });
                        if (slotOut) slotOut.innerHTML = '<div class="banner success">' + esc(slotResult.reply || 'ok') + '</div><p class="hint">' + esc(slotResult.provider || '') + ' · ' + esc(slotResult.model || '') + ' · ' + esc(slotResult.ms) + 'ms</p>';
                    } catch (err) {
                        if (slotOut) slotOut.innerHTML = '<div class="banner error">' + esc(err.message) + '</div>';
                    } finally {
                        busy(button, false);
                    }
                } else if (action === 'pv-models') {
                    busy(button, true, 'Loading…');
                    var modelOut = el('pv-models-' + slotId);
                    try {
                        var listed = await api('/api/dash/ai/providers/models?slot=' + encodeURIComponent(slotId));
                        if (!listed.ok) {
                            modelOut.innerHTML = '<p class="hint">' + esc(listed.reason || 'Listing unsupported — type the model id.') + '</p>';
                        } else if (!listed.models.length) {
                            modelOut.innerHTML = '<p class="hint">No models returned — type the model id.</p>';
                        } else {
                            modelOut.innerHTML = '<div class="pill-row" style="margin-top:8px">' + listed.models.slice(0, 12).map(function (model) {
                                return '<button class="chip" data-action="pv-pick" data-slot="' + esc(slotId) + '" data-model="' + esc(model) + '">' + esc(model) + '</button>';
                            }).join('') + '</div><p class="hint">' + esc(listed.models.length) + ' models available</p>';
                        }
                    } catch (err) {
                        modelOut.innerHTML = '<p class="hint">' + esc(err.message) + '</p>';
                    } finally {
                        busy(button, false);
                    }
                } else if (action === 'pv-pick') {
                    q('[data-pv-model="' + slotId + '"]').value = button.dataset.model;
                    toast('Model picked — press Save', 'success');
                } else if (action === 'pv-up' || action === 'pv-down') {
                    var currentOrder = (await api('/api/dash/ai/providers')).order.slice();
                    var index = currentOrder.indexOf(slotId);
                    var swapWith = action === 'pv-up' ? index - 1 : index + 1;
                    if (swapWith < 0 || swapWith >= currentOrder.length) return;
                    var moved = currentOrder[swapWith];
                    currentOrder[swapWith] = slotId;
                    currentOrder[index] = moved;
                    await mutate('/api/dash/ai/providers/order', { order: currentOrder });
                    toast('Failover order updated', 'success');
                    await route();
                }
            } else if (action === 'change-password') {
                var currentPass = el('cur-pass').value;
                var newPass = el('new-pass').value;
                var repeat = el('new-pass2').value;
                if (newPass !== repeat) { toast('New passwords do not match.', 'error'); return; }
                busy(button, true, 'Updating…');
                await mutate('/api/auth/password', { currentPassword: currentPass, newPassword: newPass });
                toast('Password changed — sign in again.', 'success');
                setTimeout(function () { location.href = '/login'; }, 1200);
            }
        } catch (err) {
            fail(err);
        } finally {
            busy(button, false);
        }
    });

    el('refresh').addEventListener('click', function () { route(); });
    el('menu-toggle').addEventListener('click', function () {
        el('sidebar').classList.add('open');
        el('backdrop').classList.add('show');
    });
    el('backdrop').addEventListener('click', function () {
        el('sidebar').classList.remove('open');
        el('backdrop').classList.remove('show');
    });
    el('logout').addEventListener('click', async function (event) {
        event.preventDefault();
        try { await mutate('/api/auth/logout', {}); } catch (err) {}
        location.href = '/login';
    });
    window.addEventListener('hashchange', route);

    (async function boot() {
        try {
            var data = await api('/api/auth/me');
            me = data.account;
            csrf = data.csrf;
        } catch (err) {
            if (err.status === 401) { location.href = '/login'; return; }
            view().innerHTML = '<div class="banner error">' + esc(err.message) + '</div>';
            return;
        }
        el('who').textContent = me.number + ' · ' + me.role;
        renderNav();
        await route();
        connectEvents();
        if (me.mustChangePassword) toast('You are using a temporary password — change it in Security.', 'error');
    })();
})();
