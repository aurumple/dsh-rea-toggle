/**
 * dsh-rea-toggle — Client half.
 *
 * One pill in the composer dock. It is deliberately dumb: it asks the Host half
 * what the switch currently is, and posts the opposite back. Every decision
 * about what "off" means lives in `lib/index.js`; nothing is duplicated here.
 *
 * The label is localized through the Client locale service, and the pill hides
 * itself entirely until the Host answers — an unlabelled control that silently
 * does nothing is worse than no control.
 */

window.__ModuleLoader__.load({
  id: 'dsh-rea-toggle',
  factory: require => {
    const react = require('react')

    const name = 'rea-toggle'
    const inject = ['slots', 'locale']

    /** Locale namespace for this plugin's own copy. */
    const NS = 'rea-toggle'

    /** Where the Host half serves the switch's state. */
    const ENDPOINT = '/rea-toggle/state'

    const en = {
      on: 'REA on',
      off: 'REA off',
      onTitle: 'REA context is on: the model can see REA\'s tool schemas and its instructions. Click to turn it off.',
      offTitle: 'REA context is off: REA\'s tools and instructions are removed from the model context. Click to turn it on.',
      busy: 'Switching…',
      failed: 'The host did not answer. Is the plugin still installed?',
    }

    const zh = {
      on: 'REA 开',
      off: 'REA 关',
      onTitle: 'REA 上下文已开启：模型能看到 REA 的工具与说明。点击关闭。',
      offTitle: 'REA 上下文已关闭：REA 的工具与说明已从模型上下文移除。点击开启。',
      busy: '切换中…',
      failed: '宿主没有应答，插件还在吗？',
    }

    /**
     * Read the current position from the Host.
     * @returns the state object, or undefined when the Host cannot answer.
     */
    async function readState() {
      try {
        const response = await fetch(ENDPOINT, { credentials: 'same-origin' })
        if (!response.ok) return undefined
        return await response.json()
      } catch {
        return undefined
      }
    }

    /**
     * Move the switch on the Host.
     * @param enabled - the desired position.
     * @returns the state after the call, or undefined on failure.
     */
    async function writeState(enabled) {
      try {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        })
        if (!response.ok) return undefined
        return await response.json()
      } catch {
        return undefined
      }
    }

    /**
     * The switch itself: one small pill under the composer.
     *
     * Green means the model can see the governed servers' tools and
     * instructions; grey means they are out of its context. Clicking flips it and
     * the change lands on the next step — no restart, no page reload.
     * @param props - carries the bound translate function.
     */
    function ReaToggle({ t }) {
      const [state, setState] = react.useState(undefined)
      const [busy, setBusy] = react.useState(false)
      const [failed, setFailed] = react.useState(false)

      react.useEffect(() => {
        let live = true
        readState().then(next => {
          if (live && next !== undefined) setState(next)
        })
        return () => {
          live = false
        }
      }, [])

      const enabled = state?.enabled
      const known = typeof enabled === 'boolean'

      const toggle = react.useCallback(async () => {
        if (busy) return
        setBusy(true)
        setFailed(false)
        const next = await writeState(!enabled)
        if (next !== undefined) setState(next)
        else setFailed(true)
        setBusy(false)
      }, [busy, enabled])

      // Nothing to offer until the Host answers.
      if (!known) return null

      const title = failed ? t('failed') : enabled ? t('onTitle') : t('offTitle')
      const label = busy ? t('busy') : enabled ? t('on') : t('off')

      return react.createElement(
        'button',
        {
          type: 'button',
          onClick: toggle,
          disabled: busy,
          title,
          'aria-pressed': enabled,
          'aria-label': title,
          'data-rea-toggle': enabled ? 'on' : 'off',
          style: {
            alignSelf: 'flex-end',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            height: '22px',
            padding: '0 9px',
            marginBottom: '2px',
            borderRadius: '999px',
            border: `1px solid ${
              failed
                ? 'var(--dsw-alias-state-error-primary)'
                : enabled
                  ? 'var(--dsw-alias-state-success-primary)'
                  : 'var(--dsw-alias-border-l1)'
            }`,
            background: enabled ? 'transparent' : 'var(--dsw-alias-bg-layer-1)',
            color: failed
              ? 'var(--dsw-alias-state-error-primary)'
              : enabled
                ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-label-secondary)',
            font: 'inherit',
            fontSize: '11px',
            lineHeight: 1,
            letterSpacing: '0.02em',
            cursor: busy ? 'progress' : 'pointer',
            opacity: busy ? 0.6 : 1,
            transition: 'color 120ms ease, border-color 120ms ease, background 120ms ease',
            userSelect: 'none',
            whiteSpace: 'nowrap',
          },
        },
        react.createElement('span', {
          'aria-hidden': 'true',
          style: {
            width: '5px',
            height: '5px',
            borderRadius: '50%',
            background: failed
              ? 'var(--dsw-alias-state-error-primary)'
              : enabled
                ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-state-idle-primary)',
          },
        }),
        label,
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'rea-toggle: dictionaries')
      const t = ctx.locale.bind(NS)

      // The dock's registration options are `id`, `order` and `label` only, so
      // the translate function rides in through the component's own closure
      // rather than an option the slot would reject.
      const Toggle = () => react.createElement(ReaToggle, { t })

      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'rea-toggle',
            order: 90,
            label: () => t('on'),
          },
          Toggle,
        ),
      )
    }

    return { name, inject, apply }
  },
})
