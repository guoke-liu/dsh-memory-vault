// 记忆仓库 v2 —— 设置页 UI（client 半边）。
//
// 只写这一个文件：宿主提供 React，零第三方依赖，不用 TypeScript。
//
// ⚠ 包装壳必须用 window.__ModuleLoader__.load({ id, factory })，React 从 factory 的
//   require('react') 取 —— 这是本宿主真实可用的写法（对照 dsh-speak-up/lib/client.js）。
//   写成 globalThis.React 或 ESM export 都会导致设置页白屏。
//
// 后端接口（lib/routes.js 已实现）：
//   GET  /dsh-memory-vault/settings → { version, 存图模式, 启用私聊, 启用群聊, 库目录 }
//   POST /dsh-memory-vault/settings → body 部分更新，返回新配置
//
// 写法约定：用 React.createElement 而不是 JSX，宿主转译/不转译都能跑；
// 网络失败只降级显示，绝不让页面白屏。

window.__ModuleLoader__.load({
  id: 'dsh-memory-vault',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const inject = ['slots'];


  const BASE = '/dsh-memory-vault'; // 宿主路由前缀，fetch(BASE + path) 读写设置接口

  // 三档存图模式：每档一句话讲清代价（文案与 lib/settings.js describe() 对齐）
  const MODES = [
    { value: 'both', label: '原图 + 文字（both）', desc: '存原图也存文字描述。占磁盘最大，但图都能留底、文字可搜。' },
    { value: 'text', label: '只存文字（text）', desc: '只存文字描述，不存原图。最省磁盘，但原图不留底。' },
    { value: 'image', label: '只存原图（image）', desc: '只存原图，不要文字描述。占磁盘大，没有文字可搜。' },
  ];

  // GET 失败 / 字段缺失时的默认值（与 settings.js DEFAULTS 一致）
  const DEFAULTS = {
    存图模式: 'both',
    启用私聊: true,
    启用群聊: false,
    记私聊聊天: true,
    记群聊聊天: true,
    定时拉取: true,
    拉取间隔秒: 60,
    允许的插件: [],
    库目录: '',
  };

  /**
   * 把任意来源的原始数据洗成本页要用的形状：
   * 缺字段 / 类型不对 → 按默认值补；非法模式回退 'both'。
   */
  function normalizeSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
      存图模式: MODES.some((m) => m.value === src['存图模式']) ? src['存图模式'] : DEFAULTS.存图模式,
      启用私聊: typeof src['启用私聊'] === 'boolean' ? src['启用私聊'] : DEFAULTS.启用私聊,
      启用群聊: typeof src['启用群聊'] === 'boolean' ? src['启用群聊'] : DEFAULTS.启用群聊,
      记私聊聊天: typeof src['记私聊聊天'] === 'boolean' ? src['记私聊聊天'] : DEFAULTS.记私聊聊天,
      记群聊聊天: typeof src['记群聊聊天'] === 'boolean' ? src['记群聊聊天'] : DEFAULTS.记群聊聊天,
      定时拉取: typeof src['定时拉取'] === 'boolean' ? src['定时拉取'] : DEFAULTS.定时拉取,
      拉取间隔秒: (Number.isFinite(Number(src['拉取间隔秒'])) && Number(src['拉取间隔秒']) >= 10) ? Number(src['拉取间隔秒']) : DEFAULTS.拉取间隔秒,
      库目录: typeof src['库目录'] === 'string' ? src['库目录'] : DEFAULTS.库目录,
    };
  }

  /** 拿 React —— 由包装壳的 require('react') 提供，不依赖任何全局变量。 */
  function getReact() {
    return React;
  }

  /**
   * 设置页组件：加载当前配置，三选一 + 两个开关 + 库目录输入 + 保存按钮。
   * 用 createElement 写法（不依赖 JSX 转译）。
   */
  /**
   * 设置页组件（挂到宿主设置页左栏「记忆仓库」那一项）。
   *
   * 数据流：
   *   挂载时 GET /dsh-memory-vault/settings 填控件
   *   用户改控件 → 本地 state
   *   点「保存」→ POST 同一路径（部分更新）→ 宿主写 config.json → 插件下一轮读新值
   *
   * ⚠️ 样式要注意的两点（都踩过）：
   *   1. 设置页在手机上只有约 170px 宽。别写死宽度，用 width:'100%' + minWidth:0，
   *      文字加 whiteSpace:'normal' 让它正常换行，否则会被挤成一条竖缝。
   *   2. 组件用 React.createElement 写（宿主不一定转译 JSX），
   *      React 从包装壳的 require('react') 拿（不是 globalThis.React）。
   */
  function Section() {
    const R = getReact();
    const ce = (tag, props, ...kids) =>
      R.createElement(tag, props, ...kids.filter((k) => k !== null && k !== undefined && k !== false));

    // 五个控件状态 + 加载态（loadState: 'loading' | 'ready' | 'error'）
    const [mode, setMode] = R.useState(DEFAULTS.存图模式);
    const [privateOn, setPrivateOn] = R.useState(DEFAULTS.启用私聊);
    const [groupOn, setGroupOn] = R.useState(DEFAULTS.启用群聊);
    const [chatPrivate, setChatPrivate] = R.useState(DEFAULTS.记私聊聊天);
    const [chatGroup, setChatGroup] = R.useState(DEFAULTS.记群聊聊天);
    const [autoPull, setAutoPull] = R.useState(DEFAULTS.定时拉取);
    const [pullSec, setPullSec] = R.useState(DEFAULTS.拉取间隔秒);
    const [allowList, setAllowList] = R.useState('');  // 逗号分隔的字符串，存的时候转数组
    const [libDir, setLibDir] = R.useState(DEFAULTS.库目录);
    const [loadState, setLoadState] = R.useState('loading'); // 当前配置加载态
    const [loadError, setLoadError] = R.useState(''); // GET 失败时的一句提示
    const [saving, setSaving] = R.useState(false); // 保存进行中
    // ⭐ 2026-11-02：手动扫描 —— 点一下立刻扫一轮（私聊 + 所有群），不用等定时轮询
    const [scanning, setScanning] = R.useState(false);
    const [scanResult, setScanResult] = R.useState('');
    // ⭐ 2026-11-02：新版本提示 —— 进页面自动查一次（缓存 6 小时）
    const [verInfo, setVerInfo] = R.useState(null);
    const [verChecking, setVerChecking] = R.useState(false);
    const [saveState, setSaveState] = R.useState('idle'); // idle | ok | error
    const [saveError, setSaveError] = R.useState(''); // POST 失败提示

    // 加载时先 GET 拿当前配置，填进控件；失败就显示默认值 + 一句错误提示（不白屏）
    R.useEffect(() => {
      let alive = true;
      fetch(`${BASE}/settings`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((data) => {
          if (!alive) return;
          const s = normalizeSettings(data); // 洗一遍，坏字段不会污染控件
          setMode(s.存图模式);
          setPrivateOn(s.启用私聊);
          setGroupOn(s.启用群聊);
          setChatPrivate(s.记私聊聊天);
          setChatGroup(s.记群聊聊天);
          setAutoPull(s.定时拉取);
          setPullSec(s.拉取间隔秒);
          setAllowList(Array.isArray(s.允许的插件) ? s.允许的插件.join(', ') : '');
          setLibDir(s.库目录);
          setLoadState('ready');
        })
        .catch((err) => {
          if (!alive) return;
          setLoadError(String((err && err.message) || err)); // 网络失败降级，不白屏
          setLoadState('error');
        });
      return () => {
        alive = false;
      };
    }, []);

    // 保存：POST 要改的字段（后端按字段部分更新），成功后显示「已保存」
    async function save(e) {
      if (e && e.preventDefault) e.preventDefault();
      if (saving) return;
      setSaving(true);
      setSaveState('idle');
      setSaveError('');
      try {
        const res = await fetch(`${BASE}/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            存图模式: mode, // 三档里选中的那档
            启用私聊: privateOn,
            启用群聊: groupOn,
            记私聊聊天: chatPrivate,
            记群聊聊天: chatGroup,
            定时拉取: autoPull,
            拉取间隔秒: Number(pullSec) || 60,
            允许的插件: String(allowList).split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
            库目录: libDir.trim(), // 可留空 → 后端走默认值
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSaveState('ok');
      } catch (err) {
        setSaveState('error');
        setSaveError(`保存失败：${String((err && err.message) || err)}`);
      } finally {
        setSaving(false);
      }
    }

    const activeMode = MODES.find((m) => m.value === mode); // 选中档位的说明文案
    // 行内样式：宿主没主题时也能看清，不依赖外部 CSS 类
    const styles = {
      // ⚠️ 曾经只有 maxWidth:420 没有 width，flex 容器在设置页的窄栏里会缩到
      //    内容宽度，文字被挤成每行 4-5 个字。现在让它撑满可用宽度、设最小宽度、
      //    并允许长文字正常换行，窄屏也不会挤成一条缝。
      box: {
        width: '100%',
        minWidth: 0,
        maxWidth: 640,
        boxSizing: 'border-box',
        padding: 12,
        border: '1px solid #3a3a3a',
        borderRadius: 8,
        fontFamily: 'system-ui, sans-serif',
        fontSize: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        overflowWrap: 'break-word',
        wordBreak: 'break-word',
      },
      h: { margin: 0, fontSize: 16, lineHeight: 1.4, whiteSpace: 'normal' },
      sub: { fontSize: 12, color: '#999', margin: '2px 0 0', lineHeight: 1.5, whiteSpace: 'normal' },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
      radio: { margin: 0, cursor: 'pointer' },
      hint: { fontSize: 12, color: '#888', margin: '2px 0 0 20px', lineHeight: 1.5, whiteSpace: 'normal' },
      field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      input: { padding: '4px 6px', fontSize: 14, boxSizing: 'border-box', width: '100%', minWidth: 0 },
      err: { fontSize: 12, color: '#c66' },
      ok: { fontSize: 12, color: '#4a4' },
      btn: {
        padding: '6px 14px',
        fontSize: 14,
        cursor: saving ? 'wait' : 'pointer',
        alignSelf: 'flex-start',
      },
    };

    // ① 存图模式三选一：单选按钮，每档下面一句代价说明
    const modesBlock = ce(
      'div',
      { style: styles.field },
      ce('strong', null, '存图模式'),
      MODES.map((m) =>
        ce(
          'div',
          { key: m.value },
          ce(
            'label',
            { style: styles.radio },
            ce('input', {
              type: 'radio',
              name: 'memory-vault-mode',
              value: m.value,
              checked: mode === m.value,
              onChange: () => setMode(m.value),
            }),
            ce('span', null, ' ' + m.label),
          ),
          ce('p', { style: styles.hint }, m.desc),
        ),
      ),
    );

    // ② 两个开关：启用私聊 / 启用群聊
    const privRow = ce(
      'div',
      { style: styles.row },
      ce(
        'label',
        null,
        ce('input', {
          type: 'checkbox',
          checked: privateOn,
          onChange: (e) => setPrivateOn(e.target.checked),
        }),
        ' 启用私聊',
      ),
    );
    const groupRow = ce(
      'div',
      { style: styles.row },
      ce(
        'label',
        null,
        ce('input', {
          type: 'checkbox',
          checked: groupOn,
          onChange: (e) => setGroupOn(e.target.checked),
        }),
        ' 启用群聊',
      ),
    );

    // ②b 聊天记录开关：私聊 / 群聊分开记
    const chatPrivRow = ce(
      'div',
      { style: styles.row },
      ce(
        'label',
        null,
        ce('input', {
          type: 'checkbox',
          checked: chatPrivate,
          onChange: (e) => setChatPrivate(e.target.checked),
        }),
        ' 记私聊聊天',
      ),
    );
    const chatGroupRow = ce(
      'div',
      { style: styles.row },
      ce(
        'label',
        null,
        ce('input', {
          type: 'checkbox',
          checked: chatGroup,
          onChange: (e) => setChatGroup(e.target.checked),
        }),
        ' 记群聊聊天',
      ),
    );
    // 聊天记录说明块
    const chatBlock = ce(
      'div',
      { style: styles.field },
      ce('strong', null, '聊天记录'),
      ce('p', { style: styles.sub }, '按天存纯文本，私聊群聊分开；群聊再按群号分目录。模型可用 chat_search 搜索。'),
      chatPrivRow,
      chatGroupRow,
    );

    // ②c 定时拉取开关 + 间隔
    const autoRow = ce(
      'div',
      { style: styles.row },
      ce(
        'label',
        null,
        ce('input', {
          type: 'checkbox',
          checked: autoPull,
          onChange: (e) => setAutoPull(e.target.checked),
        }),
        ' 定时拉取',
      ),
    );
    const secRow = ce(
      'div',
      { style: styles.field },
      ce('label', { htmlFor: 'memory-vault-pullsec' }, '拉取间隔（秒，最小 10）'),
      ce('input', {
        id: 'memory-vault-pullsec',
        type: 'number',
        min: 10,
        max: 3600,
        value: pullSec,
        onChange: (e) => setPullSec(e.target.value),
        style: styles.input,
      }),
    );
    const autoBlock = ce(
      'div',
      { style: styles.field },
      ce('strong', null, '定时拉取'),
      ce('p', { style: styles.sub }, '开着就每隔一段时间自动去拉新消息（收图 + 记聊天）。关掉只在你手动调用时才拉。'),
      autoRow,
      secRow,
    );

    // ②d 外部插件白名单
    const allowBlock = ce(
      'div',
      { style: styles.field },
      ce('strong', null, '允许写入的插件'),
      ce('p', { style: styles.sub }, '别的记忆插件可以通过 POST /dsh-memory-vault/ingest 把记忆存进来。这里填它们允许的 source 名，逗号分隔。留空 = 全部拒绝。'),
      ce('input', {
        id: 'memory-vault-allow',
        type: 'text',
        value: allowList,
        placeholder: '例如：other-memory, claude-mem',
        onChange: (e) => setAllowList(e.target.value),
        style: styles.input,
      }),
    );

    // ③ 库目录文本输入：可留空用默认值
    const libDirBlock = ce(
      'div',
      { style: styles.field },
      ce('label', { htmlFor: 'memory-vault-libdir' }, '库目录'),
      ce('input', {
        id: 'memory-vault-libdir',
        style: styles.input,
        type: 'text',
        value: libDir,
        placeholder: '留空则使用默认目录',
        onChange: (e) => setLibDir(e.target.value),
      }),
    );

    // ⭐ 2026-11-02：查新版本。进页面自动查一次；点按钮强制刷新。
    const 查版本 = async (force) => {
      setVerChecking(true)
      try {
        const r = await fetch('./dsh-memory-vault/update' + (force ? '?refresh=1' : ''))
        const j = await r.json().catch(() => null)
        if (j && j.ok) setVerInfo(j)
      } catch (e) {
      } finally {
        setVerChecking(false)
      }
    };
    // 只在第一次挂载时自动查（缓存命中就不会真的发请求）
    R.useEffect(() => { 查版本(false) }, []);

    // ⭐ 2026-11-02：手动扫描。POST /scan，后端跑一轮 sync + syncGroup。
    const 扫描 = async () => {
      if (scanning) return
      setScanning(true)
      setScanResult('')
      try {
        const r = await fetch('./dsh-memory-vault/scan', { method: 'POST' })
        const j = await r.json().catch(() => null)
        if (!r.ok || !j || j.ok === false) {
          throw new Error((j && j.error) || ('HTTP ' + r.status))
        }
        const 私 = j.私聊 || {}
        const 群 = j.群们 || {}
        const 群条 = Object.keys(群).map((g) => g + ':' + (群[g].archived ?? 0)).join(' ')
        setScanResult(`扫描完成 · 私聊归档 ${私.archived ?? 0} 张` + (群条 ? ` · 群 ${群条}` : ''))
      } catch (err) {
        setScanResult('扫描失败：' + String((err && err.message) || err))
      } finally {
        setScanning(false)
      }
    }

    // ④ 保存按钮 + 状态反馈（成功显示「已保存」，失败显示原因）
    const saveBtn = ce(
      'button',
      { type: 'button', style: styles.btn, disabled: saving, onClick: save },
      saving ? '保存中…' : '保存',
    );
    const scanBtn = ce(
      'button',
      { type: 'button', style: styles.btn, disabled: scanning, onClick: 扫描 },
      scanning ? '扫描中…' : '立即扫描',
    );
    const scanNote = scanResult ? ce('span', { style: styles.hint }, scanResult) : null;
    // 版本行：有新版本时高亮提示；查不到时如实说，不冒充「已是最新」
    let verNode = null;
    if (verInfo) {
      if (verInfo.hasUpdate) {
        verNode = ce('div', { style: styles.err },
          `有新版本：当前 ${verInfo.current} → 最新 ${verInfo.latest}（去仓库更新后再重启）`);
      } else if (verInfo.ahead) {
        verNode = ce('div', { style: styles.hint }, `当前 ${verInfo.current}（本地比仓库新，自己改过还没推）`);
      } else {
        verNode = ce('div', { style: styles.hint }, `当前版本 ${verInfo.current}，已是最新`);
      }
    } else {
      verNode = ce('div', { style: styles.hint }, '版本：查询中…');
    }
    const verBtn = ce(
      'button',
      { type: 'button', style: styles.btn, disabled: verChecking, onClick: () => 查版本(true) },
      verChecking ? '查询中…' : '检查更新',
    );
    const savedNote = saveState === 'ok' ? ce('span', { style: styles.ok }, '已保存') : null;
    const errNote = saveState === 'error' ? ce('span', { style: styles.err }, saveError) : null;
    const modeNote =
      activeMode && saveState === 'idle' && loadState === 'ready'
        ? ce('span', { style: styles.hint }, '当前：' + activeMode.label)
        : null;

    // GET 失败的降级提示：控件仍显示默认值，页面不白屏
    const loadNote =
      loadState === 'error'
        ? ce(
            'div',
            { style: styles.err },
            `读取当前配置失败（${loadError}），以下显示默认值；保存时会以你当前选的为准。`,
          )
        : null;

    return ce(
      'div',
      { style: styles.box },
      ce(
        'div',
        null,
        ce('h3', { style: styles.h }, '记忆仓库 · 设置'),
        ce('p', { style: styles.sub }, '改完点「保存」才生效；库目录留空则用默认位置。'),
      ),
      loadNote,
      modesBlock,
      privRow,
      groupRow,
      chatBlock,
      autoBlock,
      allowBlock,
      libDirBlock,
      ce('div', { style: styles.row }, saveBtn, savedNote, errNote, modeNote),
      // ⭐ 2026-11-02：手动扫描按钮 —— 立刻扫一轮，不用等定时拉取
      ce('div', { style: styles.row }, scanBtn, scanNote),
      // ⭐ 2026-11-02：新版本提示 + 检查更新
      ce('div', { style: styles.row }, verBtn),
      verNode,
    );
  }

  /**
   * 宿主入口：从 ctx 拿插槽，往 settings.section 挂本插件的设置区。
   * 插槽不可用（ctx.get('slots') 为 undefined）直接返回，不影响宿主其它部分。
   */
  function apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) return;
    slots.inject('settings.section', () =>
      slots.register(
        {
          name: 'settings.section',
          id: 'dsh-memory-vault-settings',
          order: 50,
          label: () => '记忆仓库',
        },
        Section,
      ),
    );
  }

    exports.apply = apply;
    exports.inject = inject;
    exports.Section = Section;
    // 导出 normalizeSettings 供测试复用（内部也用它洗 GET 返回值）
    exports.normalizeSettings = normalizeSettings;
    return module.exports;
  },
});
