/**
 * 右上角的「使用指南」按钮 + 弹窗。
 *
 * 抽成一个组件是因为每个功能页都要有、行为完全一致：点开看步骤，看完关掉。
 * 文案放在 `lib/guides.ts`，这里只管渲染，避免十个页面各写一份弹窗结构。
 */
import { useState } from 'react';
import { Button, IconInfo, Modal } from './ui';
import type { Guide } from '../lib/guides';

export default function PageGuide({ guide, label = '使用指南' }: { guide: Guide; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)} title={`查看${guide.title}`}>
        <IconInfo className="h-3.5 w-3.5" />
        {label}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={guide.title}
        subtitle={guide.subtitle}
        footer={
          <Button variant="primary" onClick={() => setOpen(false)}>
            我知道了
          </Button>
        }
      >
        <div className="space-y-3 text-sm">
          {guide.steps.map((s, i) => (
            <div key={i} className="flex gap-3">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-indigo-100 bg-indigo-50 text-xs font-semibold text-indigo-600">
                {i + 1}
              </div>
              <div className="min-w-0">
                <div className="font-medium text-zinc-800">{s.title}</div>
                <div className="mt-0.5 text-xs leading-relaxed text-zinc-500">{s.desc}</div>
              </div>
            </div>
          ))}
          {!!guide.tips?.length && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
              <div className="mb-1 text-xs font-medium text-amber-700">注意事项</div>
              <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-amber-700/90">
                {guide.tips.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
