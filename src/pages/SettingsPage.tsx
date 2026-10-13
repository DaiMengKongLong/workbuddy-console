import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  IconChevronDown,
  IconClock,
  IconCopy,
  IconDatabase,
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
import { del, get, post, put } from '../lib/api';
import type {
  BackupEntry,
  BackupsResponse,
  CheckinAllResult,
  CheckinState,
  CheckinStatusResponse,
  DetectResult,
  LoadedInfo,
  PermissionCheck,
  PermissionResponse,
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
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${className}`}>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-zinc-700">{label}</div>
        {desc && <div className="mt-0.5 text-xs text-zinc-400 leading-relaxed">{desc}</div>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

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
  }, [loadSettings, loadStatus, loadBackups, loadLocalLogs, loadPerm, loadCheckin]);

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
      const r = await put<{ workbuddyDir: string; detected: SettingsInfo['detected'] }>('/api/settings', { workbuddyDir: dir });
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
      const r = await put<{ ok: boolean; proxyUrl: string; effectiveProxy: string | null }>('/api/settings', { proxyUrl: url });
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
      const r = await put<{ autoCheckin: boolean }>('/api/settings', { autoCheckin: next });
      setSettings((p) => (p ? { ...p, autoCheckin: r.autoCheckin } : p));
      toast('ok', r.autoCheckin ? '已开启自动签到：服务端每小时巡检一次，发现未签到会自动补签' : '已关闭自动签到');
    } catch (e: any) {
      setSettings((p) => (p ? { ...p, autoCheckin: prev } : p));
      toast('err', e?.message || '保存失败');
    }
  };

  const runCheckin = async (accountId?: string) => {
    setCheckingIn(true);
    try {
      if (accountId) {
        const r = await post<{ ok: boolean; action: string; message: string }>('/api/workbuddy/checkin', { accountId });
        toast(r.ok ? 'ok' : 'err', r.message);
      } else {
        const r = await post<CheckinAllResult>('/api/workbuddy/checkin', { onlyPending: true });
        const { summary } = r;
        const parts = [`新签到 ${summary.checked} 个`];
        if (summary.already) parts.push(`已签到 ${summary.already} 个`);
        if (summary.skipped) parts.push(`跳过 ${summary.skipped} 个`);
        if (summary.failed) parts.push(`失败 ${summary.failed} 个`);
        toast(summary.failed ? 'err' : 'ok', `签到完成：${parts.join('，')}`);
      }
      await loadCheckin(true);
    } catch (e: any) {
      toast('err', e?.message || '签到失败');
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
      {/* WorkBuddy 运行状态 */}
      <PageSection
        icon={<IconPower />}
        title="WorkBuddy 运行状态"
        desc="模型配置是否已生效、进程是否可以重启"
        actions={
          <Button size="sm" variant="subtle" loading={detecting} onClick={() => redetect(false)}>
            <IconRefresh className="w-3.5 h-3.5" />
            重新检测
          </Button>
        }
      >
        <Card className="p-5">
          {!status ? (
            <div className="py-6 flex justify-center">
              <Spinner />
            </div>
          ) : (
            <>
              <div
                className={`rounded-xl border px-3.5 py-3 ${
                  status.pendingRestart ? 'border-amber-200 bg-amber-50/70' : status.running ? 'border-emerald-200 bg-emerald-50/60' : 'border-zinc-200 bg-zinc-50/70'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge color={status.running ? 'green' : status.detectError ? 'amber' : 'gray'} dot>
                    {status.running ? '运行中' : status.detectError ? '状态未知' : '未运行'}
                  </Badge>
                  {status.pendingRestart && <Badge color="amber">配置待重启生效</Badge>}
                  {status.processCount ? <span className="text-xs text-zinc-400">{status.processCount} 个进程</span> : null}
                  {status.detectMethod && <span className="text-xs text-zinc-300">探测方式：{status.detectMethod}</span>}
                </div>
                <div className="mt-2 space-y-0.5 text-xs text-zinc-500 leading-relaxed">
                  {status.exePath && (
                    <div className="break-all">
                      可执行文件：<span className="font-mono">{status.exePath}</span>
                    </div>
                  )}
                  {status.dir && (
                    <div className="break-all">
                      数据目录：<span className="font-mono">{status.dir}</span>
                    </div>
                  )}
                  {status.modelsJsonMtime ? <div>models.json 最后修改：{fmtDateTime(status.modelsJsonMtime)}</div> : null}
                  {status.detectError && <div className="text-amber-600">无法确认运行状态：{status.detectError}</div>}
                  {status.detectWarning && <div className="text-amber-600">{status.detectWarning}</div>}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button variant="subtle" loading={restarting} disabled={!status.running} onClick={restartWb} title={status.running ? '结束进程并重新启动' : '当前未检测到运行中的 WorkBuddy'}>
                  <IconPower className="w-4 h-4" />
                  重启 WorkBuddy
                </Button>
                <span className="text-xs text-zinc-400">
                  在 WorkBuddy 运行期间载入的模型需要重启才会生效；工具已自动备份登录态，重启不影响账号。
                </span>
              </div>
            </>
          )}
        </Card>
      </PageSection>

      {/* 每日签到 */}
      <PageSection
        icon={<IconClock />}
        title="每日签到"
        count={cnStates.length ? `${cnStates.filter((s) => s.todayCheckedIn).length}/${cnStates.length} 今日已签` : undefined}
        desc="国内版账号每日可领积分；自动巡检默认开启，可在下方关闭"
        actions={
          <>
            <Button size="sm" variant="subtle" loading={checkinLoading} onClick={() => loadCheckin(false)}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新状态
            </Button>
            <Button size="sm" variant="primary" loading={checkingIn} disabled={!cnStates.length} onClick={() => runCheckin()}>
              一键签到
            </Button>
          </>
        }
      >
        <Card className="p-5">
          <div className="divide-y divide-zinc-100 -mx-4 mb-3">
            <Row
              label={
                <span className="flex flex-wrap items-center gap-2">
                  自动签到
                  <Badge color={settings?.autoCheckin ? 'green' : 'gray'}>
                    {settings?.autoCheckin ? '已开启（默认）' : '已关闭'}
                  </Badge>
                </span>
              }
              desc={
                <>
                  <b className="text-zinc-600">默认为开启</b>
                  ，服务端每小时巡检一次（06:00–23:00），发现当日未签到会自动补签
                  （只对国内版账号生效；签到接口幂等，重复提交无副作用）。
                  巡检依赖管理台处于运行状态：桌面版关闭窗口后会驻留系统托盘，签到不会中断。
                  <br />
                  不需要自动签到可在此关闭；关闭后仍可随时点右上角「一键签到」或单账号「签到」手动领取。
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
                    <Button size="sm" variant="subtle" loading={checkingIn} disabled={!s.ok || s.todayCheckedIn} onClick={() => runCheckin(s.account.id)}>
                      签到
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!!checkin?.logs?.length && (
            <div className="mt-4">
              <div className="text-xs text-zinc-400 mb-1.5">最近签到记录</div>
              <div className="max-h-40 overflow-y-auto rounded-xl border border-zinc-100 divide-y divide-zinc-50">
                {checkin.logs.map((l, i) => (
                  <div key={`${l.ts}-${i}`} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
                    <span className="text-zinc-400 tabular-nums">{fmtDateTime(l.ts)}</span>
                    <span className="text-zinc-600 truncate max-w-40">{l.accountName}</span>
                    <span className={l.ok ? 'text-emerald-600' : 'text-red-500'}>{l.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </PageSection>

      {/* WorkBuddy 数据目录 */}
      <PageSection
        icon={<IconDatabase />}
        title="WorkBuddy 数据目录"
        desc="模型配置与 Token 统计的数据来源"
        actions={
          <Button size="sm" variant="subtle" loading={detecting} onClick={() => redetect(false)}>
            <IconRefresh className="w-3.5 h-3.5" />
            重新检测
          </Button>
        }
      >
        <Card className="p-5">
          {!settings ? (
            <div className="py-6 flex justify-center">
              <Spinner />
            </div>
          ) : (
            <>
              <div className={`rounded-xl border px-3.5 py-3 ${settings.detected.valid ? 'border-emerald-200 bg-emerald-50/60' : 'border-amber-200 bg-amber-50'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-zinc-800 break-all">{settings.detected.dir}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    {settings.detected.source === 'override' && <Badge color="blue">{settings.detected.sourceLabel}</Badge>}
                    {settings.detected.valid ? <Badge color="green">已检测到</Badge> : <Badge color="amber">未检测到</Badge>}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <MarkerBadge ok={settings.detected.markers.modelsJson} label="models.json" />
                  <MarkerBadge ok={settings.detected.markers.projects} label="会话日志" />
                  <MarkerBadge ok={settings.detected.markers.sessions} label="sessions" />
                  <MarkerBadge ok={settings.detected.markers.db} label="workbuddy.db" />
                </div>
                {!settings.detected.valid && (
                  <div className="mt-2 text-xs text-amber-600">
                    未找到 WorkBuddy 数据特征文件。请先安装并运行一次 WorkBuddy，或展开「手动指定」填写数据目录。
                  </div>
                )}
              </div>

              <div className="mt-3">
                <Button size="sm" variant="ghost" onClick={() => setShowManual((v) => !v)}>
                  <IconChevronDown className={`w-3.5 h-3.5 transition-transform ${showManual ? '' : '-rotate-90'}`} />
                  手动指定
                </Button>
              </div>

              {showManual && (
                <div className="mt-3 rounded-xl border border-zinc-200 p-3.5 animate-fade-in">
                  <div className="text-xs text-zinc-500 mb-2">手动指定数据目录（一般无需修改；留空保存即恢复自动检测）：</div>
                  <div className="flex items-center gap-2">
                    <input
                      value={wbDir}
                      onChange={(e) => setWbDir(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && saveDir(wbDir)}
                      placeholder="例如 C:\Users\你\.workbuddy"
                      className="flex-1 h-9 px-3 rounded-xl border border-zinc-200 text-sm font-mono outline-none focus:border-indigo-400"
                    />
                    <Button variant="primary" loading={savingDir} onClick={() => saveDir(wbDir)}>
                      保存
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      </PageSection>

      {/* 登录态与目录权限 */}
      <PageSection
        icon={<IconShield />}
        title="登录态与目录权限"
        desc="切换账号、载入模型都要写这些位置"
        actions={
          <>
            {perm && <Badge color={perm.ok ? 'green' : 'red'}>{perm.ok ? '全部正常' : '存在异常'}</Badge>}
            <Button size="sm" variant="subtle" loading={permLoading} onClick={() => loadPerm(false)}>
              <IconRefresh className="w-3.5 h-3.5" />
              重新自检
            </Button>
          </>
        }
      >
        <Card className="p-5 space-y-4">
          {!perm ? (
            <div className="py-6 flex justify-center">
              <Spinner />
            </div>
          ) : (
            permGroups.map(([group, items]) => (
              <div key={group}>
                <div className="text-xs font-medium text-zinc-400 mb-1.5">{group}</div>
                <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200/80">
                  {items.map((item) => (
                    <div key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
                      <Badge color={item.ok ? 'green' : 'red'}>{item.ok ? '✓' : '✗'}</Badge>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-zinc-700">{item.label}</div>
                        <div className="text-xs text-zinc-400 font-mono break-all">{item.path}</div>
                        <div className="text-xs text-zinc-400 mt-0.5">{item.hint}</div>
                        {!item.exists && <div className="text-xs text-zinc-400 mt-0.5">尚未创建，首次使用时自动生成。</div>}
                        {item.exists && !item.writable && <div className="text-xs text-red-500 mt-0.5">不可写：可能是只读或被其他程序占用。</div>}
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                        <span className={item.readable ? 'text-emerald-600' : 'text-red-500'}>读</span>
                        <span className="text-zinc-200">/</span>
                        <span className={item.writable ? 'text-emerald-600' : 'text-red-500'}>写</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </Card>
      </PageSection>

      {/* 登录态备份与恢复 */}
      <PageSection
        icon={<IconDatabase />}
        title="登录态备份与恢复"
        count={backups ? `${backups.backups.length} 份` : undefined}
        desc="每次切换账号前自动备份，可随时回退"
        actions={
          <>
            <Button size="sm" variant="subtle" onClick={loadBackups}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新
            </Button>
            <Button size="sm" variant="subtle" disabled={!backups?.backups.length} onClick={cleanBackups}>
              <IconTrash className="w-3.5 h-3.5" />
              清理旧备份
            </Button>
          </>
        }
      >
        <Card className="p-5">
          <div className="text-xs text-zinc-400 mb-3 break-all">备份目录：{backups?.dir || '…'}</div>
          {!backups ? (
            <div className="py-6 flex justify-center">
              <Spinner />
            </div>
          ) : backups.backups.length === 0 ? (
            <div className="text-sm text-zinc-400 py-3">还没有备份。切换账号时本工具会自动把切换前的登录态存到这里。</div>
          ) : (
            <div className="max-h-80 overflow-y-auto rounded-xl border border-zinc-200/80 divide-y divide-zinc-100">
              {backups.backups.map((b) => (
                <div key={b.name} className="flex flex-wrap items-center gap-2 px-3.5 py-2.5 hover:bg-zinc-50/70 transition-colors">
                  <div className="min-w-0">
                    <div className="text-sm text-zinc-700 tabular-nums">{new Date(b.createdAt).toLocaleString('zh-CN')}</div>
                    <div className="text-xs text-zinc-400">
                      {b.variantLabel} · {fmtSize(b.size)} · {fmtRelative(b.mtime)}
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button size="sm" variant="subtle" loading={backupBusy === b.name} onClick={() => restoreBackup(b)}>
                      恢复
                    </Button>
                    <Button size="sm" variant="danger" loading={backupBusy === b.name} onClick={() => removeBackup(b)}>
                      <IconTrash className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
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
      <PageSection icon={<IconShield />} title="关于 WorkBuddy 管理台">
        <Card className="p-5 text-xs text-zinc-400 leading-relaxed space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="font-medium text-zinc-600 text-sm">WorkBuddy 一体化管理工具</div>
            <Badge color="gray">v0.2.0</Badge>
          </div>
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
