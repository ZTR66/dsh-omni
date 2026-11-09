/**
 * dsh-omni settings page.
 *
 * A settings section rendered in `settings.section`, matching the Host's own pages:
 * theme tokens only, no literal colours, no Host component packages imported.
 *
 * The page owns three things a user needs to change without editing YAML:
 *
 *   - the image provider list (base URL, model ids, which credential holds the key)
 *   - the video provider list (same shape)
 *   - the ASR mode and local model size
 *
 * Credentials are referenced by *name*, never typed into this page: the field is
 * `apiKeyEnv`, the name of a credential the Host already stores. That keeps the
 * secret out of the patch file, out of the page's state, and out of every request
 * body this page sends.
 */
window.__ModuleLoader__.load({
  id: 'dsh-omni',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const API = '/api/omni';

    // ---- styles ---------------------------------------------------------
    //
    // Every colour is a theme alias so light and dark both work. Copied in shape
    // from the Host's Plugins page rather than imported from it: importing a Host
    // package would couple this plugin to an internal module path.
    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        padding: '4px 2px 32px',
        fontFamily: 'Inter, var(--dsw-font-family), system-ui, sans-serif',
        color: 'var(--dsw-alias-label-primary)',
      },
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
      heading: {
        fontSize: 14,
        fontWeight: 600,
        margin: 0,
      },
      hint: {
        fontSize: 12,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary)',
        margin: 0,
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      field: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      },
      label: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 10px',
        fontSize: 13,
        fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        outline: 'none',
      },
      row: {
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        flexWrap: 'wrap',
      },
      button: {
        padding: '7px 14px',
        fontSize: 13,
        fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        cursor: 'pointer',
      },
      primary: {
        padding: '7px 14px',
        fontSize: 13,
        fontFamily: 'inherit',
        fontWeight: 500,
        color: 'var(--dsw-alias-bg-base)',
        background: 'var(--dsw-alias-brand-primary)',
        border: '1px solid var(--dsw-alias-brand-primary)',
        borderRadius: 8,
        cursor: 'pointer',
      },
      danger: {
        padding: '5px 10px',
        fontSize: 12,
        fontFamily: 'inherit',
        color: 'var(--dsw-alias-state-error-primary)',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        cursor: 'pointer',
      },
      badge: {
        fontSize: 11,
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      badgeOk: {
        fontSize: 11,
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      badgeBad: {
        fontSize: 11,
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-state-error-primary)',
      },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
      },
      pre: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11.5,
        lineHeight: 1.7,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        margin: 0,
        padding: 12,
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        maxHeight: 320,
        overflow: 'auto',
        color: 'var(--dsw-alias-label-secondary)',
      },
    };

    /**
     * Placeholder examples, per provider kind.
     *
     * These are hints for someone adding their first provider, so they name the
     * model families people actually reach for: `gpt` on the image side and
     * `seedance` on the video side. The previous text used this plugin's own
     * first test provider (`mona` / `gpt-free`), which read as "this is the only
     * supported service" rather than "here is the shape of the value".
     */
    const EXAMPLES = {
      image: {
        id: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        keyRef: 'OPENAI_API_KEY',
        models: 'gpt-image-1, gpt-image-1-mini',
      },
      video: {
        id: 'seedance',
        name: 'Seedance',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        keyRef: 'ARK_API_KEY',
        models: 'seedance-1-0-pro-250528',
      },
    };

    /** One labelled text input. */
    function Field({ label, value, onChange, placeholder, mono }) {
      return h('label', { style: S.field },
        h('span', { style: S.label }, label),
        h('input', {
          type: 'text',
          value: value ?? '',
          placeholder: placeholder ?? '',
          onChange: (event) => onChange(event.target.value),
          spellCheck: false,
          style: mono === true ? { ...S.input, ...S.mono } : S.input,
        }));
    }

    /** One provider card: its fields and its key status. */
    function ProviderCard({ provider, onChange, onRemove, kind }) {
      const set = (patch) => onChange({ ...provider, ...patch });
      const example = EXAMPLES[kind] ?? EXAMPLES.image;
      return h('div', { style: S.card },
        h('div', { style: S.row },
          h('span', { style: { ...S.heading, fontSize: 13 } }, provider.name || provider.id || '（未命名）'),
          provider.hasKey === true
            ? h('span', { style: S.badgeOk }, '密钥就绪')
            : h('span', { style: S.badgeBad }, '缺少密钥'),
          h('span', { style: S.badge }, kind === 'video' ? '视频' : '图片'),
          h('div', { style: { flex: 1 } }),
          h('button', { type: 'button', style: S.danger, onClick: onRemove }, '移除')),
        h(Field, {
          label: '标识（唯一，用于工具调用时指定）',
          value: provider.id,
          onChange: (v) => set({ id: v }),
          placeholder: example.id,
          mono: true,
        }),
        h(Field, {
          label: '显示名称',
          value: provider.name,
          onChange: (v) => set({ name: v }),
          placeholder: example.name,
        }),
        h(Field, {
          label: 'API 地址',
          value: provider.baseUrl,
          onChange: (v) => set({ baseUrl: v }),
          placeholder: example.baseUrl,
          mono: true,
        }),
        h(Field, {
          label: '凭据引用名，或直接填密钥（保存时会自动移入凭据库）',
          value: provider.apiKeyEnv,
          onChange: (v) => set({ apiKeyEnv: v }),
          placeholder: example.keyRef,
          mono: true,
        }),
        h(Field, {
          label: '模型 id（逗号分隔，第一个为默认）',
          value: (provider.models ?? []).join(', '),
          onChange: (v) => set({ models: v.split(',').map((m) => m.trim()).filter((m) => m !== '') }),
          placeholder: example.models,
          mono: true,
        }));
    }

    /** The page. */
    function OmniSettings() {
      const [state, setState] = useState(null);
      const [error, setError] = useState('');
      const [saving, setSaving] = useState(false);
      const [savedAt, setSavedAt] = useState(0);
      const [checkText, setCheckText] = useState('');
      const [notes, setNotes] = useState([]);
      const [checking, setChecking] = useState(false);

      const load = useCallback(async () => {
        try {
          const response = await fetch(`${API}/settings`, { cache: 'no-store' });
          const data = await response.json();
          if (data?.ok === true) {
            setState(data);
            setError('');
          }
          else {
            setError(data?.error ?? '读取配置失败');
          }
        }
        catch (fetchError) {
          setError(String(fetchError?.message ?? fetchError));
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const save = useCallback(async () => {
        if (state === null) return;
        setSaving(true);
        try {
          const response = await fetch(`${API}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              image: { providers: state.image.providers },
              video: { providers: state.video.providers },
              asr: state.asr,
              ffmpegPath: state.ffmpegPath,
              pythonPath: state.pythonPath,
            }),
          });
          const data = await response.json();
          if (data?.ok === true) {
            setSavedAt(Date.now());
            setError('');
            // The Host moves a pasted secret into the credential store and
            // rewrites the field to a reference name. Saying so explains why the
            // input changed after saving.
            setNotes(Array.isArray(data.notes) ? data.notes : []);
            await load();
          }
          else {
            setError(data?.error ?? '保存失败');
          }
        }
        catch (saveError) {
          setError(String(saveError?.message ?? saveError));
        }
        finally {
          setSaving(false);
        }
      }, [state, load]);

      const runCheck = useCallback(async () => {
        setChecking(true);
        try {
          const response = await fetch(`${API}/check`, { cache: 'no-store' });
          const data = await response.json();
          setCheckText(data?.ok === true ? data.text : `检测失败：${data?.error ?? ''}`);
        }
        catch (checkError) {
          setCheckText(`检测失败：${String(checkError?.message ?? checkError)}`);
        }
        finally {
          setChecking(false);
        }
      }, []);

      if (state === null) {
        return h('div', { style: S.page }, h('p', { style: S.hint }, error || '正在读取配置…'));
      }

      const updateProvider = (kind, index, next) => {
        setState((current) => {
          const list = [...current[kind].providers];
          list[index] = next;
          return { ...current, [kind]: { ...current[kind], providers: list } };
        });
      };
      const removeProvider = (kind, index) => {
        setState((current) => ({
          ...current,
          [kind]: { providers: current[kind].providers.filter((_, i) => i !== index) },
        }));
      };
      const addProvider = (kind) => {
        const example = EXAMPLES[kind] ?? EXAMPLES.image;
        setState((current) => ({
          ...current,
          [kind]: {
            providers: [
              ...current[kind].providers,
              // Pre-fill the fields with the example rather than leaving them
              // blank. A blank card gives no clue what a valid base URL or model
              // id looks like; a filled one only needs the key pasted in and the
              // wrong values are obvious to correct.
              {
                id: example.id,
                name: example.name,
                baseUrl: example.baseUrl,
                apiKeyEnv: '',
                models: example.models.split(',').map((m) => m.trim()).filter((m) => m !== ''),
                hasKey: false,
              },
            ],
          },
        }));
      };

      const renderProviders = (kind, title, hint) => h('section', { style: S.section },
        h('h3', { style: S.heading }, title),
        h('p', { style: S.hint }, hint),
        ...state[kind].providers.map((provider, index) => h(ProviderCard, {
          key: `${kind}-${index}`,
          provider,
          kind,
          onChange: (next) => updateProvider(kind, index, next),
          onRemove: () => removeProvider(kind, index),
        })),
        h('div', null,
          h('button', { type: 'button', style: S.button, onClick: () => addProvider(kind) }, '+ 添加提供商')));

      return h('div', { style: S.page },
        h('section', { style: S.section },
          h('h3', { style: S.heading }, '媒体服务'),
          h('p', { style: S.hint },
            '这里配置图片和视频生成服务。密钥不写在这个页面：填的是 DSH 凭据库里的引用名，',
            '密钥本身通过凭据管理设置。ASR 默认走本地模型，不需要任何服务。')),

        error !== '' ? h('div', { style: { ...S.card, borderColor: 'var(--dsw-alias-state-error-primary)' } },
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, error)) : null,

        renderProviders('image', '图片生成',
          '内置适配：OpenAI、GPT-Image、Gemini、硅基流动、火山方舟 Seedance、智谱 CogView、百炼通义万相、Mona，以及本地 A1111。'),
        renderProviders('video', '视频生成',
          '内置适配：Seedance（火山方舟）、Agnes Video、智谱 CogVideoX。能力判定会拒绝代码能画的场景，这里配的模型只用于真正需要的镜头。'),

        h('section', { style: S.section },
          h('h3', { style: S.heading }, '语音识别'),
          h('p', { style: S.hint }, 'auto 会先用宿主注册的识别器，没有再退回本地 faster-whisper。'),
          h('div', { style: S.row },
            h('label', { style: S.field },
              h('span', { style: S.label }, '模式'),
              h('select', {
                value: state.asr.mode,
                onChange: (event) => setState({ ...state, asr: { ...state.asr, mode: event.target.value } }),
                style: S.input,
              },
                h('option', { value: 'auto' }, 'auto（宿主优先，本地兜底）'),
                h('option', { value: 'local' }, 'local（只用本地模型）'),
                h('option', { value: 'cloud' }, 'cloud（只用宿主/云端）'))),
            h('label', { style: S.field },
              h('span', { style: S.label }, '本地模型'),
              h('select', {
                value: state.asr.localModel,
                onChange: (event) => setState({ ...state, asr: { ...state.asr, localModel: event.target.value } }),
                style: S.input,
              },
                h('option', { value: 'tiny' }, 'tiny（39MB，最快，精度一般）'),
                h('option', { value: 'base' }, 'base（74MB）'),
                h('option', { value: 'small' }, 'small（244MB，推荐）'),
                h('option', { value: 'medium' }, 'medium（769MB，慢）'))))),

        h('section', { style: S.section },
          h('h3', { style: S.heading }, '高级'),
          h(Field, {
            label: 'ffmpeg 路径（留空则用 PATH 或内置查找）',
            value: state.ffmpegPath,
            onChange: (v) => setState({ ...state, ffmpegPath: v }),
            placeholder: 'D:\\ffmpeg\\bin\\ffmpeg.exe',
            mono: true,
          }),
          h(Field, {
            label: 'Python 路径（留空则自动探测）',
            value: state.pythonPath,
            onChange: (v) => setState({ ...state, pythonPath: v }),
            placeholder: '自动探测',
            mono: true,
          })),

        h('div', { style: S.row },
          h('button', { type: 'button', style: S.primary, disabled: saving, onClick: save },
            saving ? '保存中…' : '保存'),
          h('button', { type: 'button', style: S.button, disabled: checking, onClick: runCheck },
            checking ? '检测中…' : '重新检测环境'),
          savedAt > 0 && Date.now() - savedAt < 4000
            ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-brand-primary)' } }, '已保存')
            : null),

        notes.length > 0
          ? h('div', { style: { ...S.card } },
            h('span', { style: { ...S.label, color: 'var(--dsw-alias-brand-primary)' } }, '已处理'),
            ...notes.map((note, index) => h('span', { key: index, style: S.hint }, note)))
          : null,

        checkText !== '' ? h('pre', { style: S.pre }, checkText) : null);
    }

    /** Nav icon: a small film-frame mark. */
    function OmniSettingsIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }),
        h('path', { d: 'M3 9h18M7 5v14M17 5v14' }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon', id: 'omni-media', order: 62,
        }, OmniSettingsIcon));

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'omni-media', order: 62, label: '全模态',
        }, OmniSettings));
      },
    };
  },
});
