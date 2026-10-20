import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconInbox,
  IconKey,
  IconRefresh,
  IconShield,
  IconTrash,
  PageSection,
  PlatformNote,
  useConfirm,
  useToast,
} from '../components/ui';
import { del, get, post } from '../lib/api';
import type { KeyInfo, KeysResponse, PlatformInfo, SettingsInfo } from '../lib/types';
import { fmtDate, fmtRelative, showsMask } from '../lib/format';

/**
 * 平台 API Keys 面板。
 *
 * 与「免费模型」「平台额度」同属平台底座能力，因此从设置页迁出、并入平台页，
 * 三者用同一组平台数据：Key 决定能载入哪些模型、也决定额度页能看到什么。
 */
/** baseUrl → 主机名（解析失败返回 null）；用于多节点平台的节点徽标 */
function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export default function PlatformKeysPanel({ active = true }: { active?: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [activeKeys, setActiveKeys] = useState<Record<string, string | null>>({});
  const [newPlatform, setNewPlatform] = useState('openrouter');
  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsInfo | null>(null);

  const platformMeta = platforms.find((p) => p.id === newPlatform);

  const loadKeys = useCallback(() => {
    get<KeysResponse>('/api/keys')
      .then((r) => {
        setKeys(r.keys);
        setActiveKeys(r.activeKeys || {});
      })
      .catch((e) => toast('err', e.message));
  }, [toast]);

  const loadSettings = useCallback(() => {
    get<SettingsInfo>('/api/settings')
      .then(setSettings)
      .catch(() => {});
  }, []);

  useEffect(() => {
    get<{ platforms: PlatformInfo[] }>('/api/platforms')
      .then((r) => setPlatforms(r.platforms || []))
      .catch(() => {});
    loadKeys();
    loadSettings();
  }, [loadKeys, loadSettings]);

  // 页签激活时刷新：在平台页切换回来能看到最新 Key 状态
  useEffect(() => {
    if (active) loadKeys();
  }, [active, loadKeys]);

  const addKey = async () => {
    const key = newKey.trim();
    if (!key) return;
    setAdding(true);
    try {
      const r = await post<{ id: string; label: string; platform: string; warn?: string | null }>('/api/keys', {
        platform: newPlatform,
        key,
        label: newLabel.trim() || undefined,
      });
      // warn：鉴权已通过、但平台的探测模型不接受试探请求（如魔搭首项模型不支持 chat）。
      // 这时 Key 是有效的，只是没能"完整"验证，如实告诉用户而不是报错拦下。
      if (r.warn) toast('info', `${platformMeta?.name || r.platform} 的 Key「${r.label}」已添加。${r.warn}`);
      else toast('ok', `${platformMeta?.name || r.platform} 的 Key「${r.label}」已添加`);
      setNewKey('');
      setNewLabel('');
      loadKeys();
    } catch (e: any) {
      toast('err', e?.message || '添加失败');
    } finally {
      setAdding(false);
    }
  };

  const removeKey = async (k: KeyInfo) => {
    const pname = platforms.find((p) => p.id === k.platform)?.name || k.platform;
    const ok = await confirm({
      title: '删除平台 Key',
      message: (
        <>
          确定删除 <b className="text-zinc-800">{pname}</b> 的 Key「{k.label}」吗？
          <br />
          仅从本工具移除（<span className="font-mono text-xs">~/.free-token/config.json</span>），不影响平台账号，也不会改动已载入 WorkBuddy 的模型。
        </>
      ),
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/api/keys/${k.id}`);
      toast('ok', '已删除');
      loadKeys();
    } catch (e: any) {
      toast('err', e?.message || '删除失败');
    }
  };

  const activateKey = async (k: KeyInfo) => {
    try {
      await post(`/api/keys/${k.id}/activate`);
      toast('ok', `已将「${k.label}」设为该平台活跃 Key，新载入的模型默认使用它`);
      loadKeys();
    } catch (e: any) {
      toast('err', e?.message || '操作失败');
    }
  };

  const testKey = async (k: KeyInfo) => {
    setTestingId(k.id);
    try {
      const r = await post<{ ok: boolean; error?: string; baseUrl?: string | null; warn?: string | null }>(`/api/keys/${k.id}/test`);
      if (r.ok) {
        const node = hostOf(r.baseUrl) ? `（生效节点：${hostOf(r.baseUrl)}）` : '';
        if (r.warn) toast('info', `「${k.label}」鉴权有效${node}。${r.warn}`);
        else toast('ok', `「${k.label}」有效${node}`);
      } else toast('err', `「${k.label}」无效或已撤销${r.error ? `（${r.error}）` : ''}`);
      loadKeys();
    } catch (e: any) {
      toast('err', e?.message || '测试失败');
    } finally {
      setTestingId(null);
    }
  };

  const clearCache = async () => {
    try {
      await post('/api/cache/clear', {});
      toast('ok', '全部平台的模型列表缓存已清除，下次进入免费模型会重新拉取');
      loadSettings();
    } catch (e: any) {
      toast('err', e?.message || '操作失败');
    }
  };

  // 按平台分组展示已配置的 key（无 key 的平台不显示）
  const groupedKeys = platforms
    .map((p) => ({ platform: p, keys: keys.filter((k) => k.platform === p.id) }))
    .filter((g) => g.keys.length > 0);

  return (
    <div className="space-y-6">
      <PageSection
        icon={<IconKey />}
        title="平台 API Keys"
        count={keys.length > 0 ? `${keys.length} 个 Key` : undefined}
        desc={keys.length > 0 ? `${groupedKeys.length} 个平台` : undefined}
        actions={
          <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
            <IconShield className="w-3.5 h-3.5" />
            仅存本机，不上传
          </span>
        }
      >
        <Card className="p-5">
          <div className="text-xs text-zinc-400 mb-4 leading-relaxed">
            每个平台的 Key 分开管理、可配多个轮换。Key 只保存在本机 <span className="font-mono">~/.free-token/config.json</span>
            ，仅用于调用对应平台的官方接口，不会发送到其他任何地方。Key 同时决定「免费模型」可载入的模型与「平台额度」能看到的用量。
          </div>

          {keys.length === 0 ? (
            <div className="text-sm text-zinc-500 bg-zinc-50 border border-dashed border-zinc-200 rounded-xl px-4 py-6 text-center mb-4">
              <div className="font-medium text-zinc-700">还没有添加任何 Key</div>
              <div className="text-xs text-zinc-400 mt-1">在下方选择平台，粘贴该平台的 API Key 后会自动校验并保存。</div>
            </div>
          ) : (
            <div className="mb-4">
              {groupedKeys.map(({ platform: p, keys: ks }) => (
                <div key={p.id} className="mb-3 last:mb-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xs font-medium text-zinc-500">{p.name}</span>
                    {p.keyUrl && (
                      <a href={p.keyUrl} target="_blank" rel="noreferrer" className="text-indigo-400 hover:text-indigo-600" title="打开该平台 Key 管理页">
                        <IconExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    {p.uiDisabled && <Badge color="gray">{p.uiDisabled === 'region' ? '地区受限' : '平台限制'}</Badge>}
                  </div>
                  <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200/80">
                    {ks.map((k) => (
                      <div key={k.id} className="flex flex-wrap items-center gap-2 px-3.5 py-2.5 hover:bg-zinc-50/70 transition-colors">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-zinc-800 font-medium truncate max-w-48">{k.label}</span>
                            {k.id === activeKeys[k.platform] ? <Badge color="green">活跃</Badge> : k.lastStatus === 'invalid' ? <Badge color="red">无效</Badge> : null}
                            {/* 多节点平台（如 Agnes 双站）：key 绑定的节点与平台默认不同时亮出来 */}
                            {(() => {
                              const node = hostOf(k.baseUrl);
                              const def = hostOf(p.baseUrl);
                              return node && node !== def ? (
                                <span title={`该 Key 鉴权通过的 API 节点：${k.baseUrl}`}>
                                  <Badge color="blue" className="font-mono">
                                    {node}
                                  </Badge>
                                </span>
                              ) : null;
                            })()}
                          </div>
                          <div className="text-xs text-zinc-400 font-mono">
                            {showsMask(k.label, k.masked) && <span className="mr-1">{k.masked} ·</span>}
                            添加于 {fmtDate(k.addedAt)}
                          </div>
                        </div>
                        <div className="ml-auto flex items-center gap-1.5">
                          {k.id !== activeKeys[k.platform] && (
                            <Button size="sm" variant="subtle" onClick={() => activateKey(k)}>
                              设为活跃
                            </Button>
                          )}
                          <Button size="sm" variant="subtle" loading={testingId === k.id} onClick={() => testKey(k)}>
                            <IconRefresh className="w-3.5 h-3.5" />
                            测试
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => removeKey(k)}>
                            <IconTrash className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 添加 Key：先选平台 */}
          <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-zinc-500 shrink-0">添加到平台</span>
              <select
                value={newPlatform}
                onChange={(e) => setNewPlatform(e.target.value)}
                className="h-9 px-2.5 rounded-xl border border-zinc-200 text-sm bg-white outline-none focus:border-indigo-400"
              >
                {platforms.map((p) => (
                  <option key={p.id} value={p.id} disabled={!!p.uiDisabled}>
                    {p.name}
                    {p.uiDisabled ? (p.uiDisabled === 'region' ? '（地区受限）' : '（平台限制）') : ''}
                  </option>
                ))}
              </select>
              {platformMeta?.site && (
                <a
                  href={platformMeta.site}
                  target="_blank"
                  rel="noreferrer"
                  title={`打开 ${platformMeta.name} 官网`}
                  className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-indigo-600"
                >
                  <IconExternalLink className="w-3 h-3" />
                  平台官网
                </a>
              )}
              {platformMeta?.keyUrl && (
                <a
                  href={platformMeta.keyUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={`打开 ${platformMeta.name} 的 Key 管理页`}
                  className="inline-flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-600"
                >
                  <IconKey className="w-3 h-3" />
                  获取 / 管理 Key
                </a>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-56">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addKey()}
                  placeholder={platformMeta?.keyPlaceholder || '粘贴 API Key'}
                  className="w-full h-9 px-3 pr-10 rounded-xl border border-zinc-200 text-sm font-mono outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
                  onClick={() => setShowKey((v) => !v)}
                  title={showKey ? '隐藏 Key' : '显示 Key'}
                  aria-label={showKey ? '隐藏 Key' : '显示 Key'}
                >
                  {showKey ? <IconEyeOff className="w-4 h-4" /> : <IconEye className="w-4 h-4" />}
                </button>
              </div>
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="备注名（可选）"
                className="w-40 h-9 px-3 rounded-xl border border-zinc-200 text-sm outline-none focus:border-indigo-400"
              />
              <Button variant="primary" loading={adding} disabled={!newKey.trim()} onClick={addKey}>
                验证并添加
              </Button>
            </div>
            {platformMeta?.note && (
              <div className="text-[11px] text-zinc-400 leading-relaxed">
                <PlatformNote note={platformMeta.note} tutorialUrl={platformMeta.tutorialUrl} />
              </div>
            )}
            {platformMeta?.modelsPublic && (
              <div className="space-y-1 text-[11px] leading-relaxed text-amber-600">
                <div>
                  该平台模型列表无需 Key 即可浏览；Key 仅在载入模型到 WorkBuddy 与实际对话时使用。点击「测试」会消耗一次极小的调用（1 token）。
                </div>
                <div>
                  若提示「HTTP 400」或「Key 无效：400」，<b>不代表 Key 有问题</b>：这表示 Key 已通过鉴权、只是这次探测请求被平台拒了
                  （探测模型暂不可用，或平台对参数挑剔）。工具会自动换几个模型重试；仍被拒也会照常保存并说明。
                  真正失效的 Key 平台一律返回 401/403，界面上会明确写「平台拒绝访问」。
                </div>
              </div>
            )}
          </div>
        </Card>
      </PageSection>

      {/* 模型列表缓存：与平台强相关，随平台能力放在一起 */}
      <PageSection icon={<IconInbox />} title="模型列表缓存" desc="进入免费模型对应平台时自动刷新">
        <Card className="p-5">
          <div className="text-xs text-zinc-400 mb-3">
            {settings?.modelsCaches?.length ? '各平台模型列表缓存于本机：' : '暂无缓存，进入免费模型时会自动拉取'}
          </div>
          {!!settings?.modelsCaches?.length && (
            <div className="space-y-1 mb-4">
              {settings.modelsCaches.map((c) => (
                <div key={c.platform} className="text-xs text-zinc-500 flex flex-wrap gap-x-2">
                  <span className="font-medium text-zinc-600">{c.platformName}</span>
                  <span>{c.count} 个模型</span>
                  <span>
                    {fmtRelative(c.fetchedAt)}（{new Date(c.fetchedAt).toLocaleString('zh-CN')}）
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="text-xs text-zinc-400 mb-3 break-all">缓存目录：{settings?.cacheDir}</div>
          <Button variant="subtle" onClick={clearCache} disabled={!settings?.modelsCaches?.length}>
            <IconTrash className="w-4 h-4" />
            清除全部缓存
          </Button>
        </Card>
      </PageSection>
    </div>
  );
}
