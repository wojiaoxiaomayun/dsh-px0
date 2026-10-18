/**
 * Client half of @dsh-xhl/dsh-px0-preview.
 *
 * Registers a right-sidebar tab type (kind "px0") that claims session file
 * addresses at the `extension` band — outranking the built-in text preview —
 * and renders px0 in a same-origin iframe pointed at the Host's /px0/ proxy.
 */
window.__ModuleLoader__.load({
  id: '@dsh-xhl/dsh-px0-preview',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useCallback } = React;

    const NS = 'px0';
    const PX0_ID = '@dsh-xhl/dsh-px0-preview';
    const PX0_KIND = 'px0';

    const en = {
      tabTitle: 'px0',
      'status.missing': 'px0 binary not found. Downloading on first start…',
      'status.downloading': 'Downloading px0…',
      'status.starting': 'Starting px0…',
      'status.updating': 'Updating px0…',
      'status.failed': 'px0 failed to start.',
      'status.idle': 'px0 is not running yet…',
      retry: 'Retry',
      updateAvailable: 'px0 {version} available',
      update: 'Update',
      openExternal: 'Open in browser',
      openFolder: 'Open folder in File Explorer',
      openVsCode: 'Open folder in VS Code',
      vsCodeMissing: 'VS Code not found',
      openFailed: 'Could not open the folder',
      'guide.description': 'Browse and preview the workspace in px0',
    };
    const zh = {
      tabTitle: 'px0',
      'status.missing': '未找到 px0 二进制，首次启动将自动下载…',
      'status.downloading': '正在下载 px0…',
      'status.starting': '正在启动 px0…',
      'status.updating': '正在更新 px0…',
      'status.failed': 'px0 启动失败。',
      'status.idle': 'px0 尚未启动…',
      retry: '重试',
      updateAvailable: 'px0 {version} 可用',
      update: '更新',
      openExternal: '在浏览器中打开',
      openFolder: '在文件资源管理器中打开文件夹',
      openVsCode: '在 VS Code 中打开文件夹',
      vsCodeMissing: '未检测到 VS Code',
      openFailed: '无法打开该文件夹',
      'guide.description': '用 px0 浏览与预览工作区文件',
    };

    /** Decode `dsh-resource://file/session/<sessionId>/<path>` into a workspace-relative path. */
    function filePathOf(address) {
      try {
        const m = /^dsh-resource:\/\/file\/session\/[^/]+\/(.+)$/.exec(address);
        if (m) return m[1].split('/').map(decodeURIComponent).join('/');
      } catch { /* fall through */ }
      return null;
    }

    /**
     * One control-plane call against this plugin's Host half.
     * The Host registers `/px0-api` on the same Web origin, so the browser's
     * existing session cookie authorizes the request.
     * @param {string} action status | start | update | openRoot
     * @param {Record<string,string>} [query]
     */
    async function control(action, query) {
      const qs = query ? '?' + new URLSearchParams(query).toString() : '';
      const res = await fetch(`/px0-api/${action}${qs}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      return body;
    }

    /**
     * Ask the Host which desktop applications are actually installed.
     * The open-in-app plugin resolves each catalog entry against the real
     * system, so this is the authoritative answer: an app missing here cannot
     * be launched and its button must not pretend otherwise.
     * @returns {Promise<string[]>} installed catalog ids, e.g. ['explorer', 'vscode']
     */
    async function installedApps() {
      try {
        const res = await fetch('/open-in-app/apps', {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        });
        if (!res.ok) return [];
        const payload = await res.json();
        return Array.isArray(payload.apps) ? payload.apps.filter((id) => typeof id === 'string') : [];
      } catch {
        return [];
      }
    }

    /**
     * Ask the Host to launch an installed desktop application on a directory.
     * Reuses the product's own open-in-app endpoints, so the launch rules
     * (which apps exist, how each is invoked) stay owned by that plugin rather
     * than duplicated here.
     * @param {string} app catalog id: 'explorer', 'vscode', …
     * @param {string} path absolute directory to open
     */
    async function launchApp(app, path) {
      const res = await fetch('/open-in-app/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app, path }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `HTTP ${res.status}`);
      }
    }

    /**
     * Append one file reference to a Session's composer draft.
     * The conversation service owns the draft; the px0 document only asks.
     * @param {object} ctx client context
     * @param {string} sessionId the Session whose composer receives the text
     * @param {string} text the reference to append
     * @returns {{ok: boolean, reason?: string}}
     */
    function appendToDraft(ctx, sessionId, text) {
      try {
        const conversation = ctx.get('conversation');
        if (!conversation) return { ok: false, reason: 'conversation 不可用' };
        const actx = ctx.sessions?.scope?.(sessionId);
        if (!actx) return { ok: false, reason: 'sessions.scope 不可用' };
        const input = conversation.input.for(actx);
        const draft = input.state.getSnapshot().draft;
        input.setDraft(draft.trim() === '' ? text : `${draft} ${text}`);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: String(e?.message || e) };
      }
    }

    function Px0Body(props) {
      const { useTabInfo, t, layout, sidebarRight, insertRef, useSessions, sessionId: seatSessionId } = props;
      const { tab } = useTabInfo();
      const [status, setStatus] = useState({ state: 'idle' });
      const [tick, setTick] = useState(0); // bump to remount the iframe after update
      const [dir, setDir] = useState('');   // the directory sent to the Host
      const [dirInput, setDirInput] = useState(''); // the editable field's text
      const seenReady = React.useRef(false); // px0 has served this tab at least once
      // Catalog ids the Host reports as installed; null until the first answer.
      const [apps, setApps] = useState(null);

      const address = tab?.contentId ?? '';
      const filePath = useMemo(() => filePathOf(address), [address]);

      // The Session whose working directory px0 should serve. A tab belongs to
      // a Session; the seat's Session is the fallback for a page tab.
      const sessionId = tab?.sessionId ?? seatSessionId;
      const sessionCwd = useSessions
        ? useSessions((snap) => snap?.byId?.[sessionId]?.cwd ?? snap?.sessions?.[sessionId]?.cwd ?? undefined)
        : undefined;

      // Keep the editable field in step with the Host's actual root unless the
      // user is mid-edit.
      useEffect(() => {
        if (status.root) setDirInput(status.root);
      }, [status.root]);

      // Resolve which desktop apps exist on this machine, so a button is only
      // offered for something that can actually launch.
      useEffect(() => {
        let alive = true;
        installedApps().then((list) => { if (alive) setApps(list); });
        return () => { alive = false; };
      }, []);

      // The px0 document posts its context-menu choices here; this side owns
      // the composer, so it appends the reference to the Session's draft.
      useEffect(() => {
        const onMessage = (e) => {
          if (e.origin !== window.location.origin) return;
          const data = e.data;
          if (!data || data.type !== 'dsh-px0:insert' || typeof data.text !== 'string') return;
          const result = insertRef?.(data.text);
          if (result && !result.ok) setStatus(prev => ({ ...prev, error: result.reason }));
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, [insertRef]);

      // px0 takes its root as a process argument, so it cannot be repointed
      // without a restart. Re-send whenever the Session's committed cwd
      // changes (a "switch directory" action does not change the tab).
      // The iframe is torn down while the restart runs, so the user sees the
      // in-panel loading state rather than a browser fetch error.
      useEffect(() => {
        if (!sessionCwd || sessionCwd === dir) return;
        setDir(sessionCwd);
        setStatus(prev => ({ ...prev, state: 'starting' }));
        control('openRoot', { root: sessionCwd })
          .then(s => { setStatus(s); setTick(n => n + 1); })
          .catch(e => setStatus({ state: 'failed', error: String(e?.message || e) }));
      }, [sessionCwd]);

      // px0 is a full IDE, so it wants the whole column. The sidebar owns the
      // presentation mode; its toggleFullscreen resolves a target from live
      // focus, so focus this pane first and only flip when it is not already
      // fullscreen.
      useEffect(() => {
        if (!sidebarRight || !layout) return;
        const panel = document.querySelector('[data-sidebar-right-panel]');
        if (!panel) return;
        if (panel.getAttribute('data-sidebar-right-panel') === 'fullscreen') return;
        const target = sidebarRight.commandTarget(panel.querySelector('iframe') ?? panel);
        if (target) sidebarRight.toggleFullscreen(target);
      }, [sidebarRight, layout, tick]);

      useEffect(() => {
        let alive = true;
        let timer;
        const poll = async () => {
          try {
            const s = await control('status');
            if (alive) setStatus(s || { state: 'idle' });
            const busy = !s || ['idle', 'missing', 'downloading', 'starting', 'updating'].includes(s.state);
            if (alive) timer = setTimeout(poll, busy ? 1500 : 30000);
          } catch (e) {
            if (alive) setStatus({ state: 'failed', error: String(e?.message || e) });
            if (alive) timer = setTimeout(poll, 5000);
          }
        };
        poll();
        return () => { alive = false; clearTimeout(timer); };
      }, [tick]);

      const retry = useCallback(() => {
        control('start').then(s => setStatus(s)).catch(e => setStatus({ state: 'failed', error: String(e?.message || e) }));
      }, []);
      const update = useCallback(() => {
        control('update')
          .then(s => { setStatus(s); if (s.state === 'ready') setTick(n => n + 1); })
          .catch(e => setStatus({ state: 'failed', error: String(e?.message || e) }));
      }, []);

      const ready = status.state === 'ready' && status.port;
      if (ready) seenReady.current = true;
      // While px0 restarts, keep the document requested from the Host: the
      // proxy answers a document request with its own loading page, which
      // polls and reloads into px0 when it is ready. Only a terminal failure
      // swaps the iframe for the in-panel error state.
      const transitional = !ready && status.state !== 'failed' && status.state !== 'missing';
      const keepFrame = (ready || transitional) && seenReady.current;
      const iframeSrc = ready || keepFrame
        ? '/px0/' + (filePath ? `?path=${encodeURIComponent(filePath)}` : '')
        : null;

      const barStyle = {
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2))',
        fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)', flex: 'none',
      };
      const btnStyle = {
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
        background: 'transparent', color: 'inherit', borderRadius: 4,
        padding: '2px 10px', cursor: 'pointer', fontSize: 12,
      };
      const iconBtnStyle = {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 24, height: 22, padding: 0, flex: 'none',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
        background: 'transparent', color: 'inherit', borderRadius: 4,
        cursor: 'pointer',
      };

      if (!ready) {
        const key = `status.${status.state || 'idle'}`;
        return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
          h('div', { style: barStyle }, 'px0'),
          h('div', { style: { flex: 1, display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' } },
            h('div', null,
              h('div', { style: { marginBottom: 12 } }, t(key)),
              status.error ? h('div', { style: { opacity: 0.7, marginBottom: 12, wordBreak: 'break-all', fontSize: 12 } }, status.error) : null,
              status.state === 'failed' ? h('button', { style: btnStyle, onClick: retry }, t('retry')) : null,
            )));
      }

      /** Launch a desktop app on the directory px0 is currently serving. */
      const openIn = (app) => {
        if (!status.root) return;
        launchApp(app, status.root).catch((e) => {
          setStatus(prev => ({ ...prev, error: `${t('openFailed')}: ${String(e?.message || e)}` }));
        });
      };

      const applyDir = () => {
        const next = dirInput.trim();
        if (!next || next === status.root) return;
        setDir(next);
        control('openRoot', { root: next })
          .then(s => { setStatus(s); setTick(n => n + 1); })
          .catch(e => setStatus({ state: 'failed', error: String(e?.message || e) }));
      };
      const rootLabel = status.root ? status.root.split(/[\\/]/).filter(Boolean).pop() : t('tabTitle');

      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
        h('div', { style: barStyle },
          h('input', {
            value: dirInput,
            onChange: (e) => setDirInput(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') applyDir(); },
            onBlur: applyDir,
            spellCheck: false,
            style: {
              flex: 1, minWidth: 0, border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
              background: 'transparent', color: 'inherit', borderRadius: 4,
              padding: '2px 8px', fontSize: 12, fontFamily: 'inherit',
            },
          }),
          status.latestVersion
            ? h(React.Fragment, null,
                h('span', null, t('updateAvailable').replace('{version}', status.latestVersion)),
                h('button', { style: btnStyle, onClick: update }, t('update')))
            : null,
          // Only offer an "open in …" button for an app the Host reports as
          // installed; `apps === null` means the answer has not arrived yet.
          (apps === null || apps.includes('explorer'))
            ? h('button', {
                style: iconBtnStyle,
                title: t('openFolder'),
                'aria-label': t('openFolder'),
                disabled: !status.root,
                onClick: () => openIn('explorer'),
              }, h(FolderIcon))
            : null,
          (apps === null || apps.includes('vscode'))
            ? h('button', {
                style: iconBtnStyle,
                title: t('openVsCode'),
                'aria-label': t('openVsCode'),
                disabled: !status.root,
                onClick: () => openIn('vscode'),
              }, h(VsCodeIcon))
            : null,
          // VS Code is missing on this machine: say so instead of silently
          // hiding the button, so the absence is explained rather than lost.
          (apps !== null && !apps.includes('vscode'))
            ? h('span', {
                style: { fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap' },
                title: t('vsCodeMissing'),
              }, t('vsCodeMissing'))
            : null,
          h('button', {
            style: iconBtnStyle,
            title: t('openExternal'),
            'aria-label': t('openExternal'),
            onClick: () => window.open(`http://127.0.0.1:${status.port}/` + (filePath ? `?path=${encodeURIComponent(filePath)}` : ''), '_blank'),
          }, h(ExternalLinkIcon)),
        ),
        h('iframe', {
          key: `${tick}:${iframeSrc}:${status.root || ''}`,
          src: iframeSrc,
          style: { flex: 1, border: 'none', width: '100%', background: '#1e1e2e' },
          title: 'px0',
        }));
    }

    /** Shared icon frame: a 13px stroked glyph in currentColor. */
    function iconFrame(children) {
      return h('svg', {
        width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false',
      }, children);
    }

    /** External-link glyph: an arrow leaving a box, drawn in currentColor. */
    function ExternalLinkIcon() {
      return iconFrame([
        h('path', { key: 'a', d: 'M15 3h6v6' }),
        h('path', { key: 'b', d: 'M10 14 21 3' }),
        h('path', { key: 'c', d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }),
      ]);
    }

    /** Folder glyph: a tabbed folder outline. */
    function FolderIcon() {
      return iconFrame(h('path', {
        key: 'f',
        d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
      }));
    }

    /**
     * VS Code glyph: the product's angular ribbon mark, filled so it reads as
     * a distinct application rather than another outline.
     */
    function VsCodeIcon() {
      return h('svg', {
        width: 13, height: 13, viewBox: '0 0 24 24',
        fill: 'currentColor', stroke: 'none',
        'aria-hidden': true, focusable: 'false',
      }, h('path', {
        d: 'M17.5 2.2 22 4.4v15.2l-4.5 2.2L7.9 12.6 4.5 15.2 3 14.4V9.6l1.5-.8L7.9 11.4zm0 4.1L11.6 12l5.9 5.7V6.3z',
      }));
    }

    function Px0Title() {
      return h(React.Fragment, null, 'px0');
    }

    /** Resolve a dictionary key against the host's current language. */
    function makeT(ctx) {
      try { return ctx.locale.bind(NS); } catch { return (k) => en[k] ?? k; }
    }

    const definition = (t) => ({
      id: PX0_ID,
      kind: PX0_KIND,
      patterns: ['dsh-resource://file/[\\s\\S]+'],
      priority: 'extension',
      title: (address) => {
        try {
          const seg = decodeURIComponent(address.split('/').pop() || '');
          return seg || 'px0';
        } catch { return 'px0'; }
      },
      // Entry capsule on the right sidebar's guide page: opens px0 with no
      // file target, ready for the explorer inside it.
      guide: [{
        id: 'px0',
        order: 50,
        title: () => t('tabTitle'),
        description: () => t('guide.description'),
      }],
    });

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'layout', 'sidebarRight', 'conversation', 'sessions'],
      apply(ctx) {
        const t = makeT(ctx);
        const layout = ctx.layout;
        const sidebarRight = ctx.sidebarRight;
        // Composer insertion for the Session on screen, offered to the tab body.
        const insertRef = (text) => {
          const sessionId = sidebarRight?.mounted?.getSnapshot?.();
          if (!sessionId) return { ok: false, reason: '当前没有打开的会话' };
          return appendToDraft(ctx, sessionId, text);
        };
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'px0: dictionaries');
        ctx.effect(() => ctx.sidebarRightTabs.register(definition(t)), 'px0: tab type');
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: PX0_ID,
          locale: NS,
          inject: () => ({ layout, sidebarRight, insertRef }),
        }, Px0Body)), 'px0: body');
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: PX0_ID,
        }, Px0Title)), 'px0: title');
      },
    };
  },
});
