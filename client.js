/**
 * Client half: the configuration form rendered on this plugin's page in the
 * Plugins panel. It writes through the Host route, which owns validation and
 * persistence, so the form never needs to parse the profile patch.
 */

window.__ModuleLoader__.load({
  id: 'dsh-media-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CONFIG_PATH = '/api/media-bridge'

    const TEXT_FIELDS = [
      { path: 'baseUrl', label: '接口地址 Base URL', placeholder: 'https://api.example.com/v1', hint: 'OpenAI 兼容根路径，需含 /v1' },
      { path: 'apiKey', label: 'API Key', secret: true, hint: '留空则读取下面的环境变量' },
      { path: 'apiKeyEnv', label: 'API Key 环境变量', placeholder: 'MEDIA_BRIDGE_API_KEY' },
      { path: 'outputDir', label: '输出目录', placeholder: '选择一个目录给生成结果', hint: '音频与视频保存到这里' },
    ]

    const GROUPS = [
      {
        title: '视觉',
        hint: '纯文本模型看图时调用；三类服务可以分别指向不同网关',
        fields: [
          { path: 'vision.baseUrl', label: '接口地址', placeholder: 'https://api.example.com/v1' },
          { path: 'vision.model', label: '视觉模型', placeholder: 'Qwen2.5-VL-72B-Instruct' },
          { path: 'vision.maxTokens', label: '回答长度上限', type: 'number', placeholder: '1024' },
        ],
      },
      {
        title: '语音',
        hint: '识别与合成可分别填不同的模型',
        fields: [
          { path: 'speech.baseUrl', label: '接口地址', placeholder: '留空则用上面的 Base URL' },
          { path: 'speech.model', label: '识别模型', placeholder: 'SenseVoice' },
          { path: 'speech.ttsModel', label: '合成模型', placeholder: 'CosyVoice' },
          { path: 'speech.voice', label: '音色', placeholder: 'alloy' },
          { path: 'speech.format', label: '音频格式', placeholder: 'mp3' },
        ],
      },
      {
        title: '视频',
        hint: '生成与编辑共用同一模型；任务按轮询推进',
        fields: [
          { path: 'video.baseUrl', label: '接口地址', placeholder: 'https://api.example.com/v1' },
          { path: 'video.model', label: '视频模型', placeholder: 'doubao-seedance-2.0' },
          { path: 'video.style', label: '接口形态', placeholder: 'openai 或 volc', hint: 'volc = 火山方舟 /contents/generations/tasks 形态；openai = /videos 形态' },
          { path: 'video.pollIntervalMs', label: '轮询间隔 (ms)', type: 'number', placeholder: '5000' },
          { path: 'video.timeoutMs', label: '总超时 (ms)', type: 'number', placeholder: '600000' },
        ],
      },
    ]

    const TRIGGERS = [
      { path: 'trigger.providers', label: '只在指定 provider 下出现', hint: '逗号分隔，例如 a2；留空表示所有模型都能用' },
      { path: 'trigger.models', label: '只在指定模型下出现', hint: '例如 a2/glm-5.3，支持 * 通配' },
    ]

    const TOGGLES = [
      { path: 'tools.vision', label: '图片理解 media_vision' },
      { path: 'tools.speech', label: '语音 media_speech' },
      { path: 'tools.video', label: '视频 media_video' },
      { path: 'tools.status', label: '诊断 media_status' },
    ]

    /** One nested value by dotted path. */
    function readPath(source, path) {
      return path.split('.').reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), source)
    }

    /** Build the flat form state from the Host response. */
    function toFormState(values) {
      const state = {}
      for (const field of [...TEXT_FIELDS, ...GROUPS.flatMap((group) => group.fields)]) {
        const value = readPath(values, field.path)
        state[field.path] = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : ''
      }
      state['trigger.providers'] = Array.isArray(values?.trigger?.providers) ? values.trigger.providers.join(', ') : ''
      state['trigger.models'] = Array.isArray(values?.trigger?.models) ? values.trigger.models.join(', ') : ''
      for (const toggle of TOGGLES) state[toggle.path] = readPath(values, toggle.path) !== false
      return state
    }

    /** Build the nested payload the Host merges. */
    function toPayload(state) {
      const number = (path) => (state[path] === '' ? '' : Number(state[path]))
      return {
        baseUrl: state.baseUrl,
        apiKey: state.apiKey,
        apiKeyEnv: state.apiKeyEnv,
        outputDir: state.outputDir,
        vision: { baseUrl: state['vision.baseUrl'], model: state['vision.model'], maxTokens: number('vision.maxTokens') },
        speech: {
          baseUrl: state['speech.baseUrl'],
          model: state['speech.model'],
          ttsModel: state['speech.ttsModel'],
          voice: state['speech.voice'],
          format: state['speech.format'],
        },
        video: {
          baseUrl: state['video.baseUrl'],
          model: state['video.model'],
          pollIntervalMs: number('video.pollIntervalMs'),
          timeoutMs: number('video.timeoutMs'),
        },
        trigger: { providers: state['trigger.providers'], models: state['trigger.models'] },
        tools: {
          vision: state['tools.vision'],
          speech: state['tools.speech'],
          video: state['tools.video'],
          status: state['tools.status'],
        },
      }
    }

    /** Host of a configured endpoint, for the status line. */
    function hostOf(value) {
      if (typeof value !== 'string' || value.length === 0) return '(未填写)'
      try {
        return new URL(value).host
      } catch {
        return value
      }
    }

    /** POST one action, returning the parsed answer or a transport error. */
    async function post(action, values) {
      try {
        const response = await fetch(CONFIG_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, values }),
        })
        return await response.json()
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }

    const styles = `
      .mb-form { display: flex; flex-direction: column; gap: 18px; }
      .mb-banner { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; font-size: 13px; }
      .mb-pill { padding: 2px 8px; border-radius: 999px; font-size: 12px;
        border: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.35)); }
      .mb-pill[data-on="true"] { color: var(--dsw-alias-text-success, #2f9e5f); }
      .mb-group { display: flex; flex-direction: column; gap: 10px; }
      .mb-group-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-text-primary, currentColor); }
      .mb-group-hint { font-size: 12px; color: var(--dsw-alias-text-secondary, #8b93a3); }
      .mb-row { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 10px 14px; align-items: center; }
      .mb-label { font-size: 13px; color: var(--dsw-alias-text-primary, currentColor); }
      .mb-input, .mb-textarea { width: 100%; box-sizing: border-box; padding: 7px 10px; font: inherit; font-size: 13px;
        color: var(--dsw-alias-text-primary, currentColor); background: var(--dsw-alias-surface-raised, rgba(127,127,127,.08));
        border: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.35)); border-radius: 8px; outline: none; }
      .mb-input:focus, .mb-textarea:focus { border-color: var(--dsw-alias-border-accent, #679EFE); }
      .mb-hint { grid-column: 2; font-size: 12px; color: var(--dsw-alias-text-secondary, #8b93a3); margin-top: -6px; }
      .mb-check { display: flex; align-items: center; gap: 8px; font-size: 13px;
        color: var(--dsw-alias-text-primary, currentColor); }
      .mb-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
      .mb-button { padding: 7px 14px; font: inherit; font-size: 13px; border-radius: 8px; cursor: pointer;
        border: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.35));
        background: var(--dsw-alias-surface-raised, rgba(127,127,127,.08));
        color: var(--dsw-alias-text-primary, currentColor); }
      .mb-button[data-primary="true"] { background: var(--dsw-alias-fill-accent, #679EFE); border-color: transparent; color: #fff; }
      .mb-button:disabled { opacity: .55; cursor: default; }
      .mb-notice { font-size: 13px; color: var(--dsw-alias-text-secondary, #8b93a3); }
      .mb-notice[data-error="true"] { color: var(--dsw-alias-text-danger, #d6444f); }
      @media (max-width: 620px) { .mb-row { grid-template-columns: minmax(0, 1fr); } .mb-hint { grid-column: 1; } }
    `

    /** The configuration page for this bundle. */
    function MediaBridgeConfig() {
      const [state, setState] = React.useState(null)
      const [status, setStatus] = React.useState('loading')
      const [notice, setNotice] = React.useState('')
      const [noticeError, setNoticeError] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [effective, setEffective] = React.useState(null)
      const [writable, setWritable] = React.useState(true)

      const load = React.useCallback(async (soft) => {
        if (soft !== true) setStatus('loading')
        try {
          const response = await fetch(CONFIG_PATH, { headers: { accept: 'application/json' } })
          const body = await response.json()
          setState(toFormState(body.values))
          setEffective(body.effective ?? null)
          setWritable(body.writable !== false)
          setStatus('ready')
          if (soft === true) setNotice('配置已重新读取')
        } catch {
          // A soft reload races the plugin restart that follows a save, so the
          // form keeps its values instead of collapsing to an error state.
          if (soft === true) setNotice('插件重载中，稍后点「重新读取」确认结果')
          else setStatus('unavailable')
        }
      }, [])

      React.useEffect(() => { void load() }, [load])

      const change = (path) => (event) => {
        const next = event.target.type === 'checkbox' ? event.target.checked : event.target.value
        setState((current) => ({ ...current, [path]: next }))
      }

      const save = async () => {
        if (state === null) return
        setBusy(true)
        setNotice('')
        const body = await post('save', toPayload(state))
        setBusy(false)
        setNoticeError(body.ok !== true)
        setNotice(body.ok === true ? '已保存，插件正在重载；工具会在数秒内按新配置出现' : (body.message ?? '保存失败'))
        if (body.ok === true) window.setTimeout(() => { void load(true) }, 2500)
      }

      const test = async () => {
        if (state === null) return
        setBusy(true)
        setNotice('正在探测端点…')
        setNoticeError(false)
        const body = await post('test', toPayload(state))
        setBusy(false)
        const result = body.result ?? body
        setNoticeError(result.ok !== true)
        setNotice(result.message ?? '探测结束')
      }

      if (status === 'loading') return h('div', { className: 'mb-notice' }, '读取配置…')
      if (status === 'unavailable' || state === null) {
        return h('div', { className: 'mb-notice', 'data-error': 'true' }, '配置通道未就绪，请确认插件已启用后刷新页面')
      }

      const textInput = (field) => h('div', { className: 'mb-row', key: field.path },
        h('label', { className: 'mb-label', htmlFor: `mb-${field.path}` }, field.label),
        h('input', {
          id: `mb-${field.path}`,
          className: 'mb-input',
          type: field.secret === true ? 'password' : field.type === 'number' ? 'number' : 'text',
          value: state[field.path],
          placeholder: field.placeholder ?? '',
          onChange: change(field.path),
        }),
        field.hint === undefined ? null : h('div', { className: 'mb-hint' }, field.hint),
      )

      return h('div', { className: 'mb-form' },
        h('style', null, styles),
        h('div', { className: 'mb-banner' },
          h('span', { className: 'mb-pill', 'data-on': String(effective?.configured === true) },
            effective?.configured === true ? '端点已配置' : '端点未配置'),
          h('span', { className: 'mb-pill', 'data-on': String(effective?.hasApiKey === true) },
            effective?.hasApiKey === true ? '密钥已就绪' : '未提供密钥'),
          effective?.vision
            ? h('span', { className: 'mb-pill', 'data-on': 'true' }, `视觉 ${effective.vision} @ ${hostOf(effective?.hosts?.vision)}`)
            : null,
          effective?.speech
            ? h('span', { className: 'mb-pill', 'data-on': 'true' }, `语音 ${effective.speech} @ ${hostOf(effective?.hosts?.speech)}`)
            : null,
          effective?.video
            ? h('span', { className: 'mb-pill', 'data-on': 'true' }, `视频 ${effective.video} @ ${hostOf(effective?.hosts?.video)}`)
            : null,
        ),
        h('div', { className: 'mb-group' }, TEXT_FIELDS.map(textInput)),
        GROUPS.map((group) => h('div', { className: 'mb-group', key: group.title },
          h('div', { className: 'mb-group-title' }, group.title),
          h('div', { className: 'mb-group-hint' }, group.hint),
          group.fields.map(textInput),
        )),
        h('div', { className: 'mb-group' },
          h('div', { className: 'mb-group-title' }, '触发条件'),
          h('div', { className: 'mb-group-hint' }, '控制这些工具在哪些模型下出现；留空即全部可见'),
          TRIGGERS.map(textInput),
        ),
        h('div', { className: 'mb-group' },
          h('div', { className: 'mb-group-title' }, '工具开关'),
          TOGGLES.map((toggle) => h('label', { className: 'mb-check', key: toggle.path },
            h('input', {
              type: 'checkbox',
              checked: state[toggle.path] !== false,
              onChange: change(toggle.path),
            }),
            toggle.label,
          )),
        ),
        h('div', { className: 'mb-actions' },
          h('button', { className: 'mb-button', 'data-primary': 'true', disabled: busy || !writable, onClick: save }, busy ? '处理中…' : '保存'),
          h('button', { className: 'mb-button', disabled: busy, onClick: test }, '测试连接'),
          h('button', { className: 'mb-button', disabled: busy, onClick: () => { void load(true) } }, '重新读取'),
          notice === '' ? null : h('span', { className: 'mb-notice', 'data-error': String(noticeError) }, notice),
        ),
        writable ? null : h('div', { className: 'mb-notice', 'data-error': 'true' }, '当前 profile 不允许写入配置；请改用 cordis.patch.yml'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-media-bridge',
        }, MediaBridgeConfig))
      },
    }
  },
})
