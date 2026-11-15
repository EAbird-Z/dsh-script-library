/**
 * Browser half of the script library panel.
 *
 * Two tabs over one registry:
 * - 清册 lists everything already registered, with the checks the host can make
 *   without running anything, so the library stays readable;
 * - 待登记 scans for scripts written since the last sweep and lets the reader
 *   write the one sentence that makes each of them findable before adding it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-script-library',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const en = {
      'panel.title': 'Script library',
      'panel.subtitle': 'Scripts worth calling again, shared by every workspace',
      'tab.registry': 'Registry {n}',
      'tab.scan': 'To register {n}',
      'scan.run': 'Scan',
      'scan.running': 'Scanning…',
      'scan.hint': 'Scans the roots the script-index skill watches plus every registered workspace, and lists what is not in the registry yet.',
      'registry.search': 'Filter by id, title, tag, or path…',
      'registry.empty': 'Nothing registered yet.',
      'registry.noMatch': 'Nothing matches that filter.',
      'registry.ready': 'ready',
      'registry.broken': 'needs a look',
      'registry.args': 'args',
      'registry.runs': 'runs',
      'count.registered': '{n} registered',
      'count.candidates': '{n} new',
      'field.what': 'What it does',
      'field.whatPlaceholder': 'One sentence: this is what makes it findable later',
      'field.args': 'Arguments',
      'field.argsPlaceholder': 'Optional, e.g. <input.txt> [-o out/]',
      'field.from': 'From',
      'field.entry': 'Runs as',
      'action.register': 'Register {n}',
      'action.registering': 'Registering…',
      'action.selectAll': 'Select all',
      'action.selectNone': 'Clear',
      'action.reload': 'Reload',
      'action.back': 'Back',
      'empty.title': 'Nothing to register',
      'empty.body': 'Every script written since the last sweep is already in the registry. Write something new, then scan again.',
      'error.scan': 'Scan failed',
      'error.register': 'Registration failed',
      'error.needWhat': 'Fill in “What it does” for every selected row first.',
      'done.registered': 'Registered {n}.',
      'done.skipped': 'Registered {n}, skipped {m}.',
      'loading': 'Loading…',
    }

    const zh = {
      'panel.title': '脚本库',
      'panel.subtitle': '值得再调用的脚本，所有工作区共用一份',
      'tab.registry': '清册 {n}',
      'tab.scan': '待登记 {n}',
      'scan.run': '扫一遍',
      'scan.running': '正在扫…',
      'scan.hint': '扫 script-index skill 盯着的目录，外加所有注册工作区，列出还没进清册的。',
      'registry.search': '按 id、名字、标签、路径筛…',
      'registry.empty': '清册还是空的。',
      'registry.noMatch': '没有匹配的条目。',
      'registry.ready': '可用',
      'registry.broken': '要看看',
      'registry.args': '参数',
      'registry.runs': '怎么跑',
      'count.registered': '已登记 {n} 条',
      'count.candidates': '新增 {n} 条',
      'field.what': '干什么的',
      'field.whatPlaceholder': '一句话：以后靠它才搜得到',
      'field.args': '参数',
      'field.argsPlaceholder': '可空，例如 <input.txt> [-o out/]',
      'field.from': '来自',
      'field.entry': '怎么跑',
      'action.register': '登记 {n} 条',
      'action.registering': '正在登记…',
      'action.selectAll': '全选',
      'action.selectNone': '清空',
      'action.reload': '刷新',
      'action.back': '返回',
      'empty.title': '没有要登记的',
      'empty.body': '上次之后写的东西都已经在清册里了。以后再写了新的，再来点一次。',
      'error.scan': '扫描失败',
      'error.register': '登记失败',
      'error.needWhat': '先给每一条选中的填上「干什么的」。',
      'done.registered': '已登记 {n} 条。',
      'done.skipped': '登记 {n} 条，跳过 {m} 条。',
      'loading': '加载中…',
    }

    const SCAN_ROUTE = '/plugin/script-library/scan'
    const REGISTER_ROUTE = '/plugin/script-library/register'
    const REGISTRY_ROUTE = '/plugin/script-library/registry'

    /** One shared fetch that always returns a parsed payload. */
    async function request(path, init) {
      const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...init })
      const body = await response.text()
      try {
        return JSON.parse(body)
      } catch {
        throw new Error('unexpected response (' + response.status + ')')
      }
    }

    function format(t, key, values) {
      const raw = t(key)
      return values === undefined
        ? raw
        : raw.replace(/\{(\w+)\}/g, (match, name) => (values[name] === undefined ? match : String(values[name])))
    }

    const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace'

    const styles = {
      page: {
        height: '100%',
        overflow: 'auto',
        padding: '20px 24px 32px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        fontFamily: 'inherit',
      },
      head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
      title: { fontSize: 18, fontWeight: 600, lineHeight: 1.3 },
      subtitle: { marginTop: 4, fontSize: 12.5, color: 'var(--dsw-alias-label-tertiary)' },
      tabs: {
        display: 'flex',
        gap: 4,
        padding: 3,
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        alignSelf: 'flex-start',
      },
      tab: {
        appearance: 'none',
        border: 'none',
        borderRadius: 8,
        padding: '6px 12px',
        fontSize: 12.5,
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'transparent',
      },
      tabActive: {
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-interactive-bg-hover)',
        fontWeight: 550,
      },
      bar: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      primary: {
        appearance: 'none',
        border: 'none',
        borderRadius: 9,
        padding: '7px 14px',
        fontSize: 13,
        fontWeight: 550,
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
        background: 'var(--dsw-alias-brand-primary)',
      },
      ghost: {
        appearance: 'none',
        borderRadius: 9,
        padding: '6px 12px',
        fontSize: 12.5,
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary)',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
      },
      disabled: { opacity: 0.55, cursor: 'default' },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 },
      search: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 10px',
        fontSize: 12.5,
        borderRadius: 9,
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        fontFamily: 'inherit',
      },
      list: { display: 'flex', flexDirection: 'column', gap: 10 },
      row: {
        display: 'grid',
        gridTemplateColumns: '20px minmax(0, 1fr)',
        gap: 12,
        padding: '12px 14px',
        borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      card: {
        padding: '12px 14px',
        borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      cardHead: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      id: { fontFamily: mono, fontSize: 12.5, fontWeight: 600 },
      kind: {
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 999,
        color: 'var(--dsw-alias-label-tertiary)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      cardTitle: { fontSize: 13.5, fontWeight: 550 },
      what: { fontSize: 12.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      meta: { fontFamily: mono, fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' },
      ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 11.5 },
      bad: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11.5 },
      fileName: { fontFamily: mono, fontSize: 12.5, fontWeight: 550 },
      filePath: { marginTop: 2, fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)', fontFamily: mono, wordBreak: 'break-all' },
      entryLine: { marginTop: 2, fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)' },
      fields: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 },
      label: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 9px',
        fontSize: 12.5,
        borderRadius: 8,
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        fontFamily: 'inherit',
      },
      message: { fontSize: 12.5, lineHeight: 1.6 },
      empty: {
        padding: '28px 20px',
        borderRadius: 12,
        textAlign: 'center',
        border: '1px dashed var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      emptyTitle: { fontSize: 13.5, fontWeight: 550, color: 'var(--dsw-alias-label-secondary)' },
      emptyBody: { marginTop: 6, fontSize: 12.5, lineHeight: 1.7 },
      spacer: { flex: 1 },
    }

    function SidebarIcon({ size = 20, active }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.75 },
      },
        h('rect', { x: 3.25, y: 4.25, width: 17.5, height: 4.2, rx: 1.9, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('rect', { x: 3.25, y: 10.1, width: 17.5, height: 4.2, rx: 1.9, stroke: 'currentColor', strokeWidth: 1.6, opacity: 0.7 }),
        h('rect', { x: 3.25, y: 15.95, width: 10.5, height: 4.2, rx: 1.9, stroke: 'currentColor', strokeWidth: 1.6, opacity: 0.45 }),
      )
    }

    function LibraryPage(props) {
      const rawT = props.t
      const t = typeof rawT === 'function' ? rawT : (key) => key
      const back = typeof props.back === 'function' ? props.back : undefined

      const [tab, setTab] = useState('registry')
      const [entries, setEntries] = useState([])
      const [registryLoaded, setRegistryLoaded] = useState(false)
      const [filter, setFilter] = useState('')

      const [rows, setRows] = useState([])
      const [scanLoaded, setScanLoaded] = useState(false)
      const [meta, setMeta] = useState({ registered: 0, store: '', workspaces: [] })

      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState(null)

      const loadRegistry = useCallback(async () => {
        setBusy('registry')
        try {
          const payload = await request(REGISTRY_ROUTE)
          if (!payload || payload.ok !== true) throw new Error(payload?.message ?? 'registry failed')
          setEntries(Array.isArray(payload.entries) ? payload.entries : [])
          setMeta((current) => ({ ...current, registered: Number(payload.total) || 0, store: String(payload.store ?? '') }))
          setRegistryLoaded(true)
        } catch (error) {
          setMessage({ tone: 'error', text: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }, [])

      useEffect(() => { loadRegistry() }, [loadRegistry])

      const scan = useCallback(async () => {
        setBusy('scan')
        setMessage(null)
        try {
          const payload = await request(SCAN_ROUTE)
          if (!payload || payload.ok !== true) throw new Error(payload?.message ?? 'scan failed')
          const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
          setRows(candidates.map((candidate) => ({ ...candidate, picked: true, what: '', args: '' })))
          setMeta((current) => ({
            ...current,
            registered: Number(payload.registered) || current.registered,
            store: String(payload.store ?? current.store),
            workspaces: Array.isArray(payload.workspaces) ? payload.workspaces : [],
          }))
          setScanLoaded(true)
        } catch (error) {
          setMessage({ tone: 'error', text: t('error.scan') + ': ' + String(error?.message ?? error) })
          setScanLoaded(true)
        } finally {
          setBusy('')
        }
      }, [t])

      const update = useCallback((index, patch) => {
        setRows((current) => current.map((row, position) => (position === index ? { ...row, ...patch } : row)))
      }, [])

      const picked = rows.filter((row) => row.picked)
      const selected = picked.length
      const allPicked = rows.length > 0 && selected === rows.length

      const toggleAll = useCallback(() => {
        setRows((current) => current.map((row) => ({ ...row, picked: !allPicked })))
      }, [allPicked])

      const register = useCallback(async () => {
        const items = picked.filter((row) => row.what.trim() !== '')
        if (items.length === 0) {
          setMessage({ tone: 'error', text: t('error.needWhat') })
          return
        }
        setBusy('register')
        setMessage(null)
        try {
          const payload = await request(REGISTER_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              items: items.map((row) => ({
                path: row.path,
                id: row.id,
                title: row.title,
                kind: row.kind,
                cwd: row.cwd,
                entry: row.entry,
                what: row.what.trim(),
                args: row.args.trim(),
              })),
            }),
          })
          if (!payload || payload.ok !== true) throw new Error(payload?.message ?? 'register failed')
          const added = Array.isArray(payload.added) ? payload.added.length : 0
          const skipped = Array.isArray(payload.skipped) ? payload.skipped.length : 0
          setMessage({
            tone: 'done',
            text: skipped > 0
              ? format(t, 'done.skipped', { n: added, m: skipped })
              : format(t, 'done.registered', { n: added }),
          })
          await Promise.all([scan(), loadRegistry()])
        } catch (error) {
          setMessage({ tone: 'error', text: t('error.register') + ': ' + String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }, [picked, scan, loadRegistry, t])

      const shown = useMemo(() => {
        const query = filter.trim().toLowerCase()
        if (query === '') return entries
        const words = query.split(/\s+/)
        return entries.filter((entry) => {
          const hay = [
            entry.id, entry.title, entry.what,
            Array.isArray(entry.tags) ? entry.tags.join(' ') : '',
            entry.cwd, entry.entry,
          ].join(' ').toLowerCase()
          return words.every((word) => hay.includes(word))
        })
      }, [entries, filter])

      const header = h('div', { style: styles.head },
        h('div', null,
          h('div', { style: styles.title }, t('panel.title')),
          h('div', { style: styles.subtitle }, t('panel.subtitle')),
        ),
        back === undefined ? null : h('button', { type: 'button', style: styles.ghost, onClick: back }, t('action.back')),
      )

      const tabs = h('div', { style: styles.tabs },
        h('button', {
          type: 'button',
          style: tab === 'registry' ? { ...styles.tab, ...styles.tabActive } : styles.tab,
          onClick: () => setTab('registry'),
        }, format(t, 'tab.registry', { n: entries.length })),
        h('button', {
          type: 'button',
          style: tab === 'scan' ? { ...styles.tab, ...styles.tabActive } : styles.tab,
          onClick: () => setTab('scan'),
        }, format(t, 'tab.scan', { n: rows.length })),
      )

      const notice = message === null
        ? null
        : h('div', {
            style: {
              ...styles.message,
              color: message.tone === 'error'
                ? 'var(--dsw-alias-state-error-primary)'
                : 'var(--dsw-alias-state-success-primary)',
            },
          }, message.text)

      if (tab === 'registry') {
        const cards = shown.length === 0
          ? h('div', { style: styles.empty },
              h('div', { style: styles.emptyTitle }, registryLoaded ? t('registry.empty') : t('loading')),
              registryLoaded && entries.length > 0 ? h('div', { style: styles.emptyBody }, t('registry.noMatch')) : null,
            )
          : h('div', { style: styles.list }, shown.map((entry) => {
              const broken = Array.isArray(entry.problems) && entry.problems.length > 0
              return h('div', { key: entry.id, style: styles.card },
                h('div', { style: styles.cardHead },
                  h('span', { style: styles.id }, entry.id),
                  h('span', { style: styles.kind }, entry.kind ?? 'tool'),
                  h('span', { style: styles.cardTitle }, entry.title ?? ''),
                  h('div', { style: styles.spacer }),
                  h('span', { style: broken ? styles.bad : styles.ok },
                    broken ? t('registry.broken') + '：' + entry.problems.join('；') : t('registry.ready')),
                ),
                entry.what ? h('div', { style: styles.what }, entry.what) : null,
                h('div', { style: styles.meta }, 'cd ' + (entry.cwd ?? '~')),
                h('div', { style: styles.meta }, (entry.entry ?? '') + (entry.args ? '  ' + entry.args : '')),
                entry.note ? h('div', { style: styles.what }, entry.note) : null,
              )
            }))

        return h('div', { style: styles.page },
          header,
          tabs,
          h('div', { style: styles.bar },
            h('button', {
              type: 'button',
              style: busy === 'registry' ? { ...styles.ghost, ...styles.disabled } : styles.ghost,
              disabled: busy !== '',
              onClick: loadRegistry,
            }, t('action.reload')),
            h('div', { style: styles.spacer }),
            h('span', { style: styles.hint }, format(t, 'count.registered', { n: entries.length }) + (meta.store ? '  ·  ' + meta.store : '')),
          ),
          h('input', {
            type: 'text',
            value: filter,
            placeholder: t('registry.search'),
            onChange: (event) => setFilter(event.target.value),
            style: styles.search,
          }),
          cards,
          notice,
        )
      }

      const bar = h('div', { style: styles.bar },
        h('button', {
          type: 'button',
          style: busy === 'scan' ? { ...styles.ghost, ...styles.disabled } : styles.ghost,
          disabled: busy !== '',
          onClick: scan,
        }, busy === 'scan' ? t('scan.running') : t('scan.run')),
        rows.length === 0 ? null : h('button', {
          type: 'button',
          style: styles.ghost,
          disabled: busy !== '',
          onClick: toggleAll,
        }, allPicked ? t('action.selectNone') : t('action.selectAll')),
        h('div', { style: styles.spacer }),
        h('button', {
          type: 'button',
          style: selected === 0 || busy !== '' ? { ...styles.primary, ...styles.disabled } : styles.primary,
          disabled: selected === 0 || busy !== '',
          onClick: register,
        }, busy === 'register' ? t('action.registering') : format(t, 'action.register', { n: selected })),
      )

      const list = rows.length === 0
        ? h('div', { style: styles.empty },
            h('div', { style: styles.emptyTitle }, scanLoaded ? t('empty.title') : t('scan.run')),
            h('div', { style: styles.emptyBody }, scanLoaded ? t('empty.body') : t('scan.hint')),
          )
        : h('div', { style: styles.list }, rows.map((row, index) => h('div', { key: row.absPath, style: styles.row },
            h('input', {
              type: 'checkbox',
              checked: row.picked,
              'aria-label': row.title,
              onChange: (event) => update(index, { picked: event.target.checked }),
              style: { marginTop: 2, accentColor: 'var(--dsw-alias-brand-primary)' },
            }),
            h('div', { style: { minWidth: 0 } },
              h('div', { style: styles.fileName }, row.title),
              h('div', { style: styles.filePath }, row.path),
              h('div', { style: styles.entryLine }, t('field.from') + '：' + row.root),
              h('div', { style: styles.entryLine }, t('field.entry') + '：' + row.entry),
              h('div', { style: styles.fields },
                h('label', { style: styles.label }, t('field.what')),
                h('input', {
                  type: 'text',
                  value: row.what,
                  placeholder: t('field.whatPlaceholder'),
                  onChange: (event) => update(index, { what: event.target.value }),
                  style: styles.input,
                }),
                h('label', { style: styles.label }, t('field.args')),
                h('input', {
                  type: 'text',
                  value: row.args,
                  placeholder: t('field.argsPlaceholder'),
                  onChange: (event) => update(index, { args: event.target.value }),
                  style: styles.input,
                }),
              ),
            ),
          )))

      return h('div', { style: styles.page },
        header,
        tabs,
        bar,
        h('div', { style: styles.hint }, t('scan.hint') + (meta.store === '' ? '' : '  ·  ' + meta.store)),
        list,
        notice,
      )
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('script-library', { en, zh }), 'script-library: locale')
        const t = ctx.locale.bind('script-library')
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'script-library',
          order: 60,
          locale: 'script-library',
          label: () => t('panel.title'),
        }, SidebarIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'script-library',
          locale: 'script-library',
          inject: () => ({ back: () => ctx.layout.selectPanel('conversation') }),
        }, LibraryPage))
      },
    }
  },
})
