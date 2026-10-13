import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconArrowDown,
  IconCheck,
  IconClock,
  IconCopy,
  IconEdit,
  IconExternalLink,
  IconInfo,
  IconPower,
  IconQrCode,
  IconRefresh,
  IconSparkles,
  IconSwitch,
  IconTrash,
  IconUser,
  IconUsers,
  IconWarning,
  Modal,
  Hint,
  SectionHeader,
  Segmented,
  Skeleton,
  Spinner,
  useConfirm,
  useToast,
} from '../components/ui';
import { del, get, patch, post, TIMEOUT } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import type {
  AccountBalancesResponse,
  AccountInfo,
  AccountsResponse,
  CreditBalance,
  CreditPackage,
  LoadedInfo,
  OAuthPollResult,
  OAuthStartResult,
  VariantInfo,
} from '../lib/types';

/** 按 uid 生成稳定的头像色，同一账号每次渲染颜色一致 */
function avatarTone(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const tones = [
    'from-indigo-500 to-violet-600',
    'from-emerald-500 to-teal-600',
    'from-amber-500 to-orange-600',
    'from-sky-500 to-blue-600',
    'from-rose-500 to-pink-600',
    'from-fuchsia-500 to-purple-600',
  ];
  return tones[h % tones.length];
}

/** 积分数额：最多两位小数，千分位 */
function fmtCredits(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(v);
}

/** 积分包到期时刻：10/13 10:31；长期有效不带时刻 */
function fmtPkgExpiry(ts: number | null | undefined): string {
  if (!ts) return '长期有效';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '长期有效';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${hh}:${mm}`;
}

/** 余额更新时刻：只到分 */
function fmtClock(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function Avatar({ name, seed, size = 'md' }: { name: string; seed: string; size?: 'md' | 'lg' }) {
  const cls = size === 'lg' ? 'w-12 h-12 text-base' : 'w-12 h-12 text-base';
  return (
    <div
      className={`${cls} rounded-full bg-gradient-to-br ${avatarTone(seed)} text-white flex items-center justify-center font-semibold shrink-0 ring-4 ring-white/70 shadow-sm`}
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

/** 还有剩余的积分包，按到期时间升序 */
function usablePackages(balance: CreditBalance | null | undefined): CreditPackage[] {
  return (balance?.packages || [])
    .filter((p) => p.remaining > 0 && !p.expired)
    .slice()
    .sort((a, b) => {
      const ea = a.expireAt ?? Number.POSITIVE_INFINITY;
      const eb = b.expireAt ?? Number.POSITIVE_INFINITY;
      return ea === eb ? 0 : ea < eb ? -1 : 1;
    });
}

/**
 * 单条积分包：数额徽标 + 名称 + 到期时刻 + 细进度条。
 *
 * `pkg` 缺省时渲染**占位行**——与真实行完全同构（同一套 grid 与间距），
 * 因此两者等高，卡片不会因为积分包数量不同而参差不齐。
 */
function CreditPackageRow({ pkg }: { pkg?: CreditPackage }) {
  if (!pkg) {
    return (
      <div className="min-w-0" aria-hidden="true">
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 text-xs">
          <span className="invisible rounded-lg bg-zinc-100 px-2 py-1">0</span>
          <span className="invisible truncate">占位</span>
          <span className="invisible whitespace-nowrap">占位</span>
        </div>
        <div className="mt-1.5 h-1 rounded-full" />
      </div>
    );
  }

  const ratio = pkg.total > 0 ? Math.min(100, Math.max(0, (pkg.remaining / pkg.total) * 100)) : 0;
  const tone = pkg.expired ? 'bg-red-400' : pkg.expiringSoon ? 'bg-amber-500' : 'bg-indigo-500';
  const expiryTone = pkg.expired ? 'text-red-500' : pkg.expiringSoon ? 'text-amber-600' : 'text-zinc-400';
  const title = `${pkg.name} · 剩余 ${fmtCredits(pkg.remaining)} / ${fmtCredits(pkg.total)}${
    pkg.expireAt ? ` · ${fmtPkgExpiry(pkg.expireAt)} 到期` : ' · 长期有效'
  }`;

  return (
    <div className="min-w-0" title={title}>
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 text-xs">
        <span className="rounded-lg bg-zinc-100 px-2 py-1 font-medium tabular-nums text-zinc-700">
          {fmtCredits(pkg.remaining)}
        </span>
        <span className="truncate text-zinc-500">{pkg.name}</span>
        <span className={`whitespace-nowrap tabular-nums ${expiryTone}`}>{fmtPkgExpiry(pkg.expireAt)}</span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-100">
        <div className={`h-full rounded-full transition-all duration-500 ${tone}`} style={{ width: `${ratio}%` }} />
      </div>
    </div>
  );
}

/** 账号卡片：身份 + 积分余额 + 近期到期 + 操作条 */
function AccountCard({
  account,
  isCurrent,
  busy,
  balance,
  balanceLoading,
  onSwitch,
  onRename,
  onDelete,
  onShowPackages,
}: {
  account: AccountInfo;
  isCurrent: boolean;
  busy: boolean;
  balance: CreditBalance | null;
  balanceLoading: boolean;
  onSwitch: () => void;
  onRename: () => void;
  onDelete: () => void;
  onShowPackages: () => void;
}) {
  // 凭据状态三态：可切换 / 已过期 / 加密信封（无法作为可切换凭据）
  const credState = !account.hasPlainToken
    ? account.hasEnvelope
      ? { color: 'amber', text: '加密凭据' }
      : { color: 'red', text: '无可用凭据' }
    : account.expired
      ? { color: 'red', text: '凭据已过期' }
      : { color: 'green', text: '凭据有效' };

  const pkgs = usablePackages(balance).slice(0, 2);
  const pkgTotal = usablePackages(balance).length;

  return (
    <article
      className={`flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-white shadow-[0_1px_2px_rgba(15,23,42,.025),0_10px_28px_rgba(15,23,42,.035)] transition-shadow hover:shadow-[0_2px_4px_rgba(15,23,42,.04),0_14px_34px_rgba(15,23,42,.055)] ${
        isCurrent ? 'border-emerald-200' : 'border-zinc-200'
      }`}
    >
      {/* 卡头：染色随「是否当前登录态」变化，右下角一枚柔光斑 */}
      <header className={`relative border-b px-5 py-4 ${isCurrent ? 'bg-emerald-50/50' : 'bg-zinc-50/60'}`}>
        <div
          className={`pointer-events-none absolute -right-10 -top-16 size-24 rounded-full blur-2xl ${
            isCurrent ? 'bg-emerald-300/35' : 'bg-zinc-300/40'
          }`}
        />
        <div className="relative flex items-center gap-3">
          <Avatar name={account.name} seed={account.uid || account.id} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="truncate text-sm font-semibold leading-5 text-zinc-900" title={account.name}>
                {account.name}
              </h3>
              {isCurrent && (
                <Badge color="green" dot>
                  使用中
                </Badge>
              )}
            </div>
            <p className="mt-0.5 truncate font-mono text-xs leading-5 text-zinc-400" title={account.uid}>
              UID {account.uid}
            </p>
            {/* 备注单独显示一行：即使展示名被「手机号/邮箱」占用，改完备注也能立刻看到 */}
            {account.note && (
              <p className="mt-1 truncate text-xs leading-5 text-zinc-500" title={`备注：${account.note}`}>
                <IconEdit className="mr-1 inline h-3 w-3 -mt-0.5 text-zinc-300" />
                备注：{account.note}
              </p>
            )}
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge color="gray">{account.variantLabel}</Badge>
              <Badge color={credState.color}>{credState.text}</Badge>
            </div>
          </div>
        </div>
      </header>

      <section className="flex min-w-0 flex-1 flex-col px-5 pb-5 pt-4">
        {balanceLoading ? (
          <div className="flex items-center gap-2 py-3 text-sm text-zinc-400">
            <Spinner className="w-4 h-4" />
            积分查询中…
          </div>
        ) : !balance ? (
          <div className="flex min-w-0 items-center gap-2 py-3 text-sm text-zinc-400">
            <IconInfo className="w-4 h-4 shrink-0" />
            <span className="min-w-0 truncate" title={account.hasPlainToken ? '余额查询失败' : '该账号无可用凭据，无法查询余额'}>
              {account.hasPlainToken ? '余额暂不可用' : '无可用凭据，无法查询余额'}
            </span>
          </div>
        ) : (
          <>
            <div className="flex items-baseline gap-x-3 gap-y-1">
              <span className="flex items-center gap-1.5">
                <IconSparkles className="w-4 h-4 shrink-0 text-zinc-400" />
                <strong className="text-[22px] font-semibold leading-none tracking-[-0.025em] tabular-nums text-zinc-900">
                  {fmtCredits(balance.remaining)}
                </strong>
              </span>
              <span className="text-xs text-zinc-400">{pkgTotal} 个积分包</span>
              <div
                className="ml-auto flex items-center gap-1.5 text-xs text-zinc-400"
                title={`共 ${fmtCredits(balance.total)}，已用 ${fmtCredits(balance.used)}`}
              >
                <IconClock className="w-3.5 h-3.5 shrink-0" />
                <span className="whitespace-nowrap tabular-nums">
                  {balance.updatedAt ? `${fmtClock(balance.updatedAt)} 更新` : '—'}
                </span>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-zinc-400">近期到期</span>
              {pkgTotal > 2 && (
                <button
                  type="button"
                  onClick={onShowPackages}
                  className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-[11px] font-medium text-indigo-600 transition-colors hover:text-indigo-500"
                >
                  查看全部积分包
                  <IconArrowDown className="w-3 h-3 -rotate-90" />
                </button>
              )}
            </div>

            <div className="mt-4 space-y-2.5">
              {pkgTotal === 0 ? (
                <div className="py-1 text-[11px] text-zinc-400">暂无可用积分</div>
              ) : (
                [0, 1].map((i) => <CreditPackageRow key={i} pkg={pkgs[i]} />)
              )}
            </div>
          </>
        )}
      </section>

      <footer className="flex flex-wrap items-center gap-2 border-t border-zinc-100 px-5 py-2.5">
        <Button
          variant={isCurrent ? 'subtle' : 'primary'}
          size="sm"
          className="h-7 rounded-full px-2.5 pr-3.5 text-xs"
          disabled={isCurrent || busy || !account.hasPlainToken}
          onClick={onSwitch}
          title={account.hasPlainToken ? '设为 WorkBuddy 当前登录账号' : '该账号没有可用的明文凭据，无法切换'}
        >
          {isCurrent ? <IconCheck className="w-3.5 h-3.5" /> : <IconSwitch className="w-3.5 h-3.5" />}
          {isCurrent ? '使用中' : '设为当前'}
        </Button>
        <Button size="sm" className="h-7 rounded-full px-2.5 pr-3.5 text-xs" onClick={onRename}>
          <IconEdit className="w-3.5 h-3.5" />
          备注
        </Button>
        <Button
          size="sm"
          variant="danger"
          className="ml-auto h-7 rounded-full px-2.5 text-xs"
          onClick={onDelete}
          disabled={isCurrent || busy}
          title="从账号库删除"
        >
          <IconTrash className="w-3.5 h-3.5" />
        </Button>
      </footer>
    </article>
  );
}

/** 备注编辑弹窗 */
function RenameDialog({
  account,
  onClose,
  onSaved,
}: {
  account: AccountInfo | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [displayField, setDisplayField] = useState<'auto' | 'note' | 'phone'>('auto');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (account) {
      setNote(account.note || '');
      setDisplayField((account.displayField as 'auto' | 'note' | 'phone') || 'auto');
    }
  }, [account]);

  if (!account) return null;

  const save = async () => {
    setSaving(true);
    try {
      await patch(`/api/accounts/${account.id}`, { note, displayField });
      toast('ok', '已保存');
      onSaved();
      onClose();
    } catch (e: any) {
      toast('err', e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!account}
      onClose={onClose}
      title={`编辑「${account.name}」`}
      subtitle="仅修改本地备注，不触碰任何凭据"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-zinc-600 mb-1.5">备注</label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：主号 / 备用号 / 公司账号"
            maxLength={40}
            className="w-full h-9 px-3 rounded-xl border border-zinc-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-600 mb-1.5">列表展示名来源</label>
          <div className="space-y-1.5">
            {(
              [
                { v: 'auto', label: '自动（备注 → 邮箱 → 昵称 → UID）' },
                { v: 'note', label: '优先显示备注' },
                { v: 'phone', label: '优先显示官方手机号' },
              ] as const
            ).map((o) => (
              <label key={o.v} className="flex items-center gap-2 text-sm text-zinc-600 cursor-pointer">
                <input type="radio" checked={displayField === o.v} onChange={() => setDisplayField(o.v)} className="accent-indigo-600" />
                {o.label}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-400 leading-relaxed">
            手机号从登录态中的 profile_raw 实时读取，不额外存储一份副本。
          </p>
        </div>
      </div>
    </Modal>
  );
}

/* ---------------- 未完成的扫码请求（跨弹窗/刷新续采） ---------------- */

const PENDING_OAUTH_KEY = 'wbhub.pendingOAuth';
/** 超过该时长视为失效（官方 state 有效期 10 分钟，留一点余量） */
const PENDING_OAUTH_TTL = 12 * 60_000;

interface PendingOAuth {
  loginId: string;
  variant: 'cn' | 'ai';
  at: number;
}

export function readPendingOAuth(): PendingOAuth | null {
  try {
    const raw = localStorage.getItem(PENDING_OAUTH_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p?.loginId || Date.now() - Number(p.at || 0) > PENDING_OAUTH_TTL) {
      localStorage.removeItem(PENDING_OAUTH_KEY);
      return null;
    }
    return p as PendingOAuth;
  } catch {
    return null;
  }
}

function savePendingOAuth(p: PendingOAuth) {
  try {
    localStorage.setItem(PENDING_OAUTH_KEY, JSON.stringify(p));
  } catch {
    /* 隐私模式：仅影响"关弹窗后续采"，不影响本次采集 */
  }
}

function clearPendingOAuth() {
  try {
    localStorage.removeItem(PENDING_OAUTH_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 把官方状态码翻译成一句人话，用于提示"卡在哪一步" */
function describeOfficialState(r: OAuthPollResult): string {
  const msg = String(r.message || '');
  if (r.code === 11217 || /login\s*ing/i.test(msg)) return '官方状态：等待手机端确认授权';
  if (r.code == null && !msg) return '官方状态：尚未收到授权结果';
  return `官方状态：${msg || `code ${r.code}`}`;
}

/**
 * 扫码添加账号：OAuth 设备码流程。
 *
 * 打开即向官方申请 state，二维码在**本地渲染**（qrcode 库，验证链接不外传），
 * 随后每 1.5 秒读一次授权结果；成功后自动采集入库并回调父组件刷新。
 * 档位决定链接域名与 platform 参数，服务端按发起档位校验，绝不混档。
 *
 * 重要：真正的轮询在**服务端**跑（手机授权是异步的，用户常关掉弹窗或刷新页面），
 * 前端只负责读状态；未完成的请求会记到 localStorage，重开页面后仍能续上结果。
 */
function ScanAddDialog({
  open,
  variant,
  variantLabel,
  onClose,
  onAdded,
}: {
  open: boolean;
  variant: 'cn' | 'ai';
  variantLabel: string;
  onClose: () => void;
  onAdded: (acc: AccountInfo) => void;
}) {
  const toast = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<'starting' | 'waiting' | 'done' | 'failed'>('starting');
  const [uri, setUri] = useState('');
  const [loginId, setLoginId] = useState('');
  const [deadline, setDeadline] = useState(0);
  const [remain, setRemain] = useState(0);
  const [result, setResult] = useState<AccountInfo | null>(null);
  const [error, setError] = useState('');
  const [qrFailed, setQrFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  /** 官方接口的原始状态文案，用于解释"卡在哪一步" */
  const [official, setOfficial] = useState('');
  /** 成功回调进 ref：父组件传的是内联函数，直接进 deps 会让轮询效应反复重启 */
  const onAddedRef = useRef(onAdded);
  onAddedRef.current = onAdded;

  const start = useCallback(async () => {
    setPhase('starting');
    setUri('');
    setLoginId('');
    setResult(null);
    setError('');
    setQrFailed(false);
    setOfficial('');
    try {
      const r = await post<OAuthStartResult>('/api/oauth/start', { variant });
      setUri(r.verificationUri);
      setLoginId(r.loginId);
      setDeadline(Date.now() + r.expiresIn * 1000);
      setPhase('waiting');
      // 记录本次请求：弹窗关掉/页面刷新后仍能续上采集结果
      savePendingOAuth({ loginId: r.loginId, variant, at: Date.now() });
    } catch (e: any) {
      setError(e?.message || '发起登录失败');
      setPhase('failed');
    }
  }, [variant]);

  /** 在系统浏览器打开授权页：官方页在浏览器里完成绑定，本页只负责等结果 */
  const openAuthPage = useCallback(() => {
    if (!uri) return;
    const w = window.open(uri, '_blank', 'noopener,noreferrer');
    if (!w) toast('info', '浏览器拦截了新窗口，请点下方链接手动打开，或复制链接到浏览器');
  }, [uri, toast]);

  // 打开弹窗即自动发起，省一次点击
  useEffect(() => {
    if (open) void start();
  }, [open, start]);

  // 有效期倒计时（官方 state 有效期 10 分钟）
  useEffect(() => {
    if (phase !== 'waiting') return;
    const tick = () => setRemain(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [phase, deadline]);

  // 二维码本地渲染：失败时降级为展示链接（不依赖任何第三方二维码服务）
  // deps 带 phase：canvas 在 waiting 态才挂载，仅依赖 uri 会在 canvas 就绪前空跑
  useEffect(() => {
    if (!uri || !canvasRef.current) return;
    let alive = true;
    QRCode.toCanvas(canvasRef.current, uri, {
      width: 208,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#18181b', light: '#ffffff' },
    })
      .then(() => {
        if (alive) setQrFailed(false);
      })
      .catch(() => {
        if (alive) setQrFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [uri, phase]);

  // 轮询授权结果：done=false 继续等，done+result 已入库，done+error 失败/超时
  // 服务端有常驻采集循环，这里只是"读状态"，关掉弹窗也不影响账号入库
  useEffect(() => {
    if (!loginId) return;
    let timer: number | undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await post<OAuthPollResult>('/api/oauth/status', { loginId });
        if (cancelled) return;
        if (r.done) {
          clearPendingOAuth();
          if (r.result) {
            setResult(r.result);
            setPhase('done');
            onAddedRef.current(r.result);
          } else {
            setError(r.error || '登录失败');
            setPhase('failed');
          }
          return;
        }
        // 未完成：把官方原始状态显示出来，用户能判断是"没扫"还是"官方还在处理"
        setOfficial(describeOfficialState(r));
        timer = window.setTimeout(poll, 1500);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || '轮询失败');
        setPhase('failed');
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loginId]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('err', '复制失败，请手动选中链接复制');
    }
  };

  // 过期判定只看 deadline：remain 初始为 0，若用它判断会在 waiting 首帧误判过期，
  // 导致 canvas 来不及挂载、二维码效果空跑（表现为二维码区域永远空白）
  const expired = phase === 'waiting' && deadline > 0 && Date.now() >= deadline;
  const mmss = `${String(Math.floor(remain / 60)).padStart(2, '0')}:${String(remain % 60).padStart(2, '0')}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="扫码添加账号"
      subtitle={`${variantLabel} · 授权成功后自动采集入库`}
      footer={
        phase === 'done' ? (
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>取消</Button>
            <Button variant="subtle" onClick={() => void start()} loading={phase === 'starting'}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新二维码
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3.5 text-sm">
        {phase === 'starting' && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-400">
            <Spinner className="w-4 h-4" />
            正在向官方申请登录凭证…
          </div>
        )}

        {phase === 'waiting' && uri && !expired && (
          <>
            {variant === 'ai' && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800 leading-relaxed">
                <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-amber-500" />
                <span>
                  若浏览器已登录 workbuddy.ai，授权页会直接跳到「登录成功」而不会绑定新账号。
                  请复制链接到<strong>无痕（隐私）窗口</strong>打开并完成登录。
                </span>
              </div>
            )}
            {/* 首选：浏览器里完成授权。官方页在浏览器里点「同意」才会绑定 state，
                手机扫码偶发不绑定的情况，走浏览器最稳；二维码保留给手机扫码用户。 */}
            <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 px-3.5 py-3 space-y-2">
              <div className="text-xs text-indigo-800 leading-relaxed">
                推荐在<strong>浏览器</strong>中完成授权：点下面的按钮打开官方登录页，登录并同意后本页会自动采集账号。
              </div>
              <Button variant="primary" className="w-full" onClick={openAuthPage}>
                <IconExternalLink className="w-4 h-4" />
                在浏览器中打开授权页
              </Button>
            </div>

            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-zinc-100" />
              <span className="text-[11px] text-zinc-400">或用手机扫码</span>
              <span className="h-px flex-1 bg-zinc-100" />
            </div>

            <div className="flex flex-col items-center gap-3">
              {qrFailed ? (
                <div className="text-xs text-zinc-400">二维码渲染失败，请直接打开上方按钮或下方链接完成授权</div>
              ) : (
                <canvas ref={canvasRef} className="rounded-xl border border-zinc-200" width={208} height={208} />
              )}
              <div className="flex items-center gap-1.5 text-xs text-zinc-400 tabular-nums">
                <IconClock className="w-3.5 h-3.5" />
                有效期剩余 {mmss}
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2">
              <a
                href={uri}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate font-mono text-[11px] text-indigo-600 hover:underline"
                title="在浏览器中打开验证链接"
              >
                {uri}
              </a>
              <Button size="sm" variant="ghost" onClick={copyLink} title="复制验证链接">
                {copied ? <IconCheck className="w-3.5 h-3.5" /> : <IconCopy className="w-3.5 h-3.5" />}
                {copied ? '已复制' : '复制'}
              </Button>
            </div>
            <p className="text-center text-xs text-zinc-400">
              {variant === 'ai' ? '正在等待 Web 登录授权…' : '正在等待授权，浏览器完成或手机扫码后会自动采集…'}
            </p>
            <p className="text-center text-[11px] text-zinc-300">
              {official || '已提交，正在等待官方返回授权结果'}
            </p>
            <Hint className="justify-center">
              授权由本机服务在后台等待并自动采集：中途关闭这个弹窗不会中断，重新打开「扫码添加账号」会继续等待上一次授权（约 12 分钟内有效）。
            </Hint>
          </>
        )}

        {phase === 'waiting' && expired && (
          <div className="space-y-3 py-4 text-center">
            <div className="text-sm text-zinc-500">二维码已过期（有效期 10 分钟）</div>
            <Button variant="primary" onClick={() => void start()}>
              <IconRefresh className="w-3.5 h-3.5" />
              重新获取
            </Button>
          </div>
        )}

        {phase === 'done' && result && (
          <div className="flex flex-col items-center gap-2.5 py-6">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
              <IconCheck className="w-5 h-5" />
            </div>
            <div className="text-sm text-zinc-700">
              已添加账号「<b className="text-zinc-900">{result.name}</b>」
            </div>
            <div className="text-xs text-zinc-400">已写入账号库，可在下方一键切换</div>
          </div>
        )}

        {phase === 'failed' && (
          <div className="space-y-3 py-2">
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700 leading-relaxed">
              <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-red-500" />
              <span>{error || '登录失败'}</span>
            </div>
            <div className="text-center">
              <Button variant="subtle" onClick={() => void start()}>
                <IconRefresh className="w-3.5 h-3.5" />
                重试
              </Button>
            </div>
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-zinc-400">
          扫码链接由官方接口实时生成，仅在本机渲染二维码；授权凭据直接写入本机账号库
          <span className="font-mono"> ~/.wb-switch/accounts.json</span>，不经过任何第三方服务器。
        </p>
      </div>
    </Modal>
  );
}

/** 全部积分包弹窗 */
function PackagesDialog({ account, balance, onClose }: { account: AccountInfo | null; balance: CreditBalance | null; onClose: () => void }) {
  if (!account) return null;
  const all = (balance?.packages || [])
    .slice()
    .sort((a, b) => {
      const ea = a.expireAt ?? Number.POSITIVE_INFINITY;
      const eb = b.expireAt ?? Number.POSITIVE_INFINITY;
      return ea === eb ? 0 : ea < eb ? -1 : 1;
    });

  return (
    <Modal
      open={!!account}
      onClose={onClose}
      title="全部积分包"
      subtitle={`${account.name} · 共 ${all.length} 个积分包`}
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      {all.length === 0 ? (
        <div className="py-6 text-center text-sm text-zinc-400">当前没有可展示的积分包。</div>
      ) : (
        <div className="max-h-[60vh] min-w-0 overflow-y-auto divide-y divide-zinc-100">
          {all.map((p, i) => {
            const ratio = p.total > 0 ? Math.min(100, Math.max(0, (p.remaining / p.total) * 100)) : 0;
            return (
              <div key={`${p.packageCode || 'pkg'}-${i}`} className="min-w-0 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-zinc-800">{p.name}</div>
                    <div className="mt-1 text-[11px] text-zinc-400">
                      {p.expired ? '已到期' : p.expireAt ? `到期 ${fmtDateTime(p.expireAt)}` : '长期有效'}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-xs">
                    <div className="font-medium tabular-nums text-zinc-700">
                      {fmtCredits(p.remaining)} / {fmtCredits(p.total)}
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-400">已用 {fmtCredits(p.used)}</div>
                  </div>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className={`h-full rounded-full ${p.expired ? 'bg-red-400/70' : p.expiringSoon ? 'bg-amber-500/80' : 'bg-indigo-500/75'}`}
                    style={{ width: `${ratio}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

export default function AccountsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [balances, setBalances] = useState<AccountBalancesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [editing, setEditing] = useState<AccountInfo | null>(null);
  const [pkgTarget, setPkgTarget] = useState<AccountInfo | null>(null);
  /** 扫码添加账号弹窗（OAuth 设备码流程） */
  const [scanOpen, setScanOpen] = useState(false);
  /** 档位筛选：与 workbuddy-switch 一致，两套登录态分开管理 */
  const [variant, setVariant] = useState<'cn' | 'ai'>('cn');
  /** WorkBuddy 进程是否在运行：运行时切换会被它改写回去，需要提前提醒 */
  const [wbRunning, setWbRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await get<AccountsResponse>('/api/accounts'));
    } catch (e: any) {
      toast('err', e?.message || '读取账号失败');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadBalances = useCallback(async (refresh = false) => {
    setBalanceLoading(true);
    try {
      setBalances(await get<AccountBalancesResponse>(`/api/accounts/credits${refresh ? '?refresh=1' : ''}`, { timeoutMs: TIMEOUT.quota }));
    } catch {
      /* 余额查询失败不阻塞账号列表，卡片上会显示"余额暂不可用" */
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    void loadBalances();
    const loadWb = () => get<LoadedInfo>('/api/workbuddy/status').then((i) => setWbRunning(!!i?.running)).catch(() => {});
    loadWb();
    const t = setInterval(loadWb, 30_000);
    return () => clearInterval(t);
  }, [load, loadBalances]);

  // 首次拿到数据后，档位默认跟着当前登录态走
  useEffect(() => {
    const v = data?.current?.variant;
    if (v === 'cn' || v === 'ai') setVariant(v);
  }, [data?.current?.variant]);

  /**
   * 续采：上次扫码没在弹窗里等到结果（关了弹窗 / 刷新了页面 / 去手机上操作太慢），
   * 这里继续读服务端状态，成功了就提示并刷新列表——否则会出现"手机上明明成功了，
   * 页面里却没有账号"这种最让人困惑的情况。
   */
  useEffect(() => {
    const pending = readPendingOAuth();
    if (!pending) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const r = await post<OAuthPollResult>('/api/oauth/status', { loginId: pending.loginId });
        if (stopped) return;
        if (!r.done) return;
        clearPendingOAuth();
        clearInterval(timer);
        if (r.result) {
          toast('ok', `已扫码添加「${r.result.name}」`);
          load();
          void loadBalances(true);
        } else if (r.error) {
          toast('err', `扫码登录未完成：${r.error}`);
        }
      } catch {
        /* 瞬时错误忽略，下个周期再试 */
      }
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doSwitch = async (account: AccountInfo) => {
    const ok = await confirm({
      title: '切换账号',
      message: (
        <>
          将把账号「<b>{account.name}</b>」写入 WorkBuddy 登录态文件。
          <div className="mt-2.5 space-y-2 text-xs text-zinc-500 leading-relaxed">
            <div className="flex items-start gap-1.5">
              <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-amber-500" />
              <span>
                <b className="text-amber-700">请先完全退出 WorkBuddy。</b>
                若 WorkBuddy 正在运行，它会在检测到登录态变化后用自己的会话把文件改写回去，导致切换不生效。
              </span>
            </div>
            <div>切换前会自动备份当前登录态（~/.wb-switch/backups/），写入后需重新打开 WorkBuddy。</div>
          </div>
        </>
      ),
      confirmText: '已退出，切换',
    });
    if (!ok) return;
    setBusyId(account.id);
    try {
      const r = await post<{ backupPath: string | null }>('/api/accounts/switch', { id: account.id });
      toast('ok', `已切换到「${account.name}」，请重新打开 WorkBuddy`);
      if (r?.backupPath) console.info('登录态备份：', r.backupPath);
      load();
    } catch (e: any) {
      toast('err', e?.message || '切换失败');
    } finally {
      setBusyId(null);
    }
  };

  const doDelete = async (account: AccountInfo) => {
    const ok = await confirm({
      title: '删除账号',
      message: (
        <>
          确定从账号库删除「<b>{account.name}</b>」？该操作只删除本工具保存的记录，
          <b>不会影响 WorkBuddy 当前的登录态</b>，也无法撤销。
        </>
      ),
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setBusyId(account.id);
    try {
      await del(`/api/accounts/${account.id}`);
      toast('ok', '已删除');
      load();
    } catch (e: any) {
      toast('err', e?.message || '删除失败');
    } finally {
      setBusyId(null);
    }
  };

  const doImport = async (v: VariantInfo) => {
    setImporting(v.id);
    try {
      const acc = await post<AccountInfo>('/api/accounts/import', { variant: v.id });
      toast('ok', `已导入「${acc.name}」`);
      load();
      void loadBalances(true);
    } catch (e: any) {
      toast('err', e?.message || '导入失败');
    } finally {
      setImporting(null);
    }
  };

  const balanceOf = useCallback(
    (id: string): CreditBalance | null => balances?.accounts?.find((r) => r.accountId === id)?.balance ?? null,
    [balances]
  );

  const visibleAccounts = useMemo(
    () => (data?.accounts || []).filter((a) => a.variant === variant),
    [data, variant]
  );
  const activeVariant = (data?.variants || []).find((v) => v.id === variant);

  const stats = useMemo(() => {
    const list = data?.accounts || [];
    return {
      total: list.length,
      usable: list.filter((a) => a.hasPlainToken && !a.expired).length,
      needsAuth: list.filter((a) => !a.hasPlainToken || a.expired).length,
    };
  }, [data]);

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  const current = data?.current;
  const accounts = data?.accounts || [];

  return (
    <div className="space-y-5">
      {/* 页头：档位切换 + 运行状态（大标题由顶栏负责，这里不重复） */}
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={variant}
          onChange={setVariant}
          options={[
            { value: 'cn', label: '国内版' },
            { value: 'ai', label: '国际版' },
          ]}
        />
        <span className="text-xs text-zinc-400 leading-relaxed">
          两套登录态互相独立，账号库与 workbuddy-switch 共用同一份文件
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {wbRunning ? (
            <Badge color="green" dot>
              <IconPower className="w-3 h-3" />
              WorkBuddy 运行中
            </Badge>
          ) : (
            <Badge color="gray" dot>
              <IconPower className="w-3 h-3" />
              WorkBuddy 未运行
            </Badge>
          )}
        </div>
      </div>

      {/* 添加与迁移账号 */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50/80 px-5 py-5 shadow-[0_6px_20px_rgba(15,23,42,.025)]">
        <div className="pointer-events-none absolute -right-12 -top-20 size-44 rounded-full border-[28px] border-zinc-400/[0.06]" />
        <div className="relative flex flex-wrap items-center gap-x-5 gap-y-4">
          <div className="min-w-[200px] flex-1">
            <h2 className="text-sm font-semibold text-zinc-900">添加与迁移账号</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-500">
              扫码授权后自动采集账号入库；也可读取本机 WorkBuddy 登录态文件迁移已有账号，已存在的只更新凭据、保留本地备注
            </p>
            {activeVariant && (
              <p className="mt-1.5 truncate font-mono text-[11px] text-zinc-400" title={activeVariant.authFilePath}>
                {activeVariant.authFilePath}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              className="h-9 px-3.5"
              onClick={() => setScanOpen(true)}
              title={`打开官方${variant === 'ai' ? '国际版' : '国内版'}授权页，扫码/登录后自动采集账号入库`}
            >
              <IconQrCode className="w-3.5 h-3.5" />
              扫码添加账号
            </Button>
            <span className="hidden h-6 w-px bg-zinc-200 sm:block" />
            {(data?.variants || []).map((v) => (
              <Button
                key={v.id}
                variant="subtle"
                className="h-9 px-3.5"
                loading={importing === v.id}
                onClick={() => doImport(v)}
                title={`从 ${v.authFilePath} 导入当前登录的账号`}
              >
                <IconArrowDown className="w-3.5 h-3.5" />
                导入{v.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* 运行中提醒：WorkBuddy 会把登录态改写回去，这是切换不生效的主因 */}
      {wbRunning && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800 leading-relaxed">
          <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-amber-500" />
          <span>
            <b>WorkBuddy 正在运行。</b>此时切换账号会被它改写回原账号，请先完全退出 WorkBuddy 再切换。
          </span>
        </div>
      )}

      {/* 当前登录态 */}
      <Card className="p-4">
        <SectionHeader
          icon={<IconUsers />}
          title="当前登录态"
          desc="切换账号会重写 WorkBuddy 的登录态文件，操作前自动备份，失败自动回滚"
          actions={
            <Button
              size="sm"
              onClick={() => {
                load();
                void loadBalances(true);
              }}
            >
              <IconRefresh className="w-3.5 h-3.5" />
              刷新
            </Button>
          }
        />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {current?.exists && current.account ? (
            <>
              <Avatar name={current.account.name} seed={current.account.uid || current.account.id} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-zinc-900">{current.account.name}</span>
                  <Badge color="green" dot>
                    已登录
                  </Badge>
                  <Badge color="gray">{current.account.variantLabel}</Badge>
                </div>
                <div className="mt-1 text-xs text-zinc-400 font-mono truncate max-w-[520px]">{current.authFilePath}</div>
              </div>
            </>
          ) : (
            <>
              <div className="w-12 h-12 rounded-full bg-amber-50 border border-amber-200 text-amber-500 flex items-center justify-center shrink-0">
                <IconWarning className="w-5 h-5" />
              </div>
              <div>
                <div className="font-medium text-zinc-900">未检测到登录态</div>
                <div className="text-xs text-zinc-400 mt-0.5">
                  {current?.uid ? `登录态中的账号（${current.uid.slice(0, 8)}…）尚未导入到账号库` : 'WorkBuddy 登录态文件不存在或已损坏'}
                </div>
              </div>
            </>
          )}
        </div>
        {current?.warning && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs text-amber-800">
            <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-amber-500" />
            {current.warning}
          </div>
        )}
      </Card>

      {/* 账号列表 */}
      <section className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight text-zinc-900">
              {variant === 'ai' ? '国际版' : '国内版'}账号
            </h2>
            <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-zinc-200 bg-zinc-100 px-1.5 text-[11px] font-medium tabular-nums text-zinc-500">
              {visibleAccounts.length}
            </span>
            {stats.needsAuth > 0 && (
              <span className="text-xs text-zinc-400">
                全部 {stats.total} 个中 {stats.needsAuth} 个需要重新登录
              </span>
            )}
          </div>
          <span className="text-xs text-zinc-400">
            {balanceLoading ? '余额查询中…' : balances?.collectedAt ? `余额更新于 ${fmtClock(balances.collectedAt)}` : ''}
          </span>
        </div>

        {visibleAccounts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 px-4 py-16 text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-zinc-100 text-zinc-400">
              <IconUser className="w-5 h-5" />
            </div>
            <p className="text-sm text-zinc-500">暂无{variant === 'ai' ? '国际版' : '国内版'}账号。</p>
            <p className="mt-2 text-xs leading-5 text-zinc-400">
              先用 WorkBuddy 登录一个账号，再点上方「导入{variant === 'ai' ? '国际版' : '国内版'}」加入账号库，之后就能在这里一键切换。
            </p>
          </div>
        ) : (
          <div className="grid min-w-0 gap-5 grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))]">
            {visibleAccounts.map((a) => (
              <AccountCard
                key={a.id}
                account={a}
                isCurrent={current?.account?.id === a.id}
                busy={busyId === a.id}
                balance={balanceOf(a.id)}
                balanceLoading={balanceLoading && !balanceOf(a.id)}
                onSwitch={() => doSwitch(a)}
                onRename={() => setEditing(a)}
                onDelete={() => doDelete(a)}
                onShowPackages={() => setPkgTarget(a)}
              />
            ))}
          </div>
        )}
      </section>

      {/* 数据位置脚注：与顶栏副标题呼应，只补充具体路径，不重复导入入口 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-[11px] text-zinc-400">
        <span className="inline-flex items-center gap-1.5">
          <IconInfo className="w-3.5 h-3.5 shrink-0" />
          账号库 <span className="font-mono">~/.wb-switch/accounts.json</span> 与 workbuddy-switch 共用，两个工具可同时安装、随时切换
        </span>
        {(data?.variants || []).map((v) => (
          <span key={v.id} className="font-mono truncate" title={v.authFilePath}>
            {v.label}：{v.authFilePath}
          </span>
        ))}
      </div>

      <RenameDialog account={editing} onClose={() => setEditing(null)} onSaved={load} />
      <PackagesDialog account={pkgTarget} balance={pkgTarget ? balanceOf(pkgTarget.id) : null} onClose={() => setPkgTarget(null)} />
      <ScanAddDialog
        open={scanOpen}
        variant={variant}
        variantLabel={variant === 'ai' ? '国际版' : '国内版'}
        onClose={() => setScanOpen(false)}
        onAdded={(acc) => {
          toast('ok', `已扫码添加「${acc.name}」`);
          load();
          void loadBalances(true);
        }}
      />
    </div>
  );
}
