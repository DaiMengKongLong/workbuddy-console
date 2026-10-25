import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  IconChevronDown,
  IconClock,
  IconCopy,
  IconDatabase,
  IconDownload,
  IconLayers,
  IconPower,
  IconRefresh,
  IconShield,
  IconSliders,
  IconTrash,
  IconWarning,
  PageSection,
  Spinner,
  useConfirm,
  useToast,
} from '../components/ui';
import { del, get, post, put, TIMEOUT } from '../lib/api';
import { emitUpdateChecked } from '../lib/appUpdate';
import { emitSettingsChanged } from '../lib/appSettings';
import type {
  AccountRefreshResponse,
  AccountRefreshRunResponse,
  AppUpdateInfo,
  BackupEntry,
  BackupsResponse,
  CheckinAllResult,
  CheckinState,
  CheckinStatusResponse,
  DetectResult,
  HotUpdateResult,
  LoadedInfo,
  PermissionCheck,
  PermissionResponse,
  PlatformInfo,
  SettingsInfo,
} from '../lib/types';
import { fmtDate, fmtDateTime, fmtRelative } from '../lib/format';
import { NOTIFICATION_MAX, clearNotifications, readNotifications, type NotificationItem } from '../lib/notify';
import { ERROR_MAX, clearErrors, readErrors, type ErrorItem } from '../lib/errlog';

function MarkerBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge color={ok ? 'green' : 'gray'}>
      {ok ? '✓' : '—'} {label}
    </Badge>
  );
}

/** 设置行：左标签 + 说明，右操作；与参考项目一致的信息层级 */
function Row({
  label,
  desc,
  children,
  className = '',
}: {
  label: React.ReactNode;
  desc?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    // 手机（<768px）改为上下堆叠：说明文字占满整行宽，操作项换到下一行。
    // 否则长说明会被右侧控件挤成一条 ~150px 的窄竖条（每行十来个字），非常难读。
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 max-md:flex-col max-md:items-stretch max-md:gap-y-1.5 ${className}`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm text-zinc-700">{label}</div>
        {desc && <div className="mt-0.5 text-xs text-zinc-400 leading-relaxed">{desc}</div>}
      </div>
      {children && (
        <div className="flex flex-wrap items-center gap-2 max-md:justify-end max-md:pt-0.5">{children}</div>
      )}
    </div>
  );
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 剩余小时数 → 人话；null（账号里没有该有效期字段）与"已过期"必须区分 */
function fmtHours(h: number | null | undefined): string {
  if (h == null || !Number.isFinite(h)) return '未知';
  if (h <= 0) return '已过期';
  if (h < 48) return `${h.toFixed(1)} 小时`;
  return `${(h / 24).toFixed(1)} 天`;
}

/** 凭据刷新的判定原因 → 中文（与服务端 tokenRefresh.mjs 的 reason 一一对应） */
const REFRESH_REASON_TEXT: Record<string, string> = {
  ok: '有效期充足',
  'access-expiring': 'access 即将过期',
  'refresh-expiring': 'refresh 即将过期',
  dead: 'refresh 已过期，需重新登录',
  'unknown-expiry': '未记录有效期，暂不处理',
  'no-refresh-token': '无 refresh_token，需重新扫码',
  manual: '手动刷新',
  current: '当前登录账号（由 WorkBuddy 自行续期，不自动刷新）',
  'failed-cooldown': '上次刷新失败，已暂停自动重试',
  'verified-valid': '服务端确认有效',
  'verify-failed': '验活请求失败（网络）',
  'invalid-no-refresh': '服务端已拒绝，且无 refresh_token 可续期',
  'current-invalid': '当前登录账号已被服务端拒绝',
};

export default function SettingsPage() {
  const toast = useToast();
  const confirm = useConfirm();

  /* ---------------- 通用设置 ---------------- */
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [wbDir, setWbDir] = useState('');
  const [savingDir, setSavingDir] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [proxyInput, setProxyInput] = useState('');
  const [savingProxy, setSavingProxy] = useState(false);

  /* ---------------- WorkBuddy 运行状态 ---------------- */
  const [status, setStatus] = useState<LoadedInfo | null>(null);
  const [restarting, setRestarting] = useState(false);

  /* ---------------- 签到 ---------------- */
  const [checkin, setCheckin] = useState<CheckinStatusResponse | null>(null);
  const [checkinLoading, setCheckinLoading] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);

  /* ---------------- 凭据自动刷新 ---------------- */
  const [refreshInfo, setRefreshInfo] = useState<AccountRefreshResponse | null>(null);
  const [refreshingTokens, setRefreshingTokens] = useState(false);

  /* ---------------- 免费模型平台可见性 ---------------- */
  /** 受平台自身限制、默认收起的平台（仅用于在设置里说明"开了会放出哪几个"） */
  const [restrictedPlatforms, setRestrictedPlatforms] = useState<PlatformInfo[]>([]);

  /* ---------------- 版本自检 ---------------- */
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  /** 一键热更新：下载→替换→重启的整个过程中都要锁住按钮 */
  const [hotUpdating, setHotUpdating] = useState(false);
  const [hotUpdateMsg, setHotUpdateMsg] = useState('');

  /* ---------------- 权限自检 ---------------- */
  const [perm, setPerm] = useState<PermissionResponse | null>(null);
  const [permLoading, setPermLoading] = useState(false);

  /* ---------------- 备份 ---------------- */
  const [backups, setBackups] = useState<BackupsResponse | null>(null);
  const [backupBusy, setBackupBusy] = useState<string | null>(null);

  /* ---------------- 本地日志（前端） ---------------- */
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [errors, setErrors] = useState<ErrorItem[]>([]);

  const loadSettings = useCallback(() => {
    get<SettingsInfo>('/api/settings')
      .then((r) => {
        setSettings(r);
        setWbDir(r.workbuddyDir || '');
        setProxyInput(r.proxyUrl || '');
      })
      .catch((e) => toast('err', e.message));
    // 平台限制清单：与开关无关，始终取真实原因（restriction），用来告诉用户「打开后会放出哪几个」
    get<{ platforms: PlatformInfo[] }>('/api/platforms')
      .then((r) => setRestrictedPlatforms((r.platforms || []).filter((p) => !!p.restriction)))
      .catch(() => {
        /* 读不到就只是少一句说明，不影响开关本身 */
      });
  }, [toast]);

  const loadStatus = useCallback(() => {
    get<LoadedInfo>('/api/workbuddy/status')
      .then(setStatus)
      .catch(() => {});
  }, []);

  const loadCheckin = useCallback(
    async (silent = false) => {
      if (!silent) setCheckinLoading(true);
      try {
        setCheckin(await get<CheckinStatusResponse>('/api/workbuddy/checkin/status'));
      } catch (e: any) {
        if (!silent) toast('err', e?.message || '签到状态查询失败');
      } finally {
        setCheckinLoading(false);
      }
    },
    [toast]
  );

  const loadRefreshInfo = useCallback(async () => {
    try {
      setRefreshInfo(await get<AccountRefreshResponse>('/api/accounts/refresh'));
    } catch {
      /* 凭据状态查询失败不打扰用户，列表留空即可 */
    }
  }, []);

  const loadUpdateInfo = useCallback(
    async (force = false) => {
      setCheckingUpdate(true);
      try {
        const info = force
          ? await post<AppUpdateInfo>('/api/app/update/check')
          : await get<AppUpdateInfo>('/api/app/update');
        setUpdateInfo(info);
        // 常驻的左下角版本区是另一个组件：把结果广播过去，否则「这里已显示发现新版本、
        // 左下角却没按钮」（用户 2026-10-18 反馈）
        emitUpdateChecked(info);
      } catch (e: any) {
        if (force) toast('err', e?.message || '检查更新失败');
      } finally {
        setCheckingUpdate(false);
      }
    },
    [toast]
  );

  /**
   * 一键热更新：服务端自己把新版本拉下来 → 就地替换 server/ 与 dist/ → 重启服务。
   * 用户**不需要去 GitHub 下载 .fpk，也不需要到应用中心卸载重装**。
   *
   * 重启期间页面会短暂不可用（进程被杀掉再拉起），所以更新成功后轮询 /api/health
   * 等服务回来，再整页刷新拿新前端；等不到就提示用户手动刷新，不让界面卡在"正在更新"。
   */
  const runHotUpdate = async () => {
    setHotUpdating(true);
    setHotUpdateMsg('正在下载并替换文件…');
    try {
      const r = await post<HotUpdateResult>('/api/app/update/apply', {});
      if (!r.ok) {
        setHotUpdateMsg('');
        toast('err', r.message || '更新失败');
        return;
      }
      if (r.upToDate) {
        setHotUpdateMsg('');
        toast('ok', r.message || '已是最新版本');
        await loadUpdateInfo(true);
        return;
      }
      setHotUpdateMsg(`已更新到 v${r.to ?? ''}，正在重启服务…`);
      const deadline = Date.now() + 90_000;
      let back = false;
      while (Date.now() < deadline) {
        await new Promise((s) => setTimeout(s, 2000));
        try {
          await get<{ ok?: boolean }>('/api/health');
          back = true;
          break;
        } catch {
          /* 重启中，接口不可用属正常，继续等 */
        }
      }
      if (!back) {
        setHotUpdateMsg('等待重启超时，请稍后手动刷新页面');
        toast('err', '服务重启超时，请稍后刷新页面确认版本');
        return;
      }
      toast('ok', `已更新到 v${r.to ?? ''}`);
      window.location.reload();
    } catch (e: any) {
      setHotUpdateMsg('');
      toast('err', e?.message || '更新失败');
    } finally {
      setHotUpdating(false);
    }
  };

  /**
   * 手动「检查并刷新」：不带 force —— 只刷新已经临期的账号。
   * 不做「点一下全部重刷」，是因为刷新可能轮换 refresh_token，无谓的刷新反而会与
   * WorkBuddy 自己持有的那一份互相踩到（详见 server/workbuddy/tokenRefresh.mjs 的说明）。
   */
  const runTokenRefresh = async () => {
    setRefreshingTokens(true);
    try {
      const r = await post<AccountRefreshRunResponse>('/api/accounts/refresh', {});
      const { summary } = r;
      const failed = r.results.find((x) => x.action === 'failed');
      const dead = r.results.filter((x) => x.action === 'dead');
      if (summary.refreshed) {
        toast('ok', `已刷新 ${summary.refreshed} 个临期账号${summary.failed ? `，${summary.failed} 个失败` : ''}`);
      } else if (summary.failed) {
        toast('err', `刷新失败：${failed?.message || '未知原因'}`);
      } else if (dead.length) {
        toast('info', `${dead.length} 个账号需重新登录：${dead.map((d) => d.accountName).join('、')}`);
      } else {
        toast('ok', '所有账号的有效期都还很充足，未做任何刷新');
      }
      await loadRefreshInfo();
    } catch (e: any) {
      toast('err', e?.message || '刷新失败');
    } finally {
      setRefreshingTokens(false);
    }
  };

  const loadPerm = useCallback(
    async (silent = false) => {
      if (!silent) setPermLoading(true);
      try {
        setPerm(await get<PermissionResponse>('/api/workbuddy/permissions'));
      } catch (e: any) {
        if (!silent) toast('err', e?.message || '权限自检失败');
      } finally {
        setPermLoading(false);
      }
    },
    [toast]
  );

  const loadBackups = useCallback(async () => {
    try {
      setBackups(await get<BackupsResponse>('/api/workbuddy/backups'));
    } catch {
      /* 备份目录不存在时接口返回空列表，这里静默 */
    }
  }, []);

  const loadLocalLogs = useCallback(() => {
    setNotifications(readNotifications());
    setErrors(readErrors());
  }, []);

  useEffect(() => {
    loadSettings();
    loadStatus();
    loadBackups();
    loadLocalLogs();
    void loadPerm(true);
    void loadCheckin(true);
    void loadRefreshInfo();
    void loadUpdateInfo(false);
  }, [loadSettings, loadStatus, loadBackups, loadLocalLogs, loadPerm, loadCheckin, loadRefreshInfo, loadUpdateInfo]);

  /** 重新检测数据目录与运行状态 */
  const redetect = useCallback(
    async (silent = false) => {
      setDetecting(true);
      try {
        const r = await get<DetectResult>('/api/workbuddy/detect');
        setSettings((prev) => (prev ? { ...prev, detected: r.detected } : prev));
        loadStatus();
        if (!silent) {
          if (r.detected.valid) toast('ok', `已检测到 WorkBuddy 数据目录：${r.detected.dir}`);
          else toast('err', '未检测到 WorkBuddy 数据目录，请确认已安装并运行过 WorkBuddy，或手动指定');
          if (!r.running && r.detectError) toast('err', `无法确认 WorkBuddy 运行状态：${r.detectError}`);
        }
      } catch (e: any) {
        if (!silent) toast('err', e?.message || '检测失败');
      } finally {
        setDetecting(false);
      }
    },
    [loadStatus, toast]
  );

  const saveDir = async (dir: string) => {
    setSavingDir(true);
    try {
      const r = await put<{ workbuddyDir: string; detected: SettingsInfo['detected'] }>('/api/settings', { workbuddyDir: dir }, { timeoutMs: TIMEOUT.write });
      setSettings((prev) => (prev ? { ...prev, workbuddyDir: r.workbuddyDir, detected: r.detected } : prev));
      setWbDir(r.workbuddyDir);
      if (r.detected.valid) {
        setShowManual(false);
        toast('ok', `已保存，检测到 WorkBuddy 数据：${r.detected.dir}`);
      } else {
        toast('err', '已保存，但该目录未检测到 WorkBuddy 数据特征（models.json / 会话日志等）');
      }
    } catch (e: any) {
      toast('err', e?.message || '保存失败');
    } finally {
      setSavingDir(false);
    }
  };

  const saveProxy = async (url: string) => {
    setSavingProxy(true);
    try {
      const r = await put<{ ok: boolean; proxyUrl: string; effectiveProxy: string | null }>('/api/settings', { proxyUrl: url }, { timeoutMs: TIMEOUT.write });
      setSettings((prev) => (prev ? { ...prev, proxyUrl: r.proxyUrl, effectiveProxy: r.effectiveProxy } : prev));
      setProxyInput(r.proxyUrl);
      toast('ok', r.proxyUrl ? `代理已保存，出站请求将走 ${r.effectiveProxy || r.proxyUrl}` : '代理已清空，恢复自动探测（环境变量 / 系统代理）');
    } catch (e: any) {
      toast('err', e?.message || '保存失败');
    } finally {
      setSavingProxy(false);
    }
  };

  const toggleAutoCheckin = async (next: boolean) => {
    const prev = !!settings?.autoCheckin;
    // 乐观更新：勾选立即响应，失败再回滚（否则要等一次本机请求往返，点上去像没反应）
    setSettings((p) => (p ? { ...p, autoCheckin: next } : p));
    try {
      const r = await put<{ autoCheckin: boolean }>('/api/settings', { autoCheckin: next }, { timeoutMs: TIMEOUT.write });
      setSettings((p) => (p ? { ...p, autoCheckin: r.autoCheckin } : p));
      toast('ok', r.autoCheckin ? '已开启自动领取：服务端每小时巡检一次，自动补签并领取成长中心奖励' : '已关闭自动领取');
    } catch (e: any) {
      setSettings((p) => (p ? { ...p, autoCheckin: prev } : p));
      toast('err', e?.message || '保存失败');
    }
  };

  /** 其余布尔设置项的统一开关：与自动签到同一套「乐观更新 + 失败回滚」交互 */
  const toggleBoolSetting = async (
    key: 'autoRefreshToken' | 'autoCheckUpdate' | 'unlockAllPlatforms',
    next: boolean,
    hint: { on: string; off: string }
  ) => {
    if (!settings) return;
    const prev = !!settings[key];
    setSettings((p) => (p ? { ...p, [key]: next } : p));
    try {
      const r = await put<Partial<SettingsInfo>>('/api/settings', { [key]: next }, { timeoutMs: TIMEOUT.write });
      setSettings((p) => (p ? { ...p, [key]: !!r[key] } : p));
      // 常驻挂载的其它页面不会因为"切回来"重新取数：把变更广播出去（如免费模型页的平台列表）
      emitSettingsChanged({ [key]: !!r[key] });
      toast('ok', next ? hint.on : hint.off);
    } catch (e: any) {
      setSettings((p) => (p ? { ...p, [key]: prev } : p));
      toast('err', e?.message || '保存失败');
    }
  };

  const runCheckin = async (accountId?: string) => {
    setCheckingIn(true);
    try {
      if (accountId) {
        const r = await post<{ ok: boolean; action: string; message: string; growth?: { report: string } }>(
          '/api/workbuddy/checkin',
          { accountId }
        );
        toast(r.ok ? 'ok' : 'err', r.growth?.report ? `${r.message}；${r.growth.report}` : r.message);
      } else {
        const r = await post<CheckinAllResult>('/api/workbuddy/checkin', { onlyPending: true });
        const { summary } = r;
        const parts = [`新签到 ${summary.checked} 个`];
        if (summary.already) parts.push(`已签到 ${summary.already} 个`);
        if (summary.skipped) parts.push(`跳过 ${summary.skipped} 个`);
        if (summary.failed) parts.push(`失败 ${summary.failed} 个`);
        if (summary.growthCredits) parts.push(`成长中心 +${summary.growthCredits} 积分`);
        toast(summary.failed || summary.growthHardFailures ? 'err' : 'ok', `领取完成：${parts.join('，')}`);
      }
      await loadCheckin(true);
    } catch (e: any) {
      toast('err', e?.message || '领取失败');
    } finally {
      setCheckingIn(false);
    }
  };

  const restartWb = async () => {
    const ok = await confirm({
      title: '重启 WorkBuddy',
      message: (
        <>
          将强制结束当前 WorkBuddy 进程并重新启动，使 <span className="font-mono text-xs">models.json</span> 的最新配置生效。
          <br />
          <span className="text-amber-600">正在进行的对话会被中断，请先保存工作。</span>
        </>
      ),
      confirmText: '重启',
      danger: true,
    });
    if (!ok) return;
    setRestarting(true);
    try {
      const r = await post<{ restarted: boolean; exePath?: string }>('/api/workbuddy/restart');
      toast('ok', `WorkBuddy 已重启${r.exePath ? `（${r.exePath}）` : ''}`);
      setTimeout(loadStatus, 2500);
    } catch (e: any) {
      toast('err', e?.message || '重启失败');
    } finally {
      setRestarting(false);
    }
  };

  const restoreBackup = async (b: BackupEntry) => {
    const ok = await confirm({
      title: '恢复登录态备份',
      message: (
        <>
          将用备份 <b className="text-zinc-800">{new Date(b.createdAt).toLocaleString('zh-CN')}</b>（{b.variantLabel}）
          覆盖当前的 {b.variantLabel}登录态文件。
          <br />
          覆盖前会自动再备份一次当前文件，可再次回退。若 WorkBuddy 正在运行，恢复后需重启它才会读取新登录态。
        </>
      ),
      confirmText: '恢复',
      danger: true,
    });
    if (!ok) return;
    setBackupBusy(b.name);
    try {
      const r = await post<{ authFilePath: string; safetyBackup: string | null }>('/api/workbuddy/backups/restore', { name: b.name });
      toast('ok', `已恢复登录态到 ${r.authFilePath}${r.safetyBackup ? '（原文件已另存备份）' : ''}`);
      await loadBackups();
      await loadPerm(true);
    } catch (e: any) {
      toast('err', e?.message || '恢复失败');
    } finally {
      setBackupBusy(null);
    }
  };

  const removeBackup = async (b: BackupEntry) => {
    const ok = await confirm({
      title: '删除备份',
      message: <>确定删除备份 <b className="text-zinc-800">{new Date(b.createdAt).toLocaleString('zh-CN')}</b> 吗？删除后无法恢复。</>,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setBackupBusy(b.name);
    try {
      await del(`/api/workbuddy/backups/${encodeURIComponent(b.name)}`);
      toast('ok', '备份已删除');
      await loadBackups();
    } catch (e: any) {
      toast('err', e?.message || '删除失败');
    } finally {
      setBackupBusy(null);
    }
  };

  const cleanBackups = async () => {
    const keep = 10;
    const ok = await confirm({
      title: '清理旧备份',
      message: <>将只保留最近 <b className="text-zinc-800">{keep}</b> 份备份，更早的全部删除。删除后无法恢复。</>,
      confirmText: '清理',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await post<{ removed: number; keep: number }>('/api/workbuddy/backups/clean', { keep });
      toast('ok', r.removed ? `已清理 ${r.removed} 份旧备份，保留最近 ${r.keep} 份` : '没有需要清理的备份');
      await loadBackups();
    } catch (e: any) {
      toast('err', e?.message || '清理失败');
    }
  };

  const copyErrors = async () => {
    const text = errors
      .map((e) => `[${new Date(e.at).toLocaleString('zh-CN')}] ${e.kind === 'rejection' ? 'Promise拒绝' : '异常'} ${e.message}${e.source ? ` @ ${e.source}` : ''}${e.detail ? `\n${e.detail}` : ''}`)
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('ok', `已复制 ${errors.length} 条错误记录`);
    } catch {
      toast('err', '复制失败，请手动选中复制');
    }
  };

  // 权限项按分组聚合展示
  const permGroups = useMemo(() => {
    const map = new Map<string, PermissionCheck[]>();
    for (const item of perm?.items || []) {
      if (!map.has(item.group)) map.set(item.group, []);
      map.get(item.group)!.push(item);
    }
    return [...map.entries()];
  }, [perm]);

  const cnStates: CheckinState[] = checkin?.states || [];

  return (
    <div className="space-y-6 max-w-4xl">
      {/* 每日签到与成长中心 */}
      <PageSection
        icon={<IconClock />}
        title="每日签到与成长中心"
        count={cnStates.length ? `${cnStates.filter((s) => s.todayCheckedIn).length}/${cnStates.length} 今日已签` : undefined}
        desc="签到积分之外，成长中心的旅行礼物、任务、补登、连登兑换、盲盒、Buddy 也一并代领；自动巡检默认开启"
        actions={
          <>
            <Button size="sm" variant="subtle" loading={checkinLoading} onClick={() => loadCheckin(false)}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新状态
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={checkingIn}
              disabled={!cnStates.length}
              onClick={() => runCheckin()}
              title="签到 + 领取成长中心全部可领奖励（旅行礼物/派 Buddy/任务/断登补签/连登兑换/开盲盒/Buddy 盲盒）"
            >
              一键领取
            </Button>
          </>
        }
      >
        <Card className="p-5">
          <div className="divide-y divide-zinc-100 -mx-4 mb-3">
            <Row
              label={
                <span className="flex flex-wrap items-center gap-2">
                  自动领取（签到 + 成长中心）
                  <Badge color={settings?.autoCheckin ? 'green' : 'gray'}>
                    {settings?.autoCheckin ? '已开启（默认）' : '已关闭'}
                  </Badge>
                </span>
              }
              desc={
                <>
                  <b className="text-zinc-600">默认为开启</b>
                  ，服务端每小时巡检一次（06:00–23:00），发现当日未签到会自动补签，并顺带领取成长中心的
                  <b className="text-zinc-600">旅行礼物、派 Buddy、任务奖励、断登补签（消耗补登卡）、连登兑换、开盲盒、Buddy 盲盒</b>
                  （只对国内版账号生效；各接口幂等或由服务端兜底，重复执行无副作用；补登卡每轮最多用 1 张、盲盒每轮最多开 1 次）。
                  巡检依赖控制台处于运行状态：桌面版关闭窗口后会驻留系统托盘，领取不会中断。
                  <br />
                  不需要自动领取可在此关闭；关闭后仍可随时点右上角「一键领取」或单账号「领取」手动执行。
                </>
              }
            >
              <label className="flex items-center gap-2 text-sm text-zinc-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={!!settings?.autoCheckin}
                  onChange={(e) => toggleAutoCheckin(e.target.checked)}
                  className="accent-indigo-600 rounded"
                />
                {settings?.autoCheckin ? '已开启自动巡检' : '关闭自动巡检'}
              </label>
            </Row>
          </div>

          {!cnStates.length ? (
            <div className="text-sm text-zinc-400 py-3">暂无国内版账号。签到需要账号具备明文凭据（WorkBuddy 登录后导入）。</div>
          ) : (
            <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200/80">
              {cnStates.map((s) => (
                <div key={s.account.id} className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
                  <div className="min-w-0">
                    <div className="text-sm text-zinc-800 truncate max-w-64">{s.account.name}</div>
                    <div className="text-xs text-zinc-400">
                      {s.ok ? (s.todayCheckedIn ? '今日已签到' : '今日未签到') : s.error || '状态未知'}
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-1.5">
                    {s.ok ? (
                      s.todayCheckedIn ? (
                        <Badge color="green">已签到</Badge>
                      ) : (
                        <Badge color="amber">待签到</Badge>
                      )
                    ) : (
                      <Badge color="gray">{s.unsupported ? '不支持' : '查询失败'}</Badge>
                    )}
                    <Button
                      size="sm"
                      variant="subtle"
                      loading={checkingIn}
                      disabled={!s.ok}
                      onClick={() => runCheckin(s.account.id)}
                      title="签到（未签时）+ 领取成长中心全部可领奖励"
                    >
                      领取
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!!checkin?.logs?.length && (
            <div className="mt-4">
              <div className="text-xs text-zinc-400 mb-1.5">最近领取记录（含成长中心）</div>
              <div className="max-h-48 overflow-y-auto rounded-xl border border-zinc-100 divide-y divide-zinc-50">
                {checkin.logs.map((l, i) => (
                  <div key={`${l.ts}-${i}`} className="px-3 py-1.5 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-zinc-400 tabular-nums">{fmtDateTime(l.ts)}</span>
                      <span className="text-zinc-600 truncate max-w-40">{l.accountName}</span>
                      <span className={l.ok ? 'text-emerald-600' : 'text-red-500'}>{l.message}</span>
                      {l.growth && l.growth.creditsGained > 0 && (
                        <Badge color="green">成长中心 +{l.growth.creditsGained}</Badge>
                      )}
                    </div>
                    {l.growth?.report && (
                      <div className={`mt-0.5 pl-0.5 leading-relaxed ${l.growth.ok ? 'text-zinc-500' : 'text-amber-600'}`}>
                        {l.growth.report}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </PageSection>

      {/* 账号凭据维护 */}
      <PageSection
        icon={<IconRefresh />}
        title="账号凭据维护"
        desc="凭据不会自己续命：既没被切换过、也没走过反向代理的账号，会一路静默失效，直到只能重新扫码"
      >
        <Card className="p-5">
          <div className="divide-y divide-zinc-100 -mx-4 mb-3">
            <Row
              label={
                <span className="flex flex-wrap items-center gap-2">
                  凭据自动刷新
                  <Badge color={settings?.autoRefreshToken ? 'green' : 'gray'}>
                    {settings?.autoRefreshToken ? '已开启（默认）' : '已关闭'}
                  </Badge>
                </span>
              }
              desc={
                <>
                  服务端每 {refreshInfo?.intervalHours ?? 6} 小时看一次，
                  <b className="text-zinc-600">只在临期时才动手</b>：access_token 剩余不足{' '}
                  {refreshInfo?.accessMinHours ?? 24} 小时，或 refresh_token 剩余不足{' '}
                  {refreshInfo?.refreshMinHours ?? 72} 小时。关掉后，长期不切换、也不走反向代理的账号会一直静默过期。
                </>
              }
            >
              <label className="flex items-center gap-2 text-sm text-zinc-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={!!settings?.autoRefreshToken}
                  onChange={(e) =>
                    toggleBoolSetting('autoRefreshToken', e.target.checked, {
                      on: '已开启凭据自动刷新：只在临期时才刷新，不会频繁打扰官方接口',
                      off: '已关闭凭据自动刷新：长期不用的账号可能失效',
                    })
                  }
                  className="accent-indigo-600 rounded"
                />
                {settings?.autoRefreshToken ? '已开启' : '已关闭'}
              </label>
            </Row>

            <Row label="立即检查" desc="只刷新已经临期的账号；有效期充足的保持不动，避免无谓的凭据轮换">
              <Button size="sm" onClick={runTokenRefresh} loading={refreshingTokens}>
                {!refreshingTokens && <IconRefresh className="w-3.5 h-3.5" />}
                检查并刷新
              </Button>
            </Row>
          </div>

          {!refreshInfo ? (
            <div className="py-3 text-sm text-zinc-400">正在读取账号凭据状态…</div>
          ) : !refreshInfo.accounts.length ? (
            <div className="py-3 text-sm text-zinc-400">账号库为空。先在「账号管理」里导入账号。</div>
          ) : (
            <ul className="-mx-4 divide-y divide-zinc-100">
              {refreshInfo.accounts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-xs">
                  <span className="font-medium text-zinc-700">{a.name}</span>
                  <Badge color={a.dead ? 'red' : a.due ? 'amber' : 'gray'}>
                    {REFRESH_REASON_TEXT[a.reason] || a.reason}
                  </Badge>
                  {/* 服务端验活结论：本地有效期不算数，这里才是官方真实态度 */}
                  <span
                    title={
                      a.verify
                        ? a.verify.valid
                          ? `服务端于 ${fmtDateTime(a.verify.at)} 确认凭据有效`
                          : `服务端于 ${fmtDateTime(a.verify.at)} 拒绝该凭据${a.verify.message ? `：${a.verify.message}` : ''}`
                        : '尚未验活：每 6 小时自动巡检一次'
                    }
                  >
                    <Badge
                      color={a.verify ? (a.verify.valid ? 'green' : a.verify.unauthorized ? 'red' : 'amber') : 'gray'}
                    >
                      {a.verify
                        ? a.verify.valid
                          ? '已验活·有效'
                          : a.verify.unauthorized
                            ? '已验活·失效'
                            : '验活失败'
                        : '未验活'}
                    </Badge>
                  </span>
                  <span className="ml-auto tabular-nums text-zinc-400">
                    access {fmtHours(a.accessHours)} · refresh {fmtHours(a.refreshHours)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {refreshInfo?.lastRun && (
            <div className="mt-3 text-[11px] text-zinc-400">
              最近一次自动巡检：{fmtDateTime(refreshInfo.lastRun.at)}，刷新 {refreshInfo.lastRun.refreshed} 个账号。
            </div>
          )}
        </Card>
      </PageSection>

      {/* 免费模型平台可见性 */}
      <PageSection
        icon={<IconLayers />}
        title="免费模型平台"
        desc="默认只列出能正常接入的平台"
        count={restrictedPlatforms.length ? `默认收起 ${restrictedPlatforms.length} 个` : undefined}
      >
        <Card className="p-5">
          <Row
            label="显示全部平台"
            desc="开启后，免费模型页会把因地区限制、或平台自身禁止外部接入而默认收起的平台一并列出，可自行尝试接入"
          >
            <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-zinc-500">
              <input
                type="checkbox"
                checked={!!settings?.unlockAllPlatforms}
                onChange={(e) =>
                  toggleBoolSetting('unlockAllPlatforms', e.target.checked, {
                    on: '已开放全部平台：这些平台大概率仍会被限制，接不上属于预期结果',
                    off: '已恢复默认：只显示可正常接入的平台',
                  })
                }
                className="rounded accent-indigo-600"
              />
              {settings?.unlockAllPlatforms ? '已开启' : '已关闭'}
            </label>
          </Row>

          {restrictedPlatforms.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-zinc-100 px-4 pt-3 text-xs text-zinc-400">
              <span>受限制的平台：</span>
              {restrictedPlatforms.map((p) => (
                <span key={p.id} className="inline-flex items-center gap-1">
                  <Badge color="gray">{p.name}</Badge>
                  <span className="text-[11px] text-zinc-300">
                    {p.restriction === 'region' ? '地区受限' : '平台禁止外部接入'}
                  </span>
                </span>
              ))}
            </div>
          )}

          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-700">
            <span className="font-medium">风险提示：</span>
            上面这些平台按地区或自身策略限制了外部调用。即使 key 能创建成功，从这里接入后也可能出现
            <b>请求被拒、频繁限流，甚至账号被风控或封禁</b>
            。默认收起正是因为「接进去大概率也用不了」；是否接入请自行判断并承担风险，也请先确认你了解该平台的服务条款。
          </div>
        </Card>
      </PageSection>

      {/* 网络代理 */}
      <PageSection icon={<IconSliders />} title="网络代理" desc="访问 OpenRouter 等海外平台时使用">
        <Card className="p-5">
          <div className="text-xs text-zinc-400 mb-3 leading-relaxed">
            OpenRouter 等海外平台在国内网络下可能无法直连。工具的出站请求默认不走系统代理，此处的代理地址用于访问这些平台；留空时自动探测环境变量（
            <span className="font-mono">HTTPS_PROXY</span>）与 Windows 系统代理，均未命中则直连。
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={proxyInput}
              onChange={(e) => setProxyInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveProxy(proxyInput)}
              placeholder="例如 http://127.0.0.1:7890"
              className="flex-1 min-w-56 h-9 px-3 rounded-xl border border-zinc-200 text-sm font-mono outline-none focus:border-indigo-400"
            />
            <Button variant="primary" loading={savingProxy} onClick={() => saveProxy(proxyInput)}>
              保存
            </Button>
          </div>
          <div className="text-xs text-zinc-400 mt-2.5">
            当前出站状态：
            {settings ? (
              settings.effectiveProxy ? (
                <span className="text-emerald-600 font-mono">走代理 {settings.effectiveProxy}</span>
              ) : (
                <span className="text-amber-600">直连（未配置代理，需 VPN 的平台将无法访问）</span>
              )
            ) : (
              '…'
            )}
          </div>
        </Card>
      </PageSection>

      {/* 通知历史 */}
      <PageSection
        icon={<IconClock />}
        title="通知历史"
        count={notifications.length ? `${notifications.length} 条` : undefined}
        desc={`保留最近 ${NOTIFICATION_MAX} 条应用内提示`}
        actions={
          <>
            <Button size="sm" variant="subtle" onClick={loadLocalLogs}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新
            </Button>
            <Button
              size="sm"
              variant="subtle"
              disabled={!notifications.length}
              onClick={() => {
                clearNotifications();
                setNotifications([]);
                toast('ok', '通知历史已清空');
              }}
            >
              <IconTrash className="w-3.5 h-3.5" />
              清空
            </Button>
          </>
        }
      >
        <Card className="p-5">
          {notifications.length === 0 ? (
            <div className="text-sm text-zinc-400 py-3">还没有记录到任何提示。</div>
          ) : (
            <ul className="max-h-72 overflow-y-auto divide-y divide-zinc-50 rounded-xl border border-zinc-100">
              {notifications.map((n, i) => (
                <li key={`${n.at}-${i}`} className="px-3 py-2">
                  <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        n.type === 'ok' ? 'bg-emerald-500' : n.type === 'err' ? 'bg-red-500' : 'bg-zinc-400'
                      }`}
                    />
                    <span>{n.type === 'ok' ? '成功' : n.type === 'err' ? '错误' : '提示'}</span>
                    <span>·</span>
                    <span className="tabular-nums">{fmtDateTime(n.at)}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-600 leading-5 break-words">{n.text}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageSection>

      {/* 界面错误日志 */}
      <PageSection
        icon={<IconWarning />}
        title="界面错误日志"
        count={errors.length ? `${errors.length} 条` : undefined}
        desc={`捕获界面异常与 Promise 拒绝，保留最近 ${ERROR_MAX} 条`}
        actions={
          <>
            <Button size="sm" variant="subtle" onClick={loadLocalLogs}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新
            </Button>
            <Button size="sm" variant="subtle" disabled={!errors.length} onClick={copyErrors}>
              <IconCopy className="w-3.5 h-3.5" />
              复制
            </Button>
            <Button
              size="sm"
              variant="subtle"
              disabled={!errors.length}
              onClick={() => {
                clearErrors();
                setErrors([]);
                toast('ok', '错误日志已清空');
              }}
            >
              <IconTrash className="w-3.5 h-3.5" />
              清空
            </Button>
          </>
        }
      >
        <Card className="p-5">
          <div className="text-xs text-zinc-400 mb-3 leading-relaxed">
            界面崩溃与未捕获的错误会记录在这里，反馈问题时可直接复制贴出；只存本机，不含任何 Key 或账号凭据。
          </div>
          {errors.length === 0 ? (
            <div className="text-sm text-emerald-600 py-3">运行正常，未捕获到界面错误。</div>
          ) : (
            <ul className="max-h-72 overflow-y-auto divide-y divide-zinc-50 rounded-xl border border-zinc-100">
              {errors.map((e, i) => (
                <li key={`${e.at}-${i}`} className="px-3 py-2">
                  <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                    <Badge color="red">{e.kind === 'rejection' ? 'Promise' : '异常'}</Badge>
                    <span className="tabular-nums">{fmtDateTime(e.at)}</span>
                    {e.source && <span className="font-mono break-all">{e.source}</span>}
                  </div>
                  <div className="mt-1 text-xs text-zinc-700 leading-5 break-words">{e.message}</div>
                  {e.detail && (
                    <pre className="mt-1 max-h-32 overflow-auto rounded-lg bg-zinc-50 p-2 text-[10px] leading-4 text-zinc-500 whitespace-pre-wrap break-all">
                      {e.detail}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageSection>

      {/* 关于 */}
      <PageSection icon={<IconShield />} title="关于 workbuddy控制台">
        <Card className="p-5 text-xs text-zinc-400 leading-relaxed space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="font-medium text-zinc-600 text-sm">WorkBuddy 一体化管理工具</div>
            {/* 版本号取自服务端 package.json，前端不再硬编码（发版忘了改这里就再也对不上了） */}
            <Badge color="gray">{updateInfo ? `v${updateInfo.current}` : '版本读取中'}</Badge>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-2.5">
            {updateInfo?.hasUpdate ? (
              <>
                <Badge color="green">发现新版本 v{updateInfo.latest}</Badge>
                {/* 远端给了热更新包 → 点一下就地更新并重启；没有才让用户去下载 .fpk */}
                {updateInfo.canHotUpdate ? (
                  <Button size="sm" variant="primary" onClick={runHotUpdate} loading={hotUpdating}>
                    {!hotUpdating && <IconRefresh className="w-3.5 h-3.5" />}
                    一键更新并重启
                  </Button>
                ) : (
                  <a
                    href={updateInfo.downloadUrl || updateInfo.releaseUrl || '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-7 items-center gap-1 rounded-xl border border-indigo-300 px-2.5 text-[11px] font-medium text-indigo-600 transition-colors hover:bg-indigo-50"
                  >
                    <IconDownload className="w-3.5 h-3.5" />
                    下载安装包
                  </a>
                )}
              </>
            ) : (
              <Badge color="gray">{updateInfo?.error ? '版本状态未知' : '已是最新版本'}</Badge>
            )}
            <Button
              size="sm"
              onClick={() => loadUpdateInfo(true)}
              loading={checkingUpdate}
              disabled={hotUpdating}
            >
              {!checkingUpdate && <IconRefresh className="w-3.5 h-3.5" />}
              检查更新
            </Button>
            <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!!settings?.autoCheckUpdate}
                onChange={(e) =>
                  toggleBoolSetting('autoCheckUpdate', e.target.checked, {
                    on: '已开启自动检查更新',
                    off: '已关闭自动检查更新（仍可手动点「检查更新」）',
                  })
                }
                className="accent-indigo-600 rounded"
              />
              启动时自动检查
            </label>
          </div>

          {hotUpdateMsg && (
            <div className="text-indigo-600 flex items-center gap-1.5">
              <Spinner className="w-3.5 h-3.5" />
              {hotUpdateMsg}
            </div>
          )}
          {updateInfo?.hasUpdate && updateInfo.canHotUpdate && !hotUpdating && (
            <div className="text-zinc-400">
              一键更新会自动下载新版本、替换程序文件并重启服务，无需下载 .fpk 或卸载重装；
              旧版本会自动备份到数据盘（保留最近 3 份）。
            </div>
          )}
          {updateInfo?.error && <div className="text-amber-600">{updateInfo.error}</div>}
          {!!updateInfo?.checkedAt && !updateInfo.error && (
            <div className="text-zinc-300">
              上次检查：{fmtDateTime(updateInfo.checkedAt)}
              {updateInfo.cached ? '（本地缓存，6 小时内不重复请求）' : ''}
            </div>
          )}
          <div>
            主要能力：账号管理（扫码登录 / 切换 / 备份恢复）· Token 统计 · 积分统计 ·
            免费模型广场（免费模型 / 平台额度 / API Keys）·
            反向代理（让其他 agent 按 OpenAI / Anthropic / Responses / Gemini 四种协议调用 WorkBuddy 的积分与模型）。
          </div>
          <div>
            目标应用：<span className="text-zinc-500">WorkBuddy</span>（数据目录 {settings?.detected?.dir || '~/.workbuddy'}）。
          </div>
          <div>
            当前可用平台：OpenRouter、Agnes AI、硅基流动、魔搭；地区受限平台（Groq、Google AI Studio、NVIDIA、GitHub Models、OpenCode Zen）仅在免费模型展示，不可浏览与载入。
          </div>
          <div className="flex items-start gap-1.5">
            <IconShield className="w-3.5 h-3.5 mt-px shrink-0 text-emerald-500" />
            <span>隐私：API Key、账号凭据与统计数据均只保存在本机，不经过任何第三方服务器；界面访问仅限 127.0.0.1。</span>
          </div>
          <div className="text-zinc-300">备份与账号库与 workbuddy-switch 共用 ~/.wb-switch，可同时安装、随时切换。</div>
        </Card>
      </PageSection>
    </div>
  );
}
