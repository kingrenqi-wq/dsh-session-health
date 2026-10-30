window.__ModuleLoader__.load({
  id: 'dsh-session-health',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace served through the Client locale service. */
    const NS = 'dsh-today-panel';
    const ROUTE = '/_dsh/dsh-session-health';
    const POLL_MS = 5000;
    const REQUEST_TIMEOUT_MS = 10_000;
    const RETRY_MS = 5000;

    const DICTIONARIES = {
      zh: {
        'chip.loading': '上下文 …',
        'chip.unknown': '上下文 —',
        'chip.error': '状态不可用',
        'chip.value': '上下文 {pct}%',
        'chip.hint': '最近一次请求的输入上下文占用',
        'chip.unavailable': '不可用',
        'chip.compacting': '更新中',
        'chip.compactingNote': '压缩进行中',
        'chip.waiting': '等待下一次请求',
        'chip.stale': '数据过期（请求超时）',
        'chip.integrity': '记录不完整',
        'chip.integrity.broken': '中间有记录无法解析，历史与计数可能缺项',
        'chip.integrity.order': '事件顺序异常，已切断连续性判断',
        'chip.integrity.short': '读取不完整，正在等待追加',
        'chip.history': '最近记录',
        'chip.end.nextTurn': '下一轮开始',
        'chip.end.success': '后续调用成功',
        'chip.end.newClass': '换了错误类别',
        'chip.end.completed': '已完成',
        'chip.end.failed': '失败',
        'chip.end.killed': '被终止',
        'chip.end.cancel': '后续被取消',
        'chip.label': '上下文',
        'chip.hint.detail': '采样 {time} · {tokens} / {window} tokens · {events} 条事件',
        'chip.hint.missing': '当前会话没有可用的上下文快照',
        'chip.streak': '同类失败 ×{count}',
        'chip.streakRecent': '上一轮：同类失败 ×{count}',
        'chip.pending': '任务状态待确认',
      },
      en: {
        'chip.loading': 'Context …',
        'chip.unknown': 'Context —',
        'chip.error': 'Status unavailable',
        'chip.value': 'Context {pct}%',
        'chip.hint': 'Input context of the latest request',
        'chip.unavailable': 'n/a',
        'chip.compacting': 'updating',
        'chip.compactingNote': 'compaction running',
        'chip.waiting': 'waiting for the next request',
        'chip.stale': 'data stale (request timed out)',
        'chip.integrity': 'records incomplete',
        'chip.integrity.broken': 'some records could not be parsed; history and counts may be incomplete',
        'chip.integrity.order': 'events arrived out of order; continuity was reset',
        'chip.integrity.short': 'short read; waiting for more data',
        'chip.history': 'Recent',
        'chip.end.nextTurn': 'next turn',
        'chip.end.success': 'later succeeded',
        'chip.end.newClass': 'different error',
        'chip.end.completed': 'completed',
        'chip.end.failed': 'failed',
        'chip.end.killed': 'killed',
        'chip.end.cancel': 'later cancelled',
        'chip.label': 'Context',
        'chip.hint.detail': 'Sampled {time} · {tokens} / {window} tokens · {events} events',
        'chip.hint.missing': 'No context snapshot for this session',
        'chip.streak': 'same failure ×{count}',
        'chip.streakRecent': 'prev turn: same failure ×{count}',
        'chip.pending': 'task state unconfirmed',
      },
    };

    const cardStyle = {
      width: 164,
      boxSizing: 'border-box',
      padding: '12px 14px 11px',
      borderRadius: 12,
      background: 'linear-gradient(160deg, #232741 0%, #1b1d2c 100%)',
      border: '0.5px solid rgba(84, 96, 150, 0.55)',
      boxShadow: '0 12px 30px rgba(0, 0, 0, 0.35)',
      color: '#a8c7ff',
      fontVariantNumeric: 'tabular-nums',
      userSelect: 'none',
    };
    const cardStyleWarn = {
      ...cardStyle,
      background: 'linear-gradient(160deg, #2e2622 0%, #201a18 100%)',
      border: '0.5px solid rgba(200, 140, 70, 0.6)',
      color: '#f0b465',
    };
    const mutedInCard = { color: 'rgba(168, 176, 205, 0.85)' };
    const labelRow = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'rgba(168, 176, 205, 0.85)', fontSize: 11, lineHeight: '14px' };
    const bigNumber = { fontSize: 30, lineHeight: '36px', fontWeight: 500, marginTop: 2, letterSpacing: '-0.5px' };
    const subLine = { color: 'rgba(168, 176, 205, 0.85)', fontSize: 10.5, lineHeight: '14px' };
    const noteLine = { color: 'rgba(168, 176, 205, 0.85)', fontSize: 10.5, lineHeight: '14px', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
    const statusDot = { width: 7, height: 7, borderRadius: 4, display: 'inline-block', marginLeft: 6 };

    /** POST one JSON method to the bundle's own host route. */
    async function callHost(method, args, signal) {
      const response = await fetch(`${ROUTE}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args ?? {}),
        signal,
      });
      const text = await response.text();
      let payload;
      try { payload = JSON.parse(text); } catch { throw new Error(`bad response: ${text.slice(0, 80)}`); }
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      return payload;
    }

    function percent(value) {
      if (!Number.isFinite(value)) return null;
      const pct = value * 100;
      if (pct > 0 && pct < 1) return '<1';
      return pct >= 10 ? String(Math.round(pct)) : pct.toFixed(1);
    }

    function clockOf(ms) {
      if (!Number.isFinite(ms)) return '—';
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    }

    const card = {
      position: 'fixed',
      zIndex: 2000,
      width: 340,
      padding: '12px 14px',
      borderRadius: 10,
      background: 'var(--dsw-specific-menu)',
      border: '0.5px solid var(--dsw-alias-border-l3)',
      boxShadow: '0 10px 30px rgba(0, 0, 0, 0.32)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 12,
      lineHeight: '18px',
      whiteSpace: 'nowrap',
    };
    const cardTitle = { fontSize: 13, fontWeight: 500, marginBottom: 6 };
    const cardRow = { color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' };
    const section = { marginTop: 10, paddingTop: 10, borderTop: '0.5px solid var(--dsw-alias-border-l3)' };
    const target = { color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 280 };

    function short(value) {
      if (!Number.isFinite(value)) return '—';
      if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 2).replace(/\.?0+$/, '')}M`;
      if (value >= 1e3) return `${Math.round(value / 1e3)}k`;
      return String(value);
    }

    /** Map an integrity code to a stable locale key. */
    function integrityKey(code) {
      if (code === 'bad-json' || code === 'decode-failed' || code === 'invalid-frame') return 'broken';
      if (code === 'out-of-order') return 'order';
      if (code === 'short-read') return 'short';
      return 'broken';
    }

    function endText(t, by) {
      const map = { 'next-turn': 'nextTurn', success: 'success', 'new-class': 'newClass', completed: 'completed', failed: 'failed', killed: 'killed', cancel: 'cancel' };
      const key = map[by];
      return key === void 0 ? by : t(`chip.end.${key}`);
    }

    function group(value) {
      return Number.isFinite(value) ? Number(value).toLocaleString('en-US') : '—';
    }

    function duration(ms) {
      const total = Math.max(0, Math.round(ms / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    const STORE_KEY = 'dsh-session-health:position:v1';
    const EDGE = 24;

    function readPosition() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY);
        if (raw === null) return null;
        const value = JSON.parse(raw);
        return Number.isFinite(value?.x) && Number.isFinite(value?.y) ? value : null;
      } catch { return null; }
    }

    function writePosition(value) {
      try { window.localStorage.setItem(STORE_KEY, JSON.stringify(value)); } catch { /* storage unavailable */ }
    }

    function clampPosition(x, y) {
      const width = 180;
      const height = 96;
      const maxX = Math.max(EDGE, window.innerWidth - width - EDGE);
      const maxY = Math.max(60, window.innerHeight - height - 48);
      return {
        x: Math.min(Math.max(x, EDGE), maxX),
        y: Math.min(Math.max(y, 60), maxY),
      };
    }

    function defaultPosition() {
      return clampPosition(window.innerWidth - 210, window.innerHeight - 170);
    }

    /** Floating chip plus its evidence panel; the user drags it where they look. */
    function TodayChip({ useSessions, t }) {
      const sessionList = typeof useSessions === 'function' ? useSessions((state) => state) : void 0;
      const sessionId = React.useMemo(() => {
        const rows = sessionList?.byId ?? {};
        const entry = Object.entries(rows).find(([, row]) => ((row?.retainedBy?.mainView) ?? 0) > 0);
        return entry === void 0 ? void 0 : entry[0];
      }, [sessionList]);

      const [state, setState] = React.useState({ phase: 'loading', snapshot: void 0 });
      const [anchor, setAnchor] = React.useState(null);
      const ref = React.useRef(null);
      const [pos, setPos] = React.useState(() => readPosition() ?? defaultPosition());
      const [dragging, setDragging] = React.useState(false);
      const drag = React.useRef(null);

      /** Anchor the panel to the card itself, so page transforms cannot shift it. */
      const togglePanel = () => {
        if (anchor !== null) { setAnchor(null); return; }
        const rect = ref.current?.getBoundingClientRect();
        if (!rect) return;
        setAnchor({
          up: rect.top > window.innerHeight / 2,
          alignRight: rect.left + 340 > window.innerWidth - 12,
        });
      };

      const onPointerDown = (event) => {
        if (event.button !== 0) return;
        drag.current = { x0: event.clientX, y0: event.clientY, px: pos.x, py: pos.y, moved: false };
        ref.current?.setPointerCapture?.(event.pointerId);
      };

      const onPointerMove = (event) => {
        const current = drag.current;
        if (!current) return;
        const dx = event.clientX - current.x0;
        const dy = event.clientY - current.y0;
        if (!current.moved && Math.hypot(dx, dy) < 4) return;
        current.moved = true;
        if (!dragging) setDragging(true);
        setPos(clampPosition(current.px + dx, current.py + dy));
      };

      const onPointerUp = (event) => {
        const current = drag.current;
        drag.current = null;
        if (!current) return;
        ref.current?.releasePointerCapture?.(event.pointerId);
        setDragging(false);
        if (!current.moved) { togglePanel(); return; }
        setPos(pos);
        writePosition(pos);
      };

      React.useEffect(() => {
        const onResize = () => setPos((current) => clampPosition(current.x, current.y));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);


      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return void 0;
        let alive = true;
        let timer = 0;
        let controller;

        setState({ phase: 'loading', snapshot: void 0, sessionId });

        const schedule = (delay) => {
          clearTimeout(timer);
          timer = setTimeout(tick, delay);
        };

        const tick = async () => {
          if (!alive) return;
          if (document.visibilityState === 'hidden') { schedule(POLL_MS); return; }
          controller = new AbortController();
          const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
          try {
            const snapshot = await callHost('snapshot', { sessionId }, controller.signal);
            if (!alive) return;
            setState({ phase: 'ok', snapshot, sessionId });
            schedule(POLL_MS);
          } catch (error) {
            if (!alive) return;
            /* A timeout means "not fresh", not "switch sessions". */
            setState((previous) => ({
              phase: error?.name === 'AbortError' ? (previous.phase === 'ok' ? 'stale' : 'error') : 'error',
              snapshot: previous.snapshot,
              sessionId,
            }));
            schedule(RETRY_MS);
          } finally {
            clearTimeout(deadline);
          }
        };

        tick();

        return () => {
          alive = false;
          clearTimeout(timer);
          controller?.abort();
        };
      }, [sessionId]);

      React.useEffect(() => {
        if (anchor === null) return void 0;
        const onKey = (event) => { if (event.key === 'Escape') { setAnchor(null); ref.current?.focus?.(); } };
        const onClick = (event) => { if (!ref.current?.contains(event.target)) setAnchor(null); };
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onClick);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('mousedown', onClick);
        };
      }, [anchor]);

      if (typeof sessionId !== 'string' || sessionId === '') return null;
      const bound = state.sessionId === sessionId;
      const phase = bound ? state.phase : 'loading';
      const snapshot = bound ? state.snapshot : void 0;
      const integrity = typeof snapshot?.integrity === 'string' ? snapshot.integrity : null;
      const pct = snapshot?.fill != null ? percent(snapshot.fill) : null;
      const streak = snapshot?.streak ?? null;
      const longJob = snapshot?.longJob ?? null;
      const warn = streak !== null || longJob !== null;

      const unavailable = phase === 'error' || (phase === 'ok' && snapshot?.found !== true);
      const compacting = snapshot?.compacting === true;
      const staleRequest = phase === 'stale';
      const numberText = phase === 'loading'
        ? '…'
        : unavailable
          ? t('chip.unavailable')
          : compacting
            ? t('chip.compacting')
            : pct === null ? '—' : `${pct}%`;
      const ariaText = unavailable ? t('chip.error') : t('chip.value', { pct: pct ?? '—' });
      const rows = [];
      if (phase === 'ok' && snapshot?.found === true) {
        rows.push(h('div', { key: 'pct', style: cardTitle }, numberText));
        rows.push(h('div', { key: 'tok', style: cardRow },
          `${group(snapshot.tokens)} / ${group(snapshot.contextWindow)} tokens · 采样 ${clockOf(snapshot.sampledAt)}`));

        if (streak !== null) {
          rows.push(h('div', { key: 's', style: section },
            h('div', { key: 'sh', style: cardTitle },
              t(streak.recent ? 'chip.streakRecent' : 'chip.streak', { count: streak.count })),
            h('div', { key: 'sm', style: cardRow },
              `${streak.tool} · ${streak.category} · ${streak.count} 条记录 · ${streak.targets.length} 个目标`),
            ...streak.targets.slice(0, 3).map((value, index) => h('div', { key: `t${index}`, style: target }, value)),
            h('div', { key: 'sq', style: cardRow }, `seq ${streak.firstSeq} → ${streak.lastSeq} · ${clockOf(streak.lastAt)}`)));
        }
        if (longJob !== null) {
          rows.push(h('div', { key: 'j', style: section },
            h('div', { key: 'jh', style: cardTitle }, t('chip.pending')),
            h('div', { key: 'jm', style: cardRow },
              `${longJob.kind} · 开始于 ${clockOf(longJob.startedAt)} · 已 ${duration(longJob.ageMs)}`),
            longJob.label ? h('div', { key: 'jl', style: target }, longJob.label) : null,
            h('div', { key: 'jn', style: cardRow }, '没有结束记录，不等于还在运行')));
        }
        const history = Array.isArray(snapshot.history) ? snapshot.history.slice(-3) : [];
        if (history.length > 0) {
          rows.push(h('div', { key: 'h', style: section },
            h('div', { key: 'hh', style: cardTitle }, t('chip.history')),
            ...history.map((item, index) => h('div', { key: `hi${index}`, style: cardRow },
              item.rule === 'longJob'
                ? `${clockOf(item.startedAt)} ${item.kind} · ${endText(t, item.endedBy)}`
                : `${clockOf(item.startedAt)} ${item.tool} · ${item.category} ×${item.count} · ${endText(t, item.endedBy)}`))));
        }
        if (integrity !== null) {
          rows.push(h('div', { key: 'g', style: section },
            h('div', { key: 'gh', style: cardTitle }, t('chip.integrity')),
            h('div', { key: 'gm', style: cardRow }, t(`chip.integrity.${integrityKey(integrity)}`))));
        }
        rows.push(h('div', { key: 'f', style: section },
          h('div', { key: 'fe', style: cardRow }, `事件 ${group(snapshot.events)} · 每 5 秒刷新 · 只读本地会话文件`)));
      } else if (phase === 'error') {
        rows.push(h('div', { key: 'err', style: cardTitle }, t('chip.error')));
        rows.push(h('div', { key: 'em', style: cardRow }, t('chip.hint.missing')));
      } else if (phase === 'loading') {
        rows.push(h('div', { key: 'ld', style: cardTitle }, t('chip.loading')));
      } else {
        rows.push(h('div', { key: 'miss', style: cardTitle }, t('chip.unknown')));
        rows.push(h('div', { key: 'mm', style: cardRow }, t('chip.hint.missing')));
      }

      const ageMs = snapshot?.sampledAt && snapshot?.now ? snapshot.now - snapshot.sampledAt : 0;
      const stale = phase === 'ok' && !unavailable && ageMs > 90_000;
      const hasWindow = snapshot?.found === true && snapshot.contextWindow > 0 && snapshot.fill != null;
      const tokens = hasWindow ? `${short(snapshot.tokens)} / ${short(snapshot.contextWindow)}` : '—';
      let note;
      if (unavailable) note = t('chip.hint.missing');
      else if (staleRequest) note = t('chip.stale');
      else if (streak !== null) note = t(streak.recent ? 'chip.streakRecent' : 'chip.streak', { count: streak.count });
      else if (longJob !== null) note = t('chip.pending');
      else if (compacting) note = t('chip.compactingNote');
      else if (snapshot?.sampleValid === false) note = t('chip.waiting');
      else if (snapshot?.sampledAt) note = `${clockOf(snapshot.sampledAt)} 采样${integrity === null ? '' : ` · ${t('chip.integrity')}`}`;
      else note = t('chip.hint');

      return h('div', {
        ref,
        tabIndex: 0,
        role: 'button',
        'aria-label': ariaText,
        'aria-haspopup': 'dialog',
        'aria-expanded': anchor !== null,
        style: {
          position: 'fixed',
          left: pos.x,
          top: pos.y,
          zIndex: 2100,
          touchAction: 'none',
          cursor: dragging ? 'grabbing' : 'grab',
          ...(warn ? cardStyleWarn : cardStyle),
        },
        title: t('chip.hint'),
        'data-session-health-chip': '',
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          togglePanel();
        },
      },
        h('div', { style: labelRow },
          h('span', null, t('chip.label')),
          h('span', { style: { ...statusDot, background: warn ? '#f0b465' : '#78beff' } })),
        h('div', { style: { ...bigNumber, opacity: stale ? 0.6 : 1 } }, numberText),
        h('div', { style: subLine }, tokens),
        h('div', { style: { ...noteLine, color: warn ? '#f0b465' : 'rgba(168, 176, 205, 0.85)' } }, note),
        anchor === null ? null : h('div', {
          style: {
            ...card,
            position: 'absolute',
            ...(anchor.up ? { bottom: 'calc(100% + 6px)' } : { top: 'calc(100% + 6px)' }),
            ...(anchor.alignRight ? { right: 0 } : { left: 0 }),
          },
          role: 'dialog',
          onPointerDown: (event) => event.stopPropagation(),
        }, rows),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-today-panel: dictionaries');
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'today',
          order: 5,
          locale: NS,
        }, TodayChip));
      },
    };
  },
});
