/**
 * dsh-rea-toggle — Client half.
 *
 * One pill in the composer dock, showing the position of THE CONVERSATION IT IS
 * IN. The slot hands a component its `sessionId`, which is the same id the Host
 * keys its per-conversation state by, so the pill follows the user between
 * conversations instead of describing one global switch.
 *
 * It is deliberately dumb: it asks the Host what this conversation currently is
 * and posts the opposite back. Every decision about what "off" means lives in
 * `lib/index.js`; nothing is duplicated here.
 *
 * The label is localized through the Client locale service, and the pill hides
 * itself until the Host answers — an unlabelled control that silently does
 * nothing is worse than no control.
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
      onTitle:
        "REA context is on for this conversation: the model can see REA's tool schemas and its instructions. Click to turn it off.",
      offTitle:
        "REA context is off for this conversation: REA's tools and instructions are out of the model context. Click to turn it on.",
      busy: 'Switching…',
      failed: 'The host did not answer. Is the plugin still installed?',
    }

    const zh = {
      on: 'REA 开',
      off: 'REA 关',
      onTitle: '本对话的 REA 上下文已开启：模型能看到 REA 的工具与说明。点击关闭。',
      offTitle: '本对话的 REA 上下文已关闭：REA 的工具与说明已从模型上下文移除。点击开启。',
      busy: '切换中…',
      failed: '宿主没有应答，插件还在吗？',
    }

    /**
     * Read this conversation's position from the Host.
     * @param session - the conversation id from the slot props.
     * @returns the state object, or undefined when the Host cannot answer.
     */
    async function readState(session) {
      try {
        const response = await fetch(`${ENDPOINT}?session=${encodeURIComponent(session)}`, {
          credentials: 'same-origin',
        })
        if (!response.ok) return undefined
        return await response.json()
      } catch {
        return undefined
      }
    }

    /**
     * Move this conversation's switch on the Host.
     * @param session - the conversation id from the slot props.
     * @param enabled - the desired position.
     * @returns the state after the call, or undefined on failure.
     */
    async function writeState(session, enabled) {
      try {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session, enabled }),
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
     * instructions in this conversation; grey means they are out of its context.
     * Clicking flips it and the change lands on the next step — no restart, no
     * page reload.
     * @param props - `t` the bound translate function, `session` the slot's id.
     */
    function ReaToggle({ t, session }) {
      const [state, setState] = react.useState(undefined)
      const [busy, setBusy] = react.useState(false)
      const [failed, setFailed] = react.useState(false)

      // Re-read whenever the pill is moved to another conversation: one
      // component serves every conversation, so the id is the trigger.
      react.useEffect(() => {
        let live = true
        setState(undefined)
        setFailed(false)
        readState(session).then(next => {
          if (live && next !== undefined) setState(next)
        })
        return () => {
          live = false
        }
      }, [session])

      const enabled = state?.enabled
      const known = typeof enabled === 'boolean'

      const toggle = react.useCallback(async () => {
        if (busy) return
        setBusy(true)
        setFailed(false)
        const next = await writeState(session, !enabled)
        if (next !== undefined) setState(next)
        else setFailed(true)
        setBusy(false)
      }, [busy, enabled, session])

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
      // rather than an option the slot would reject. The slot's owner props
      // carry `sessionId`, which is what makes this pill per-conversation.
      const Entry = props => react.createElement(ReaToggle, { t, session: props.sessionId })

      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'rea-toggle',
            order: 90,
            label: () => t('on'),
          },
          Entry,
        ),
      )
    }

    return { name, inject, apply }
  },
})
