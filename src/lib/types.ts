export type OutputKind = 'text' | 'image' | 'video';

export interface ORModel {
  id: string;
  platform?: string;
  name: string;
  vendor: string;
  created: number | null;
  description: string;
  contextLength: number | null;
  pricing: { prompt: number | null; completion: number | null; request: number | null; image: number | null } | null;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  isFree: boolean;
  outputKind: OutputKind;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsImageInput: boolean;
  /** false = 协议不兼容等原因不可载入 WorkBuddy（缺省视为可载入） */
  loadable?: boolean;
}

export interface ModelsResponse {
  fetchedAt: number;
  count: number;
  models: ORModel[];
  platform?: string;
  platformName?: string;
  note?: string | null;
  /** 备注里「参考教程」四个字指向的外链（无则按纯文本渲染） */
  tutorialUrl?: string | null;
}

export interface PlatformInfo {
  id: string;
  name: string;
  shortName: string;
  site: string;
  /** 该平台创建/管理 API Key 的入口页 */
  keyUrl: string | null;
  keyPlaceholder: string | null;
  modelsPublic: boolean;
  quotaKind: 'openrouter' | 'balance' | 'none';
  note: string | null;
  /** 备注里「参考教程」四个字指向的外链（无则按纯文本渲染） */
  tutorialUrl?: string | null;
  /** 平台默认 base URL（导出配置时展示用） */
  baseUrl?: string | null;
  keyCount?: number;
  modelCount?: number | null;
  /** 置灰原因：region = 地区受限；platform = 平台限制外部使用；null = 正常可用 */
  uiDisabled?: 'region' | 'platform' | null;
}

/** 导出给其他 agent 的单条模型配置（即 OpenAI 兼容的"自定义模型"条目） */
export interface ExportEntry {
  id: string;
  name: string;
  vendor: string;
  url: string;
  /** 点了「显示」才有值，否则为 null */
  apiKey: string | null;
  supportsToolCall: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
  useCustomProtocol: boolean;
  outputKind: OutputKind;
}

export interface ExportResponse {
  platform: string;
  platformName: string;
  baseUrl: string | null;
  protocol: string;
  chatPath: string;
  /** Key 的脱敏尾巴，始终有值 */
  masked: string;
  apiKey: string | null;
  entries: ExportEntry[];
  skipped: { id: string; reason: string }[];
}

export interface FreeDailyRequests {
  used: number;
  limit: number;
  remaining: number;
}

export interface KeyQuota {
  keyId: string;
  platform: string;
  label: string;
  masked: string;
  status: 'ok' | 'invalid' | 'error' | 'unknown';
  error?: string;
  /** 该平台未提供额度查询接口时的提示 */
  note?: string | null;
  unavailable?: string | null;
  freeModelDailyRequests?: FreeDailyRequests | null;
  usage?: number | null;
  usageDaily?: number | null;
  usageWeekly?: number | null;
  usageMonthly?: number | null;
  limit?: number | null;
  limitRemaining?: number | null;
  isFreeTier?: boolean;
  expiresAt?: string | null;
  credits?: { total: number | null; used: number | null } | null;
  /** 余额型平台的余额信息（单位见平台说明） */
  balance?: { total: number | null; charge: number | null; gift: number | null } | null;
}

export interface PlatformQuotaGroup {
  platform: string;
  platformName: string;
  quotaKind: 'openrouter' | 'balance' | 'none';
  note: string | null;
  /** 备注里「参考教程」四个字指向的外链（无则按纯文本渲染） */
  tutorialUrl?: string | null;
  keys: KeyQuota[];
}

export interface QuotaResponse {
  fetchedAt: number;
  activeKeys: Record<string, string | null>;
  platforms: PlatformQuotaGroup[];
}

export interface KeyInfo {
  id: string;
  platform: string;
  label: string;
  masked: string;
  addedAt: number;
  lastStatus?: string | null;
}

export interface KeysResponse {
  activeKeys: Record<string, string | null>;
  activeKeyId?: string | null;
  keys: KeyInfo[];
  configFile: string;
}

export interface LoadedEntry {
  id: string;
  name: string;
  platform: string;
  keyTail: string;
  supportsToolCall: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
}

export interface LoadedInfo {
  exists: boolean;
  invalid?: boolean;
  dir: string;
  modelsJsonPath: string;
  loaded: LoadedEntry[];
  running?: boolean;
  exePath?: string | null;
  /** 进程探测本身失败时的原因（非空表示状态不可信，不能断定"未运行"） */
  detectError?: string | null;
  /** 探测方式：powershell / tasklist / pgrep */
  detectMethod?: string | null;
  /** 降级探测导致的能力缺失说明（例如拿不到启动时间） */
  detectWarning?: string | null;
  /** 检测到的同名进程数（Electron 应用会有多个） */
  processCount?: number | null;
  modelsJsonMtime?: number | null;
  pendingRestart?: boolean;
}

export interface LoadResult {
  added: number;
  updated: number;
  backup: string | null;
  total: number;
  keyUsed: string;
  skipped: { id: string; reason: string }[];
}

export interface StatsBucket {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 思考 token（output 的子集） */
  thinking: number;
  /**
   * 展示总量。口径：input 已包含 cacheRead，所以 total = input + output + cacheWrite，
   * 不再重复累加缓存命中。uncachedInput 才是真正新读入的输入。
   */
  total: number;
  /** input - cacheRead，下溢饱和为 0 */
  uncachedInput: number;
  /** cacheRead / input；input 为 0 时为 null */
  cacheHitRate: number | null;
  /** max(0, output - thinking)，纯回复量 */
  reply: number;
}

export interface SessionStat extends StatsBucket {
  sessionId: string;
  title: string;
  project: string;
  lastActive: number | null;
  topModels: { model: string; tokens: number }[];
  /** 所属档位（多档位合并统计时用于归类） */
  variant?: 'cn' | 'ai';
  variantLabel?: string;
}

export interface StatsResponse {
  range: string;
  modelFilter: string | null;
  /** 本次统计的档位口径：all / cn / ai */
  variantFilter?: 'all' | 'cn' | 'ai';
  generatedAt: number;
  dir: string;
  /** 每个档位的扫描根与分档汇总（全部视图下展示"归类"用） */
  dirs?: { variant: 'cn' | 'ai'; label: string; dir: string }[];
  variants?: (StatsBucket & { variant: 'cn' | 'ai'; label: string; dir: string; filesScanned: number; filesSkipped: number })[];
  filesScanned: number;
  filesSkipped?: number;
  parseErrors: number;
  coverageStartAt: number | null;
  coverageEndAt: number | null;
  summary: StatsBucket;
  models: (StatsBucket & { name: string })[];
  projects: (StatsBucket & { name: string })[];
  sessions: SessionStat[];
  daily: (StatsBucket & { date: string; byModel: Record<string, number> })[];
  hours: Record<string, number>;
}

/* ---------------- 账号管理 ---------------- */

export interface AccountInfo {
  id: string;
  uid: string;
  name: string;
  email: string | null;
  nickname: string | null;
  note: string | null;
  displayField: 'auto' | 'note' | 'phone';
  domain: string;
  variant: 'cn' | 'ai';
  variantLabel: string;
  enterpriseName: string | null;
  createdAt: number | null;
  refreshedAt: number | null;
  expiresAt: number | null;
  refreshExpiresAt: number | null;
  /** 是否持有未过期的明文 access_token（决定能否切换） */
  hasPlainToken: boolean;
  expired: boolean;
  /** token 为 WorkBuddy 5.6 加密信封：不可作为可切换凭据 */
  hasEnvelope: boolean;
  /** token 尾号，完整值永不返回前端 */
  masked: string;
}

export interface VariantInfo {
  id: string;
  label: string;
  authFilePath: string;
  dataRoot: string;
}

/* ---------------- OAuth 扫码登录 ---------------- */

/** 发起扫码登录：官方验证链接（前端本地渲染二维码，不外传） */
export interface OAuthStartResult {
  loginId: string;
  verificationUri: string;
  /** state 有效期（秒） */
  expiresIn: number;
}

/** 轮询扫码结果：done=false 表示尚未扫码；result 为采集入库的账号摘要 */
export interface OAuthPollResult {
  done: boolean;
  result?: AccountInfo;
  error?: string;
  /** 未完成时的官方状态码 / 文案（如 11217「login ing…」），用于界面解释"卡在哪一步" */
  code?: number | null;
  message?: string;
  /** 服务端已轮询次数 */
  pollCount?: number;
}

export interface AccountsResponse {
  accounts: AccountInfo[];
  current: {
    variant: string;
    uid: string | null;
    exists: boolean;
    authFilePath: string | null;
    account: AccountInfo | null;
    warning: string | null;
  };
  variants: VariantInfo[];
}

/* ---------------- 积分统计 ---------------- */

/** 单个积分资源包（官方 get-user-resource-summary 的 Packages 项） */
export interface CreditPackage {
  packageCode: string | null;
  /** 展示名：商品码命中官方映射时用映射名，否则回落 PackageName */
  name: string;
  total: number;
  remaining: number;
  used: number;
  /** 到期时刻（毫秒时间戳）；null = 长期有效 */
  expireAt: number | null;
  expired: boolean;
  /** 7 天内到期 */
  expiringSoon: boolean;
}

export interface CreditBalance {
  total: number;
  remaining: number;
  used: number;
  packageCount: number;
  unit: string;
  /** 全部资源包明细（含已用完的），按到期时间升序 */
  packages: CreditPackage[];
  /** 余额最近一次成功查询的时刻 */
  updatedAt: number | null;
}

export interface CreditAccountRow {
  accountId: string;
  accountName: string;
  variant: string;
  variantLabel: string;
  requests: number;
  credit: number;
  balance: CreditBalance | null;
  balanceError: string | null;
  error: string | null;
  unauthorized?: boolean;
}

export interface CreditRequestRow {
  requestId: string;
  ts: number;
  date: string;
  time: string;
  model: string;
  client: string;
  credit: number;
  accountId: string;
  accountName: string;
  variant: string;
  variantLabel: string;
}

export interface CreditResponse {
  /** 缓存结构标识（本工具专用缓存文件） */
  schema?: string;
  /** 本次统计的档位口径：all / cn / ai */
  variantFilter?: 'all' | 'cn' | 'ai';
  status: 'complete' | 'partial' | 'error';
  collectedAt: number;
  rangeStart: string;
  rangeEnd: string;
  days: number;
  detailLimitPerAccount: number;
  summary: {
    usageToday: number;
    usage7Days: number;
    usageThisMonth: number;
    totalRequests: number;
  };
  accounts: CreditAccountRow[];
  daily: { date: string; credit: number; requests: number; byModel: Record<string, number> }[];
  models: { model: string; credit: number; requests: number }[];
  /** 按档位分流的消耗合计（全部视图下展示"归类"用） */
  variantTotals?: { variant: 'cn' | 'ai'; credit: number; requests: number }[];
  requests: CreditRequestRow[];
  errors: { accountId: string; accountName: string; variant: string; error: string }[];
  cached?: boolean;
}

/** 单个账号的积分余额行（/api/accounts/credits） */
export interface AccountBalanceRow {
  accountId: string;
  accountName: string;
  variant: string;
  variantLabel: string;
  balance: CreditBalance | null;
  balanceError: string | null;
  error: string | null;
}

export interface AccountBalancesResponse {
  collectedAt: number;
  accounts: AccountBalanceRow[];
  errors: { accountId: string; accountName: string; variant: string; error: string }[];
  cached?: boolean;
}

export interface WorkbuddyDetection {
  dir: string;
  source: 'override' | 'default' | 'scan';
  sourceLabel: string;
  valid: boolean;
  markers: {
    modelsJson: boolean;
    projects: boolean;
    sessions: boolean;
    db: boolean;
    score: number;
    exists: boolean;
  };
}

export interface DetectResult {
  detected: WorkbuddyDetection;
  running: boolean;
  exePath: string | null;
  detectError?: string | null;
  detectMethod?: string | null;
}

export interface PlatformCacheInfo {
  platform: string;
  platformName: string;
  fetchedAt: number;
  count: number;
}

export interface SettingsInfo {
  workbuddyDir: string;
  proxyUrl: string;
  /** 自动签到（仅国内版账号，服务端每小时巡检一次） */
  autoCheckin: boolean;
  effectiveProxy: string | null;
  detected: WorkbuddyDetection;
  cacheDir: string;
  modelsCaches: PlatformCacheInfo[];
}

/* ---------------- 每日签到 ---------------- */

export interface CheckinState {
  account: AccountInfo;
  /** 状态查询是否成功；false 时看 error */
  ok: boolean;
  todayCheckedIn: boolean;
  error?: string | null;
  /** 该档位没有签到能力（国际版） */
  unsupported?: boolean;
  unauthorized?: boolean;
}

export interface CheckinLogEntry {
  ts: number;
  accountId: string;
  accountName: string;
  variant: 'cn' | 'ai';
  ok: boolean;
  alreadyCheckedIn: boolean;
  message: string;
}

export interface CheckinStatusResponse {
  states: CheckinState[];
  logs: CheckinLogEntry[];
}

export interface CheckinRunResult {
  ok: boolean;
  action: 'checked' | 'already' | 'skipped' | 'failed';
  message: string;
  account: AccountInfo;
}

export interface CheckinAllResult {
  results: CheckinRunResult[];
  summary: { total: number; checked: number; already: number; failed: number; skipped: number };
}

/* ---------------- 权限自检 ---------------- */

export interface PermissionCheck {
  id: string;
  group: string;
  label: string;
  path: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  required: 'read-write';
  hint: string;
  ok: boolean;
}

export interface PermissionResponse {
  ok: boolean;
  platform: string;
  home: string;
  items: PermissionCheck[];
}

/* ---------------- 登录态备份 ---------------- */

export interface BackupEntry {
  name: string;
  path: string;
  size: number;
  mtime: number;
  variant: 'cn' | 'ai' | null;
  variantLabel: string;
  createdAt: number;
}

export interface BackupsResponse {
  dir: string;
  backups: BackupEntry[];
  variants: { id: 'cn' | 'ai'; label: string; authFilePath: string }[];
}

export interface RestoreBackupResult {
  ok: boolean;
  restored: string;
  authFilePath: string;
  safetyBackup: string | null;
  variant: { id: 'cn' | 'ai'; label: string };
}

/* ---------------- 反向代理（OpenAI 兼容） ---------------- */

export interface ProxyAccount {
  id: string;
  name: string;
  uid: string;
  variant: 'cn' | 'ai';
  variantLabel: string;
  /** 是否可用于出站请求（需明文凭据且未过期） */
  usable: boolean;
  expired: boolean;
  expiresAt: number | null;
  selected: boolean;
}

export interface ProxyLog {
  at: number;
  ok: boolean;
  status: number;
  model: string;
  stream: boolean;
  account: string | null;
  ms: number;
  error?: string;
}

export interface ProxyStatus {
  enabled: boolean;
  baseUrl: string;
  chatUrl: string;
  hasKey: boolean;
  keyPreview: string;
  /** 明文 Key：仅在带 reveal=1 请求时返回，其余为空串 */
  apiKey: string;
  accountIds: string[];
  poolCount: number;
  accounts: ProxyAccount[];
  models: { ids: string[]; fetchedAt: number | null; error: string | null; account: string | null };
  stats: { total: number; ok: number; failed: number; lastAt: number | null };
  logs: ProxyLog[];
}

export interface ProxyTestResult {
  ok: boolean;
  account?: string;
  variant?: string;
  model?: string;
  preview?: string;
  error?: string;
}
