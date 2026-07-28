import React, { useEffect, useMemo, useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import {
  DEFAULT_SCORE_CONFIG,
  type ScoreConfig,
  type ScoreFactorKey,
  normalizeScoreConfig,
} from '../lib/scoreConfig';

interface Props {
  isOpen: boolean;
  value: ScoreConfig;
  onClose: () => void;
  onSave: (config: ScoreConfig) => void;
}

const factorLabels: Record<ScoreFactorKey, string> = {
  ytmRt: '到期收益率',
  premiumRate: '转股溢价率',
  currIssAmt: '剩余规模',
  pureBondPremiumRate: '纯债溢价率',
  turnoverRt: '换手率',
  price: '可转债价格',
  stockMom: '动量',
};

const ScoreConfigModal: React.FC<Props> = ({ isOpen, value, onClose, onSave }) => {
  const [draft, setDraft] = useState<ScoreConfig>(value);

  useEffect(() => {
    if (!isOpen) return;
    setDraft(normalizeScoreConfig(value));
  }, [isOpen, value]);

  const factorKeys = useMemo(() => Object.keys(draft.factors) as ScoreFactorKey[], [draft.factors]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-2xl w-full max-w-2xl overflow-hidden">
        <div className="flex justify-between items-center p-4 border-b border-slate-700 bg-slate-900/50">
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <SlidersHorizontal size={20} className="text-blue-500" />
            评分设置
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-4 sm:p-6 space-y-4">
          <div className="text-xs text-slate-400 leading-relaxed">
            总分 = 各因子分位得分(0~1) × 权重 之和。
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-400 uppercase bg-slate-900/50">
                <tr>
                  <th className="px-2 py-2 text-left whitespace-nowrap">因子</th>
                  <th className="px-2 py-2 text-center whitespace-nowrap">启用</th>
                  <th className="px-2 py-2 text-right whitespace-nowrap">权重</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {factorKeys.map((k) => {
                  const f = draft.factors[k];
                  return (
                    <tr key={k} className="hover:bg-slate-700/30 transition-colors">
                      <td className="px-2 py-2 text-slate-200 whitespace-nowrap">{factorLabels[k]}</td>
                      <td className="px-2 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={f.enabled}
                          onChange={(e) =>
                            setDraft((p) => ({
                              ...p,
                              factors: {
                                ...p.factors,
                                [k]: { ...p.factors[k], enabled: e.target.checked },
                              },
                            }))
                          }
                          className="accent-blue-500"
                        />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <input
                          type="number"
                          step="0.1"
                          value={Number.isFinite(f.weight) ? f.weight : 0}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            setDraft((p) => ({
                              ...p,
                              factors: {
                                ...p.factors,
                                [k]: { ...p.factors[k], weight: Number.isFinite(n) ? n : 0 },
                              },
                            }));
                          }}
                          className="w-24 bg-slate-900 border border-slate-600 text-white rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500 transition-colors text-right"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col sm:flex-row gap-2 justify-end">
            <button
              onClick={() => setDraft(DEFAULT_SCORE_CONFIG)}
              className="text-xs px-3 py-2 rounded-lg border bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700 transition-colors"
            >
              恢复默认
            </button>
            <button
              onClick={onClose}
              className="text-xs px-3 py-2 rounded-lg border bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700 transition-colors"
            >
              取消
            </button>
            <button
              onClick={() => {
                const next = normalizeScoreConfig(draft);
                (Object.keys(next.factors) as ScoreFactorKey[]).forEach((k) => {
                  next.factors[k].largerBetter = DEFAULT_SCORE_CONFIG.factors[k].largerBetter;
                });
                onSave(next);
              }}
              className="text-xs px-3 py-2 rounded-lg border bg-blue-600 text-white border-blue-500 hover:bg-blue-500 transition-colors"
            >
              保存并重算
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ScoreConfigModal;
