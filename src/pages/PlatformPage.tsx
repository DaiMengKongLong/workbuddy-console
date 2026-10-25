import { Card, IconGrid, IconKey, IconGauge, Segmented } from '../components/ui';
import ModelsPage from './ModelsPage';
import QuotaPage from './QuotaPage';
import PlatformKeysPanel from './PlatformKeysPanel';

/**
 * 平台页：把三件强关联的事合并到一个入口。
 *
 * 「免费模型」看某个平台有哪些模型 → 用「API Keys」里的 Key 载入 WorkBuddy，
 * 并在「平台额度」里核对这把 Key 还剩多少免费额度/余额。三者共享同一份平台与
 * Key 数据，分散成三个顶级入口后，用户每次都要在菜单之间来回跳。
 *
 * 三个子视图**保持挂载**（非当前 tab 只隐藏）：切回来不会重新拉取模型列表、
 * 不丢筛选与滚动位置，和 App 里页签的挂载策略一致。
 */
export type PlatformTab = 'models' | 'quota' | 'keys';

const PLATFORM_TABS = [
  { value: 'models' as const, label: '免费模型' },
  { value: 'quota' as const, label: '平台额度' },
  { value: 'keys' as const, label: 'API Keys' },
];

export default function PlatformPage({
  tab,
  onTabChange,
}: {
  tab: PlatformTab;
  onTabChange: (t: PlatformTab) => void;
}) {
  const meta = PLATFORM_TABS.find((t) => t.value === tab)!;

  return (
    <div className="space-y-5">
      <Card className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <Segmented<PlatformTab> value={tab} onChange={onTabChange} options={PLATFORM_TABS} />
        <div className="flex items-center gap-2 text-xs text-zinc-400 min-w-0">
          {tab === 'models' && (
            <>
              <IconGrid className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">浏览各平台模型，选中后一键载入 WorkBuddy 的 models.json</span>
            </>
          )}
          {tab === 'quota' && (
            <>
              <IconGauge className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">查看各平台 Key 的免费额度、余额与用量</span>
            </>
          )}
          {tab === 'keys' && (
            <>
              <IconKey className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">管理平台 API Key：可配多把轮换，决定能载入哪些模型</span>
            </>
          )}
        </div>
        <span className="ml-auto hidden text-[11px] text-zinc-300 lg:block" title="当前子页签">
          {meta.label}
        </span>
      </Card>

      {/* 三个子视图常驻挂载，用 hidden 切换 */}
      <div className={tab === 'models' ? '' : 'hidden'}>
        <ModelsPage active={tab === 'models'} onGoKeys={() => onTabChange('keys')} />
      </div>
      <div className={tab === 'quota' ? '' : 'hidden'}>
        <QuotaPage active={tab === 'quota'} onGoKeys={() => onTabChange('keys')} />
      </div>
      <div className={tab === 'keys' ? '' : 'hidden'}>
        <PlatformKeysPanel active={tab === 'keys'} />
      </div>
    </div>
  );
}
