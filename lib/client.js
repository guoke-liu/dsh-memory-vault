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


  // ⭐ 2026-11-03：BASE 必须用**相对路径**，不能写死 '/dsh-memory-vault'。
  //
  //   为什么：页面如果开在 /dsh/ 前缀下（nginx 反代到 DSH 就是这个形态），
  //   以 / 开头的绝对路径会把前缀吃掉 ——
  //     '/dsh-memory-vault/settings'  →  实际请求 http://host/dsh-memory-vault/settings
  //     nginx 没有这个 location，直接 404，设置页就报「读取失败 http404」。
  //   换成裸相对路径 'dsh-memory-vault'，浏览器会按当前页面的目录去拼：
  //     http://host/dsh/  →  http://host/dsh/dsh-memory-vault/settings  ✅
  //     http://host/      →  http://host/dsh-memory-vault/settings      ✅（直连时也对）
  //   两种部署形态都对，不依赖宿主把前缀塞进某个全局变量。
  //
  //   【兜底】没有 document（纯 node 单测）时退回绝对路径，行为与旧版一致。
  const BASE = (() => {
    try {
      return typeof document !== 'undefined' && document ? 'dsh-memory-vault' : '/dsh-memory-vault';
    } catch (e) {
      return '/dsh-memory-vault';
    }
  })();

  // 三档存图模式：每档一句话讲清代价（文案与 lib/settings.js describe() 对齐）
  const MODES = [
    { value: 'both', label: '原图 + 文字（both）', desc: '存原图也存文字描述。占磁盘最大，但图都能留底、文字可搜。' },
    { value: 'text', label: '只存文字（text）', desc: '只存文字描述，不存原图。最省磁盘，但原图不留底。' },
    { value: 'image', label: '只存原图（image）', desc: '只存原图，不要文字描述。占磁盘大，没有文字可搜。' },
  ];

  // GET 失败 / 字段缺失时的默认值（与 settings.js DEFAULTS 一致）
  const DEFAULTS = {
    存图模式: 'both',
    私聊存图模式: '',
    群聊存图模式: '',
    启用私聊: true,
    启用群聊: false,
    记私聊聊天: true,
    记群聊聊天: true,
    定时拉取: true,
    启用聊天分层: false,
    用模型打分: false,
    定时分层: false,
    分层间隔小时: 24,
    分层最低档次: 0,
    日记库目录: '',
    拉取间隔秒: 60,
    允许的插件: [],
    库目录: '',
  };

  /** 分档字段：空串=跟随总开关；合法档位原样收；其它值回退空串。 */
  function 洗分档(v) {
    if (v === undefined || v === null || v === '') return '';
    return MODES.some((m) => m.value === v) ? v : '';
  }

  /**
   * 把任意来源的原始数据洗成本页要用的形状：
   * 缺字段 / 类型不对 → 按默认值补；非法模式回退 'both'。
   */
  function normalizeSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
      存图模式: MODES.some((m) => m.value === src['存图模式']) ? src['存图模式'] : DEFAULTS.存图模式,
      私聊存图模式: 洗分档(src['私聊存图模式']),
      群聊存图模式: 洗分档(src['群聊存图模式']),
      启用私聊: typeof src['启用私聊'] === 'boolean' ? src['启用私聊'] : DEFAULTS.启用私聊,
      启用群聊: typeof src['启用群聊'] === 'boolean' ? src['启用群聊'] : DEFAULTS.启用群聊,
      记私聊聊天: typeof src['记私聊聊天'] === 'boolean' ? src['记私聊聊天'] : DEFAULTS.记私聊聊天,
      记群聊聊天: typeof src['记群聊聊天'] === 'boolean' ? src['记群聊聊天'] : DEFAULTS.记群聊聊天,
      定时拉取: typeof src['定时拉取'] === 'boolean' ? src['定时拉取'] : DEFAULTS.定时拉取,
      启用聊天分层: typeof src['启用聊天分层'] === 'boolean' ? src['启用聊天分层'] : DEFAULTS.启用聊天分层,
      用模型打分: typeof src['用模型打分'] === 'boolean' ? src['用模型打分'] : DEFAULTS.用模型打分,
      定时分层: typeof src['定时分层'] === 'boolean' ? src['定时分层'] : DEFAULTS.定时分层,
      分层间隔小时: (Number.isFinite(Number(src['分层间隔小时'])) && Number(src['分层间隔小时']) >= 1)
        ? Math.min(Number(src['分层间隔小时']), 720) : DEFAULTS.分层间隔小时,
      分层最低档次: [0, 1, 2].includes(Number(src['分层最低档次'])) ? Number(src['分层最低档次']) : DEFAULTS.分层最低档次,
      日记库目录: typeof src['日记库目录'] === 'string' ? src['日记库目录'] : DEFAULTS.日记库目录,
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
    // ⭐ 2026-11-03：私聊/群聊分开设档。空串 = 跟随上面那个总开关。
    const [privMode, setPrivMode] = R.useState(DEFAULTS.私聊存图模式);
    const [grpMode, setGrpMode] = R.useState(DEFAULTS.群聊存图模式);
    const [privateOn, setPrivateOn] = R.useState(DEFAULTS.启用私聊);
    const [groupOn, setGroupOn] = R.useState(DEFAULTS.启用群聊);
    const [chatPrivate, setChatPrivate] = R.useState(DEFAULTS.记私聊聊天);
    const [chatGroup, setChatGroup] = R.useState(DEFAULTS.记群聊聊天);
    const [autoPull, setAutoPull] = R.useState(DEFAULTS.定时拉取);
    const [tierOn, setTierOn] = R.useState(DEFAULTS.启用聊天分层);
    const [tierModel, setTierModel] = R.useState(DEFAULTS.用模型打分);
    const [tierCron, setTierCron] = R.useState(DEFAULTS.定时分层);
    const [tierHours, setTierHours] = R.useState(DEFAULTS.分层间隔小时);
    const [tierMin, setTierMin] = R.useState(DEFAULTS.分层最低档次);
    const [diaryDir, setDiaryDir] = R.useState(DEFAULTS.日记库目录);
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
          setPrivMode(s.私聊存图模式);
          setGrpMode(s.群聊存图模式);
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
            存图模式: mode, // 总开关（兜底）
            私聊存图模式: privMode, // 空串 = 跟随总开关
            群聊存图模式: grpMode,
            启用私聊: privateOn,
            启用群聊: groupOn,
            记私聊聊天: chatPrivate,
            记群聊聊天: chatGroup,
            定时拉取: autoPull,
            拉取间隔秒: Number(pullSec) || 60,
            允许的插件: String(allowList).split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
            库目录: libDir.trim(), // 可留空 → 后端走默认值
            启用聊天分层: tierOn,
            用模型打分: tierModel,
            定时分层: tierCron,
            分层间隔小时: Number(tierHours) || 24,
            分层最低档次: tierMin,
            日记库目录: diaryDir.trim(),
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

    /**
     * 胶囊开关：绿=开、红=关，左右滑块。
     *
     * 为什么不用原生 checkbox：原生框只有「勾/不勾」两个像素状态的差别，
     * 在一排开关里要凑近才看得出哪个是开的。胶囊把状态编码进三个维度 ——
     * 颜色（绿/红）、滑块位置（右/左）、文字（开/关）—— 任何一个都能单独
     * 读出状态，色弱用户靠位置和文字照样能用。
     *
     * 为什么不用 CSS 类：宿主可能没有任何主题样式，内联样式是唯一能保证
     * 显示正确的做法（这个文件里所有样式都是内联的，保持一致）。
     *
     * @param {{id:string, checked:boolean, disabled?:boolean, onChange:Function}} o
     */
    const 胶囊开关 = ({ id, checked, disabled = false, onChange }) => {
      const 宽 = 44;
      const 高 = 24;
      const 边 = 3;
      const 球 = 高 - 边 * 2; // 18
      return ce('button', {
        type: 'button',
        // role=switch + aria-checked：读屏软件能读出「开/关」，颜色是装饰不是唯一信息
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': id,
        id,
        disabled: !!disabled,
        onClick: () => { if (!disabled) onChange(!checked); },
        style: {
          position: 'relative',
          width: 宽,
          height: 高,
          padding: 0,
          border: 'none',
          borderRadius: 高 / 2,
          cursor: disabled ? 'not-allowed' : 'pointer',
          // 绿 #4a4 / 红 #c66：和本页已有的成功/错误提示同色，不引入新色系
          background: checked ? '#3f8f3f' : '#a33',
          opacity: disabled ? 0.45 : 1,
          transition: 'background-color .18s ease',
          flex: '0 0 auto',
        },
      }, ce('span', {
        'aria-hidden': 'true',
        style: {
          position: 'absolute',
          top: 边,
          left: checked ? 宽 - 球 - 边 : 边,
          width: 球,
          height: 球,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left .18s ease',
          boxShadow: '0 1px 2px rgba(0,0,0,.35)',
        },
      }))
    };

    /** 带文字的开关行：左边胶囊 + 标签 + 副说明。 */
    const 开关行 = ({ id, checked, disabled, onChange, 标签, 说明 }) =>
      ce('div', { style: styles.field },
        ce('div', { style: styles.row },
          胶囊开关({ id, checked, disabled, onChange }),
          ce('span', { style: { fontWeight: 600 } }, 标签),
          // 状态文字：颜色之外的第二重表达，避免只靠颜色区分
          ce('span', {
            style: { fontSize: 12, color: checked ? '#4a4' : '#c66' },
          }, checked ? '已开启' : '已关闭'),
        ),
        说明 ? ce('div', { style: styles.hint }, 说明) : null,
      );

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

    /**
     * ⭐ 2026-11-03：分档单选组 —— 私聊 / 群聊各一组。
     * 第一项是「跟随上面的总设置」（value 为空串），默认就选它，
     * 老用户不改这里的行为跟以前完全一样。
     */
    const 造分档组 = (标题, 说明, 当前值, 设定, name) =>
      ce(
        'div',
        { style: styles.field },
        ce('span', { style: { fontWeight: 600 } }, 标题),
        ce('p', { style: styles.sub }, 说明),
        [{ value: '', label: '跟随上面的总设置', desc: '' }].concat(MODES).map((m) =>
          ce(
            'div',
            { key: m.value || '__follow__' },
            ce(
              'label',
              { style: styles.radio },
              ce('input', {
                type: 'radio',
                name,
                value: m.value,
                checked: 当前值 === m.value,
                onChange: () => 设定(m.value),
              }),
              ce('span', null, ' ' + m.label),
            ),
            m.desc ? ce('p', { style: styles.hint }, m.desc) : null,
          ),
        ),
      );

    const 分档块 = ce(
      'div',
      { style: styles.field },
      ce('strong', null, '私聊 / 群聊分开设'),
      ce(
        'p',
        { style: styles.sub },
        '不填就跟随上面的总设置。想让私聊存原图、群里只存文字，就在这里分开选。',
      ),
      造分档组('私聊', '一对一聊天里的图。', privMode, setPrivMode, 'memory-vault-mode-private'),
      造分档组('群聊', '群里发的图。人多图杂，通常这里选「只存文字」更省磁盘。', grpMode, setGrpMode, 'memory-vault-mode-group'),
    );

    // ② 两个开关：启用私聊 / 启用群聊
    const privRow = 开关行({
      id: 'mv-sw-private',
      checked: privateOn,
      onChange: setPrivateOn,
      标签: '启用私聊',
      说明: '记录私聊的图片。关掉后不再采集你和小鱼的私聊图。',
    });
    const groupRow = 开关行({
      id: 'mv-sw-group',
      checked: groupOn,
      onChange: setGroupOn,
      标签: '启用群聊',
      说明: '群聊采集总开关。注意：这个名字容易误解——它只管「收不收群里的图」，不管收不收文字。',
    });

    // ②b 聊天记录开关：私聊 / 群聊分开记
    const chatPrivRow = 开关行({
      id: 'mv-sw-chat-private',
      checked: chatPrivate,
      onChange: setChatPrivate,
      标签: '记私聊聊天',
      说明: '把私聊的文字聊天记进仓库。关掉后只记图不记字。',
    });
    const chatGroupRow = 开关行({
      id: 'mv-sw-chat-group',
      checked: chatGroup,
      onChange: setChatGroup,
      标签: '记群聊聊天',
      说明: '把群聊的文字聊天记进仓库。关掉后群里的话一句都不会存。',
    });
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
    const autoRow = 开关行({
      id: 'mv-sw-autopull',
      checked: autoPull,
      onChange: setAutoPull,
      标签: '定时拉取',
      说明: '按下面的间隔自动拉取新消息。关掉后要手动点「扫描」才会更新。',
    });
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

    // ②c-2 聊天分层（把聊天并入检索）
    //
    // 这里每个开关的说明都写清「开了会怎样、关着会怎样、依赖什么」——
    // 开关最容易让人不敢碰的就是状态模糊：不知道当前算开还是关、不知道
    // 开了之后会发生什么。所以除了胶囊本身有绿/红 + 「已开启/已关闭」，
    // 每个开关下面还写明依赖关系和代价。
    const tierOnRow = 开关行({
      id: 'mv-sw-tier',
      checked: tierOn,
      onChange: setTierOn,
      标签: '启用聊天分层',
      说明: '把聊天记录分档后并入记忆检索。开着 = 聊天能被 memory_recall 搜到；' +
        '关着 = 只搜日记。默认关。这是总开关，下面三个只有在它开着时才有意义。',
    });
    const tierModelRow = 开关行({
      id: 'mv-sw-tier-model',
      checked: tierModel,
      disabled: !tierOn,
      onChange: setTierModel,
      标签: '用模型打分',
      // 说明始终写全：禁用时也照样显示「这个开关是干什么的」。
      // 早先写成立即切换——总开关关着时只剩一句「先打开上面那个」，
      // 用户根本看不到这个开关到底做什么，等于让人蒙着选。
      说明: '开 = 用大模型判断每条聊天值不值钱（更准，但很慢、要额度，首次全量约 8000 条需十几分钟）。' +
        '关 = 只用内置规则（零成本、0.2 秒跑完 8000 条，准确度略低）。' +
        '没配模型 API 也能用，规则不受影响。' +
        (tierOn ? '' : ' 【当前不可用：先打开上面的「启用聊天分层」】'),
    });
    const tierCronRow = 开关行({
      id: 'mv-sw-tier-cron',
      checked: tierCron,
      disabled: !tierOn,
      onChange: setTierCron,
      标签: '定时分层',
      说明: '开 = 每隔下面的小时数自动跑一次，只处理新增的聊天（处理过的不会重复送模型）。' +
        '关 = 只有你手动调 memory_score_chats 时才跑。默认关。' +
        (tierOn ? '' : ' 【当前不可用：先打开上面的「启用聊天分层」】'),
    });
    const tierHoursRow = ce(
      'div',
      { style: styles.field },
      ce('label', { htmlFor: 'memory-vault-tier-hours' }, '分层间隔（小时，1 - 720）'),
      ce('input', {
        id: 'memory-vault-tier-hours',
        type: 'number',
        min: 1,
        max: 720,
        value: tierHours,
        disabled: !(tierOn && tierCron),
        onChange: (e) => setTierHours(e.target.value),
        style: styles.input,
      }),
      ce('p', { style: styles.sub }, '默认 24 小时。只在「定时分层」开着时生效。'),
    );

    // 并入档次：三选一，用原生 radio（不是开关——这是三选一，不是开/关）
    const 档次选项 = [
      { v: 0, 名: '全部并入', 解: '闲聊也进库，但权重最低。召回最全，搜什么都可能冒出一堆。' },
      { v: 1, 名: '有用以上', 解: '只并入「核心 + 有用」。闲聊不进库。推荐。' },
      { v: 2, 名: '只并核心', 解: '只并入约定、决定、具体配置这类。库存最少，最精准。' },
    ];
    const 档次块 = ce(
      'div',
      { style: styles.field },
      ce('strong', null, '并入哪一档'),
      ce('p', { style: styles.sub }, '分三档：核心（约定/决定/具体配置）> 有用（讨论过程）> 闲聊（应答玩笑）。' +
        '选哪档以下的就不并入检索库。'),
      ...档次选项.map((o) => ce(
        'label',
        { style: styles.row, key: 'tier-' + o.v },
        ce('input', {
          type: 'radio',
          name: 'memory-vault-tier-min',
          checked: tierMin === o.v,
          disabled: !tierOn,
          onChange: () => setTierMin(o.v),
          style: styles.radio,
        }),
        ce('span', null, o.名),
        ce('span', { style: styles.hint }, o.解),
      )),
    );

    const diaryDirRow = ce(
      'div',
      { style: styles.field },
      ce('label', { htmlFor: 'memory-vault-diary' }, '日记库目录（只读，可留空）'),
      ce('input', {
        id: 'memory-vault-diary',
        type: 'text',
        value: diaryDir,
        placeholder: '例如 /root/.dsh/xiaoyu-diary；留空 = 不用日记，只搜聊天',
        onChange: (e) => setDiaryDir(e.target.value),
        style: styles.input,
      }),
      ce('p', { style: styles.sub }, '填了才会把日记当「重点库」参与检索，并且覆盖率检查才可用。' +
        '留空不影响聊天检索。这个目录只读，本插件不会往里写任何东西。'),
    );

    const tierBlock = ce(
      'div',
      { style: styles.field },
      ce('strong', null, '聊天分层检索'),
      ce('p', { style: styles.sub }, '把记忆仓库里的聊天按重要度分档后并入检索库，让 memory_recall 能搜到聊天原文。' +
        '原则：日记永远排在聊天前面（日记是人筛过的，聊天是机器筛的）。'),
      tierOnRow,
      tierModelRow,
      tierCronRow,
      tierHoursRow,
      档次块,
      diaryDirRow,
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
        const 说明 = verInfo.更新说明;
        verNode = ce('div', { style: styles.err },
          `有新版本：当前 ${verInfo.current} → 最新 ${verInfo.latest}`,
          ce('div', { style: { whiteSpace: 'pre-wrap', marginTop: 6, fontSize: '0.9em', lineHeight: 1.5 } },
            (说明 ? 说明 : '（这个版本的更新说明还没取到，可以去仓库的 CHANGELOG 看）')),
          ce('div', { style: { marginTop: 6 } }, '更新完记得重启 DSH 才生效。'));
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
      分档块,
      privRow,
      groupRow,
      chatBlock,
      autoBlock,
      tierBlock,
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
